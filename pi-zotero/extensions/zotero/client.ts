import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * ZoteroClient — Zotero 10 Local API (Web API v3) 原生客户端（审查修正版）。
 *
 * 直接走 http://127.0.0.1:23119/api（无鉴权读 + 授权写），不依赖 MCP。
 *
 * 实测约束（probe 30/30，勿违反）：
 *   - Host 必须 localhost/127.0.0.1；UA 以 Mozilla/ 开头会被断连 → 固定非浏览器 UA
 *   - `collection=` 查询参数 100% 无效 → 集合条目走 GET /collections/:key/items
 *     （该端点含 children：顶层 120 + 附件/笔记；本地 data.collections 过滤取顶层）
 *   - `limit` 不被 clamp（99999 → 全库）→ 客户端强制 limit≤100 + maxItems 兜底
 *   - `itemKey=` 匹配混入子附件 → 批量 CSL 结果必须过滤请求 keys
 *   - 写协议：无 Server-ID → 428；有 SID 无 key → 401；写需 Zotero-API-Key + Zotero-Write-Token
 *   - 初始化取 Server-ID/版本：GET /api/（不是 /users/0/）
 */
export interface ZoteroClientOptions {
  /** Local API 基址（可信配置，禁止 LLM 输入）默认 http://127.0.0.1:23119/api */
  apiBase?: string;
  /** 单请求超时，默认 15000ms */
  timeoutMs?: number;
  /** 非浏览器 UA */
  userAgent?: string;
  /** 单次列表查询上限，默认 5000 */
  maxItems?: number;
  /**
   * 方案 C（混合授权缓存）：允许将"始终允许"的写授权 key 持久化到
   * ~/.local/state/pi-zotero/auth.json（600 权限），跨会话复用，0 弹窗。
   * 仅当 Zotero 返回 remember=true 时落盘；一次性 key 永不落盘。
   */
  rememberKey?: boolean;
}

export interface ZoteroItem {
  key: string;
  version: number;
  data: Record<string, unknown> & { collections?: string[] };
  meta?: Record<string, unknown>;
}

export interface ZoteroTag {
  tag: string;
  meta?: Record<string, unknown>;
}

export interface ZoteroSearch {
  key: string;
  version: number;
  data: { name: string; conditions?: unknown[] };
  meta?: Record<string, unknown>;
}

export interface ZoteroCollection {
  key: string;
  version: number;
  data: { name: string; parentCollection?: string | false };
  meta?: Record<string, unknown>;
}

export interface ListOptions {
  limit?: number;
  start?: number;
  since?: number;
  q?: string;
  qmode?: "everything" | "titleCreatorYear";
  itemType?: string;
  tag?: string;
  format?: "json" | "csljson" | "versions";
}

/** Zotero itemKey / collectionKey 格式（实测为 8 位大写字母数字） */
export const ZOTERO_KEY_RE = /^[A-Z0-9]{8}$/;

/** 校验 Zotero 对象 key，防路径注入（key 可能来自 LLM/正文） */
export function validateKey(key: string, label = "key"): void {
  if (!ZOTERO_KEY_RE.test(key)) {
    throw new ZoteroApiError(`非法 ${label}「${key}」：须为 8 位大写字母数字`);
  }
}

export class ZoteroApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ZoteroApiError";
  }
}

/** Zotero 未运行（连接拒绝 ECONNREFUSED） */
export class ZoteroNotRunningError extends ZoteroApiError {
  constructor() {
    super(
      "无法连接 Zotero Local API（127.0.0.1:23119）。请确认 Windows 端 Zotero 正在运行，且「设置 → 高级 → 允许其他应用通信」已开启。",
    );
    this.name = "ZoteroNotRunningError";
  }
}

/** 请求超时 */
export class ZoteroTimeoutError extends ZoteroApiError {
  constructor(timeoutMs: number) {
    super(`Zotero 请求超时（${timeoutMs}ms）`);
    this.name = "ZoteroTimeoutError";
  }
}

interface ServerMeta {
  serverId: string;
  version: string;
}

