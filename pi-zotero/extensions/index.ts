/**
 * pi-zotero 扩展入口。
 * 读层、引用产物和 DOCX 工具常驻；写 action 按 write.enabled/tools/delete 配置在注册时收敛。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import { ZoteroClient, ZoteroApiError, validateKey, type ZoteroItem } from "./zotero/client.ts";
import {
  JsonCache,
  cacheNamespace,
  cslCacheData,
  defaultCacheDir,
  emptyCslCache,
  isCslCacheState,
  type CslCacheState,
} from "./zotero/cache.ts";
import { loadConfig, saveConfig, ensureConfigFile, writeActionAllowed, deleteActionAllowed, RELOAD_HINT, type ZoteroConfig } from "./zotero/config.ts";
import { auditCitations, expandMarker, extractMarkers, normalizeMarker } from "./zotero/citation.ts";
import {
  extractReferenceEvidence,
  matchReferenceDetailed,
  type AmbiguousTitleMatch,
  type BibliographicCandidate,
  type MatchedReference,
} from "./zotero/build_map.ts";
import { writeZoteroDocxFields } from "./zotero/docx_fields.ts";
import { batchWriteText, runKeyBatch } from "./zotero/batch.ts";
import { writeFileAtomic, writeJsonAtomic } from "./zotero/atomic.ts";

/** 工具执行上下文中的 cwd（pi 工具 ctx 未暴露 cwd 时回退 process.cwd） */
function toolCwd(_ctx: unknown): string {
  return process.cwd();
}

function bibliographicCandidate(item: ZoteroItem): BibliographicCandidate {
  const creatorSummary = String(item.meta?.creatorSummary ?? "");
  const creators = creatorSummary || JSON.stringify(item.data.creators ?? []);
  return {
    key: item.key,
    title: String(item.data.title ?? ""),
    doi: String(item.data.DOI ?? ""),
    year: String(item.meta?.parsedDate ?? item.data.date ?? ""),
    creators,
  };
}

function summarizeMatchMethods(matches: MatchedReference[]): string {
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.matchMethod, (counts.get(match.matchMethod) ?? 0) + 1);
  return [...counts].map(([method, count]) => `${method}=${count}`).join(", ");
}

import { registerZoteroConfigCommand } from "./zotero/config-ui.ts";

