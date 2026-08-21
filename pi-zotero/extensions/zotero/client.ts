import { createHash, randomBytes } from "node:crypto";
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
  data: Record<string, unknown> & {
    collections?: string[];
    deleted?: boolean | number;
    itemType?: string;
    parentItem?: string | false;
  };
  meta?: Record<string, unknown>;
}

export interface CreateItemsResult {
  successful: { key: string; version: number }[];
  failed: unknown[];
}

type IndexedWriteValues<T> = T[] | Record<string, T>;
interface RawWriteResult<T> {
  successful?: IndexedWriteValues<T>;
  failed?: IndexedWriteValues<unknown>;
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

export interface ListResult<T> {
  items: T[];
  /** 当前语义结果总数；若 truncated=true，则为已读取结果的已知下界。 */
  total: number;
  /** 内存过滤前端点的 Total-Results；仅集合等二次过滤接口提供。 */
  sourceTotal?: number;
  /** 仍有源结果未读取，原因可能是调用 limit 或 maxItems 硬上限。 */
  truncated: boolean;
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

export interface ServerMeta {
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
  /** true=Always Allow/磁盘恢复，可跨写请求复用；false=Allow，首个写请求后必须清空 */
  private apiKeyReusable = false;
  private readonly rememberKey: boolean;
  private versionWarned = false;
  private storedKey: string | null = null;
  private storedServerId: string | null = null;

  constructor(options: ZoteroClientOptions = {}) {
    this.apiBase = (options.apiBase ?? "http://127.0.0.1:23119/api").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.userAgent = options.userAgent ?? "pi-zotero/0.2 (zotero-local-api)";
    this.maxItems = options.maxItems ?? 5000;
    this.rememberKey = options.rememberKey ?? false;
    if (this.rememberKey) this.loadStoredKey();
    else this.clearStoredKey();
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
      console.warn(`[pi-zotero] Zotero 版本 ${ver} ≠ 实测基线 10.x，API 行为可能变化；请从源码仓库运行 API probe`);
      this.versionWarned = true;
    }
    return this.meta;
  }

  // ---------- 读 ----------

  /** 带 Total-Results/truncated 的通用列表查询；内部按 ≤100 分页并受 maxItems 硬上限约束。 */
  async listWithMeta<T = ZoteroItem>(path: string, opts: ListOptions = {}): Promise<ListResult<T>> {
    const hardLimit = Math.max(1, this.maxItems);
    const totalLimit = Math.min(Math.max(1, opts.limit ?? hardLimit), hardLimit);
    const initialStart = Math.max(0, opts.start ?? 0);
    const out: T[] = [];
    let start = initialStart;
    let totalFromHeader: number | null = null;
    let exhausted = false;
    while (out.length < totalLimit) {
      const pageSize = Math.min(100, totalLimit - out.length);
      const pageResult = await this.rawFetchResult<T[]>(this.userPath(), path, {
        params: {
          limit: String(pageSize),
          start: String(start),
          ...(opts.since !== undefined ? { since: String(opts.since) } : {}),
          ...(opts.q ? { q: opts.q, qmode: opts.qmode ?? "everything" } : {}),
          ...(opts.itemType ? { itemType: opts.itemType } : {}),
          ...(opts.tag ? { tag: opts.tag } : {}),
          ...(opts.format ? { format: opts.format } : {}),
        },
      });
      if (totalFromHeader === null) {
        const parsed = Number.parseInt(pageResult.headers.get("total-results") ?? "", 10);
        if (Number.isFinite(parsed) && parsed >= 0) totalFromHeader = parsed;
      }
      const page = pageResult.data;
      out.push(...page.slice(0, totalLimit - out.length));
      if (page.length < pageSize) {
        exhausted = true;
        break;
      }
      start += pageSize;
    }
    const knownEnd = initialStart + out.length;
    const total = totalFromHeader ?? knownEnd;
    return {
      items: out,
      total,
      truncated: totalFromHeader !== null ? knownEnd < totalFromHeader : !exhausted && out.length >= totalLimit,
    };
  }

