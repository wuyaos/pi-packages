/** 真库冒烟：验证 ZoteroClient 核心路径（需 Zotero 10 运行）。用法: npx tsx scripts/smoke_client.ts */
import { ZoteroClient, winFileUrlToWslPath } from "../extensions/zotero/client.ts";

async function main() {
  const c = new ZoteroClient({ timeoutMs: 30000 });
  const meta = await c.ensureServerMeta();
  console.log("1. init:", JSON.stringify(meta));
  const cols = await c.getCollections({ limit: 100 });
  console.log("2. collections:", cols.length, "顶层数:", cols.filter((x) => !x.data.parentCollection).length);
  const items = await c.getCollectionItems("P5Y3KVB7");
  console.log("3. 集合 P5Y3KVB7 顶层条目:", items.length, "首条:", items[0]?.data.title);
  const csl = await c.getCSLBatch(["CDW8SSDB", "IBETXJZJ"]);
  console.log("4. CSL 批量(请求2key, 应过滤附件):", Object.keys(csl).length, "keys:", Object.keys(csl).join(","));
  const ft = await c.getFulltext("KFG8ZBKE");
  console.log("5. fulltext:", ft.content.length, "chars, pages:", ft.totalPages);
  const p = await c.getAttachmentPath("KFG8ZBKE");
  console.log("6. 附件路径:", p);
  const hits = await c.search("transformer", { limit: 3 });
  console.log("7. 搜索 transformer:", hits.length, "条, 首条:", hits[0]?.data.title);
  const ss = await c.getSearchItems("UEG67GLA", { limit: 3 });
  console.log("8. saved search UEG67GLA:", ss.length, "条");
  console.log("9. 转换:", winFileUrlToWslPath("file:///D:/work/a%20b.pdf"));
  try { await c.getItem("BADKEY"); } catch (e: any) { console.log("10. 坏 key 拒绝:", e.message.slice(0, 60)); }
  try { await c.getItem("ZZZZZZZZ"); } catch (e: any) { console.log("10b. 不存在 key:", e.message.slice(0, 60)); }
  console.log("SMOKE OK");
}
main().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });
