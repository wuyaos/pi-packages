/**
 * cite_map 自动构建：正文引用标记序列 + 文献表标题 → Zotero 条目匹配。
 * 同标题/同分候选不会静默取第一条，而是进入 ambiguous，等待人工或 DOI/年份二次确认。
 */
import { expandMarker, extractMarkers, normalizeMarker } from "./citation.ts";

export interface AmbiguousTitleMatch {
  ref: string;
  candidate: string;
  matches: { key: string; title: string }[];
}

export interface BuildMapResult {
  markers: { marker: string; keys: string[] }[];
  unmatched: { ref: string; candidate: string }[];
  ambiguous: AmbiguousTitleMatch[];
  matched: number;
  totalRefs: number;
}

export interface TitleMatchResult {
  key: string | null;
  ambiguous: { key: string; title: string }[];
}

/** 从文献表行（[n] Authors. Title. *Journal*...）提取标题候选。 */
export function extractTitleCandidates(line: string): string[] {
  const match = line.match(/^\[\d+\]\s*(.+)$/);
  if (!match) return [];
  let body = match[1];
  body = body.replace(/\s*`[^`]*`\s*$/, "").replace(/\s*doi:.*$/i, "").trim();
  const out: string[] = [];
  const beforeJournal = body.split("*")[0].trim();
  if (beforeJournal) {
    const etAl = beforeJournal.split("et al.");
    const afterAuthors = etAl.length > 1 ? etAl[etAl.length - 1].trim() : "";
    if (afterAuthors) {
      out.push(afterAuthors);
    } else {
      const noAuthors = beforeJournal.replace(/^[A-Z][A-Za-z'’\-]+(?:[.,]\s+[A-Z]\.?)*[.,]\s+/, "").trim();
      out.push(noAuthors);
    }
  }
  const journal = body.match(/\*([^*]+)\*/);
  if (journal) out.push(journal[1].trim());
  out.push(body);
  return [...new Set(out)].filter((value) => value.length > 3);
}

/** 标题归一化（去标点/大小写/空白）。 */
function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2000-\u206f\u3000-\u303f\uff00-\uffef！？。，、；：""''（）【】《》—…·]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function uniqueMatches(matches: { key: string; title: string }[]): { key: string; title: string }[] {
  return [...new Map(matches.map((match) => [match.key, match])).values()];
}

/** 标题匹配：精确优先，其次包含；同等级多候选返回 ambiguous，不静默选第一条。 */
export function matchTitleDetailed(
  candidates: string[],
  collectionTitles: { key: string; title: string }[],
): TitleMatchResult {
  const normed = collectionTitles
    .map((entry) => ({ ...entry, normalized: normTitle(entry.title) }))
    .filter((entry) => entry.normalized.length >= 6);

  for (const candidate of candidates) {
    const normalizedCandidate = normTitle(candidate);
    if (normalizedCandidate.length < 6) continue;

    const exact = uniqueMatches(
      normed
        .filter((entry) => entry.normalized === normalizedCandidate)
        .map(({ key, title }) => ({ key, title })),
    );
    if (exact.length === 1) return { key: exact[0].key, ambiguous: [] };
    if (exact.length > 1) return { key: null, ambiguous: exact };

    const included = normed.filter((entry) =>
      normalizedCandidate.includes(entry.normalized) || entry.normalized.includes(normalizedCandidate));
    if (included.length === 0) continue;
    const bestDistance = Math.min(...included.map((entry) => Math.abs(entry.normalized.length - normalizedCandidate.length)));
    const best = uniqueMatches(
      included
        .filter((entry) => Math.abs(entry.normalized.length - normalizedCandidate.length) === bestDistance)
        .map(({ key, title }) => ({ key, title })),
    );
    if (best.length === 1) return { key: best[0].key, ambiguous: [] };
    if (best.length > 1) return { key: null, ambiguous: best };
  }
  return { key: null, ambiguous: [] };
}

/** 兼容调用：歧义时返回 null。 */
export function matchTitle(candidates: string[], collectionTitles: { key: string; title: string }[]): string | null {
  return matchTitleDetailed(candidates, collectionTitles).key;
}

export function buildCiteMap(text: string, collectionTitles: { key: string; title: string }[]): BuildMapResult {
  const hits = extractMarkers(text);
  const refLines = new Map<string, string>();
  const lines = text.split("\n");
  const referenceIndex = lines.findIndex((line) => /^#{1,6}\s*参考文献/.test(line.trim()));
  if (referenceIndex !== -1) {
    for (let i = referenceIndex + 1; i < lines.length; i += 1) {
      const match = lines[i].match(/^\[\s*(\d+)\s*\]\s*(.+)$/);
      if (match) refLines.set(match[1], match[2]);
    }
  }

  const refToKey = new Map<string, string>();
  const unmatched: { ref: string; candidate: string }[] = [];
  const ambiguous: AmbiguousTitleMatch[] = [];
  for (const [ref, rest] of refLines) {
    const candidates = extractTitleCandidates(`[${ref}] ${rest}`);
    const result = matchTitleDetailed(candidates, collectionTitles);
    if (result.key) refToKey.set(ref, result.key);
    else if (result.ambiguous.length > 0) {
      ambiguous.push({ ref, candidate: candidates[0] ?? rest.slice(0, 100), matches: result.ambiguous });
    } else {
      unmatched.push({ ref, candidate: candidates[0] ?? rest.slice(0, 100) });
    }
  }

  const markers = hits.map((hit) => {
    const marker = normalizeMarker(hit.marker);
    return {
      marker,
      keys: expandMarker(marker).map((reference) => refToKey.get(String(reference)) ?? ""),
    };
  });
  return { markers, unmatched, ambiguous, matched: refToKey.size, totalRefs: refLines.size };
}
