/**
 * 引用审计核心（对齐 agent_sci 工作流）。
 *  - marker 提取：<sup>[n]</sup> 优先，回退 §CITE[n]§ / 裸 [n]（文献表区之后不提取），记录行号
 *  - 展开：8-13 → [8..13]；1,3,5-7 → [1,3,5,6,7]（兼容 en-dash/空格归一化）
 *  - 核验：序列错位（期望序列比对）、缺失（引用但 map 无）、未引用（map 有但未引）、乱序（编号序 vs 出现序）
 *  - 报告：markdown 工作簿写盘（逐条：行号/上下文/文献/判定）
 */

export interface MapMarker {
  marker: string;
  keys: string[];
}

/** citation map：{markers: [{marker, keys}]}（期望序列 = markers 顺序） */
export interface CiteMap {
  markers: MapMarker[];
  [k: string]: unknown;
}

/** number map：ref# → itemKey（无期望序列，只做覆盖核对） */
export type NumberMap = Record<string, string>;

export interface AuditOptions {
  /** 正文全文 */
  text: string;
  /** 期望 marker 序列（来自 citation map markers 顺序）；缺省则只做覆盖核对 */
  expectedMarkers?: string[];
  /** ref# → key 映射（覆盖核对用） */
  numberMap?: NumberMap;
  /** CSL 数据（渲染文献条目用） */
  csls?: Record<string, Record<string, unknown>>;
}

export interface AuditIssue {
  kind: "mismatch" | "missing" | "unused" | "out-of-order";
  detail: string;
}

export interface AuditResult {
  totalMarkers: number;
  uniqueRefs: string[];
  refCount: number;
  mismatches: { index: number; actual: string; expected: string; line: number }[];
  missing: string[];
  unused: string[];
  outOfOrder: { marker: string; line: number; prev: string }[];
  issues: AuditIssue[];
  /** markdown 工作簿全文 */
  report: string;
}

interface MarkerHit {
  marker: string;
  line: number;
  /** marker 前的上下文（约 60 字） */
  context: string;
}

/** 归一化 marker：去空格、en-dash → 连字符 */
export function normalizeMarker(m: string): string {
  return m.replace(/\s+/g, "").replace(/[–—]/g, "-");
}

/** 展开 "8-13" / "1,3,5-7" → 数字数组 */
export function expandMarker(marker: string): number[] {
  const out: number[] = [];
  for (const part of normalizeMarker(marker).split(",")) {
    if (!part) continue;
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    if (m[2] === undefined) {
      out.push(a);
    } else {
      const b = Number(m[2]);
      for (let n = a; n <= b; n++) out.push(n);
    }
  }
  return out;
}

/** 提取正文引用标记（含行号与上下文）；文献表区（# 参考文献 之后）不提取。
 * 模式优先级：<sup> > §CITE > 裸括号；裸括号跳过已被前两模式匹配的区间（防重复计数）。 */
export function extractMarkers(text: string): MarkerHit[] {
  const lines = text.split("\n");
  const refIdx = lines.findIndex((l) => /^#{1,6}\s*参考文献/.test(l.trim()));
  const hits: MarkerHit[] = [];
  const supRe = /<sup>\s*\[([^\]]+)\]\s*<\/sup>/g;
  const citeRe = /§CITE\s*\[([^\]]+)\]§/g;
  const bareRe = /\[(\d+(?:[,\-–]\d+)*)\]/g;
  for (let i = 0; i < lines.length; i++) {
    if (refIdx !== -1 && i >= refIdx) break;
    const line = lines[i];
    // 区间收集：已匹配的 [start, end)，裸括号跳过
    const taken: [number, number][] = [];
    const pushHits = (m: RegExpExecArray) => {
      const marker = m[1];
      if (!/^\d/.test(marker)) return;
      hits.push({
        marker,
        line: i + 1,
        context: line.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 10).trim(),
      });
      taken.push([m.index, m.index + m[0].length]);
    };
    for (const re of [supRe, citeRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) pushHits(m);
    }
    bareRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = bareRe.exec(line)) !== null) {
      const start = m.index;
      if (!taken.some(([s, e]) => start >= s && start < e)) pushHits(m);
    }
  }
  return hits;
}

/**
 * 审计：序列错位/缺失/未引用/乱序，生成工作簿。
 * @param mapPath 输出报告路径（调用方写盘）
 */
