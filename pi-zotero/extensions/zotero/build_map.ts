/**
 * cite_map 自动构建：正文引用标记序列 + 文献表元数据 → Zotero 条目匹配。
 * DOI 优先；标题重复时仅用年份/第一作者做消歧，仍冲突则进入 ambiguous。
 */
import { expandMarker, extractMarkers, normalizeMarker } from "./citation.ts";

export interface BibliographicCandidate {
  key: string;
  title: string;
  doi?: string;
  year?: string;
  creators?: string;
}

export interface ReferenceEvidence {
  raw: string;
  titleCandidates: string[];
  doi: string | null;
  year: string | null;
  firstAuthor: string | null;
}

export type MatchMethod =
  | "doi"
  | "title-year-author"
  | "title-year"
  | "title-author"
  | "title-exact"
  | "title-contains";

export interface ReferenceMatchResult {
  key: string | null;
  ambiguous: BibliographicCandidate[];
  matchMethod: MatchMethod | null;
  confidence: number;
  matchedTitleCandidate: string | null;
}

export interface AmbiguousTitleMatch {
  ref: string;
  candidate: string;
  matches: BibliographicCandidate[];
  suggestedMethod: MatchMethod | null;
  confidence: number;
}

export interface MatchedReference {
  ref: string;
  key: string;
  matchMethod: MatchMethod;
  confidence: number;
  evidence: {
    doi: string | null;
    year: string | null;
    firstAuthor: string | null;
    titleCandidate: string | null;
  };
}

export interface BuildMapResult {
  markers: { marker: string; keys: string[] }[];
  unmatched: { ref: string; candidate: string }[];
  ambiguous: AmbiguousTitleMatch[];
  matches: MatchedReference[];
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
    const etAl = beforeJournal.split(/et al\.?/i);
    const afterAuthors = etAl.length > 1 ? etAl[etAl.length - 1].replace(/^[.,;:\s]+/, "").trim() : "";
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

/** DOI 归一化：接受 doi: 与 https://doi.org/ 前缀，忽略大小写和末尾书目分隔符。 */
export function normalizeDoi(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;:\s]+$/, "")
    .toLowerCase();
}

/** Zotero 可能把 DOI 字段保存成 ShortDOI（如 10/ggvvfn）；它不能与完整 DOI 直接判冲突。 */
function comparableDoi(value: string): string | null {
  const normalized = normalizeDoi(value);
  return /^10\.\d{4,9}\//.test(normalized) ? normalized : null;
}

/** 提取 DOI、年份和保守的第一作者姓氏，用于标题重复时消歧。 */
export function extractReferenceEvidence(line: string): ReferenceEvidence {
  const match = line.match(/^\[\d+\]\s*(.+)$/);
  const raw = (match?.[1] ?? line).trim();
  const doiMatch = raw.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
  const yearMatch = raw.match(/\b((?:19|20)\d{2})[a-z]?\b/i);
  const firstToken = raw.match(/^([^\s,.;:]+)/u)?.[1] ?? "";
  const firstAuthor = normalizeAuthor(firstToken).length >= 2 ? firstToken : null;
  return {
    raw,
    titleCandidates: extractTitleCandidates(line),
    doi: doiMatch ? normalizeDoi(doiMatch[1]) : null,
    year: yearMatch?.[1] ?? null,
    firstAuthor,
  };
}

/** 标题归一化（去标点/大小写/空白）。 */
function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2000-\u206f\u3000-\u303f\uff00-\uffef！？。，、；：""''（）【】《》—…·]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function normalizeAuthor(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function creatorTokens(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/gu).map(normalizeAuthor).filter(Boolean);
}

function normalizedYear(value?: string): string {
  return value?.match(/(?:19|20)\d{2}/)?.[0] ?? "";
}

function uniqueMatches<T extends { key: string }>(matches: T[]): T[] {
  return [...new Map(matches.map((match) => [match.key, match])).values()];
}

/** 标题匹配兼容接口：精确优先，其次包含；同等级多候选返回 ambiguous。 */
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

function chooseBibliographicMatch(
  matches: BibliographicCandidate[],
  evidence: ReferenceEvidence,
  baseMethod: "title-exact" | "title-contains",
  titleCandidate: string,
): ReferenceMatchResult {
  const unique = uniqueMatches(matches);
  if (unique.length === 1) {
    // 包含匹配只作为人工候选，绝不直接写入 Word 引用域。
    if (baseMethod === "title-contains") {
      return {
        key: null,
        ambiguous: unique,
        matchMethod: "title-contains",
        confidence: 0.8,
        matchedTitleCandidate: titleCandidate,
      };
    }
    return {
      key: unique[0].key,
      ambiguous: [],
      matchMethod: baseMethod,
      confidence: evidence.doi && !comparableDoi(unique[0].doi ?? "") ? 0.93 : 0.98,
      matchedTitleCandidate: titleCandidate,
    };
  }

  let narrowed = unique;
  let yearMatched = false;
  if (evidence.year) {
    const byYear = narrowed.filter((entry) => normalizedYear(entry.year) === evidence.year);
    if (byYear.length > 0) {
      narrowed = byYear;
      yearMatched = true;
      if (narrowed.length === 1) {
        return {
          key: narrowed[0].key,
          ambiguous: [],
          matchMethod: "title-year",
          confidence: baseMethod === "title-exact" ? 0.995 : 0.9,
          matchedTitleCandidate: titleCandidate,
        };
      }
    }
  }

  if (evidence.firstAuthor) {
    const author = normalizeAuthor(evidence.firstAuthor);
    const byAuthor = narrowed.filter((entry) => creatorTokens(entry.creators ?? "").includes(author));
    if (byAuthor.length === 1) {
      return {
        key: byAuthor[0].key,
        ambiguous: [],
        matchMethod: yearMatched ? "title-year-author" : "title-author",
        confidence: yearMatched ? 0.998 : (baseMethod === "title-exact" ? 0.99 : 0.88),
        matchedTitleCandidate: titleCandidate,
      };
    }
    if (byAuthor.length > 1) narrowed = byAuthor;
  }

  return { key: null, ambiguous: narrowed, matchMethod: null, confidence: 0, matchedTitleCandidate: titleCandidate };
}

