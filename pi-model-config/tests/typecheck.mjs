import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..");
const sdkRoot = resolve(process.env.PI_SDK_ROOT ?? "C:/Users/wff19/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent");
const sdkPackage = join(sdkRoot, "package.json");
const tsc = join(repoRoot, "node_modules/typescript/bin/tsc");
const undiciTypes = existsSync(join(packageRoot, "node_modules/undici/index.d.ts")) ? join(packageRoot, "node_modules/undici/index.d.ts") : join(resolve(sdkRoot, "..", ".."), "undici/index.d.ts");

for (const required of [sdkPackage, tsc, undiciTypes]) {
  if (!existsSync(required)) throw new Error(`Required test dependency not found: ${required}`);
}
const sdk = createRequire(sdkPackage)(sdkPackage);
if (!/^1\.[23]\./.test(sdk.version)) throw new Error(`Expected Pi SDK 1.2.0+, found ${sdk.version}`);

const dependencyRoot = existsSync(join(sdkRoot, "node_modules/@earendil-works/pi-tui")) ? join(sdkRoot, "node_modules") : resolve(sdkRoot, "..", "..");
const files = [
  join(packageRoot, "extensions/model-config.ts"),
  ...readdirSync(join(packageRoot, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(packageRoot, "src", entry.name)),
  ...readdirSync(here, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(here, entry.name)),
];
const tempDir = mkdtempSync(join(tmpdir(), "pi-model-config-typecheck-"));
const configPath = join(tempDir, "tsconfig.json");

try {
  writeFileSync(configPath, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ["node"],
      typeRoots: [join(repoRoot, "node_modules/@types"), join(dependencyRoot, "@types")],
      baseUrl: repoRoot,
      paths: {
        "@earendil-works/pi-coding-agent": [join(sdkRoot, "dist/index.d.ts")],
        "@earendil-works/pi-agent-core": [join(dependencyRoot, "@earendil-works/pi-agent-core/dist/index.d.ts")],
        "@earendil-works/pi-tui": [join(dependencyRoot, "@earendil-works/pi-tui/dist/index.d.ts")],
        "@earendil-works/pi-ai": [join(dependencyRoot, "@earendil-works/pi-ai/dist/compat.d.ts")],
        "@earendil-works/pi-ai/providers/all": [join(dependencyRoot, "@earendil-works/pi-ai/dist/providers/all.d.ts")],
        "@earendil-works/pi-ai/*": [join(dependencyRoot, "@earendil-works/pi-ai/dist/*.d.ts")],
        undici: [undiciTypes],
      },
    },
    files,
  }, null, 2)}\n`, "utf8");

  const result = spawnSync(process.execPath, [tsc, "-p", configPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  console.log(`TYPECHECK_SDK_VERSION=${sdk.version}`);
  console.log(`TYPECHECK_FILE_COUNT=${files.length}`);
  console.log(`TYPECHECK_RESULT=${status === 0 ? "pass" : "fail"}`);
  process.exitCode = status;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
