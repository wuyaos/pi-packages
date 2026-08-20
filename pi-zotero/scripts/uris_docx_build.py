#!/usr/bin/env python3
"""uris Word 域实测闭环 — 步骤 1：构造含 ZOTERO_ITEM/BIBL 域的 test.docx。

关键设计（源码论证 + skill 踩坑对齐）：
- citationItems[].id 用占位 0（非真 itemID），uris 正确 → Zotero 刷新时 uris 优先解析（integration.js loadItemData）
- run 平级不嵌套；instrText 只转义 & 和 <；前导+尾随空格 " ADDIN ... "
- itemData 从 Local API csljson 获取（嵌套包裹）
"""
import json
import sys
import zipfile
import urllib.request

USER_ID = "6207753"
API = f"http://127.0.0.1:23119/api/users/0"
H = {"User-Agent": "uris-test/1.0", "Zotero-API-Version": "3"}
SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"

KEYS = ["CDW8SSDB", "IBETXJZJ"]


def fetch_csl(key: str) -> dict:
    req = urllib.request.Request(f"{API}/items/{key}?format=csljson", headers=H)
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read())
        return d[0] if isinstance(d, list) else d


def xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;")


def citation_item(key: str, csl: dict) -> dict:
    item_data = {k: v for k, v in csl.items() if k not in ("id", "uris")}
    item_data["id"] = 0  # 占位；刷新后 Zotero 回填真 itemID
    return {
        "id": 0,
        "uris": [f"http://zotero.org/users/{USER_ID}/items/{key}"],
        "itemData": item_data,
    }


def field_runs(instr_text: str, display: str, rpr: str = "") -> str:
    instr = " ADDIN " + instr_text + " "
    return "".join([
        f"<w:r>{rpr}<w:fldChar w:fldCharType=\"begin\"/></w:r>",
        f"<w:r>{rpr}<w:instrText xml:space=\"preserve\">{xml_escape(instr)}</w:instrText></w:r>",
        f"<w:r>{rpr}<w:fldChar w:fldCharType=\"separate\"/></w:r>",
        f"<w:r>{rpr}<w:t>{xml_escape(display)}</w:t></w:r>",
        f"<w:r>{rpr}<w:fldChar w:fldCharType=\"end\"/></w:r>",
    ])


def build_docx(csls: dict[str, dict], out: str) -> None:
    # 两个引用域（占位 id=0 + 正确 uris）
    cit_json = {
        "citationID": "citURISTest1",
        "properties": {"unsorted": False, "formattedCitation": "[1]", "plainCitation": "[1]", "noteIndex": 0},
        "citationItems": [citation_item(KEYS[0], csls[KEYS[0]])],
        "schema": SCHEMA,
    }
    cit_json2 = {
        "citationID": "citURISTest2",
        "properties": {"unsorted": False, "formattedCitation": "[2]", "plainCitation": "[2]", "noteIndex": 0},
        "citationItems": [citation_item(KEYS[1], csls[KEYS[1]])],
        "schema": SCHEMA,
    }
    bibl_json = {
        "citationID": "biblURISTest",
        "properties": {"noteIndex": 0},
        "citationItems": [citation_item(k, csls[k]) for k in KEYS],
        "schema": SCHEMA,
    }
    body = (
        '<w:body xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:p><w:r><w:t>uris 实测：引用域 id 占位 0，刷新后应回填真 itemID。</w:t></w:r></w:p>"
        "<w:p>" + field_runs(f"ZOTERO_ITEM CSL_CITATION {json.dumps(cit_json, ensure_ascii=False)}", "[1]") + "</w:p>"
        "<w:p>" + field_runs(f"ZOTERO_ITEM CSL_CITATION {json.dumps(cit_json2, ensure_ascii=False)}", "[2]") + "</w:p>"
        "<w:p>参考文献表占位（下方 BIBL 域刷新后生成）。</w:p>"
        "<w:p>" + field_runs(f"ZOTERO_BIBL CSL_BIBLIOGRAPHY {json.dumps(bibl_json, ensure_ascii=False)}", "（参考文献表）") + "</w:p>"
        "</w:body>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/uris_test.docx"
    csls = {k: fetch_csl(k) for k in KEYS}
    build_docx(csls, out)
    print(f"已生成 {out}（2 个引用域 id=0 + BIBL 域）")
    # 良构验证
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(out) as z:
        ET.fromstring(z.read("word/document.xml"))
    print("XML 良构 ✅")


if __name__ == "__main__":
    main()
