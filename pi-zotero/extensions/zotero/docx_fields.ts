import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode,
} from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import type { ZoteroClient } from "./client.ts";
import { writeFileAtomic } from "./atomic.ts";

const DOCUMENT_XML = "word/document.xml";
const DEFAULT_BIBL_PLACEHOLDER = "（此处由 Zotero 插入参考文献表）";
const CSL_SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";
const ZOTERO_KEY_RE = /^[A-Z0-9]{8}$/;
const USER_ITEM_URI_RE = /\/users\/(\d+)\/items\/([A-Z0-9]{8})$/;

export interface DocxFieldsOptions {
  src: string;
  out: string;
  mapPath: string;
}

export interface DocxFieldsResult {
  output: string;
  markersReplaced: number;
  bibliography: "placeholder" | "appended";
  itemCount: number;
}

interface CitationSpec {
  marker: string;
  keys: string[];
}

interface CitationMap {
  markers: CitationSpec[];
  biblPlaceholder: string;
  serverId?: string;
}

interface RunInfo {
  run: XmlElement;
  parent: XmlNode;
  text: string;
  start: number;
  end: number;
}

export class DocxFieldsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxFieldsError";
  }
}

function nodesOf<T extends XmlNode>(list: { length: number; item(index: number): T | null }): T[] {
  const out: T[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const node = list.item(i);
    if (node) out.push(node);
  }
  return out;
}

function elementChildren(node: XmlNode): XmlElement[] {
  const out: XmlElement[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) out.push(child as XmlElement);
  }
  return out;
}

function directElements(node: XmlNode, tagName: string): XmlElement[] {
  return elementChildren(node).filter((child) => child.tagName === tagName);
}

function directText(node: XmlNode): string {
  let out = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 || child.nodeType === 4) out += child.nodeValue ?? "";
  }
  return out;
}

function runText(run: XmlElement): string {
  return directElements(run, "w:t").map(directText).join("");
}

function fieldCharTypes(run: XmlElement): Set<string> {
  const types = new Set<string>();
  for (const element of directElements(run, "w:fldChar")) {
    const value = element.getAttribute("w:fldCharType") || element.getAttribute("fldCharType");
    if (value) types.add(value);
  }
  return types;
}

/** 返回段落中不属于既有 Word 域的可见纯文本 run。 */
function visibleRuns(paragraph: XmlElement): { text: string; infos: RunInfo[] } {
  const infos: RunInfo[] = [];
  let text = "";
  let fieldDepth = 0;

  for (const run of nodesOf<XmlElement>(paragraph.getElementsByTagName("w:r"))) {
    const fieldTypes = fieldCharTypes(run);
    if (fieldTypes.has("begin")) fieldDepth += 1;

    const hasInstruction = directElements(run, "w:instrText").length > 0;
    const value = runText(run);
    if (fieldDepth === 0 && !hasInstruction && value) {
      if (!run.parentNode) throw new DocxFieldsError("Word run 缺少父节点");
      infos.push({ run, parent: run.parentNode, text: value, start: text.length, end: text.length + value.length });
      text += value;
    }

    if (fieldTypes.has("end")) fieldDepth = Math.max(0, fieldDepth - 1);
  }
  return { text, infos };
}

function validateSimpleTextRun(run: XmlElement): void {
  const unsupported = elementChildren(run)
    .map((child) => child.tagName)
    .filter((tagName) => tagName !== "w:rPr" && tagName !== "w:t");
  if (unsupported.length > 0) {
    throw new DocxFieldsError(`标记位于复杂 Word run（${unsupported.join(", ")}），为防数据丢失已中止`);
  }
}

function cloneRunWithText(document: XmlDocument, template: XmlElement, text: string): XmlElement {
  const run = document.createElement("w:r");
  for (let i = 0; i < template.attributes.length; i += 1) {
    const attribute = template.attributes.item(i);
    if (attribute) run.setAttribute(attribute.name, attribute.value);
  }
  const runProperties = directElements(template, "w:rPr")[0];
  if (runProperties) run.appendChild(runProperties.cloneNode(true));

  const textElement = document.createElement("w:t");
  if (/^\s|\s$/.test(text)) textElement.setAttribute("xml:space", "preserve");
  textElement.appendChild(document.createTextNode(text));
  run.appendChild(textElement);
  return run;
}

function fieldRun(document: XmlDocument, inner: XmlElement, runProperties?: XmlElement): XmlElement {
  const run = document.createElement("w:r");
  if (runProperties) run.appendChild(runProperties.cloneNode(true));
  run.appendChild(inner);
  return run;
}

