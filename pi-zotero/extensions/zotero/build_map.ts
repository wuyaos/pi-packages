/**
 * cite_map 自动构建：正文引用标记序列 + 文献表标题 → Zotero 条目匹配 → cite_map.json。
 *
 * 输入：正文文本（markers 序列 + 文献表区 [n] 行）+ 集合条目（key/title）
 * 输出：{ markers: [{marker, keys}], unmatched: [{ref, candidate}] }
 *        markers 顺序 = 正文出现序（audit 的期望序列直接消费）
 */
import { extractMarkers, normalizeMarker, expandMarker } from "./citation.ts";

export interface BuildMapResult {
  markers: { marker: string; keys: string[] }[];
  unmatched: { ref: string; candidate: string }[];
  matched: number;
  totalRefs: number;
}

/** 从文献表行（[n] Authors. Title. *Journal*...）提取标题候选 */
export function extractTitleCandidates(line: string): string[] {
  const m = line.match(/^\[\d+\]\s*(.+)$/);
  if (!m) return [];
  let body = m[1];
  // 去掉尾部 url/doi/标点噪声
  body = body.replace(/\s*`[^`]*`\s*$/, "").replace(/\s*doi:.*$/i, "").trim();
  const out: string[] = [];
  // 候选 1：期刊（*...*）之前的部分
  const beforeJournal = body.split("*")[0].trim();
  if (beforeJournal) {
    // 去掉作者段：优先 "et al." 之后
    const etAl = beforeJournal.split("et al.");
    const afterAuthors = etAl.length > 1 ? etAl[etAl.length - 1].trim() : "";
    if (afterAuthors) {
      out.push(afterAuthors);
    } else {
      // 无 et al.：跳过作者缩写前缀（如 "Vaswani A., " / "Jablonka K. M. "）
      const noAuthors = beforeJournal.replace(/^[A-Z][A-Za-z'’\-]+(?:[.,]\s+[A-Z]\.?)*[.,]\s+/, "").trim();
      out.push(noAuthors);
    }
  }
  // 候选 2：*...* 内的期刊名（书名类条目标题可能在期刊位置）
  const journal = body.match(/\*([^*]+)\*/);
  if (journal) out.push(journal[1].trim());
  // 候选 3：整行（兜底，匹配阶段做包含判定）
  out.push(body);
  return [...new Set(out)].filter((x) => x.length > 3);
}

/** 标题归一化（与 duplicates_scan 一致：去标点/大小写/空白） */
function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[\u2000-\u206f\u3000-\u303f\uff00-\uffef！？。，、；：""''（）【】《》—…·]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** 单行文献匹配：候选标题 → 集合条目 key（精确→包含，取最短命中） */
export function matchTitle(candidates: string[], collectionTitles: { key: string; title: string }[]): string | null {
  const normed = collectionTitles.map((c) => ({ ...c, n: normTitle(c.title) }));
  for (const cand of candidates) {
    const cn = normTitle(cand);
    if (cn.length < 6) continue;
    // 精确
    const exact = normed.find((c) => c.n === cn);
    if (exact) return exact.key;
    // 包含（双向，候选与标题任一方向包含；取最短标题减少误配）
    let best: { key: string; n: string } | null = null;
    for (const c of normed) {
      if (c.n.length < 6) continue;
      if (cn.includes(c.n) || c.n.includes(cn)) {
        if (!best || c.n.length < best.n.length) best = c;
      }
    }
    if (best) return best.key;
  }
  return null;
}

/**
 * 构建 cite_map：
 * @param text 正文（含文献表区）
 * @param collectionTitles 集合条目 {key, title}
 */
export function buildCiteMap(text: string, collectionTitles: { key: string; title: string }[]): BuildMapResult {
  const hits = extractMarkers(text);
  // 文献表区 [n] 行
  const refLines = new Map<string, string>();
  const lines = text.split("\n");
  const refIdx = lines.findIndex((l) => /^#{1,6}\s*参考文献/.test(l.trim()));
  if (refIdx !== -1) {
    for (let i = refIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\[\s*(\d+)\s*\]\s*(.+)$/);
      if (m) refLines.set(m[1], m[2]);
    }
  }
  // 每个编号 → key
  const refToKey = new Map<string, string>();
  const unmatched: { ref: string; candidate: string }[] = [];
  for (const [ref, rest] of refLines) {
    const cands = extractTitleCandidates(`[${ref}] ${rest}`);
    const key = matchTitle(cands, collectionTitles);
    if (key) refToKey.set(ref, key);
    else unmatched.push({ ref, candidate: cands[0] ?? rest.slice(0, 100) });
  }
  // 正文 marker 序列 → keys（与展开 refs 等长，未匹配用空串占位防错位）
  const markers = hits.map((h) => {
    const m = normalizeMarker(h.marker);
    const keys: string[] = [];
    for (const n of expandMarker(m)) {
      keys.push(refToKey.get(String(n)) ?? "");
    }
    return { marker: m, keys };
  });
  return {
    markers,
    unmatched,
    matched: refToKey.size,
    totalRefs: refLines.size,
  };
}