  /** 兼容数组调用；需要判断完整性时使用 listWithMeta。 */
  async list<T = ZoteroItem>(path: string, opts: ListOptions = {}): Promise<T[]> {
    return (await this.listWithMeta<T>(path, opts)).items;
  }

  async getItemsWithMeta(opts: ListOptions = {}): Promise<ListResult<ZoteroItem>> {
    return this.listWithMeta<ZoteroItem>("/items", opts);
  }

  async getItems(opts: ListOptions = {}): Promise<ZoteroItem[]> {
    return (await this.getItemsWithMeta(opts)).items;
  }

  /** 回收站条目；Local API 默认 /items 列表不会返回这些条目。 */
  async getTrashItemsWithMeta(opts: ListOptions = {}): Promise<ListResult<ZoteroItem>> {
    return this.listWithMeta<ZoteroItem>("/items/trash", opts);
  }

  async getTrashItems(opts: ListOptions = {}): Promise<ZoteroItem[]> {
    return (await this.getTrashItemsWithMeta(opts)).items;
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
  async getCollectionItemsWithMeta(
    collectionKey: string,
    opts: { topLevelOnly?: boolean } = {},
  ): Promise<ListResult<ZoteroItem>> {
    validateKey(collectionKey, "collectionKey");
    const topLevelOnly = opts.topLevelOnly ?? true;
    const result = await this.listWithMeta<ZoteroItem>(`/collections/${collectionKey}/items`);
    // 当前 Zotero 10 端点默认排除回收站；仍显式过滤，避免未来版本行为变化。
    const active = result.items.filter((item) => !item.data.deleted);
    const items = topLevelOnly
      ? active.filter((item) => (item.data.collections ?? []).includes(collectionKey))
      : active;
    return { items, total: items.length, sourceTotal: result.total, truncated: result.truncated };
  }

  async getCollectionItems(collectionKey: string, opts: { topLevelOnly?: boolean } = {}): Promise<ZoteroItem[]> {
    return (await this.getCollectionItemsWithMeta(collectionKey, opts)).items;
  }

  /** 回收站中仍保留该集合直接归属关系的顶层条目。 */
  async getCollectionTrashItemsWithMeta(collectionKey: string): Promise<ListResult<ZoteroItem>> {
    validateKey(collectionKey, "collectionKey");
    const result = await this.getTrashItemsWithMeta();
    const items = result.items.filter((item) => (item.data.collections ?? []).includes(collectionKey));
    return { items, total: items.length, sourceTotal: result.total, truncated: result.truncated };
  }

  async getCollectionTrashItems(collectionKey: string): Promise<ZoteroItem[]> {
    return (await this.getCollectionTrashItemsWithMeta(collectionKey)).items;
  }

  /** 集合内顶层条目 keys（export/batch 复用） */
  async getCollectionKeys(collectionKey: string): Promise<string[]> {
    const items = await this.getCollectionItems(collectionKey);
    return items.map((it) => it.key);
  }

  /** 全文搜索（Zotero 10 FTS5） */
  async searchWithMeta(q: string, opts: Omit<ListOptions, "q"> = {}): Promise<ListResult<ZoteroItem>> {
    return this.getItemsWithMeta({ ...opts, q, qmode: opts.qmode ?? "everything" });
  }

  async search(q: string, opts: Omit<ListOptions, "q"> = {}): Promise<ZoteroItem[]> {
    return (await this.searchWithMeta(q, opts)).items;
  }

  /** 集合内搜索；limit 作用于过滤后的顶层结果，children 占页时继续翻页。 */
  async searchCollectionWithMeta(
    collectionKey: string,
    q: string,
    opts: Omit<ListOptions, "q"> = {},
  ): Promise<ListResult<ZoteroItem>> {
    validateKey(collectionKey, "collectionKey");
    const desired = Math.min(Math.max(1, opts.limit ?? 20), Math.max(1, this.maxItems));
    const out: ZoteroItem[] = [];
    let start = Math.max(0, opts.start ?? 0);
    let scanned = 0;
    let sourceTotal: number | null = null;
    let sourceExhausted = false;
    let stoppedInsidePage = false;
    while (out.length < desired && scanned < this.maxItems) {
      const pageSize = Math.min(100, this.maxItems - scanned);
      const pageResult = await this.rawFetchResult<ZoteroItem[]>(this.userPath(), `/collections/${collectionKey}/items`, {
        params: {
          limit: String(pageSize),
          start: String(start),
          q,
          qmode: opts.qmode ?? "everything",
          ...(opts.itemType ? { itemType: opts.itemType } : {}),
          ...(opts.tag ? { tag: opts.tag } : {}),
        },
      });
      if (sourceTotal === null) {
        const parsed = Number.parseInt(pageResult.headers.get("total-results") ?? "", 10);
        if (Number.isFinite(parsed) && parsed >= 0) sourceTotal = parsed;
      }
      const page = pageResult.data;
      scanned += page.length;
      sourceExhausted = page.length < pageSize || (sourceTotal !== null && start + page.length >= sourceTotal);
      for (let index = 0; index < page.length; index += 1) {
        const item = page[index];
        if (item.data.deleted || !(item.data.collections ?? []).includes(collectionKey)) continue;
        out.push(item);
        if (out.length >= desired) {
          stoppedInsidePage = index < page.length - 1;
          break;
        }
      }
      if (sourceExhausted) break;
      start += pageSize;
    }
    return {
      items: out,
      total: out.length,
      sourceTotal: sourceTotal ?? scanned,
      truncated: stoppedInsidePage || !sourceExhausted,
    };
  }

  async searchCollection(
    collectionKey: string,
    q: string,
    opts: Omit<ListOptions, "q"> = {},
  ): Promise<ZoteroItem[]> {
    return (await this.searchCollectionWithMeta(collectionKey, q, opts)).items;
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

  /** 批量读取条目本地 version，用于 CSL 缓存失效。 */
  async getItemVersions(keys: string[]): Promise<Record<string, number>> {
    const requested = new Set(keys);
    for (const key of requested) validateKey(key);
    const out: Record<string, number> = {};
    const list = [...requested];
    for (let i = 0; i < list.length; i += 50) {
      const page = list.slice(i, i + 50);
      const values = await this.rawFetch<Record<string, number>>(this.userPath(), "/items", {
        params: { format: "versions", itemKey: page.join(","), limit: "100", start: "0" },
      });
      for (const [key, version] of Object.entries(values)) {
        if (requested.has(key) && Number.isInteger(version)) out[key] = version;
      }
    }
    return out;
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

  /** 设置写授权 key（主要供诊断/测试）；默认按一次性 key 处理。 */
  setApiKey(key: string | null, reusable = false): void {
    this.apiKey = key;
    this.apiKeyReusable = key !== null && reusable;
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
    this.apiKeyReusable = data.remember;
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
      const value = JSON.parse(raw) as { serverId?: unknown; key?: unknown };
      if (typeof value.serverId !== "string" || typeof value.key !== "string" || value.key.length < 16) {
        throw new Error("invalid auth cache");
      }
      // 预载时先不校验 serverId（ensureServerMeta 尚未运行）；写前再校验。
      this.storedServerId = value.serverId;
      this.storedKey = value.key;
    } catch {
      this.storedServerId = null;
      this.storedKey = null;
    }
  }

  private storeKey(key: string, serverId: string): void {
    const target = ZoteroClient.authFilePath();
    const temporary = `${target}.${process.pid}.${randomToken().slice(0, 8)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ serverId, key, savedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      this.storedServerId = serverId;
      this.storedKey = key;
    } catch {
      fs.rmSync(temporary, { force: true });
      // 落盘失败不阻塞当前会话写入（仅影响跨会话复用）。
    }
  }

  private clearStoredKey(): void {
    this.storedServerId = null;
    this.storedKey = null;
    try {
      fs.rmSync(ZoteroClient.authFilePath(), { force: true });
    } catch {
      // 忽略权限/文件不存在；内存中已禁用该缓存。
    }
  }

  /** 写前恢复可复用 key；rememberKey=false 时不会读取磁盘。 */
  private async ensureApiKey(): Promise<void> {
    if (this.apiKey) return;
    const meta = await this.ensureServerMeta();
    if (this.rememberKey && this.storedKey && this.storedServerId === meta.serverId) {
      this.apiKey = this.storedKey;
      this.apiKeyReusable = true;
      return;
    }
    if (this.storedKey && this.storedServerId !== meta.serverId) this.clearStoredKey();
    this.apiKey = null;
    this.apiKeyReusable = false;
  }

  private clearInMemoryApiKey(): void {
    this.apiKey = null;
    this.apiKeyReusable = false;
  }

  /** 创建集合 */
  async createCollection(name: string, parentCollection?: string | false): Promise<{ key: string; version: number }> {
    const res = await this.writeRequest<RawWriteResult<{ key: string; version: number }>>("/collections", {
      method: "POST",
      body: JSON.stringify([{ name, ...(parentCollection !== undefined ? { parentCollection } : {}) }]),
    });
    const created = indexedWriteValues(res.successful)[0];
    if (!created) throw new ZoteroApiError(`集合创建失败: ${JSON.stringify(indexedWriteValues(res.failed)).slice(0, 300)}`);
    return created;
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
    const item = await this.getItem(key);
    await this.updateItem(key, { deleted: true }, item.version);
  }

  /** 从回收站恢复；若条目已是活动状态则不写入并返回 false。 */
  async restoreItem(key: string): Promise<boolean> {
    validateKey(key);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const item = await this.getItem(key);
      if (!item.data.deleted) return false;
      try {
        await this.updateItem(key, { deleted: false }, item.version);
        return true;
      } catch (error) {
        if (!(error instanceof ZoteroApiError && error.status === 412 && attempt === 0)) throw error;
      }
    }
    return false;
  }

  /** 彻底删除条目（DELETE 需版本头） */
  async deleteItem(key: string): Promise<void> {
    validateKey(key);
    const it = await this.getItem(key);
    await this.writeRequest(`/items/${key}`, { method: "DELETE", body: "{}", version: it.version });
  }

  /** 创建保存搜索（conditions 为 Zotero 10 条件 JSON 数组） */
  async createSearch(name: string, conditions: unknown[]): Promise<{ key: string; version: number }> {
    const res = await this.writeRequest<RawWriteResult<{ key: string; version: number }>>("/searches", {
      method: "POST",
      body: JSON.stringify([{ name, conditions }]),
    });
    const created = indexedWriteValues(res.successful)[0];
    if (!created) throw new ZoteroApiError(`保存搜索创建失败: ${JSON.stringify(indexedWriteValues(res.failed)).slice(0, 300)}`);
    return created;
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
   * 1) Local API 初始化（一次写授权）→ {exists:1} 或 {url, uploadKey}
   * 2) 向暂存 URL 上传内容（uploadKey 授权，不消耗 Local API key）
   * 3) Local API register（另一次写授权）→ 把暂存文件移入 storage
   *
   * 用户选择 Allow 时步骤 1/3 会各弹一次授权；Always Allow 时复用同一 key。
   */
  async uploadFile(attachmentKey: string, filePath: string): Promise<{ exists: boolean }> {
    validateKey(attachmentKey, "attachmentKey");
    const initialStat = fs.statSync(filePath);
    if (!initialStat.isFile()) throw new ZoteroApiError(`附件路径不是普通文件: ${filePath}`);
    const md5 = await fileMd5(filePath);
    const stat = fs.statSync(filePath);
    if (stat.size !== initialStat.size || stat.mtimeMs !== initialStat.mtimeMs) {
      throw new ZoteroApiError("附件在计算 MD5 期间发生变化，请停止写入后重试");
    }
    const filename = path.basename(filePath);
    const metadata = { md5, filename, filesize: stat.size, mtime: Math.floor(stat.mtimeMs) };

    const initRes = await this.authorizedWriteFetch(
      `${this.userPath()}/items/${attachmentKey}/file`,
      {
        method: "POST",
        headers: { "If-None-Match": "*", "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      },
    );
    if (!initRes.ok) {
      const body = await initRes.text().catch(() => "");
      throw new ZoteroApiError(`上传初始化失败 ${initRes.status}: ${body.slice(0, 200)}`, initRes.status);
    }
    const data = (await initRes.json()) as { exists?: number; url?: string; uploadKey?: string };
    if (data.exists) return { exists: true };
    if (!data.url || !data.uploadKey) {
      throw new ZoteroApiError("上传初始化响应缺少 url 或 uploadKey");
    }

    const uploadTimeoutMs = Math.max(this.timeoutMs, 300_000);
    const uploadStream = fs.createReadStream(filePath);
    let uploadResponse: Response;
    try {
      const uploadInit: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          "User-Agent": this.userAgent,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stat.size),
        },
        body: uploadStream as unknown as BodyInit,
        duplex: "half",
        signal: AbortSignal.timeout(uploadTimeoutMs),
      };
      uploadResponse = await fetch(data.url, uploadInit);
      uploadStream.destroy();
    } catch (err) {
      uploadStream.destroy();
      throw classifyFetchError(err, uploadTimeoutMs);
    }
    if (!uploadResponse.ok) {
      const body = await uploadResponse.text().catch(() => "");
      throw new ZoteroApiError(`上传失败 ${uploadResponse.status}: ${body.slice(0, 200)}`, uploadResponse.status);
    }

    const registerResponse = await this.authorizedWriteFetch(
      `${this.userPath()}/items/${attachmentKey}/file`,
      {
        method: "POST",
        headers: { "If-None-Match": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ upload: data.uploadKey }),
      },
    );
    if (!registerResponse.ok) {
      const body = await registerResponse.text().catch(() => "");
      throw new ZoteroApiError(`上传注册失败 ${registerResponse.status}: ${body.slice(0, 200)}`, registerResponse.status);
    }
    return { exists: false };
  }

  /**
   * 创建条目（v0.2 工具层调用）。
   * @returns 创建的 { key, version }
   */
  async createItems(items: Record<string, unknown>[]): Promise<CreateItemsResult> {
    // Local API 的 401 表示 key 未通过验证、请求未执行，因此可在重新授权后安全重试一次。
    const res = await this.writeRequest<RawWriteResult<{ key: string; version: number }>>(
      "/items",
      { method: "POST", body: JSON.stringify(items) },
    );
    const result: CreateItemsResult = {
      successful: indexedWriteValues(res.successful).map((entry) => ({ key: entry.key, version: entry.version })),
      failed: indexedWriteValues(res.failed),
    };
    if (items.length > 0 && result.successful.length === 0 && result.failed.length === 0) {
      throw new ZoteroApiError("条目创建失败：响应中既没有 successful 也没有 failed 结果");
    }
    return result;
  }

  /**
   * 更新条目（If-Unmodified-Since-Version）。
   * 412 直接上抛：通用层不能安全重放由旧 tags/collections 计算出的完整数组；
   * 需要 merge 的调用方必须重新读取条目、重新计算 patch 后再重试。
   */
  async updateItem(key: string, data: Record<string, unknown>, version: number): Promise<void> {
    validateKey(key);
    await this.writeRequest(`/items/${key}`, { method: "PATCH", body: JSON.stringify(data), version });
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
    return (await this.rawFetchResult<T>(base, path, init)).data;
  }

  /** 与 rawFetch 相同，但保留响应头供列表读取 Total-Results。 */
  private async rawFetchResult<T>(
    base: string,
    path: string,
    init: { params?: URLSearchParams | Record<string, string>; method?: string; body?: string } = {},
  ): Promise<{ data: T; headers: Headers }> {
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
      return { data: (await res.json()) as T, headers: res.headers };
    } catch {
      throw new ZoteroApiError(`Zotero 响应非 JSON（status ${res.status}）`);
    }
  }

  /**
   * 发送带 Local API 写授权的请求。
   * - 无 key 时先 authorize，不再用一次无授权请求探测。
   * - Allow key 在一次请求收到响应后立即清空；Always Allow key 保留复用。
   * - 401 明确表示请求未通过认证、未执行，因此包括 POST 在内可安全重授权重试一次。
   * - 428 清空 Server-ID/key 后重新初始化并重试一次。
   */
  private async authorizedWriteFetch(
    url: string,
    init: { method: string; body: string; headers?: Record<string, string>; timeoutMs?: number },
    authRetried = false,
    serverRetried = false,
  ): Promise<Response> {
    await this.ensureApiKey();
    if (!this.apiKey) await this.authorize("pi-zotero");
    const meta = await this.ensureServerMeta();
    const apiKey = this.apiKey;
    if (!apiKey) throw new ZoteroApiError("Zotero 未返回写授权 key");
    const singleUse = !this.apiKeyReusable;

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: {
          "User-Agent": this.userAgent,
          "Zotero-API-Version": "3",
          "Zotero-Server-ID": meta.serverId,
          "Zotero-Write-Token": randomToken(),
          "Zotero-API-Key": apiKey,
          ...init.headers,
        },
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err, init.timeoutMs ?? this.timeoutMs);
    }

    // 一次性 key 的生命周期以请求为单位；收到任意响应后均不再复用。
    if (singleUse) this.clearInMemoryApiKey();

    if (response.status === 428 && !serverRetried) {
      this.meta = null;
      this.clearInMemoryApiKey();
      this.clearStoredKey();
      return this.authorizedWriteFetch(url, init, authRetried, true);
    }
    if (response.status === 401 && !authRetried) {
      this.clearInMemoryApiKey();
      this.clearStoredKey();
      return this.authorizedWriteFetch(url, init, true, serverRetried);
    }
    return response;
  }

  /** 写请求：Server-ID + API-Key + Write-Token + 版本并发。 */
  private async writeRequest<T>(
    path: string,
    init: { method: string; body: string; version?: number },
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (init.version !== undefined) headers["If-Unmodified-Since-Version"] = String(init.version);
    const res = await this.authorizedWriteFetch(`${this.userPath()}${path}`, {
      method: init.method,
      headers,
      body: init.body,
    });

    if (res.status === 401) {
      throw new ZoteroApiError("Zotero 写授权失败（401）：授权被拒绝、吊销或无法复用。", 401);
    }
    if (res.status === 428) {
      throw new ZoteroApiError("Zotero 要求有效的 Server-ID（428），重新初始化后仍失败。", 428);
    }
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      throw new ZoteroApiError(`Zotero 请求限流（429）${retry ? `，Retry-After: ${retry}s` : ""}`, 429);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ZoteroApiError(`Zotero 写请求失败 ${res.status}: ${body.slice(0, 300)}`, res.status, body);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new ZoteroApiError(`Zotero 响应非 JSON（status ${res.status}）`);
    }
  }
}

/** Local API 实测返回 {"0": value}；兼容 Web API/测试中的数组形态。 */
function indexedWriteValues<T>(value: IndexedWriteValues<T> | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.keys(value)
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => value[key]);
}

/** 两遍上传的第一遍：流式计算 MD5，不把整个附件读入 Pi 进程内存。 */
async function fileMd5(filePath: string): Promise<string> {
  const hash = createHash("md5");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
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
  return randomBytes(16).toString("hex");
}
