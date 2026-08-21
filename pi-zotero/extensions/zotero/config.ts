/**
 * 配置加载与门控（~/.pi/agent/config/zotero.json + env 覆盖）。
 * 懒加载：首次工具调用时读取；配置修改后需 /reload 扩展生效。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomic } from "./atomic.ts";

export interface ZoteroWriteConfig {
  /** 总开关：false 时所有写 action 收敛（LLM 不可见） */
  enabled: boolean;
  /** 资源白名单：允许写动作的资源（"items" | "collections" | "searches"） */
  tools: string[];
  /** 独立高危总闸：delete 类动作（永久删除） */
  delete: boolean;
  /** true 时仅把用户选择 Always Allow 后返回的可复用 key 持久化；false 时重载即删除磁盘 key */
  rememberKey: boolean;
}

export interface ZoteroConfig {
  /** Local API 基址（http://127.0.0.1:23119/api） */
  baseUrl: string;
  timeoutMs: number;
  /** 缓存目录；null → <cwd>/.zotero-cache */
  cacheDir: string | null;
  /** 单次列表查询上限 */
  maxItems: number;
  write: ZoteroWriteConfig;
}

export const DEFAULT_CONFIG: ZoteroConfig = {
  baseUrl: "http://127.0.0.1:23119/api",
  timeoutMs: 15_000,
  cacheDir: null,
  maxItems: 5000,
  write: { enabled: false, tools: [], delete: false, rememberKey: true },  // 方案 C：允许持久化"始终允许"的授权 key（600 权限，跨会话 0 弹窗）
};

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "config", "zotero.json");

let cached: ZoteroConfig | null = null;

/** 首次加载时自动生成默认配置文件（不存在时） */
export function ensureConfigFile(): void {
  if (fs.existsSync(CONFIG_PATH)) return;
  const defaults = {
    _comment: "pi-zotero 配置。写操作默认全关；write.enabled=true 且 tools 含对应资源后才启用写工具。修改后 /reload 生效。",
    baseUrl: DEFAULT_CONFIG.baseUrl,
    timeoutMs: DEFAULT_CONFIG.timeoutMs,
    cacheDir: null,
    maxItems: DEFAULT_CONFIG.maxItems,
    write: DEFAULT_CONFIG.write,
  };
  writeJsonAtomic(CONFIG_PATH, defaults, { mode: 0o600 });
}

/** 保存配置（TUI 用） */
export function saveConfig(cfg: ZoteroConfig): void {
  const out = { ...cfg };
  writeJsonAtomic(CONFIG_PATH, out, { mode: 0o600 });
  cached = cfg;
}

/** 读取配置（env 覆盖文件；文件缺失/损坏 → 默认值） */
export function loadConfig(): ZoteroConfig {
  if (cached) return cached;
  const cfg: ZoteroConfig = { ...DEFAULT_CONFIG, write: { ...DEFAULT_CONFIG.write } };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<ZoteroConfig>;
      if (raw.baseUrl) cfg.baseUrl = raw.baseUrl;
      if (raw.timeoutMs) cfg.timeoutMs = raw.timeoutMs;
      if (raw.cacheDir) cfg.cacheDir = raw.cacheDir;
      if (raw.maxItems) cfg.maxItems = raw.maxItems;
      if (raw.write) {
        cfg.write = {
          ...DEFAULT_CONFIG.write,
          ...raw.write,
          tools: raw.write.tools ?? DEFAULT_CONFIG.write.tools,
        };
      }
    }
  } catch {
    // 配置损坏 → 默认值，不阻塞扩展
  }
  if (process.env.ZOTERO_BASE_URL) cfg.baseUrl = process.env.ZOTERO_BASE_URL;
  if (process.env.ZOTERO_TIMEOUT_MS) {
    const n = Number(process.env.ZOTERO_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) cfg.timeoutMs = n;
  }
  if (process.env.ZOTERO_CACHE_DIR) cfg.cacheDir = process.env.ZOTERO_CACHE_DIR;
  cached = cfg;
  return cfg;
}

/** 测试用：清缓存强制重读 */
export function resetConfigCache(): void {
  cached = null;
}

// ---------- 门控 ----------

export type ZoteroResource = "items" | "collections" | "searches";

/** 某资源的写动作是否可用（不含 delete） */
export function writeActionAllowed(cfg: ZoteroConfig, resource: ZoteroResource): boolean {
  return cfg.write.enabled && cfg.write.tools.includes(resource);
}

/** delete 动作是否可用（独立总闸，且资源白名单需含该资源） */
export function deleteActionAllowed(cfg: ZoteroConfig, resource: ZoteroResource): boolean {
  return writeActionAllowed(cfg, resource) && cfg.write.delete;
}

/** 配置变更需 /reload 的提示文案（门控在注册时固化） */
export const RELOAD_HINT = "（修改 zotero.json 后需 /reload 扩展生效）";