export class ZoteroClient {
  readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly maxItems: number;
  private meta: ServerMeta | null = null;
  /** 写授权 key（内存持有；方案 C 下可从磁盘恢复） */
  private apiKey: string | null = null;
  private readonly rememberKey: boolean;
  private versionWarned = false;
  private storedKey: string | null = null;
  private storedServerId: string | null = null;

  constructor(options: ZoteroClientOptions = {}) {
    this.apiBase = (options.apiBase ?? "http://127.0.0.1:23119/api").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.userAgent = options.userAgent ?? "pi-zotero/0.1 (zotero-local-api)";
    this.maxItems = options.maxItems ?? 5000;
    this.rememberKey = options.rememberKey ?? false;
    this.loadStoredKey();
  }

  /** Zotero 是否可达（不抛错） */
  async ping(): Promise<boolean> {
    try {
      await this.ensureServerMeta();
      return true;
    } catch {
      return false;
    }
  }

  /** 显式初始化：GET /api/ 取 Server-ID + 版本（根路径 body 非 JSON，只读头） */
  async ensureServerMeta(): Promise<ServerMeta> {
    if (this.meta) return this.meta;
    let res: Response;
    try {
      res = await fetch(this.apiBase + "/", {
        headers: { "User-Agent": this.userAgent, "Zotero-API-Version": "3" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err, this.timeoutMs);
    }
    const sid = res.headers.get("zotero-server-id");
    const ver = res.headers.get("x-zotero-version") ?? "?";
    if (!sid) {
      throw new ZoteroApiError(`Zotero 响应缺少 Zotero-Server-ID 头（status ${res.status}）`);
    }
    this.meta = { serverId: sid, version: ver };
    if (!this.versionWarned && ver !== "?" && !ver.startsWith("10")) {
      // 快速发布周期护栏：行为基线在 10.x 实测，跨 major 需重跑 probe
      console.warn(`[pi-zotero] Zotero 版本 ${ver} ≠ 实测基线 10.x，API 行为可能变化，请重跑 scripts/zotero_api_probe.py`);
      this.versionWarned = true;
    }
    return this.meta;
  }

  // ---------- 读 ----------

  /** 通用列表查询（自动分页：limit≤100，maxItems 兜底） */
  async list<T = ZoteroItem>(path: string, opts: ListOptions = {}): Promise<T[]> {
    const limit = Math.min(opts.limit ?? 100, 100);
    const out: T[] = [];
    for (let start = opts.start ?? 0; ; start += limit) {
      const page = await this.rawFetch<T[]>(this.userPath(), path, {
        params: {
          limit: String(limit),
          start: String(start),
          ...(opts.since !== undefined ? { since: String(opts.since) } : {}),
          ...(opts.q ? { q: opts.q, qmode: opts.qmode ?? "everything" } : {}),
          ...(opts.itemType ? { itemType: opts.itemType } : {}),
          ...(opts.tag ? { tag: opts.tag } : {}),
          ...(opts.format ? { format: opts.format } : {}),
        },
      });
      out.push(...page);
      if (page.length < limit) break;
      if (out.length >= this.maxItems) break;
    }
    return out;
  }

  async getItems(opts: ListOptions = {}): Promise<ZoteroItem[]> {
    return this.list<ZoteroItem>("/items", opts);
  }

  async getItem(key: string): Promise<ZoteroItem> {
    validateKey(key);
    return this.rawFetch<ZoteroItem>(this.userPath(), `/items/${key}`);
  }

  async getCollections(opts: ListOptions = {}): Promise<ZoteroCollection[]> {
    return this.list<ZoteroCollection>("/collections", opts);
  }

  /** 某 item 的子项（附件/笔记/批注） */
  async getChildren(key: string): Promise<ZoteroItem[]> {
    validateKey(key);
    return this.list<ZoteroItem>(`/items/${key}/children`);
  }

  /**
   * 集合条目（实测端点，含 children：顶层 + 附件/笔记）。
   * topLevelOnly=true（默认）时用 data.collections 过滤出顶层条目；
   * false 时返回全部（含附件/笔记）。
   */
  async getCollectionItems(collectionKey: string, opts: { topLevelOnly?: boolean } = {}): Promise<ZoteroItem[]> {
    validateKey(collectionKey, "collectionKey");
    const topLevelOnly = opts.topLevelOnly ?? true;
    const all = await this.list<ZoteroItem>(`/collections/${collectionKey}/items`);
    if (!topLevelOnly) return all;
    return all.filter((it) => (it.data.collections ?? []).includes(collectionKey));
  }

  /** 集合内顶层条目 keys（export/batch 复用） */
  async getCollectionKeys(collectionKey: string): Promise<string[]> {
    const items = await this.getCollectionItems(collectionKey);
    return items.map((it) => it.key);
  }

  /** 全文搜索（Zotero 10 FTS5） */
  async search(q: string, opts: Omit<ListOptions, "q"> = {}): Promise<ZoteroItem[]> {
    return this.getItems({ ...opts, q, qmode: opts.qmode ?? "everything" });
  }

  /**
   * 批量取 CSL JSON（列表端点 ?format=csljson + itemKey=）。
   * 注意：itemKey= 匹配会混入子附件 → 结果必须过滤请求 keys。
   */
  async getCSLBatch(keys: string[]): Promise<Record<string, Record<string, unknown>>> {
    const requested = new Set(keys);
    const out: Record<string, Record<string, unknown>> = {};
    const batch = 50;
    for (let i = 0; i < keys.length; i += batch) {
      const page = keys.slice(i, i + batch);
      // limit 必须 ≥ 请求数 + children 混入余量（实测 limit=请求数 会截断混入项）
      const csls = await this.rawFetch<Record<string, unknown>[]>(this.userPath(), "/items", {
        params: { limit: "100", start: "0", format: "csljson", itemKey: page.join(",") },
      });
      for (const csl of csls) {
        const key = extractKeyFromCSL(csl);
        if (key && requested.has(key)) out[key] = csl;
      }
    }
    return out;
  }

  /** 集合内全部顶层条目的 CSL */
  async getCollectionCSL(collectionKey: string): Promise<Record<string, Record<string, unknown>>> {
    const keys = await this.getCollectionKeys(collectionKey);
    return this.getCSLBatch(keys);
  }

  /** 全文内容（无索引 → ZoteroApiError 404） */
  async getFulltext(key: string): Promise<{ content: string; indexedPages: number; totalPages: number }> {
    validateKey(key);
    return this.rawFetch<{ content: string; indexedPages: number; totalPages: number }>(
      this.userPath(),
      `/items/${key}/fulltext`,
    );
  }

  /** 附件磁盘路径（file:///D:/… → WSL /mnt/d/…；响应为纯文本非 JSON） */
  async getAttachmentPath(key: string): Promise<string> {
    validateKey(key);
    const url = `${this.userPath()}/items/${key}/file/view/url`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": this.userAgent, "Zotero-API-Version": "3" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err, this.timeoutMs);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ZoteroApiError(`Zotero API 错误 ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
    const text = await res.text();
    return winFileUrlToWslPath(text.trim());
  }

  /** 保存的搜索列表 */
  async getSearches(): Promise<ZoteroSearch[]> {
    return this.list<ZoteroSearch>("/searches", { limit: 100 });
  }

  /** 执行保存的搜索 */
  async getSearchItems(searchKey: string, opts: ListOptions = {}): Promise<ZoteroItem[]> {
    validateKey(searchKey, "searchKey");
    return this.list<ZoteroItem>(`/searches/${searchKey}/items`, opts);
  }

  /** 单个集合（公开方法，供工具层） */
  async getCollection(collectionKey: string): Promise<ZoteroCollection> {
    validateKey(collectionKey, "collectionKey");
    return this.rawFetch<ZoteroCollection>(this.userPath(), `/collections/${collectionKey}`);
  }

  // ---------- 写（v0.2 启用；契约已就位） ----------

  /** 设置写授权 key（仅内存；由 authorize 流程填充） */
  setApiKey(key: string | null): void {
    this.apiKey = key;
  }

  hasApiKey(): boolean {
    return this.apiKey !== null;
  }

  /** 请求写授权（弹窗）：POST /api/local/authorize */
  async authorize(appName = "pi-zotero"): Promise<{ key: string; remember: boolean }> {
    const meta = await this.ensureServerMeta();
    const res = await fetch(`${this.apiBase}/local/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        "Zotero-API-Version": "3",
        "Zotero-Server-ID": meta.serverId,
      },
      body: JSON.stringify({ appName }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 403) {
      throw new ZoteroApiError("用户在 Zotero 弹窗中拒绝了写授权", 403);
    }
    if (res.status === 429) {
      throw new ZoteroApiError(
        `授权请求过于频繁（Zotero 限流 5 次/分钟），请稍后重试${res.headers.get("retry-after") ? `（Retry-After: ${res.headers.get("retry-after")}s）` : ""}`,
        429,
      );
    }
    if (!res.ok) {
      throw new ZoteroApiError(`授权失败 ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    }
    const data = (await res.json()) as { key: string; remember: boolean };
    this.apiKey = data.key;
    // 方案 C：仅"始终允许"（remember=true，key 可无限复用）时落盘；
    // 一次性 key 落盘无意义（下个写即 401，还得重授权）
    if (this.rememberKey && data.remember) {
      this.storeKey(data.key, meta.serverId);
    }
    return data;
  }

  /** 磁盘授权缓存（方案 C）：~/.local/state/pi-zotero/auth.json，600 权限 */
  private static authFilePath(): string {
    return path.join(os.homedir(), ".local", "state", "pi-zotero", "auth.json");
  }

  private loadStoredKey(): void {
    try {
      const raw = fs.readFileSync(ZoteroClient.authFilePath(), "utf-8");
      const d = JSON.parse(raw) as { serverId: string; key: string };
      // 预载时先不校验 serverId（ensureServerMeta 可能未跑）；writeRequest 前 ensureApiKey 校验
      this.storedServerId = d.serverId;
      this.storedKey = d.key;
    } catch {
      // 无缓存或损坏：忽略
    }
  }

  private storeKey(key: string, serverId: string): void {
    try {
      const p = ZoteroClient.authFilePath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ serverId, key, savedAt: Date.now() }), { mode: 0o600 });
    } catch {
      // 落盘失败不阻塞（仅影响跨会话复用）
    }
  }

  private clearStoredKey(): void {
    try {
      fs.rmSync(ZoteroClient.authFilePath(), { force: true });
    } catch {
      // 忽略
    }
  }

  /** 写前确保 apiKey 可用：内存无 → 磁盘恢复（校验 serverId）→ 仍无则报错提示授权 */
  private async ensureApiKey(): Promise<void> {
    if (this.apiKey) return;
    const meta = await this.ensureServerMeta();
    if (this.storedKey && this.storedServerId === meta.serverId) {
      this.apiKey = this.storedKey;
      return;
    }
    this.apiKey = null;
  }

  /** 创建集合 */
  async createCollection(name: string, parentCollection?: string | false): Promise<{ key: string; version: number }> {
    const res = await this.writeRequest<{ successful: { key: string; version: number }[] }>("/collections", {
      method: "POST",
      body: JSON.stringify([{ name, ...(parentCollection !== undefined ? { parentCollection } : {}) }]),
    }, false, false);
    return res.successful?.[0] ?? { key: "", version: 0 };
  }

  /** 更新集合（重命名/换父） */
  async updateCollection(key: string, data: Record<string, unknown>, version: number): Promise<void> {
    validateKey(key, "collectionKey");
    await this.writeRequest(`/collections/${key}`, { method: "PATCH", body: JSON.stringify(data), version });
  }

  /** 删除集合（永久，无回收站语义；DELETE 需版本头，实测 428 提示） */
  async deleteCollection(key: string): Promise<void> {
    validateKey(key, "collectionKey");
    const col = await this.getCollection(key);
    await this.writeRequest(`/collections/${key}`, { method: "DELETE", body: "{}", version: col.version });
  }

  /** 条目移入回收站（可恢复） */
  async trashItem(key: string): Promise<void> {
    validateKey(key);
    const it = await this.getItem(key);
    await this.updateItem(key, { deleted: 1 }, it.version);
  }

  /** 彻底删除条目（DELETE 需版本头） */
  async deleteItem(key: string): Promise<void> {
    validateKey(key);
    const it = await this.getItem(key);
    await this.writeRequest(`/items/${key}`, { method: "DELETE", body: "{}", version: it.version });
  }

  /** 创建保存搜索（conditions 为 Zotero 10 条件 JSON 数组） */
  async createSearch(name: string, conditions: unknown[]): Promise<{ key: string; version: number }> {
    const res = await this.writeRequest<{ successful: { key: string; version: number }[] }>("/searches", {
      method: "POST",
      body: JSON.stringify([{ name, conditions }]),
    }, false, false);
    return res.successful?.[0] ?? { key: "", version: 0 };
  }

  /** 单个保存搜索 */
  async getSearch(searchKey: string): Promise<{ key: string; version: number; data: { name: string; conditions?: unknown[] } }> {
    validateKey(searchKey, "searchKey");
    return this.rawFetch(this.userPath(), `/searches/${searchKey}`);
  }

  /** 更新保存搜索 */
  async updateSearch(searchKey: string, data: Record<string, unknown>, version: number): Promise<void> {
    validateKey(searchKey, "searchKey");
    await this.writeRequest(`/searches/${searchKey}`, { method: "PATCH", body: JSON.stringify(data), version });
  }

  /** 删除保存搜索（DELETE 需版本头） */
  async deleteSearch(searchKey: string): Promise<void> {
    validateKey(searchKey, "searchKey");
    const s = await this.getSearch(searchKey);
    await this.writeRequest(`/searches/${searchKey}`, { method: "DELETE", body: "{}", version: s.version });
  }

  /** 全局标签列表 */
  async getTags(opts: ListOptions = {}): Promise<ZoteroTag[]> {
    return this.list<ZoteroTag>("/tags", opts);
  }

  /** 删除标签（从全部条目移除） */
  async deleteTag(tag: string): Promise<void> {
    if (!tag) throw new ZoteroApiError("标签名为空");
    await this.writeRequest(`/tags/${encodeURIComponent(tag)}`, { method: "DELETE", body: "{}" });
  }

  /**
   * 附件三段式上传（Zotero 10 本地文件上传）：
   * 1) POST /items/:key/file（md5/filename/filesize/mtime + If-None-Match:*）→ {exists:1} 或 {url, uploadKey}
   * 2) 已存在则跳过；否则 POST 文件内容到 url（uploadKey 授权，无需 Server-ID/API-Key）
   * @returns {exists} 是否已存在（跳过上传）
   */
  async uploadFile(attachmentKey: string, filePath: string): Promise<{ exists: boolean }> {
    validateKey(attachmentKey, "attachmentKey");
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath);
    const md5 = createHash("md5").update(content).digest("hex");
    const filename = path.basename(filePath);
    // mtime 必须毫秒（实测 400 提示）
    return this.uploadInit(attachmentKey, { md5, filename, filesize: stat.size, mtime: Math.floor(stat.mtimeMs) }, content, false);
  }

  /** 上传初始化（含 401 自动授权重试一次；幂等：初始化未处理时重试安全） */
  private async uploadInit(
    attachmentKey: string,
    meta: { md5: string; filename: string; filesize: number; mtime: number },
    content: Buffer,
    retried: boolean,
  ): Promise<{ exists: boolean }> {
    await this.ensureApiKey();
    const server = await this.ensureServerMeta();
    const initRes = await fetch(`${this.userPath()}/items/${attachmentKey}/file`, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Zotero-API-Version": "3",
        "Zotero-Server-ID": server.serverId,
        "Zotero-Write-Token": randomToken(),
        "If-None-Match": "*",
        "Content-Type": "application/json",
        ...(this.apiKey ? { "Zotero-API-Key": this.apiKey } : {}),
      },
      body: JSON.stringify(meta),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (initRes.status === 401 && !retried) {
      // 未授权或 key 失效：自动授权后重试一次（初始化未处理时重试安全）
      await this.authorize("pi-zotero");
      return this.uploadInit(attachmentKey, meta, content, true);
    }
    if (!initRes.ok) {
      const body = await initRes.text().catch(() => "");
      throw new ZoteroApiError(`上传初始化失败 ${initRes.status}: ${body.slice(0, 200)}`, initRes.status);
    }
    const data = (await initRes.json()) as { exists?: number; url?: string; uploadKey?: string };
    if (data.exists) return { exists: true };
    if (!data.url) throw new ZoteroApiError("上传初始化响应缺少 url");
    // 第二段：上传内容（uploadKey 授权，无需 Server-ID/API-Key）
    const upRes = await fetch(data.url, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
      },
      body: new Uint8Array(content),
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 60_000)),
    });
    if (!upRes.ok) {
      const body = await upRes.text().catch(() => "");
      throw new ZoteroApiError(`上传失败 ${upRes.status}: ${body.slice(0, 200)}`, upRes.status);
    }
    // 第三段：register（body 带 upload=<key>，源码 registerUpload 从 POST body 读），
    // 把暂存文件移入 storage 并更新附件元数据
    const regRes = await fetch(`${this.userPath()}/items/${attachmentKey}/file`, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Zotero-API-Version": "3",
        "Zotero-Server-ID": server.serverId,
        "Zotero-Write-Token": randomToken(),
        "If-None-Match": "*",
        "Content-Type": "application/json",
        ...(this.apiKey ? { "Zotero-API-Key": this.apiKey } : {}),
      },
      body: JSON.stringify({ upload: data.uploadKey }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (regRes.status === 401 && !retried) {
      await this.authorize("pi-zotero");
      return this.uploadInit(attachmentKey, meta, content, true);
    }
    if (!regRes.ok) {
      const body = await regRes.text().catch(() => "");
      throw new ZoteroApiError(`上传注册失败 ${regRes.status}: ${body.slice(0, 200)}`, regRes.status);
    }
    return { exists: false };
  }

  /**
   * 创建条目（v0.2 工具层调用）。
   * @returns 创建的 { key, version }
   */
  async createItems(items: Record<string, unknown>[]): Promise<{ key: string; version: number }[]> {
    // POST 非幂等：401 不自动重试（重试会重复创建，实测踩坑）
    const res = await this.writeRequest<{ successful: { key: string; version: number }[]; failed: unknown[] }>(
      "/items",
      { method: "POST", body: JSON.stringify(items) },
      false,
      false,
    );
    if (res.failed?.length) {
      throw new ZoteroApiError(`部分条目创建失败: ${JSON.stringify(res.failed).slice(0, 300)}`);
    }
    return res.successful ?? [];
  }

  /**
   * 更新条目（读-改-写：412 冲突时重取 version 重试一次）。
   * data 为部分字段；version 用条目当前 version（If-Unmodified-Since-Version）。
   */
  async updateItem(key: string, data: Record<string, unknown>, version: number): Promise<void> {
    validateKey(key);
    try {
      await this.writeRequest(`/items/${key}`, { method: "PATCH", body: JSON.stringify(data), version });
    } catch (err) {
      if (err instanceof ZoteroApiError && err.status === 412) {
        // 乐观并发冲突：重读最新 version 后重放一次
        const fresh = await this.getItem(key);
        await this.writeRequest(`/items/${key}`, {
          method: "PATCH",
          body: JSON.stringify(data),
          version: fresh.version,
        });
        return;
      }
      throw err;
    }
  }

  // ---------- 内部 ----------

  private userPath(): string {
    return `${this.apiBase}/users/0`;
  }

  /** 原始请求：GET 返回 JSON；错误归一化（NotRunning/Timeout/HTTP/非 JSON） */
  private async rawFetch<T>(
    base: string,
    path: string,
    init: { params?: URLSearchParams | Record<string, string>; method?: string; body?: string } = {},
  ): Promise<T> {
    const sp = init.params instanceof URLSearchParams ? init.params : new URLSearchParams(init.params ?? {});
    const qs = sp.toString() ? `?${sp}` : "";
    let res: Response;
    try {
      res = await fetch(`${base}${path}${qs}`, {
        method: init.method ?? "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": this.userAgent,
          "Zotero-API-Version": "3",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err, this.timeoutMs);
    }
    if (res.status === 412) {
      throw new ZoteroApiError(
        "Zotero 并发冲突：目标对象已被修改（If-Unmodified-Since-Version 不匹配），请重新读取后重试。",
        412,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ZoteroApiError(`Zotero API 错误 ${res.status}: ${body.slice(0, 300)}`, res.status, body);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ZoteroApiError(`Zotero 响应非 JSON（status ${res.status}）`);
    }
  }

  /** 写请求：Server-ID + API-Key + Write-Token + 版本并发；401 自动重授权重试一次。
   * retryOnAuth=false 用于 POST（非幂等，重试会重复创建——实测踩坑）。 */
  private async writeRequest<T>(
    path: string,
    init: { method: string; body: string; version?: number },
    retried = false,
    retryOnAuth = true,
  ): Promise<T> {
    await this.ensureApiKey();
    const meta = await this.ensureServerMeta();
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      "Zotero-API-Version": "3",
      "Content-Type": "application/json",
      "Zotero-Server-ID": meta.serverId,
      "Zotero-Write-Token": randomToken(),
      ...(this.apiKey ? { "Zotero-API-Key": this.apiKey } : {}),
    };
    if (init.version !== undefined) headers["If-Unmodified-Since-Version"] = String(init.version);
    let res: Response;
    try {
      res = await fetch(`${this.userPath()}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err, this.timeoutMs);
    }
    if (res.status === 428) {
      // Server-ID 失效（数据库迁移/恢复）：重初始化后重试一次
      this.meta = null;
      throw new ZoteroApiError("Zotero 要求先提供 Server-ID（428）", 428);
    }
    if (res.status === 401) {
      // 从未授权（apiKey=null，请求未被处理）→ 任何写都自动授权后重试（安全）
      // 已授权但 key 失效 → 仅幂等操作重试（POST 可能已处理，防重复创建）
      if (!retried && (!this.apiKey || retryOnAuth)) {
        await this.authorize("pi-zotero");
        return this.writeRequest<T>(path, init, true, retryOnAuth);
      }
      throw new ZoteroApiError(
        this.apiKey
          ? "Zotero 写授权 key 已失效（401），可能被消耗或吊销。请在 Zotero 设置 → 高级 → 清除写授权后重试。"
          : "Zotero 写授权失败（401），弹窗可能被拒绝。",
        401,
      );
    }
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      throw new ZoteroApiError(`Zotero 请求限流（429）${retry ? `，Retry-After: ${retry}s` : ""}`, 429);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ZoteroApiError(`Zotero 写请求失败 ${res.status}: ${body.slice(0, 300)}`, res.status, body);
    }
    // PATCH/DELETE 成功常为 204 No Content（实测）
    if (res.status === 204) {
      return undefined as T;
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ZoteroApiError(`Zotero 响应非 JSON（status ${res.status}）`);
    }
  }
}

/** fetch 错误分类：连接拒绝 → 未运行；超时 → 超时；其余原样 */
function classifyFetchError(err: unknown, timeoutMs: number): Error {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return new ZoteroTimeoutError(timeoutMs);
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED") {
      return new ZoteroNotRunningError();
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** CSL JSON 的 id 形如 http://zotero.org/users/<uid>/items/<KEY> */
function extractKeyFromCSL(csl: Record<string, unknown>): string | null {
  const id = csl["id"];
  if (typeof id !== "string") return null;
  const m = id.match(/\/items\/([A-Z0-9]{8})$/);
  return m ? m[1] : null;
}

/** file:///D:/work/a.pdf → /mnt/d/work/a.pdf（WSL 可读） */
export function winFileUrlToWslPath(url: string): string {
  // file:///D:/work/a.pdf → /mnt/d/work/a.pdf（file: + 3 斜杠 + 盘符）
  const m = url.match(/^file:\/\/\/([A-Za-z]):\/(.*)$/);
  if (!m) return url;
  const drive = m[1].toLowerCase();
  const rest = decodeURIComponent(m[2]);
  return `/mnt/${drive}/${rest}`;
}

/** 一次性写 token（单次有效，防 CSRF；Zotero 要求 5-32 字符） */
function randomToken(): string {
  const c = typeof globalThis !== "undefined" && "crypto" in globalThis ? globalThis.crypto : undefined;
  if (c && "getRandomValues" in c) {
    const buf = new Uint8Array(16);
    c.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `t${Date.now()}${Math.random().toString(36).slice(2, 14)}`;
}
