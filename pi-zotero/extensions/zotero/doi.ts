/**
 * DOI 元数据获取与映射：
 * - fetchDoiCsl（client）：doi.org 内容协商拿权威 CSL JSON（出网）
 * - cslToZoteroFields：CSL → Zotero 条目字段
 * - mergeDoiFields：回填策略——默认只补空字段，overwrite 时整体覆盖（itemType 永不自动改）
 */

const CSL_TYPE_MAP: Record<string, string> = {
  "journal-article": "journalArticle",
  "book-chapter": "bookSection",
  "proceedings-article": "conferencePaper",
  "paper-conference": "conferencePaper",
  book: "book",
  monograph: "book",
  report: "report",
  thesis: "thesis",
  dataset: "document",
  "posted-content": "preprint",
};

/** 校验并归一化用户输入的 DOI（接受 doi: 与 https://doi.org/ 前缀）。 */
export function normalizeDoiInput(input: string): string {
  const value = input
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;:\s]+$/, "");
  if (!/^10\.\d{4,9}\/\S+$/i.test(value)) {
    throw new Error(`无效 DOI「${input}」：应为 10.xxxx/suffix 形式`);
  }
  return value;
}

function cslCreators(csl: Record<string, unknown>): { creatorType: string; firstName?: string; lastName?: string; name?: string }[] {
  const out: { creatorType: string; firstName?: string; lastName?: string; name?: string }[] = [];
  for (const role of ["author", "editor"] as const) {
    const list = csl[role];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const person = entry as { given?: unknown; family?: unknown; literal?: unknown; name?: unknown };
      if (typeof person.family === "string" && person.family.trim()) {
        out.push({ creatorType: role, ...(typeof person.given === "string" && person.given.trim() ? { firstName: person.given.trim() } : {}), lastName: person.family.trim() });
      } else if (typeof person.literal === "string" && person.literal.trim()) {
        out.push({ creatorType: role, name: person.literal.trim() });
      } else if (typeof person.name === "string" && person.name.trim()) {
        out.push({ creatorType: role, name: person.name.trim() });
      }
    }
  }
  return out;
}

function cslDate(csl: Record<string, unknown>): string | undefined {
  const issued = csl.issued as { "date-parts"?: unknown } | undefined;
  const parts = issued?.["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const values = (parts[0] as unknown[]).filter((value): value is number => typeof value === "number");
  if (values.length === 0) return undefined;
  return values.join("-");
}

export interface DoiLookupResult {
  itemType: string;
  fields: Record<string, unknown>;
  source: { type: string | null; publisher: string | null };
}

/** CSL JSON → Zotero 条目字段。仅映射 Zotero 支持的字段名。 */
export function cslToZoteroFields(csl: Record<string, unknown>): DoiLookupResult {
  const cslType = typeof csl.type === "string" ? csl.type : null;
  const itemType = (cslType && CSL_TYPE_MAP[cslType]) || "document";
  const container = Array.isArray(csl["container-title"]) ? csl["container-title"].find((value): value is string => typeof value === "string") : undefined;
  const fields: Record<string, unknown> = {};
  if (typeof csl.title === "string") fields.title = csl.title;
  const creators = cslCreators(csl);
  if (creators.length > 0) fields.creators = creators;
  if (typeof csl.DOI === "string" && csl.DOI.trim()) fields.DOI = csl.DOI.trim();
  const date = cslDate(csl);
  if (date) fields.date = date;
  if (itemType === "conferencePaper") {
    if (container) fields.proceedingsTitle = container;
  } else if (container) {
    fields.publicationTitle = container;
  }
  if (typeof csl.volume === "string" && csl.volume.trim()) fields.volume = csl.volume.trim();
  if (typeof csl.issue === "string" && csl.issue.trim()) fields.issue = csl.issue.trim();
  if (typeof csl.page === "string" && csl.page.trim()) fields.pages = csl.page.trim();
  if (typeof csl.publisher === "string" && csl.publisher.trim()) fields.publisher = csl.publisher.trim();
  if (typeof csl.ISBN === "string" && csl.ISBN.trim()) fields.ISBN = csl.ISBN.trim();
  if (Array.isArray(csl.ISBN)) {
    const isbn = csl.ISBN.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (isbn) fields.ISBN = isbn.trim();
  }
  if (typeof csl.ISSN === "string" && csl.ISSN.trim()) fields.ISSN = csl.ISSN.trim();
  if (typeof csl.url === "string" && csl.url.trim()) fields.url = csl.url.trim();
  if (typeof csl.abstract === "string" && csl.abstract.trim()) fields.abstractNote = csl.abstract.trim().slice(0, 5000);
  if (typeof csl.language === "string" && csl.language.trim()) fields.language = csl.language.trim();
  return { itemType, fields, source: { type: cslType, publisher: typeof csl.publisher === "string" ? csl.publisher : null } };
}

/** 回填合并：默认仅补空字段；creators 仅在条目无作者或 overwrite 时替换；itemType 不在回填范围。 */
export function mergeDoiFields(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  overwrite = false,
): Record<string, unknown> {
  const isEmpty = (value: unknown): boolean =>
    value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(incoming)) {
    if (field === "itemType") continue;
    if (field === "creators") {
      const current = existing.creators;
      if (overwrite || !Array.isArray(current) || current.length === 0) out.creators = value;
      continue;
    }
    if (overwrite || isEmpty(existing[field])) out[field] = value;
  }
  return out;
}