export default function registerZoteroExtension(pi: ExtensionAPI): void {
  // 配置首次自动生成（不存在时写默认 + 说明）
  ensureConfigFile();
  registerZoteroConfigCommand(pi);
  // 客户端惰性创建（首次工具调用才初始化）
  let client: ZoteroClient | null = null;
  const getClient = (): ZoteroClient => {
    if (!client) {
      const cfg = loadConfig();
      client = new ZoteroClient({ apiBase: cfg.baseUrl, timeoutMs: cfg.timeoutMs, maxItems: cfg.maxItems, rememberKey: cfg.write.rememberKey });
    }
    return client;
  };

  const zoteroErr = (err: unknown): string =>
    err instanceof ZoteroApiError ? err.message : err instanceof Error ? err.message : String(err);
  const configuredCacheDir = (ctx: unknown): string =>
    defaultCacheDir(toolCwd(ctx), loadConfig().cacheDir);
  const serverCacheDir = async (c: ZoteroClient, ctx: unknown): Promise<string> => {
    const meta = await c.ensureServerMeta();
    return cacheNamespace(configuredCacheDir(ctx), meta.serverId, 0);
  };

  /** 对读-改-写字段做一次安全的 412 重算；禁止把旧数组直接套用到新 version。 */
  const updateItemWithFreshMerge = async (
    c: ZoteroClient,
    key: string,
    buildPatch: (item: Awaited<ReturnType<ZoteroClient["getItem"]>>) => Record<string, unknown>,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const item = await c.getItem(key);
      try {
        await c.updateItem(key, buildPatch(item), item.version);
        return;
      } catch (err) {
        if (!(err instanceof ZoteroApiError && err.status === 412 && attempt === 0)) throw err;
      }
    }
  };

  // ---------- zotero_search ----------
  pi.registerTool({
    name: "zotero_search",
    label: "Zotero 搜索",
    description:
      "搜索 Zotero 文献库（Zotero 10 FTS5，qmode=everything 含 PDF 全文索引）。" +
      "触发词：查文献、找文献、搜索 Zotero、这篇文献在库里吗。返回精简条目列表（key/title/年份/类型/作者）。",
    promptSnippet: "Search the Zotero library (metadata or full text)",
    parameters: Type.Object({
      q: Type.String({ description: "搜索词（支持引号短语，如 \"self-driving lab\"）" }),
      qmode: Type.Optional(
        Type.Union([Type.Literal("everything"), Type.Literal("titleCreatorYear")], {
          description: "everything=含附件全文（默认）；titleCreatorYear=仅标题/作者/年份",
        }),
      ),
      collectionKey: Type.Optional(Type.String({ description: "限定集合（本地过滤）" })),
      itemType: Type.Optional(Type.String({ description: "条目类型，如 journalArticle" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "默认 20" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const c = getClient();
        const result = params.collectionKey
          ? await c.searchCollectionWithMeta(params.collectionKey, params.q, {
              limit: params.limit ?? 20,
              qmode: params.qmode ?? "everything",
              itemType: params.itemType,
            })
          : await c.searchWithMeta(params.q, {
              limit: params.limit ?? 20,
              qmode: params.qmode ?? "everything",
              itemType: params.itemType,
            });
        const out = result.items.map((it) => ({
          key: it.key,
          title: String(it.data.title ?? "(无标题)").slice(0, 120),
          year: (it.meta?.parsedDate ?? "") as string,
          itemType: it.data.itemType,
          creators: String(it.meta?.creatorSummary ?? ""),
        }));
        return {
          content: [
            {
              type: "text",
              text: `命中 ${out.length} 条${result.truncated ? "（结果已截断）" : ""}${params.collectionKey ? `（集合 ${params.collectionKey}）` : ""}\n` +
                out.slice(0, 20).map((x) => `[${x.key}] ${x.title} (${x.itemType} ${x.year}) ${x.creators}`).join("\n"),
            },
          ],
          details: { count: out.length, total: result.total, sourceTotal: result.sourceTotal ?? result.total, truncated: result.truncated, items: out.slice(0, 20) },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_search 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_export_collection ----------
  pi.registerTool({
    name: "zotero_export_collection",
    label: "Zotero 集合导出",
    description:
      "导出集合内全部活动顶层条目为索引 JSON 写盘（默认排除回收站），并报告回收站中仍保留该集合关系的条目。" +
      "字段含 key/title/creators/date/doi/itemType/year。触发词：导出集合、集合索引、这个集合有哪些文献。",
    promptSnippet: "Export a Zotero collection index to a JSON file",
    parameters: Type.Object({
      collectionKey: Type.String({ description: "集合 key（zotero_collections list 可查）" }),
      output: Type.Optional(Type.String({ description: "输出路径；默认 <cacheDir>/<key>_index.json" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        validateKey(params.collectionKey, "collectionKey");
        const c = getClient();
        const [collectionResult, trashResult, meta] = await Promise.all([
          c.getCollectionItemsWithMeta(params.collectionKey),
          c.getCollectionTrashItemsWithMeta(params.collectionKey),
          c.ensureServerMeta(),
        ]);
        const items = collectionResult.items;
        const trashed = trashResult.items;
        const truncated = collectionResult.truncated || trashResult.truncated;
        const indexed = items.map((it) => ({
          key: it.key,
          title: String(it.data.title ?? ""),
          creators: String(it.meta?.creatorSummary ?? ""),
          date: String(it.data.date ?? ""),
          doi: String(it.data.DOI ?? ""),
          itemType: String(it.data.itemType ?? ""),
          year: String(it.meta?.parsedDate ?? ""),
        }));
        const outPath = params.output ?? path.join(await serverCacheDir(c, ctx), `${params.collectionKey}_index.json`);
        writeJsonAtomic(outPath, {
          generatedAt: new Date().toISOString(),
          serverId: meta.serverId,
          collectionKey: params.collectionKey,
          count: indexed.length,
          sourceTotal: collectionResult.sourceTotal ?? collectionResult.total,
          truncated,
          excludedTrashCount: trashed.length,
          trashSourceTotal: trashResult.sourceTotal ?? trashResult.total,
          excludedTrash: trashed.map((item) => ({ key: item.key, title: String(item.data.title ?? "") })),
          items: indexed,
        });
        return {
          content: [
            {
              type: "text",
              text: `已导出 ${indexed.length} 条活动文献 → ${outPath}` +
                (truncated ? `\n⚠ 原始端点结果已截断（集合源总数 ${collectionResult.sourceTotal ?? collectionResult.total}，回收站源总数 ${trashResult.sourceTotal ?? trashResult.total}），产物可能不完整` : "") +
                (trashed.length ? `\n另有 ${trashed.length} 条在回收站（未导出）: ${trashed.map((item) => item.key).join(", ")}` : "\n回收站排除项: 0") +
                `\n` + indexed.slice(0, 10).map((x) => `[${x.key}] ${x.title.slice(0, 60)} (${x.year})`).join("\n") +
                (indexed.length > 10 ? `\n… 共 ${indexed.length} 条` : ""),
            },
          ],
          details: {
            path: outPath,
            count: indexed.length,
            sourceTotal: collectionResult.sourceTotal ?? collectionResult.total,
            truncated,
            excludedTrashCount: trashed.length,
            excludedTrash: trashed.map((item) => item.key),
            preview: indexed.slice(0, 10),
          },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_export_collection 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_batch_csl ----------
  pi.registerTool({
    name: "zotero_batch_csl",
    label: "Zotero CSL 批量",
    description:
      "批量获取条目 CSL JSON 并缓存到本地文件（按 Server-ID 隔离并对比 item version 自动更新；refresh 强制重拉）。" +
      "用于引用审计/文献表渲染的数据准备。触发词：取 CSL、缓存文献数据。",
    promptSnippet: "Batch-fetch Zotero CSL JSON into a local cache",
    parameters: Type.Object({
      keys: Type.Optional(Type.Array(Type.String(), { description: "条目 keys（与 collectionKey 二选一）" })),
      collectionKey: Type.Optional(Type.String({ description: "集合 key（取集合全部顶层条目）" })),
      cachePath: Type.Optional(Type.String({ description: "缓存文件路径；默认 <cacheDir>/<Server-ID>-0/csl.json" })),
      refresh: Type.Optional(Type.Boolean({ description: "强制重拉（默认 false 增量）" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const c = getClient();
        let keys: string[];
        if (params.collectionKey) {
          validateKey(params.collectionKey, "collectionKey");  // 已判空
          keys = await c.getCollectionKeys(params.collectionKey);
        } else if (params.keys?.length) {
          keys = params.keys;
        } else {
          return { content: [{ type: "text", text: "需提供 keys 或 collectionKey" }], details: {} };
        }
        keys = [...new Set(keys)];
        const meta = await c.ensureServerMeta();
        const cachePath = params.cachePath ?? path.join(await serverCacheDir(c, ctx), "csl.json");
        const cache = new JsonCache<unknown>(cachePath);
        const loaded = cache.load();
        const state: CslCacheState = isCslCacheState(loaded) && loaded.serverId === meta.serverId
          ? loaded
          : emptyCslCache(meta.serverId);
        const versions = await c.getItemVersions(keys);
        const missingVersions = keys.filter((key) => versions[key] === undefined);
        if (missingVersions.length > 0) {
          throw new ZoteroApiError(`以下条目不存在或无法读取 version: ${missingVersions.join(", ")}`);
        }
        const missing = params.refresh
          ? keys
          : keys.filter((key) => !state.items[key] || state.items[key].version !== versions[key]);
        const fetched = await c.getCSLBatch(missing);
        const unfetched = missing.filter((key) => !fetched[key]);
        if (unfetched.length > 0) {
          throw new ZoteroApiError(`以下条目 CSL 获取失败，缓存未写入: ${unfetched.join(", ")}`);
        }
        for (const [key, data] of Object.entries(fetched)) {
          state.items[key] = { version: versions[key], data };
        }
        new JsonCache<CslCacheState>(cachePath).save(state);
        return {
          content: [
            {
              type: "text",
              text: `CSL 缓存: 有效 ${keys.length - missing.length} 条，更新 ${missing.length} 条 → ${cachePath}`,
            },
          ],
          details: { cachePath, serverId: meta.serverId, cached: keys.length - missing.length, fetched: missing.length },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_batch_csl 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_audit_citations ----------
  pi.registerTool({
    name: "zotero_audit_citations",
    label: "Zotero 引用审计",
    description:
      "核验正文引用标记（<sup>[n]</sup>/§CITE[n]§/裸[n]）与引用映射的一致性：" +
      "序列错位/缺失/未引用/乱序（出现序 vs 编号序），生成审计工作簿写盘。" +
      "mapPath 支持 citation map（{markers:[{marker,keys}]}，提供期望序列）或 number map（{ref#:key}）。" +
      "触发词：审计引用、核验参考文献、引用检查。",
    promptSnippet: "Audit citation markers in a manuscript against a Zotero map",
    parameters: Type.Object({
      manuscriptPath: Type.Optional(Type.String({ description: "正文 md 路径（与 text 二选一）" })),
      text: Type.Optional(Type.String({ description: "正文文本（与 manuscriptPath 二选一）" })),
      mapPath: Type.Optional(Type.String({ description: "映射 JSON 路径（citation map 或 number map）" })),
      cslCachePath: Type.Optional(Type.String({ description: "CSL 缓存路径（渲染文献条目用）" })),
      output: Type.Optional(Type.String({ description: "报告输出路径；默认 <cacheDir>/citation_audit.md" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const text = params.text ?? (params.manuscriptPath ? fs.readFileSync(params.manuscriptPath, "utf-8") : null);
        if (!text) return { content: [{ type: "text", text: "需提供 manuscriptPath 或 text" }], details: {} };
        let numberMap: Record<string, string> | undefined;
        let expected: string[] | undefined;
        if (params.mapPath) {
          const map = JSON.parse(fs.readFileSync(params.mapPath, "utf-8")) as Record<string, unknown>;
          // 兼容三种格式：citation map（markers 数组）/ {ref_to_key:{}} / 纯 number map
          let inner: Record<string, unknown> | null = null;
          if (Array.isArray(map.markers)) {
            const markers = map.markers as { marker: string; keys: string[] }[];
            expected = markers.map((m) => m.marker);
            const nm: Record<string, string> = {};
            for (const m of markers) {
              // marker 展开顺序与 keys 一一对应：[1-2] → refs [1,2] → keys [k1,k2]
              const refs = expandMarker(m.marker);
              if (!Array.isArray(m.keys) || refs.length !== m.keys.length) {
                throw new ZoteroApiError(`citation map 中 ${m.marker} 展开为 ${refs.length} 项，但 keys 有 ${Array.isArray(m.keys) ? m.keys.length : 0} 项`);
              }
              refs.forEach((r, i) => {
                const k = m.keys[i];
                if (k) nm[String(r)] = k;
              });
            }
            numberMap = nm;
          } else if (map.ref_to_key && typeof map.ref_to_key === "object") {
            inner = map.ref_to_key as Record<string, unknown>;
          }
          if (inner) {
            numberMap = {};
            for (const [k, v] of Object.entries(inner)) {
              if (typeof v === "string") numberMap[k] = v;
            }
          }
        }
        let csls: Record<string, Record<string, unknown>> | undefined;
        if (params.cslCachePath) {
          const cached = new JsonCache<unknown>(params.cslCachePath).load();
          if (!isCslCacheState(cached)) {
            throw new ZoteroApiError("CSL 缓存格式过旧或损坏，请用 zotero_batch_csl 重新生成");
          }
          const meta = await getClient().ensureServerMeta();
          if (cached.serverId !== meta.serverId) {
            throw new ZoteroApiError(`CSL 缓存属于其他 Zotero 数据库（${cached.serverId} ≠ ${meta.serverId}）`);
          }
          csls = cslCacheData(cached);
        }
        const res = auditCitations({ text, numberMap, expectedMarkers: expected, csls });
        const outPath = params.output ?? path.join(configuredCacheDir(ctx), "citation_audit.md");
        writeFileAtomic(outPath, res.report);
        const summary =
          `标记 ${res.totalMarkers} | 唯一编号 ${res.uniqueRefs.length} | 映射 ${res.refCount} | ` +
          `错位 ${res.mismatches.length} | 缺失 ${res.missing.length} | 未引用 ${res.unused.length} | 乱序 ${res.outOfOrder.length}\n` +
          `报告: ${outPath}`;
        return {
          content: [{ type: "text", text: summary + (res.issues.length ? `\n问题 ${res.issues.length} 项，详见报告。` : "\n无问题。") }],
          details: {
            totalMarkers: res.totalMarkers,
            mismatches: res.mismatches,
            missing: res.missing,
            unused: res.unused,
            outOfOrder: res.outOfOrder,
            path: outPath,
          },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_audit_citations 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_fulltext ----------
  pi.registerTool({
    name: "zotero_fulltext",
    label: "Zotero 全文",
    description:
      "获取条目的全文索引内容（Zotero 10 FTS5 索引文本，含页码标记）。" +
      "注意：内容将进入 LLM 上下文（发送至云端模型），默认只返回前 2000 字，full=true 才返回全文。" +
      "无全文索引时返回提示。触发词：全文内容、这篇文章讲了什么、PDF 内容。",
    promptSnippet: "Read indexed full text of a Zotero item (truncated by default)",
    parameters: Type.Object({
      key: Type.String({ description: "条目 key" }),
      full: Type.Optional(Type.Boolean({ description: "true 返回全文（大），默认 false 截断 2000 字" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        const ft = await c.getFulltext(params.key);
        const truncated = !params.full && ft.content.length > 2000;
        const text = truncated ? ft.content.slice(0, 2000) + `\n…[已截断，共 ${ft.content.length} 字，需全文请加 full=true]` : ft.content;
        return {
          content: [{ type: "text", text: `[${params.key}] 全文 ${ft.content.length} 字（${ft.totalPages} 页）\n${text}` }],
          details: { key: params.key, length: ft.content.length, totalPages: ft.totalPages, truncated },
        };
      } catch (err) {
        const msg = zoteroErr(err);
        return {
          content: [{ type: "text", text: msg.includes("404") ? `条目 ${params.key} 无全文索引（无附件或未索引）` : `zotero_fulltext 失败: ${msg}` }],
          details: {},
        };
      }
    },
  });

  // ---------- zotero_attachment_path ----------
  pi.registerTool({
    name: "zotero_attachment_path",
    label: "Zotero 附件路径",
    description:
      "获取条目 PDF/附件在磁盘的路径（已转换为 WSL 可读路径，如 /mnt/d/...），可配合 read/pdf 工具直接阅读。" +
      "注意：路径会暴露本地目录结构。触发词：PDF 在哪、附件路径、读这篇 PDF。",
    promptSnippet: "Get the local disk path of a Zotero attachment (WSL-friendly)",
    parameters: Type.Object({
      key: Type.String({ description: "附件条目 key（zotero_items children 可查附件）" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        const p = await c.getAttachmentPath(params.key);
        return { content: [{ type: "text", text: p }], details: { key: params.key, path: p } };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_attachment_path 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_saved_searches ----------
  pi.registerTool({
    name: "zotero_saved_searches",
    label: "Zotero 保存搜索",
    description:
      "列出保存的搜索（list）或执行某个保存搜索（execute，返回匹配条目）。" +
      "触发词：保存的搜索、执行筛选、saved search。",
    promptSnippet: "List or execute Zotero saved searches",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("execute")], { description: "list=列表；execute=执行" }),
      searchKey: Type.Optional(Type.String({ description: "execute 时必填" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "execute 返回上限，默认 20" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        if (params.action === "list") {
          const s = await c.getSearches();
          return {
            content: [{ type: "text", text: `共 ${s.length} 个保存搜索\n` + s.map((x: any) => `[${x.key}] ${x.data?.name ?? ""}`).join("\n") }],
            details: { count: s.length, searches: s },
          };
        }
        validateKey(params.searchKey ?? "", "searchKey");
        const items = await c.getSearchItems(params.searchKey ?? "", { limit: params.limit ?? 20 });
        return {
          content: [{
            type: "text",
            text: `命中 ${items.length} 条\n` +
              items.map((it) => `[${it.key}] ${String(it.data.title ?? "").slice(0, 80)}`).join("\n"),
          }],
          details: { count: items.length, items },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_saved_searches 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_duplicates_scan ----------
  pi.registerTool({
    name: "zotero_duplicates_scan",
    label: "Zotero 疑似重复",
    description:
      "扫描集合（或全库）内疑似重复条目：标题归一化（去标点/大小写/空白）后精确匹配分组。" +
      "只标记不删除。触发词：重复文献、查重、重复条目。",
    promptSnippet: "Scan a Zotero collection for likely duplicate items",
    parameters: Type.Object({
      collectionKey: Type.Optional(Type.String({ description: "限定集合；缺省扫全库（较慢）" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "扫描条目上限，默认 1000；达到上限会报告 truncated" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        const result = params.collectionKey
          ? await c.getCollectionItemsWithMeta(params.collectionKey)
          : await c.getItemsWithMeta({ limit: params.limit ?? 1000 });
        const items = result.items;
        const groups = new Map<string, { key: string; title: string }[]>();
        for (const it of items) {
          const title = String(it.data.title ?? "");
          if (!title) continue;
          const norm = normalizeTitle(title);
          if (!norm) continue;
          groups.set(norm, [...(groups.get(norm) ?? []), { key: it.key, title: title.slice(0, 100) }]);
        }
        const dups = [...groups.values()].filter((g) => g.length > 1);
        return {
          content: [{
            type: "text",
            text: `扫描 ${items.length}/${result.total} 条${result.truncated ? "（已截断，结论可能不完整）" : ""}，疑似重复组 ${dups.length} 组\n` +
              dups.slice(0, 10).map((g) => g.map((x) => `[${x.key}] ${x.title}`).join("  ║  ")).join("\n") +
              (dups.length > 10 ? `\n… 共 ${dups.length} 组` : ""),
          }],
          details: { scanned: items.length, total: result.total, truncated: result.truncated, groups: dups.length, duplicates: dups.slice(0, 20) },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_duplicates_scan 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ========== 写层（v0.2，门控 action 枚举收敛） ==========
  const cfg = loadConfig();
  const canWriteItems = writeActionAllowed(cfg, "items");
  const canWriteCollections = writeActionAllowed(cfg, "collections");
  const canWriteSearches = writeActionAllowed(cfg, "searches");
  const canDeleteItems = deleteActionAllowed(cfg, "items");
  const canDeleteCollections = deleteActionAllowed(cfg, "collections");
  const canDeleteSearches = deleteActionAllowed(cfg, "searches");
  // 全局删除标签会改写所有条目，必须同时通过 items 写白名单和 delete 总闸。
  const canDeleteTags = canDeleteItems;
  const writeHint = "（写操作会修改 Zotero 库，调用前需用户确认）";

  /** 按门控构建 action 枚举（未启用时 LLM 在 schema 层不可见） */
  const actionsOf = (base: string[], extra: string[], enabled: boolean, del: boolean): string[] =>
    enabled ? [...base, ...extra, ...(del ? ["delete"] : [])] : base;

  // ---------- zotero_items（children/trash-list 常驻 + 写动作门控） ----------
  const itemActions = actionsOf(["children", "trash-list"], ["add", "update", "tag", "note", "move", "trash", "restore", "upload"], canWriteItems, canDeleteItems);
  pi.registerTool({
    name: "zotero_items",
    label: "Zotero 条目",
    description:
      `Zotero 条目操作。children=查条目子项；trash-list=列出回收站条目（可按 collectionKey 过滤），均常驻；` +
      (canWriteItems ? `add=创建条目/笔记、update=改元数据（title/DOI/date/extra/url）、tag=增删标签、note=更新笔记、move=集合归属、trash=移入回收站、restore=从回收站恢复、upload=附件文件上传（需先有 attachment 条目）；${writeHint}` : `写动作未启用（配置 write.enabled+write.tools 含 items 后 /reload）`) +
      (canDeleteItems ? `；delete=彻底删除（受 write.delete）` : ""),
    promptSnippet: "Query or modify Zotero items (gated writes)",
    parameters: Type.Object({
      action: Type.Union(itemActions.map((a) => Type.Literal(a)) as [never], { description: "操作类型" }),
      key: Type.Optional(Type.String({ description: "children/upload 必填：条目 key" })),
      keys: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "tag/move/trash/restore/delete 必填，至少 1 个" })),
      collectionKey: Type.Optional(Type.String({ description: "trash-list 可选：仅列出仍保留此集合关系的回收站条目" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "trash-list 返回上限，默认 100" })),
      items: Type.Optional(Type.Array(Type.Object({
        itemType: Type.String(),
        title: Type.String(),
        creators: Type.Optional(Type.Array(Type.Object({
          creatorType: Type.String(), firstName: Type.Optional(Type.String()), lastName: Type.String(),
        }))),
        DOI: Type.Optional(Type.String()),
        parentItem: Type.Optional(Type.String({ description: "add 笔记时必填" })),
        note: Type.Optional(Type.String({ description: "add 笔记时必填" })),
      }), { minItems: 1, description: "add 必填，至少 1 条" })),
      fields: Type.Optional(Type.Object({
        title: Type.Optional(Type.String()),
        DOI: Type.Optional(Type.String()),
        date: Type.Optional(Type.String()),
        extra: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
      }, { additionalProperties: false, description: "update 必填：仅允许 title/DOI/date/extra/url" })),
      tags: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "tag 必填，至少 1 个" })),
      mode: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace"), Type.Literal("remove")], { description: "tag 模式，默认 append" })),
      parentKey: Type.Optional(Type.String({ description: "note 必填：父条目 key" })),
      noteKey: Type.Optional(Type.String({ description: "note 可选：笔记自身 key（缺省用父条目首条笔记）" })),
      content: Type.Optional(Type.String({ description: "note 必填：新笔记内容" })),
      addCollections: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "move：加入的集合" })),
      removeCollections: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "move：移出的集合" })),
      version: Type.Optional(Type.Integer({ description: "update 可选：条目当前 version（缺省自动读取）" })),
      filePath: Type.Optional(Type.String({ description: "upload 必填：本地文件路径（WSL 路径）" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        // ---------- 常驻：children / trash-list ----------
        if (params.action === "children") {
          validateKey(params.key ?? "", "key");
          const ch = await c.getChildren(params.key ?? "");
          return {
            content: [{ type: "text", text: `子项 ${ch.length} 个\n` + ch.map((x) => `[${x.key}] ${x.data.itemType} ${String(x.data.title ?? "").slice(0, 60)}`).join("\n") }],
            details: { count: ch.length, children: ch },
          };
        }
        if (params.action === "trash-list") {
          const limit = params.limit ?? 100;
          const result = params.collectionKey
            ? await c.getCollectionTrashItemsWithMeta(params.collectionKey)
            : await c.getTrashItemsWithMeta({ limit });
          const trash = result.items.slice(0, limit);
          const truncated = result.truncated || result.items.length > limit;
          return {
            content: [{
              type: "text",
              text: `回收站返回 ${trash.length} 条${truncated ? "（已截断）" : ""}${params.collectionKey ? `（仍关联集合 ${params.collectionKey}）` : ` / 源总数 ${result.total}`}\n` +
                trash.map((item) => `[${item.key}] ${String(item.data.title ?? "").slice(0, 80)}`).join("\n"),
            }],
            details: { count: trash.length, total: result.total, sourceTotal: result.sourceTotal ?? result.total, truncated, items: trash },
          };
        }
        // ---------- 门控检查（双保险） ----------
        if (!canWriteItems) {
          return { content: [{ type: "text", text: `写操作未启用：配置 write.enabled=true 且 write.tools 含 "items" 后 /reload${RELOAD_HINT}` }], details: {} };
        }
        if (params.action === "delete" && !canDeleteItems) {
          return { content: [{ type: "text", text: "delete 未启用：需 write.delete=true" }], details: {} };
        }
        if (params.action === "delete") {
          const keys = params.keys ?? [];
          if (!keys.length) return { content: [{ type: "text", text: "delete 需提供非空 keys" }], details: {} };
          const result = await runKeyBatch(keys, (key) => c.deleteItem(key));
          return { content: [{ type: "text", text: batchWriteText("彻底删除", result) }], details: result };
        }
        if (params.action === "trash") {
          const keys = params.keys ?? [];
          if (!keys.length) return { content: [{ type: "text", text: "trash 需提供非空 keys" }], details: {} };
          const result = await runKeyBatch(keys, (key) => c.trashItem(key));
          return { content: [{ type: "text", text: batchWriteText("移入回收站", result) }], details: result };
        }
        if (params.action === "restore") {
          const keys = params.keys ?? [];
          if (!keys.length) return { content: [{ type: "text", text: "restore 需提供非空 keys" }], details: {} };
          const result = await runKeyBatch(keys, (key) => c.restoreItem(key));
          const restored = result.succeeded.filter((entry) => entry.value).map((entry) => entry.key);
          const alreadyActive = result.succeeded.filter((entry) => !entry.value).map((entry) => entry.key);
          return {
            content: [{ type: "text", text: batchWriteText("回收站恢复", result) + (alreadyActive.length ? `\n原本已活动: ${alreadyActive.join(", ")}` : "") }],
            details: { ...result, restored, alreadyActive },
          };
        }
        if (params.action === "add") {
          const items = params.items ?? [];
          if (!items.length) return { content: [{ type: "text", text: "add 需提供非空 items" }], details: {} };
          const creation = await c.createItems(items);
          return {
            content: [{
              type: "text",
              text: `创建成功 ${creation.successful.length} 条，失败 ${creation.failed.length} 条` +
                (creation.successful.length ? `\n成功 keys: ${creation.successful.map((entry) => entry.key).join(", ")}` : "") +
                (creation.failed.length ? `\n失败: ${JSON.stringify(creation.failed).slice(0, 500)}` : ""),
            }],
            details: creation,
          };
        }
        if (params.action === "update") {
          validateKey(params.key ?? "", "key");
          const fields = params.fields as Record<string, unknown> | undefined;
          if (!fields || Object.keys(fields).length === 0) return { content: [{ type: "text", text: "update 需提供至少一个 fields 字段" }], details: {} };
          const whitelist = ["title", "DOI", "date", "extra", "url"];
          const bad = Object.keys(fields).filter((k) => !whitelist.includes(k));
          if (bad.length) return { content: [{ type: "text", text: `字段不在白名单: ${bad.join(", ")}（允许: ${whitelist.join("/")}）` }], details: {} };
          let v = params.version;
          if (v === undefined) {
            const it = await c.getItem(params.key ?? "");
            v = it.version;
          }
          await c.updateItem(params.key ?? "", fields, v ?? 0);
          return { content: [{ type: "text", text: `已更新 [${params.key}]` }], details: { key: params.key } };
        }
        if (params.action === "tag") {
          const keys = params.keys ?? [];
          const tags = params.tags ?? [];
          if (!keys.length || !tags.length) return { content: [{ type: "text", text: "tag 需提供非空 keys 和 tags" }], details: {} };
          const mode = params.mode ?? "append";
          const result = await runKeyBatch(keys, (key) => updateItemWithFreshMerge(c, key, (item) => {
            const current = (item.data.tags as { tag: string; type?: number }[] | undefined) ?? [];
            let next: { tag: string; type: number }[];
            if (mode === "replace") next = tags.map((tag) => ({ tag, type: 1 }));
            else if (mode === "remove") next = current.filter((entry) => !tags.includes(entry.tag)).map((entry) => ({ tag: entry.tag, type: entry.type ?? 0 }));
            else {
              const existing = new Set(current.map((entry) => entry.tag));
              next = current.map((entry) => ({ tag: entry.tag, type: entry.type ?? 0 }));
              for (const tag of tags) if (!existing.has(tag)) next.push({ tag, type: 1 });
            }
            return { tags: next };
          }));
          return { content: [{ type: "text", text: batchWriteText(`${mode} 标签 ${tags.join(",")}`, result) }], details: { ...result, tags, mode } };
        }
        if (params.action === "note") {
          validateKey(params.parentKey ?? "", "parentKey");
          let noteKey = params.noteKey;
          if (!noteKey) {
            const ch = await c.getChildren(params.parentKey ?? "");
            noteKey = ch.find((x) => x.data.itemType === "note")?.key;
            if (!noteKey) return { content: [{ type: "text", text: "父条目无笔记，请用 add（itemType=note）创建" }], details: {} };
          }
          const it = await c.getItem(noteKey);
          await c.updateItem(noteKey, { note: params.content ?? "" }, it.version);
          return { content: [{ type: "text", text: `已更新笔记 [${noteKey}]（父 ${params.parentKey}）` }], details: { noteKey } };
        }
        if (params.action === "move") {
          const keys = params.keys ?? [];
          const addCollections = params.addCollections ?? [];
          const removeCollections = params.removeCollections ?? [];
          if (!keys.length || (!addCollections.length && !removeCollections.length)) {
            return { content: [{ type: "text", text: "move 需提供非空 keys，并至少提供 addCollections/removeCollections 之一" }], details: {} };
          }
          for (const collectionKey of [...addCollections, ...removeCollections]) validateKey(collectionKey, "collectionKey");
          const result = await runKeyBatch(keys, (key) => updateItemWithFreshMerge(c, key, (item) => {
            const next = new Set(item.data.collections ?? []);
            for (const collectionKey of addCollections) next.add(collectionKey);
            for (const collectionKey of removeCollections) next.delete(collectionKey);
            return { collections: [...next] };
          }));
          return { content: [{ type: "text", text: batchWriteText("调整集合归属", result) }], details: { ...result, addCollections, removeCollections } };
        }
        if (params.action === "upload") {
          validateKey(params.key ?? "", "key");
          if (!params.filePath) return { content: [{ type: "text", text: "upload 需提供 filePath" }], details: {} };
          const k = params.key ?? "";
          const { exists } = await c.uploadFile(k, params.filePath);
          return { content: [{ type: "text", text: exists ? "附件文件已存在（跳过上传）" : `已上传 → [${params.key}]` }], details: { key: params.key, exists } };
        }
        return { content: [{ type: "text", text: `未知 action: ${params.action}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_items 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_collections 写动作（门控） ----------
  const collActions = actionsOf(["list", "get"], ["create", "update"], canWriteCollections, canDeleteCollections);
  pi.registerTool({
    name: "zotero_collections",
    label: "Zotero 集合",
    description:
      `集合操作。list/get 常驻；` +
      (canWriteCollections ? `create=新建、update=重命名/换父（parentKey=false 置顶）${writeHint}；` : `写动作未启用（write.tools 含 collections 后 /reload）；`) +
      (canDeleteCollections ? `delete=删除集合（永久，无回收站，子集合一并删）` : `delete 未启用（write.delete）`),
    promptSnippet: "List, inspect or modify Zotero collections (gated writes)",
    parameters: Type.Object({
      action: Type.Union(collActions.map((a) => Type.Literal(a)) as [never], { description: "操作类型" }),
      collectionKey: Type.Optional(Type.String({ description: "get/update/delete 必填" })),
      name: Type.Optional(Type.String({ description: "create 必填；update 可选（newName 或本字段）" })),
      parentKey: Type.Optional(Type.Union([Type.String(), Type.Literal(false)], { description: "create/update 可选：集合 key；传 false 置顶" })),
      newName: Type.Optional(Type.String({ description: "update：新名称" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        if (params.action === "list") {
          const cols = await c.getCollections({ limit: 100 });
          const byParent = new Map<string | false, typeof cols>();
          for (const col of cols) byParent.set(col.data.parentCollection ?? false, [...(byParent.get(col.data.parentCollection ?? false) ?? []), col]);
          const lines: string[] = [];
          const walk = (parent: string | false, depth: number) => {
            for (const col of byParent.get(parent) ?? []) {
              lines.push(`${"  ".repeat(depth)}[${col.key}] ${col.data.name}`);
              walk(col.key, depth + 1);
            }
          };
          walk(false, 0);
          return { content: [{ type: "text", text: `共 ${cols.length} 个集合\n${lines.join("\n")}` }], details: { count: cols.length } };
        }
        if (params.action === "get") {
          validateKey(params.collectionKey ?? "", "collectionKey");
          const d = await c.getCollection(params.collectionKey ?? "");
          return { content: [{ type: "text", text: `[${d.key}] ${d.data.name} (父: ${d.data.parentCollection ?? "无"})` }], details: { collection: d } };
        }
        if (!canWriteCollections) {
          return { content: [{ type: "text", text: `写操作未启用：配置 write.tools 含 "collections" 后 /reload${RELOAD_HINT}` }], details: {} };
        }
        if (params.action === "delete" && !canDeleteCollections) {
          return { content: [{ type: "text", text: "delete 未启用：需 write.delete=true" }], details: {} };
        }
        if (params.action === "create") {
          if (!params.name) return { content: [{ type: "text", text: "create 需提供 name" }], details: {} };
          const created = await c.createCollection(params.name, params.parentKey === undefined ? undefined : params.parentKey || false);
          return { content: [{ type: "text", text: `已创建集合 [${created.key}] ${params.name}` }], details: { key: created.key } };
        }
        if (params.action === "update") {
          validateKey(params.collectionKey ?? "", "collectionKey");
          const it = await c.getCollection(params.collectionKey ?? "");
          const data: Record<string, unknown> = {};
          if (params.newName) data.name = params.newName;
          if (params.parentKey !== undefined) data.parentCollection = params.parentKey || false;
          await c.updateCollection(params.collectionKey ?? "", data, it.version);
          return { content: [{ type: "text", text: `已更新集合 [${params.collectionKey}]` }], details: { key: params.collectionKey } };
        }
        if (params.action === "delete") {
          validateKey(params.collectionKey ?? "", "collectionKey");
          await c.deleteCollection(params.collectionKey ?? "");
          return { content: [{ type: "text", text: `已删除集合 [${params.collectionKey}]（永久）` }], details: { key: params.collectionKey } };
        }
        return { content: [{ type: "text", text: `未知 action: ${params.action}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_collections 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_searches 写（list/execute 常驻 + 写门控） ----------
  const searchActions = actionsOf(["list", "execute"], ["create", "update"], canWriteSearches, canDeleteSearches);
  pi.registerTool({
    name: "zotero_searches",
    label: "Zotero 保存搜索管理",
    description:
      `保存搜索管理。list/execute 常驻；` +
      (canWriteSearches ? `create=新建（conditions 用 Zotero 10 条件 JSON）、update=修改${writeHint}；` : `写动作未启用（write.tools 含 searches 后 /reload）；`) +
      (canDeleteSearches ? `delete=删除` : `delete 未启用（write.delete）`),
    promptSnippet: "List, execute or manage Zotero saved searches (gated writes)",
    parameters: Type.Object({
      action: Type.Union(searchActions.map((a) => Type.Literal(a)) as [never], { description: "操作类型" }),
      searchKey: Type.Optional(Type.String({ description: "execute/update/delete 必填" })),
      name: Type.Optional(Type.String({ description: "create/update 必填" })),
      conditions: Type.Optional(Type.Array(Type.Object({
        condition: Type.String(), operator: Type.String(), value: Type.String(),
      }), { description: "create/update 必填：条件 JSON（老格式兼容）" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        if (params.action === "list") {
          const s = await c.getSearches();
          return { content: [{ type: "text", text: `共 ${s.length} 个保存搜索\n` + s.map((x) => `[${x.key}] ${x.data?.name ?? ""}`).join("\n") }], details: { count: s.length } };
        }
        if (params.action === "execute") {
          validateKey(params.searchKey ?? "", "searchKey");
          const items = await c.getSearchItems(params.searchKey ?? "", { limit: params.limit ?? 20 });
          return { content: [{ type: "text", text: `命中 ${items.length} 条\n` + items.map((it) => `[${it.key}] ${String(it.data.title ?? "").slice(0, 80)}`).join("\n") }], details: { count: items.length } };
        }
        if (!canWriteSearches) {
          return { content: [{ type: "text", text: `写操作未启用：配置 write.tools 含 "searches" 后 /reload${RELOAD_HINT}` }], details: {} };
        }
        if (params.action === "delete" && !canDeleteSearches) {
          return { content: [{ type: "text", text: "delete 未启用：需 write.delete=true" }], details: {} };
        }
        if (params.action === "create") {
          if (!params.name || !params.conditions) return { content: [{ type: "text", text: "create 需 name + conditions" }], details: {} };
          const created = await c.createSearch(params.name, params.conditions as never);
          return { content: [{ type: "text", text: `已创建保存搜索 [${created.key}] ${params.name}` }], details: { key: created.key } };
        }
        if (params.action === "update") {
          validateKey(params.searchKey ?? "", "searchKey");
          const s = await c.getSearch(params.searchKey ?? "");
          const data: Record<string, unknown> = {};
          if (params.name) data.name = params.name;
          if (params.conditions) data.conditions = params.conditions;
          await c.updateSearch(params.searchKey ?? "", data, s.version);
          return { content: [{ type: "text", text: `已更新保存搜索 [${params.searchKey}]` }], details: { key: params.searchKey } };
        }
        if (params.action === "delete") {
          validateKey(params.searchKey ?? "", "searchKey");
          await c.deleteSearch(params.searchKey ?? "");
          return { content: [{ type: "text", text: `已删除保存搜索 [${params.searchKey}]` }], details: { key: params.searchKey } };
        }
        return { content: [{ type: "text", text: `未知 action: ${params.action}` }], details: {} };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_searches 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_build_map ----------
  pi.registerTool({
    name: "zotero_build_map",
    label: "Zotero 引用映射构建",
    description:
      "从正文（引用标记序列 + 文献表区 [n] 行）自动构建 cite_map.json：" +
      "按 DOI → 标题+年份/作者 → 标题分级匹配（集合优先、全库 fallback；同分候选进入 ambiguous）并记录 matchMethod/confidence → markers:[{marker,keys}]。" +
      "产物可直接被 zotero_audit_citations 消费。触发词：构建引用映射、生成 cite_map、文献匹配。",
    promptSnippet: "Build a citation map (marker→Zotero keys) from a manuscript",
    parameters: Type.Object({
      manuscriptPath: Type.Optional(Type.String({ description: "正文 md 路径（与 text 二选一）" })),
      text: Type.Optional(Type.String({ description: "正文文本" })),
      collectionKey: Type.Optional(Type.String({ description: "优先匹配的集合（缺省全库）" })),
      fullLibraryFallback: Type.Optional(Type.Boolean({ description: "集合未匹配时全库匹配，默认 true" })),
      output: Type.Optional(Type.String({ description: "cite_map 输出路径；默认 <cacheDir>/<Server-ID>-0/cite_map.json" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const text = params.text ?? (params.manuscriptPath ? fs.readFileSync(params.manuscriptPath, "utf-8") : null);
        if (!text) return { content: [{ type: "text", text: "需提供 manuscriptPath 或 text" }], details: {} };
        const c = getClient();
        // 元数据池：集合优先；没有唯一结果时再回退全库。
        const pool: BibliographicCandidate[] = [];
        let collectionTruncated = false;
        if (params.collectionKey) {
          const collectionResult = await c.getCollectionItemsWithMeta(params.collectionKey);
          pool.push(...collectionResult.items.map(bibliographicCandidate));
          collectionTruncated = collectionResult.truncated;
        }
        const refLines = new Map<string, string>();
        const lines = text.split("\n");
        const refIdx = lines.findIndex((line) => /^#{1,6}\s*参考文献/.test(line.trim()));
        if (refIdx !== -1) {
          for (let index = refIdx + 1; index < lines.length; index += 1) {
            const match = lines[index].match(/^\[\s*(\d+)\s*\]\s*(.+)$/);
            if (match) refLines.set(match[1], match[2]);
          }
        }
        const refToKey = new Map<string, string>();
        const unmatched: { ref: string; candidate: string }[] = [];
        const ambiguous: AmbiguousTitleMatch[] = [];
        const matches: MatchedReference[] = [];
        let libraryPool: BibliographicCandidate[] | null = null;
        let libraryTotal: number | null = null;
        let libraryTruncated = false;
        for (const [ref, rest] of refLines) {
          const evidence = extractReferenceEvidence(`[${ref}] ${rest}`);
          let match = matchReferenceDetailed(evidence, pool);
          if (!match.key && params.fullLibraryFallback !== false) {
            if (!libraryPool) {
              const libraryResult = await c.getItemsWithMeta();
              libraryPool = libraryResult.items.map(bibliographicCandidate);
              libraryTotal = libraryResult.total;
              libraryTruncated = libraryResult.truncated;
            }
            const fallbackMatch = matchReferenceDetailed(evidence, libraryPool);
            if (fallbackMatch.key || fallbackMatch.ambiguous.length > 0) match = fallbackMatch;
          }
          if (match.key && match.matchMethod) {
            refToKey.set(ref, match.key);
            matches.push({
              ref,
              key: match.key,
              matchMethod: match.matchMethod,
              confidence: match.confidence,
              evidence: {
                doi: evidence.doi,
                year: evidence.year,
                firstAuthor: evidence.firstAuthor,
                titleCandidate: match.matchedTitleCandidate,
              },
            });
          } else if (match.ambiguous.length > 0) {
            ambiguous.push({
              ref,
              candidate: evidence.titleCandidates[0] ?? rest.slice(0, 100),
              matches: match.ambiguous,
              suggestedMethod: match.matchMethod,
              confidence: match.confidence,
            });
          } else {
            unmatched.push({ ref, candidate: evidence.titleCandidates[0] ?? rest.slice(0, 100) });
          }
        }
        // 正文 marker 序列 → keys（与展开 refs 等长，未匹配用空串占位防错位）
        const hits = extractMarkers(text);
        const markers = hits.map((h) => {
          const m = normalizeMarker(h.marker);
          const keys: string[] = [];
          for (const n of expandMarker(m)) {
            keys.push(refToKey.get(String(n)) ?? "");
          }
          return { marker: m, keys };
        });
        const meta = await c.ensureServerMeta();
        const outPath = params.output ?? path.join(await serverCacheDir(c, ctx), "cite_map.json");
        const truncated = collectionTruncated || libraryTruncated;
        writeJsonAtomic(outPath, {
          generatedAt: new Date().toISOString(),
          serverId: meta.serverId,
          collectionKey: params.collectionKey ?? null,
          truncated,
          librarySourceTotal: libraryTotal,
          markers,
          matches,
          unmatched,
          ambiguous,
        });
        return {
          content: [{
            type: "text",
            text: `文献表 ${refLines.size} 条，匹配 ${refToKey.size}，歧义 ${ambiguous.length}，未匹配 ${unmatched.length}；markers ${markers.length} 个 → ${outPath}` +
              (truncated ? `\n⚠ Zotero 元数据源已截断${libraryTotal !== null ? `（全库总数 ${libraryTotal}）` : ""}，未匹配结论可能不完整` : "") +
              (matches.length ? `\n匹配方式: ${summarizeMatchMethods(matches)}` : "") +
              (ambiguous.length ? `\n歧义: ${ambiguous.map((entry) => `[${entry.ref}] ${entry.matches.map((item) => item.key).join("/")}`).join("; ")}` : "") +
              (unmatched.length ? `\n未匹配: ${unmatched.map((entry) => `[${entry.ref}]${entry.candidate.slice(0, 30)}`).join("; ")}` : ""),
          }],
          details: {
            path: outPath,
            serverId: meta.serverId,
            matched: refToKey.size,
            matches,
            ambiguous,
            unmatched,
            markers: markers.length,
            truncated,
            librarySourceTotal: libraryTotal,
          },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_build_map 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  // ---------- zotero_docx_fields ----------
  pi.registerTool({
    name: "zotero_docx_fields",
    label: "Zotero 引用域写入",
    description:
      "把 docx 正文中的方括号引用标记（[8-13]/[42]）按出现顺序替换为 Zotero Word 动态域（ZOTERO_ITEM + 文末 BIBL），" +
      "保留标记所在 run 的前后正文，支持重复标记及同一 XML 容器内的跨 run 标记；复杂 run 会安全中止，不生成损坏文档。" +
      "刷新后由 Zotero 生成引用与文献表。uris 方案（id 占位+正确 uris+itemData，实测 Zotero 10.0 回填真 itemID），" +
      "无需整数 itemID、无需 MCP。mapPath 用 zotero_build_map 产物。" +
      "生成新 docx（不修改 Zotero 库）；Word 刷新需在 Windows 端进行。触发词：插入 Zotero 引用域、方括号转引用、生成引用文档。",
    promptSnippet: "Replace [n] markers in a docx with Zotero Word fields (uris-based)",
    parameters: Type.Object({
      src: Type.String({ description: "输入 docx 路径（必填）" }),
      out: Type.String({ description: "输出 docx 路径（必填）" }),
      mapPath: Type.String({ description: "cite_map.json 路径（markers:[{marker,keys}]，zotero_build_map 产物）" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await writeZoteroDocxFields(getClient(), {
          src: params.src,
          out: params.out,
          mapPath: params.mapPath,
        });
        return {
          content: [{
            type: "text",
            text: `已替换 ${result.markersReplaced} 个引用标记，文献表${result.bibliography === "placeholder" ? "已替换占位符" : "已追加到文末"} → ${result.output}`,
          }],
          details: result,
        };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_docx_fields 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "zotero_tags",
    label: "Zotero 标签",
    description:
      `全局标签清单（list 常驻）；delete=从全部条目移除该标签${canDeleteTags ? `（${writeHint}）` : `（未启用：需 write.enabled、items 白名单和 write.delete）`}。` +
      "增/改标签请用 zotero_items tag（按条目）。",
    promptSnippet: "List or delete Zotero tags (delete gated)",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), ...(canDeleteTags ? [Type.Literal("delete")] : [])] as [never], { description: "操作类型" }),
      tag: Type.Optional(Type.String({ description: "delete 必填：标签名" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const c = getClient();
        if (params.action === "list") {
          const t = await c.getTags({ limit: 100 });
          return { content: [{ type: "text", text: `共 ${t.length} 个标签\n` + t.map((x) => x.tag).slice(0, 50).join(", ") }], details: { count: t.length, tags: t } };
        }
        if (!canDeleteTags) {
          return { content: [{ type: "text", text: "delete 未启用：需 write.enabled=true、write.tools 含 items 且 write.delete=true" }], details: {} };
        }
        await c.deleteTag(params.tag ?? "");
        return { content: [{ type: "text", text: `已从全部条目移除标签「${params.tag}」` }], details: { tag: params.tag } };
      } catch (err) {
        return { content: [{ type: "text", text: `zotero_tags 失败: ${zoteroErr(err)}` }], details: {} };
      }
    },
  });
}

/** 标题归一化（去标点/大小写/空白），用于疑似重复分组 */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[\u2000-\u206f\u3000-\u303f\uff00-\uffef！？。，、；：""''（）【】《》—…·]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}
