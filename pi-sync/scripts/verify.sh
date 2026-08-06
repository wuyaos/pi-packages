#!/usr/bin/env bash
# Full pi-sync verification. The WebDAV smoke portion is deliberately guarded
# by PI_SYNC_SMOKE_WRITE=1 in smoke-webdav.ts and cleans up its unique objects.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"

node --import tsx --test pi-sync/extensions/sync/*.test.ts

npx tsc --noEmit \
	--target ES2022 \
	--module NodeNext \
	--moduleResolution NodeNext \
	--strict \
	--skipLibCheck \
	--types node \
	--allowImportingTsExtensions \
	pi-sync/extensions/sync/*.ts \
	pi-sync/scripts/smoke-webdav.ts

node --import tsx -e 'import("./pi-sync/extensions/sync/index.ts").then(() => console.log("pi-sync-extension-load-ok"))'

pack_json=$(mktemp)
trap 'rm -f "$pack_json"' EXIT
(
	cd pi-sync
	npm pack --dry-run --json
) > "$pack_json"
python3 - "$pack_json" <<'PY'
import json
import sys

package = json.load(open(sys.argv[1], encoding="utf-8"))[0]
paths = [entry["path"] for entry in package["files"]]
assert "scripts/smoke-webdav.ts" not in paths
assert "scripts/verify.sh" not in paths
assert not any(".test." in path for path in paths)
print(f"pi-sync-pack-ok files={len(paths)} bytes={package['size']}")
PY

node --import tsx pi-sync/scripts/smoke-webdav.ts

git diff --check -- pi-sync README.md AGENTS.md tsconfig.check.json
echo "FINAL_VERIFY_OK"