function complexFieldNodes(
  document: XmlDocument,
  instruction: string,
  displayText: string,
  formatRun?: XmlElement,
): XmlElement[] {
  const runProperties = formatRun ? directElements(formatRun, "w:rPr")[0] : undefined;

  const begin = document.createElement("w:fldChar");
  begin.setAttribute("w:fldCharType", "begin");

  const instructionText = document.createElement("w:instrText");
  instructionText.setAttribute("xml:space", "preserve");
  instructionText.appendChild(document.createTextNode(` ADDIN ${instruction} `));

  const separate = document.createElement("w:fldChar");
  separate.setAttribute("w:fldCharType", "separate");

  const display = document.createElement("w:t");
  if (/^\s|\s$/.test(displayText)) display.setAttribute("xml:space", "preserve");
  display.appendChild(document.createTextNode(displayText));

  const end = document.createElement("w:fldChar");
  end.setAttribute("w:fldCharType", "end");

  return [
    fieldRun(document, begin, runProperties),
    fieldRun(document, instructionText, runProperties),
    fieldRun(document, separate, runProperties),
    fieldRun(document, display, runProperties),
    fieldRun(document, end, runProperties),
  ];
}

function runIndexForStart(infos: RunInfo[], offset: number): number {
  const index = infos.findIndex((info) => info.start <= offset && offset < info.end);
  if (index < 0) throw new DocxFieldsError("无法定位引用标记起始 run");
  return index;
}

function runIndexForEnd(infos: RunInfo[], offset: number): number {
  const index = infos.findIndex((info) => info.start < offset && offset <= info.end);
  if (index < 0) throw new DocxFieldsError("无法定位引用标记结束 run");
  return index;
}

function replaceVisibleSpan(
  document: XmlDocument,
  paragraph: XmlElement,
  start: number,
  end: number,
  instruction: string,
  displayText: string,
): void {
  const { text, infos } = visibleRuns(paragraph);
  if (!(start >= 0 && start < end && end <= text.length)) throw new DocxFieldsError("引用标记偏移越界");

  const firstIndex = runIndexForStart(infos, start);
  const lastIndex = runIndexForEnd(infos, end);
  const affected = infos.slice(firstIndex, lastIndex + 1);
  if (new Set(affected.map((info) => info.parent)).size !== 1) {
    throw new DocxFieldsError("引用标记跨越不同 XML 容器（如 hyperlink），为防结构损坏已中止");
  }
  affected.forEach((info) => validateSimpleTextRun(info.run));

  const first = affected[0];
  const last = affected[affected.length - 1];
  // 标记跨 run 时，若中间夹有 w:br/w:tab/bookmark 等非目标元素，移动 run 会改变视觉顺序；安全拒绝。
  const affectedRuns = new Set<XmlNode>(affected.map((info) => info.run));
  let sibling: XmlNode | null = first.run;
  while (sibling) {
    if (sibling.nodeType === 1 && !affectedRuns.has(sibling)) {
      throw new DocxFieldsError("引用标记跨 run 且中间含非文本节点，为防重排内容已中止");
    }
    if (sibling === last.run) break;
    sibling = sibling.nextSibling;
  }
  if (sibling !== last.run) throw new DocxFieldsError("引用标记 run 顺序异常");
  const prefix = first.text.slice(0, start - first.start);
  const suffix = last.text.slice(end - last.start);
  const replacements: XmlElement[] = [];
  if (prefix) replacements.push(cloneRunWithText(document, first.run, prefix));
  replacements.push(...complexFieldNodes(document, instruction, displayText, first.run));
  if (suffix) replacements.push(cloneRunWithText(document, last.run, suffix));

  for (const replacement of replacements) first.parent.insertBefore(replacement, first.run);
  for (const info of affected) info.parent.removeChild(info.run);
}

function parseXml(xml: string): XmlDocument {
  const errors: string[] = [];
  const document = new DOMParser({
    onError(level, message) {
      if (level !== "warning") errors.push(message);
    },
  }).parseFromString(xml, "application/xml");
  if (errors.length > 0 || !document.documentElement) {
    throw new DocxFieldsError(`document.xml 解析失败: ${errors.join("; ") || "无根节点"}`);
  }
  return document;
}