export function auditCitations(opts: AuditOptions): AuditResult {
  const hits = extractMarkers(opts.text);
  const actual = hits.map((h) => normalizeMarker(h.marker));
  const used = new Set<string>();
  for (const m of actual) {
    for (const n of expandMarker(m)) used.add(String(n));
  }
  const refKeys = new Set(Object.keys(opts.numberMap ?? {}));
  const missing = [...used].filter((r) => !refKeys.has(r)).sort((a, b) => Number(a) - Number(b));
  const unused = [...refKeys].filter((r) => !used.has(r)).sort((a, b) => Number(a) - Number(b));

  // 序列错位（期望序列存在时）
  const mismatches: AuditResult["mismatches"] = [];
  if (opts.expectedMarkers && opts.expectedMarkers.length) {
    const expected = opts.expectedMarkers.map(normalizeMarker);
    const n = Math.max(actual.length, expected.length);
    for (let i = 0; i < n; i++) {
      const a = actual[i];
      const e = expected[i];
      if (a !== e) {
        mismatches.push({ index: i + 1, actual: a ?? "(无)", expected: e ?? "(无)", line: hits[i]?.line ?? 0 });
      }
    }
  }

  // 乱序检测：每篇文献首次被引用的行号必须随编号递增（与 Zotero 按出现序重排语义一致）
  const outOfOrder: AuditResult["outOfOrder"] = [];
  const firstSeen = new Map<string, number>();
  for (const h of hits) {
    for (const n of expandMarker(h.marker)) {
      if (!firstSeen.has(String(n))) firstSeen.set(String(n), h.line);
    }
  }
  const sortedRefs = [...firstSeen.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  let prevLine = 0;
  let prevRef = "";
  for (const [ref, line] of sortedRefs) {
    if (line < prevLine) {
      outOfOrder.push({ marker: `[${ref}]`, line, prev: `[${prevRef}]` });
    }
    prevLine = Math.max(prevLine, line);
    prevRef = ref;
  }

  const issues: AuditIssue[] = [];
  for (const mm of mismatches) issues.push({ kind: "mismatch", detail: `#${mm.index} 期望 [${mm.expected}] 实际 [${mm.actual}]（行 ${mm.line}）` });
  for (const r of missing) issues.push({ kind: "missing", detail: `[${r}] 正文引用但映射中无此编号` });
  for (const r of unused) issues.push({ kind: "unused", detail: `[${r}] 映射中存在但正文未引用` });
  for (const oo of outOfOrder) issues.push({ kind: "out-of-order", detail: `[${oo.marker}]（行 ${oo.line}）编号小于此前出现的最小编号 [${oo.prev}] — Word 刷新会重排` });

  const report = buildReport({ hits, numberMap: opts.numberMap ?? {}, csls: opts.csls ?? {}, mismatches, missing, unused, outOfOrder });

  return {
    totalMarkers: hits.length,
    uniqueRefs: [...used].sort((a, b) => Number(a) - Number(b)),
    refCount: refKeys.size,
    mismatches,
    missing,
    unused,
    outOfOrder,
    issues,
    report,
  };
}

function buildReport(ctx: {
  hits: MarkerHit[];
  numberMap: NumberMap;
  csls: Record<string, Record<string, unknown>>;
  mismatches: AuditResult["mismatches"];
  missing: string[];
  unused: string[];
  outOfOrder: AuditResult["outOfOrder"];
}): string {
  const { hits, numberMap, csls, mismatches, missing, unused, outOfOrder } = ctx;
  const used = new Set<string>();
  for (const h of hits) for (const n of expandMarker(h.marker)) used.add(String(n));
  const L: string[] = [];
  L.push("# 引用事实核验工作簿（自动生成）");
  L.push("");
  L.push(`- 正文引用标记数: ${hits.length}`);
  L.push(`- 引用唯一编号: ${used.size}`);
  L.push(`- 文献表条目数（映射）: ${Object.keys(numberMap).length}`);
  L.push(`- 序列错位: ${mismatches.length}`);
  L.push(`- 缺失: ${missing.length}`);
  L.push(`- 未引用: ${unused.length}`);
  L.push(`- 乱序: ${outOfOrder.length}`);
  L.push("");
  L.push("## 逐条核验（标记 | 行号 | 上下文 | 文献 | 判定）");
  L.push("");
  const ctxByRef = new Map<string, string>();
  for (const h of hits) {
    for (const n of expandMarker(h.marker)) {
      if (!ctxByRef.has(String(n))) ctxByRef.set(String(n), h.context);
    }
  }
  for (const ref of [...used].sort((a, b) => Number(a) - Number(b))) {
    const key = numberMap[ref];
    const csl = key ? csls[key] : undefined;
    const label = csl ? renderCSL(csl) : key ? `(key ${key})` : "(映射无)";
    const verdict = missing.includes(ref) ? "⚠️ 缺失" : "OK";
    L.push(`### [${ref}] ${verdict}`);
    L.push(`- 行号: ${ctxByRef.get(ref) ?? "-"}`);
    L.push(`- 上下文: ${(ctxByRef.get(ref) ?? "").slice(0, 100)}`);
    L.push(`- 文献: ${label}`);
    L.push("");
  }
  if (mismatches.length || missing.length || unused.length || outOfOrder.length) {
    L.push("## 问题清单");
    L.push("");
    for (const mm of mismatches) L.push(`- [错位] #${mm.index} 期望 [${mm.expected}] 实际 [${mm.actual}]（行 ${mm.line}）`);
    for (const r of missing) L.push(`- [缺失] [${r}] 正文引用但映射无`);
    for (const r of unused) L.push(`- [未引用] [${r}] 映射有但正文未引`);
    for (const oo of outOfOrder) L.push(`- [乱序] [${oo.marker}]（行 ${oo.line}）编号小于此前 [${oo.prev}]`);
  }
  return L.join("\n");
}

/** 精简文献渲染：[n] FirstAuthor et al. Title. Year（非正式格式，仅核对用） */
function renderCSL(csl: Record<string, unknown>): string {
  const creators = (csl["author"] ?? csl["editor"] ?? []) as { family?: string; literal?: string }[];
  const first = creators[0] ? (creators[0].literal ?? creators[0].family ?? "?") : "?";
  const etAl = creators.length > 1 ? " et al." : "";
  const title = String(csl["title"] ?? "");
  const year = (csl["issued"] as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0]?.[0] ?? "";
  return `${first}${etAl}. ${title}. ${year}`.trim();
}
