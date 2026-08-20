#!/usr/bin/env python3
"""Zotero 10 Local API 回归探测（pi-zotero 依赖行为基线）。

用法: python3 scripts/zotero_api_probe.py [--json out.json]
前提: Windows 端 Zotero 10 运行中。只读，不触发写授权弹窗。
Zotero 升级后必须重跑（版本断言会响亮提醒行为基线变化）。
"""
import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request

API_ROOT = "http://127.0.0.1:23119/api"
USER_BASE = f"{API_ROOT}/users/0"
H = {"Accept": "application/json", "User-Agent": "zotero-api-probe/2.0",
     "Zotero-API-Version": "3"}
BASE_VERSION = "10"          # 行为基线：10.x 实测
TEST_COLLECTION = "P5Y3KVB7"  # 已知集合
KNOWN_KEY = "CDW8SSDB"
KNOWN_PARENT = "IBETXJZJ"
FULLTEXT_KEY = "KFG8ZBKE"


def req(base, path, params=None, headers=None, method="GET", body=None):
    qs = "?" + urllib.parse.urlencode(params) if params else ""
    r = urllib.request.Request(base + path + qs, headers={**H, **(headers or {})},
                               method=method, data=body)
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=30) as res:
            return {"status": res.status, "headers": dict(res.headers),
                    "body": res.read(), "ms": int((time.time() - t0) * 1000)}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "headers": dict(e.headers), "body": e.read(),
                "ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"status": None, "headers": {}, "body": str(e).encode(), "ms": 0}


def j(r):
    try:
        return json.loads(r["body"])
    except Exception:
        return None


def section(name):
    print(f"\n=== {name} ===")
    return {"name": name, "checks": []}


def check(out, name, ok, detail, data=None):
    out["checks"].append({"name": name, "ok": bool(ok), "detail": detail, "data": data})
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} — {detail}")