/** DOI → 标题精确 → 标题包含；年份/作者仅用于多候选消歧。 */
export function matchReferenceDetailed(
  evidence: ReferenceEvidence,
  collectionItems: BibliographicCandidate[],
): ReferenceMatchResult {
  if (evidence.doi) {
    const doiMatches = uniqueMatches(collectionItems.filter((entry) => normalizeDoi(entry.doi ?? "") === evidence.doi));
    if (doiMatches.length === 1) {
      return { key: doiMatches[0].key, ambiguous: [], matchMethod: "doi", confidence: 1, matchedTitleCandidate: null };
    }
    if (doiMatches.length > 1) {
      return { key: null, ambiguous: doiMatches, matchMethod: null, confidence: 0, matchedTitleCandidate: null };
    }
  }

  const normed = collectionItems
    .map((entry) => ({ ...entry, normalized: normTitle(entry.title) }))
    .filter((entry) => entry.normalized.length >= 6);
  for (const candidate of evidence.titleCandidates) {
    const normalizedCandidate = normTitle(candidate);
    if (normalizedCandidate.length < 6) continue;
    const exact = normed.filter((entry) => entry.normalized === normalizedCandidate);
    if (exact.length > 0) {
      const compatible = evidence.doi
        ? exact.filter((entry) => !comparableDoi(entry.doi ?? "") || comparableDoi(entry.doi ?? "") === evidence.doi)
        : exact;
      if (compatible.length === 0) {
        return { key: null, ambiguous: exact, matchMethod: null, confidence: 0, matchedTitleCandidate: candidate };
      }
      return chooseBibliographicMatch(compatible, evidence, "title-exact", candidate);
    }

    const included = normed.filter((entry) =>
      normalizedCandidate.includes(entry.normalized) || entry.normalized.includes(normalizedCandidate));
    if (included.length === 0) continue;
    const bestDistance = Math.min(...included.map((entry) => Math.abs(entry.normalized.length - normalizedCandidate.length)));
    const best = included.filter((entry) => Math.abs(entry.normalized.length - normalizedCandidate.length) === bestDistance);
    const compatible = evidence.doi
      ? best.filter((entry) => !comparableDoi(entry.doi ?? "") || comparableDoi(entry.doi ?? "") === evidence.doi)
      : best;
    if (compatible.length === 0) {
      return { key: null, ambiguous: best, matchMethod: null, confidence: 0, matchedTitleCandidate: candidate };
    }
    return chooseBibliographicMatch(compatible, evidence, "title-contains", candidate);
  }
  return { key: null, ambiguous: [], matchMethod: null, confidence: 0, matchedTitleCandidate: null };
}

/** 兼容调用：歧义时返回 null。 */
export function matchTitle(candidates: string[], collectionTitles: { key: string; title: string }[]): string | null {
  return matchTitleDetailed(candidates, collectionTitles).key;
}

export function buildCiteMap(text: string, collectionItems: BibliographicCandidate[]): BuildMapResult {
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
  const matches: MatchedReference[] = [];
  for (const [ref, rest] of refLines) {
    const evidence = extractReferenceEvidence(`[${ref}] ${rest}`);
    const result = matchReferenceDetailed(evidence, collectionItems);
    if (result.key && result.matchMethod) {
      refToKey.set(ref, result.key);
      matches.push({
        ref,
        key: result.key,
        matchMethod: result.matchMethod,
        confidence: result.confidence,
        evidence: {
          doi: evidence.doi,
          year: evidence.year,
          firstAuthor: evidence.firstAuthor,
          titleCandidate: result.matchedTitleCandidate,
        },
      });
    } else if (result.ambiguous.length > 0) {
      ambiguous.push({
        ref,
        candidate: evidence.titleCandidates[0] ?? rest.slice(0, 100),
        matches: result.ambiguous,
        suggestedMethod: result.matchMethod,
        confidence: result.confidence,
      });
    } else {
      unmatched.push({ ref, candidate: evidence.titleCandidates[0] ?? rest.slice(0, 100) });
    }
  }

  const markers = hits.map((hit) => {
    const marker = normalizeMarker(hit.marker);
    return {
      marker,
      keys: expandMarker(marker).map((reference) => refToKey.get(String(reference)) ?? ""),
    };
  });
  return { markers, unmatched, ambiguous, matches, matched: refToKey.size, totalRefs: refLines.size };
}