function parseCitationMap(mapPath: string): CitationMap {
  const raw = JSON.parse(fs.readFileSync(mapPath, "utf-8")) as Record<string, unknown>;
  if (!Array.isArray(raw.markers) || raw.markers.length === 0) {
    throw new DocxFieldsError("cite_map.markers 为空或格式错误");
  }

  const markers = raw.markers.map((value, index): CitationSpec => {
    if (!value || typeof value !== "object") throw new DocxFieldsError(`markers[${index}] 格式错误`);
    const entry = value as Record<string, unknown>;
    if (typeof entry.marker !== "string" || !entry.marker) throw new DocxFieldsError(`markers[${index}].marker 无效`);
    if (!Array.isArray(entry.keys) || entry.keys.length === 0) {
      throw new DocxFieldsError(`markers[${index}] ${entry.marker} 没有关联 key`);
    }
    const keys = entry.keys.map((key) => {
      if (typeof key !== "string" || !ZOTERO_KEY_RE.test(key)) {
        throw new DocxFieldsError(`markers[${index}] ${entry.marker} 含空值或非法 Zotero key`);
      }
      return key;
    });
    return { marker: entry.marker, keys };
  });

  if (raw.bibl_placeholder !== undefined && typeof raw.bibl_placeholder !== "string") {
    throw new DocxFieldsError("bibl_placeholder 必须为字符串");
  }
  if (raw.serverId !== undefined && typeof raw.serverId !== "string") {
    throw new DocxFieldsError("serverId 必须为字符串");
  }
  return {
    markers,
    biblPlaceholder: (raw.bibl_placeholder as string | undefined) ?? DEFAULT_BIBL_PLACEHOLDER,
    serverId: raw.serverId as string | undefined,
  };
}

function cslKey(csl: Record<string, unknown>): string | undefined {
  const match = String(csl.id ?? "").match(USER_ITEM_URI_RE);
  return match?.[2];
}

function userIdFromCsls(csls: Record<string, Record<string, unknown>>): string {
  const userIds = new Set<string>();
  for (const csl of Object.values(csls)) {
    const match = String(csl.id ?? "").match(USER_ITEM_URI_RE);
    if (match) userIds.add(match[1]);
  }
  if (userIds.size !== 1) {
    throw new DocxFieldsError(`无法确定唯一 Zotero userID（检测到 ${JSON.stringify([...userIds])}）`);
  }
  return [...userIds][0];
}

function citationItem(key: string, csl: Record<string, unknown>, userId: string): Record<string, unknown> {
  const itemData = Object.fromEntries(Object.entries(csl).filter(([name]) => name !== "id" && name !== "uris"));
  itemData.id = 0;
  return {
    id: 0,
    uris: [`http://zotero.org/users/${userId}/items/${key}`],
    itemData,
  };
}

function citationJson(
  marker: string,
  keys: string[],
  csls: Record<string, Record<string, unknown>>,
  userId: string,
  occurrence: number,
): string {
  const citationId = `cit${createHash("sha256").update(`${occurrence}\0${marker}\0${keys.join(",")}`).digest("hex").slice(0, 12)}`;
  return JSON.stringify({
    citationID: citationId,
    properties: { unsorted: false, formattedCitation: marker, plainCitation: marker, noteIndex: 0 },
    citationItems: keys.map((key) => citationItem(key, csls[key], userId)),
    schema: CSL_SCHEMA,
  });
}

function paragraphText(paragraph: XmlElement): string {
  return visibleRuns(paragraph).text;
}

function referenceBoundary(paragraphs: XmlElement[], placeholder: string): number {
  for (let i = 0; i < paragraphs.length; i += 1) {
    const text = paragraphText(paragraphs[i]).trim();
    if (placeholder && text.includes(placeholder)) return i;
    if (/^(?:参考文献|references)\s*[:：]?$/i.test(text)) return i;
  }
  return paragraphs.length;
}

function replaceCitations(
  document: XmlDocument,
  specs: CitationSpec[],
  csls: Record<string, Record<string, unknown>>,
  userId: string,
  placeholder: string,
): number {
  const paragraphs = nodesOf<XmlElement>(document.getElementsByTagName("w:p"));
  const boundary = referenceBoundary(paragraphs, placeholder);
  let paragraphIndex = 0;
  let cursor = 0;

  for (let occurrence = 0; occurrence < specs.length; occurrence += 1) {
    const spec = specs[occurrence];
    let found = false;
    for (let i = paragraphIndex; i < boundary; i += 1) {
      const text = paragraphText(paragraphs[i]);
      const position = text.indexOf(spec.marker, i === paragraphIndex ? cursor : 0);
      if (position < 0) continue;
      replaceVisibleSpan(
        document,
        paragraphs[i],
        position,
        position + spec.marker.length,
        `ZOTERO_ITEM CSL_CITATION ${citationJson(spec.marker, spec.keys, csls, userId, occurrence)}`,
        spec.marker,
      );
      paragraphIndex = i;
      cursor = position;
      found = true;
      break;
    }
    if (!found) throw new DocxFieldsError(`未在正文中按顺序找到第 ${occurrence + 1} 个引用标记 ${spec.marker}`);
  }

  const leftover: string[] = [];
  const citationPattern = /\[\s*\d+(?:\s*(?:[-–—,，])\s*\d+)*\s*\]/g;
  for (let i = 0; i < boundary; i += 1) {
    leftover.push(...(paragraphText(paragraphs[i]).match(citationPattern) ?? []));
  }
  if (leftover.length > 0) {
    throw new DocxFieldsError(`正文仍有未映射引用标记，拒绝生成部分动态域: ${[...new Set(leftover)].join(", ")}`);
  }
  return specs.length;
}

