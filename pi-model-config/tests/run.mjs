import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const sdkRoot = resolve(process.env.PI_SDK_ROOT ?? "C:/app/scoop/persist/nodejs24/bin/node_modules/@earendil-works/pi-coding-agent");
const sdkPackage = join(sdkRoot, "package.json");

function resolveEnvironmentJiti(sdkRoot, repoRoot) {
  const candidates = [
    join(sdkRoot, "node_modules/jiti/lib/jiti.mjs"),
    join(repoRoot, "node_modules/jiti/lib/jiti.mjs"),
    join(sdkRoot, "..", "..", "jiti/lib/jiti.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("jiti not found under " + sdkRoot + " or " + repoRoot);
}
if (!existsSync(sdkPackage)) throw new Error(`Pi SDK not found: ${sdkPackage}`);

const sdk = createRequire(sdkPackage)(sdkPackage);
if (!/^1.[23]./.test(sdk.version )) throw new Error(`Expected Pi SDK 1.2.0+ (or 1.3.0), found ${sdk.version}`);
process.env.PI_MODEL_CONFIG_TEST_SDK = sdkRoot;

const { createJiti } = await import(pathToFileURL(resolveEnvironmentJiti(sdkRoot, repoRoot)).href);
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
  "i18n-ui-config.test.ts",
  "selector-ui.test.ts",
  "panel-ui.test.ts",
  "config-transaction.test.ts",
  "discovery.test.ts",
  "runtime.test.ts",
  "image-apis.test.ts",
  "model-test.test.ts",
  "context-probe.test.ts",
  "model-editor.test.ts",
  "thinking-probe.test.ts",
  "command.test.ts",
  "auto-probe.test.ts"
]) {
  await jiti.import(join(here, file));
}

console.error(`pi-model-config tests loaded with Pi SDK ${sdk.version} from ${sdkRoot}`);
