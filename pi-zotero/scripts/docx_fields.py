#!/usr/bin/env python3
"""docx 方括号引用标记 → Zotero 动态域（uris 方案版，无需整数 itemID）。

对齐 zotero-word-field-insert skill 的 OOXML 踩坑约束：
  1. 每个 fldChar/instrText/display 独占一个 <w:r>，平级不嵌套
  2. instrText 只转义 & 和 <（引号直出）
  3. instrText 前导+尾随空格 " ADDIN ... "
  4. BIBL instrText 不含前导 ADDIN（complex_field 统一加）
uris 方案（实测通过，Zotero 10.0）：citationItems[].id 用占位 0，
刷新时 Zotero 用 uris 解析条目并回填真 itemID。

用法:
  python3 docx_fields.py --src in.docx --out out.docx --map cite_map.json
cite_map.json: {"markers": [{"marker": "[8-13]", "keys": ["2YXT3NVJ", ...]}]}
（zotero_build_map 产物格式；USER_ID 从 Local API 自动获取）

限制: marker 须在单个 <w:r> 内（Word 排版拆 run 的标记会报 not found）。
"""
import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

API = "http://127.0.0.1:23119/api/users/0"
H = {"Accept": "application/json", "User-Agent": "pi-zotero-docx/1.0", "Zotero-API-Version": "3"}
SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"


def xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;")


def make_run(rpr: str, inner: str) -> str:
    return f"<w:r>{rpr}{inner}</w:r>"


def complex_field(instr_text: str, display_text: str, rpr: str) -> str:
    instr = " ADDIN " + instr_text + " "
    return "".join([
        make_run(rpr, '<w:fldChar w:fldCharType="begin"/>'),
        make_run(rpr, f'<w:instrText xml:space="preserve">{xml_escape(instr)}</w:instrText>'),
        make_run(rpr, '<w:fldChar w:fldCharType="separate"/>'),
        make_run(rpr, f'<w:t>{xml_escape(display_text)}</w:t>'),
        make_run(rpr, '<w:fldChar w:fldCharType="end"/>'),
    ])


def get_user_id() -> str:
    """从 Local API 取当前用户 ID（csljson id 形如 http://zotero.org/users/<uid>/items/<KEY>）"""
    req = urllib.request.Request(API + "/items?limit=1&format=csljson", headers=H)
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read())
        m = re.search(r"/users/(\d+)/items/", d[0]["id"])
        return m.group(1) if m else "0"


def fetch_csl_batch(keys: list[str], user_id: str, cache: dict) -> tuple[dict, list[str]]:
    """批量取 CSL（itemKey + format=csljson；limit 必须 ≥ 请求数+children 余量；过滤请求 keys）"""
    out, failed = {}, []
    requested = set(keys)
    for i in range(0, len(keys), 50):
        page = keys[i:i + 50]
        cached = {k: cache[k] for k in page if k in cache}
        out.update(cached)
        missing = [k for k in page if k not in cache]
        if not missing:
            continue
        url = API + "/items?limit=100&start=0&format=csljson&itemKey=" + ",".join(missing)
        req = urllib.request.Request(url, headers=H)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                csls = json.loads(r.read())
        except Exception as e:
            failed.extend(missing)
            print(f"CSL fetch FAIL batch: {e}")
            continue
        for c in csls:
            m = re.search(r"/items/([A-Z0-9]{8})$", c.get("id", ""))
            if m and m.group(1) in requested:
                out[m.group(1)] = c
                cache[m.group(1)] = c
        for k in missing:
            if k not in out:
                failed.append(k)
    return out, failed


def citation_item(key: str, csl: dict, user_id: str) -> dict:
    item_data = {k: v for k, v in csl.items() if k not in ("id", "uris")}
    item_data["id"] = 0  # 占位；刷新时 Zotero 回填真 itemID（uris 方案实测）
    return {"id": 0, "uris": [f"http://zotero.org/users/{user_id}/items/{key}"], "itemData": item_data}