function appendBibliographyParagraph(document: XmlDocument, fields: XmlElement[]): void {
  const body = nodesOf<XmlElement>(document.getElementsByTagName("w:body"))[0];
  if (!body) throw new DocxFieldsError("document.xml 缺少 w:body");
  const paragraph = document.createElement("w:p");
  fields.forEach((field) => paragraph.appendChild(field));
  const sectionProperties = elementChildren(body).find((child) => child.tagName === "w:sectPr");
  if (sectionProperties) body.insertBefore(paragraph, sectionProperties);
  else body.appendChild(paragraph);
}

function insertBibliography(
  document: XmlDocument,
  placeholder: string,
  orderedKeys: string[],
  csls: Record<string, Record<string, unknown>>,
  userId: string,
): "placeholder" | "appended" {
  const value = JSON.stringify({
    citationID: "biblDocxFields",
    properties: { noteIndex: 0 },
    citationItems: orderedKeys.map((key) => citationItem(key, csls[key], userId)),
    schema: CSL_SCHEMA,
  });
  const instruction = `ZOTERO_BIBL CSL_BIBLIOGRAPHY ${value}`;

  if (placeholder) {
    for (const paragraph of nodesOf<XmlElement>(document.getElementsByTagName("w:p"))) {
      const position = paragraphText(paragraph).indexOf(placeholder);
      if (position < 0) continue;
      replaceVisibleSpan(document, paragraph, position, position + placeholder.length, instruction, "参考文献表");
      return "placeholder";
    }
  }

  appendBibliographyParagraph(document, complexFieldNodes(document, instruction, "参考文献表"));
  return "appended";
}

function readDocx(src: string): { files: Record<string, Uint8Array>; document: XmlDocument } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(fs.readFileSync(src)));
  } catch (error) {
    throw new DocxFieldsError(`无法读取 docx ZIP: ${error instanceof Error ? error.message : String(error)}`);
  }
  const documentXml = files[DOCUMENT_XML];
  if (!documentXml) throw new DocxFieldsError(`输入不是有效 docx：缺少 ${DOCUMENT_XML}`);
  return { files, document: parseXml(strFromU8(documentXml)) };
}

function writeDocx(out: string, files: Record<string, Uint8Array>, document: XmlDocument): void {
  if (!document.documentElement) throw new DocxFieldsError("document.xml 缺少根元素");
  // xmldom 0.9 对 Document 内 XML 声明 PI 做严格检查时会拒绝；严格序列化根元素后显式补声明。
  const rootXml = new XMLSerializer().serializeToString(document.documentElement, { requireWellFormed: true });
  const serialized = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${rootXml}`;
  // 序列化后再次解析，避免把结构错误写入目标文件。
  parseXml(serialized);
  files[DOCUMENT_XML] = strToU8(serialized);
  const archive = zipSync(files, { level: 6 });
  // 写盘前验证 ZIP 中 document.xml 仍可解析。
  const verification = unzipSync(archive)[DOCUMENT_XML];
  if (!verification) throw new DocxFieldsError(`生成的 docx 缺少 ${DOCUMENT_XML}`);
  parseXml(strFromU8(verification));
  writeFileAtomic(out, archive);
}

export async function writeZoteroDocxFields(
  client: ZoteroClient,
  options: DocxFieldsOptions,
): Promise<DocxFieldsResult> {
  const src = path.resolve(options.src);
  const out = path.resolve(options.out);
  if (src === out) throw new DocxFieldsError("src 与 out 不得为同一路径；工具只生成新文档");

  const map = parseCitationMap(options.mapPath);
  const meta = await client.ensureServerMeta();
  if (map.serverId && map.serverId !== meta.serverId) {
    throw new DocxFieldsError(`cite_map 属于其他 Zotero 数据库（${map.serverId} ≠ ${meta.serverId}）`);
  }
  const orderedKeys = [...new Set(map.markers.flatMap((spec) => spec.keys))];
  const fetched = await client.getCSLBatch(orderedKeys);
  const csls = Object.fromEntries(Object.entries(fetched).filter(([key, csl]) => cslKey(csl) === key));
  const missing = orderedKeys.filter((key) => !csls[key]);
  if (missing.length > 0) {
    throw new DocxFieldsError(`CSL 获取失败，未生成部分引用：${missing.join(", ")}`);
  }
  const userId = userIdFromCsls(csls);

  const { files, document } = readDocx(src);
  const markersReplaced = replaceCitations(document, map.markers, csls, userId, map.biblPlaceholder);
  const bibliography = insertBibliography(document, map.biblPlaceholder, orderedKeys, csls, userId);
  writeDocx(out, files, document);

  return { output: out, markersReplaced, bibliography, itemCount: orderedKeys.length };
}