report = {"generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "sections": []}

# ── 0. 版本断言（升级护栏） ───────────────────────────────
s = section("0. 版本断言")
r = req(API_ROOT, "/")
sid = r["headers"].get("Zotero-Server-ID")
ver = r["headers"].get("X-Zotero-Version", "?")
check(s, f"版本基线 {BASE_VERSION}.x", ver.startswith(BASE_VERSION),
      f"X-Zotero-Version={ver}（≠ {BASE_VERSION} 时必须审查 API 行为变更）")
check(s, "Server-ID 存在", r["status"] == 200 and bool(sid),
      f"status={r['status']} Server-ID={sid} Zotero-API-Version={r['headers'].get('Zotero-API-Version')}")
report["sections"].append(s)

# ── 1. 集合 ──────────────────────────────────────────────
s = section("1. 集合")
r = req(USER_BASE, "/collections", {"limit": "100"})
d = j(r) or []
has_parent = any(c["data"].get("parentCollection") for c in d)
check(s, "collections 列表+层级", r["status"] == 200 and len(d) > 0 and has_parent,
      f"count={len(d)} 有父子层级={has_parent}")
r = req(USER_BASE, "/collections/top", {"limit": "5"})
check(s, "collections/top", r["status"] == 200 and len(j(r) or []) > 0, f"count={len(j(r) or [])}")
report["sections"].append(s)

# ── 2. collection= 参数（预期无效）+ 集合条目端点 ──────────
s = section("2. 集合条目路径")
r = req(USER_BASE, "/items", {"collection": TEST_COLLECTION, "limit": "100"})
d_coll = j(r) or []
r2 = req(USER_BASE, "/items", {"limit": "100"})
d_all = j(r2) or []
same = [x["key"] for x in d_coll] == [x["key"] for x in d_all]
check(s, "collection= 参数无效（与全库一致）", same,
      f"collection= 返回与全库前100条一致={same} → 必须用 /collections/:key/items")
coll_items = []
for start in range(0, 5000, 100):
    r = req(USER_BASE, f"/collections/{TEST_COLLECTION}/items", {"limit": "100", "start": str(start)})
    page = j(r) or []
    coll_items.extend(page)
    if len(page) < 100:
        break
kinds = {}
for it in coll_items:
    t = it["data"].get("itemType", "?")
    kinds[t] = kinds.get(t, 0) + 1
top = [it for it in coll_items if TEST_COLLECTION in it["data"].get("collections", [])]
check(s, "集合端点可用+含 children", len(coll_items) > len(top) > 50,
      f"总 {len(coll_items)} = 顶层 {len(top)}，构成 {kinds}")
report["sections"].append(s)

# ── 3. itemKey / CSL ─────────────────────────────────────
s = section("3. itemKey 与 csljson")
r = req(USER_BASE, "/items", {"itemKey": f"{KNOWN_KEY},{KNOWN_PARENT}", "format": "csljson", "limit": "100"})
d = j(r) or []
keys = [x["id"].split("/")[-1] for x in d]
check(s, "itemKey+csljson（limit 必须 ≥ 请求数+children）",
      r["status"] == 200 and KNOWN_KEY in keys and KNOWN_PARENT in keys,
      f"请求2key 返回 {len(d)} 条: {keys}")
extra = [k for k in keys if k not in (KNOWN_KEY, KNOWN_PARENT)]
check(s, "混入 children（客户端需过滤）", len(extra) > 0, f"混入 {extra}")
report["sections"].append(s)

# ── 4. 搜索 / since ──────────────────────────────────────
s = section("4. 搜索与增量")
r = req(USER_BASE, "/items", {"q": "transformer", "qmode": "everything", "limit": "5"})
d = j(r) or []
check(s, "q 全文搜索", r["status"] == 200 and len(d) > 0,
      f"Total={r['headers'].get('Total-Results')} 返回={len(d)}")
r = req(USER_BASE, "/items", {"since": "50", "limit": "5"})
check(s, "since 增量", r["status"] == 200 and isinstance(j(r), list), f"status={r['status']}")
report["sections"].append(s)

# ── 5. fulltext / 附件路径 ───────────────────────────────
s = section("5. fulltext 与附件路径")
r = req(USER_BASE, f"/items/{FULLTEXT_KEY}/fulltext")
d = j(r)
check(s, "fulltext 端点", r["status"] == 200 and isinstance(d, dict) and "content" in d,
      f"keys={list(d.keys()) if d else '-'} content_len={len(str(d.get('content','')))}")
r = req(USER_BASE, f"/items/{FULLTEXT_KEY}/file/view/url")
check(s, "file/view/url", r["status"] == 200 and r["body"].decode().startswith("file:///"),
      f"path={r['body'][:80]!r}")
report["sections"].append(s)

# ── 6. saved searches / tags / note ──────────────────────
s = section("6. searches/tags/note")
r = req(USER_BASE, "/searches", {"limit": "5"})
d = j(r) or []
check(s, "searches 列表", r["status"] == 200 and len(d) > 0, f"count={len(d)}")
if d:
    r2 = req(USER_BASE, f"/searches/{d[0]['key']}/items", {"limit": "3"})
    check(s, "searches/:key/items 执行", r2["status"] == 200 and len(j(r2) or []) > 0,
          f"Total={r2['headers'].get('Total-Results')}")
r = req(USER_BASE, "/tags", {"limit": "5"})
check(s, "tags 列表", r["status"] == 200 and len(j(r) or []) > 0, f"count={len(j(r) or [])}")
report["sections"].append(s)

# ── 7. 错误与边界 ────────────────────────────────────────
s = section("7. 错误与边界")
r = req(USER_BASE, "/items/BADKEY88")
check(s, "坏 key → 404", r["status"] == 404, f"status={r['status']}")
r = req(USER_BASE, "/items", {"limit": "101"})
check(s, "limit 不 clamp（101→101）", len(j(r) or []) == 101, f"len={len(j(r) or [])}")
r = req(USER_BASE, "/items", {"limit": "99999"})
check(s, "limit=99999 → 全库（客户端必须自限）", len(j(r) or []) > 1000, f"len={len(j(r) or [])}")
report["sections"].append(s)

# ── 8. 写协议（不触发弹窗） ──────────────────────────────
s = section("8. 写协议错误路径")
def patch(headers):
    return req(USER_BASE, "/items/BADKEY88",
               headers={"Content-Type": "application/json", **headers},
               method="PATCH", body=json.dumps({"title": "x"}).encode())
r = patch({"If-Unmodified-Since-Version": "1"})
check(s, "无 Server-ID → 428", r["status"] == 428, f"status={r['status']} body={r['body'][:60]!r}")
r = patch({"Zotero-Server-ID": sid or "", "If-Unmodified-Since-Version": "1"})
check(s, "有 SID 无 key → 401", r["status"] == 401
      and "Zotero-API-Key" in (r["headers"].get("WWW-Authenticate") or ""),
      f"status={r['status']} WWW-Auth={r['headers'].get('WWW-Authenticate')}")
report["sections"].append(s)

total = sum(len(x["checks"]) for x in report["sections"])
passed = sum(1 for x in report["sections"] for c in x["checks"] if c["ok"])
print(f"\n{'='*50}\n总检 {total} 项，通过 {passed} 项")
report["summary"] = {"total": total, "passed": passed}

ap = argparse.ArgumentParser()
ap.add_argument("--json", help="输出 JSON 报告路径")
args = ap.parse_args()
if args.json:
    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"报告已写入 {args.json}")