def build_citation_json(marker: str, keys: list[str], csls: dict, user_id: str) -> str:
    cits = [citation_item(k, csls[k], user_id) for k in keys]
    cit = {
        "citationID": "cit" + str(abs(hash(marker)) % 10 ** 12),
        "properties": {"unsorted": False, "formattedCitation": marker, "plainCitation": marker, "noteIndex": 0},
        "citationItems": cits,
        "schema": SCHEMA,
    }
    return json.dumps(cit, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--map", required=True, help="cite_map.json（markers:[{marker,keys}]）")
    ap.add_argument("--csl-cache", help="可选 CSL 缓存 JSON 路径")
    args = ap.parse_args()

    cmap = json.load(open(args.map, encoding="utf-8"))
    markers = cmap["markers"]
    bibl_placeholder = cmap.get("bibl_placeholder", "（此处由 Zotero 插入参考文献表）")
    cache = {}
    if args.csl_cache and os.path.exists(args.csl_cache):
        cache = json.load(open(args.csl_cache, encoding="utf-8"))

    user_id = get_user_id()
    all_keys = sorted({k for m in markers for k in m["keys"]})
    csls, failed = fetch_csl_batch(all_keys, user_id, cache)

    shutil.copy2(args.src, args.out)
    with zipfile.ZipFile(args.out) as z:
        doc = z.read("word/document.xml").decode("utf-8")

    replaced, not_found = 0, []
    for m in markers:
        marker, keys = m["marker"], [k for k in m["keys"] if k in csls]
        if not keys:
            not_found.append(marker)
            print(f"skip {marker}: 无可用 CSL（keys 全部缺失）")
            continue
        idx = doc.find(marker)
        if idx < 0:
            not_found.append(marker)
            print(f"marker not found in doc: {marker}")
            continue
        rstart = doc.rfind("<w:r>", 0, idx)
        rend = doc.find("</w:r>", idx) + len("</w:r>")
        old_run = doc[rstart:rend]
        rpr_m = re.search(r"<w:rPr>.*?</w:rPr>", old_run, re.DOTALL)
        rpr = rpr_m.group(0) if rpr_m else ""
        cit_json = build_citation_json(marker, keys, csls, user_id)
        doc = doc[:rstart] + complex_field(f"ZOTERO_ITEM CSL_CITATION {cit_json}", marker, rpr) + doc[rend:]
        replaced += 1
        print(f"replaced {marker} -> {len(keys)} items")

    # BIBL 域：完整 CSL_BIBLIOGRAPHY JSON（含 citationItems，uris_docx_build 实测格式；
    # 空结构 {"uncited":[]} 刷新后域被 Zotero 丢弃——实测）
    bibl_json = {
        "citationID": "biblDocxFields",
        "properties": {"noteIndex": 0},
        "citationItems": [citation_item(k, csls[k], user_id) for k in all_keys if k in csls],
        "schema": SCHEMA,
    }
    bibl_field = complex_field(f'ZOTERO_BIBL CSL_BIBLIOGRAPHY {json.dumps(bibl_json, ensure_ascii=False)}', "参考文献表", rpr="")
    idx = doc.find(bibl_placeholder)
    if idx >= 0:
        rstart = doc.rfind("<w:r>", 0, idx)
        rend = doc.find("</w:r>", idx) + len("</w:r>")
        doc = doc[:rstart] + bibl_field + doc[rend:]
        print(f"BIBL inserted at placeholder")
    else:
        print(f"WARNING bibl_placeholder not found: {bibl_placeholder}")

    # 写回 zip
    tmp = args.out + ".tmp"
    with zipfile.ZipFile(args.out) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                data = doc.encode("utf-8")
            zout.writestr(item, data)
    os.replace(tmp, args.out)

    if args.csl_cache:
        open(args.csl_cache, "w", encoding="utf-8").write(json.dumps(cache, ensure_ascii=False, indent=2))

    try:
        ET.fromstring(doc)
        xml_ok = True
    except ET.ParseError as e:
        xml_ok = False
        print("XML PARSE ERROR:", e)
    print(f"xml_ok={xml_ok} markers_replaced={replaced} not_found={not_found} "
          f"ZOTERO_ITEM={doc.count('ZOTERO_ITEM')} ZOTERO_BIBL={doc.count('ZOTERO_BIBL')} "
          f"ADDIN_ADDIN_dup={doc.count('ADDIN ADDIN')}")
    if failed:
        print(f"WARNING CSL 获取失败: {failed}")
    print(f"output={args.out}")
    sys.exit(0 if xml_ok else 1)


if __name__ == "__main__":
    main()
