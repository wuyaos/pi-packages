import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const sdkRoot = resolve(process.env.PI_SDK_ROOT ?? "C:/Users/wff19/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent");
const sdkPackage = join(sdkRoot, "package.json");
if (!existsSync(sdkPackage)) throw new Error(`Pi SDK not found: ${sdkPackage}`);

const sdk = createRequire(sdkPackage)(sdkPackage);
if (!/^1\.[23]\./.test(sdk.version)) throw new Error(`Expected Pi SDK 1.2.0+, found ${sdk.version}`);

const { createJiti } = await import(pathToFileURL((existsSync(join(sdkRoot, "node_modules/jiti/lib/jiti.mjs")) ? join(sdkRoot, "node_modules/jiti/lib/jiti.mjs") : (existsSync(join(repoRoot ?? ".", "node_modules/jiti/lib/jiti.mjs")) ? join(repoRoot ?? ".", "node_modules/jiti/lib/jiti.mjs") : join(sdkRoot, "..", "..", "jiti/lib/jiti.mjs")))).href);
const dependencyRoot = existsSync(join(sdkRoot, "node_modules/@earendil-works/pi-tui")) ? join(sdkRoot, "node_modules") : resolve(sdkRoot, "..", "..");
const jiti = createJiti(import.meta.url, {
  moduleCache: true,
  alias: {
    "@earendil-works/pi-coding-agent": join(sdkRoot, "dist/index.js"),
    "@earendil-works/pi-agent-core": join(dependencyRoot, "@earendil-works/pi-agent-core/dist/index.js"),
    "@earendil-works/pi-tui": join(dependencyRoot, "@earendil-works/pi-tui/dist/index.js"),
    "@earendil-works/pi-ai/providers/all": join(dependencyRoot, "@earendil-works/pi-ai/dist/providers/all.js"),
    "@earendil-works/pi-ai": join(dependencyRoot, "@earendil-works/pi-ai/dist/compat.js"),
    "undici": join(dependencyRoot, "undici/index.js"),
  },
});

for (const file of [
  "archive.test.ts",
  "config.test.ts",
  "engine.test.ts",
  "i18n.test.ts",
  "index.test.ts",
  "menus.test.ts",
  "multi-select.test.ts",
  "repair.test.ts",
  "restore-panel.test.ts",
  "restore-rows.test.ts",
  "restore.test.ts",
  "webdav.test.ts",
]) {
  await jiti.import(join(here, "..", "extensions", "sync", file));
}

console.error(`pi-sync tests loaded with Pi SDK ${sdk.version} from ${sdkRoot}`);
