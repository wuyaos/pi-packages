import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  applyRepairSelections,
  classifyValuePlatform,
  fallbackHomePortable,
  isWslPath,
  portableHomePath,
  readRepairDocs,
  scanPlatformIssues,
  setValueAtPath,
  type PlatformIssue,
} from "./repair.ts";

// ── classifyValuePlatform ───────────────────────────────────────────────

test("classify detects Windows-specific values", () => {
  for (const [value, key] of [
    ["C:\\Users\\alice\\.pi\\agent", "mcp.servers.fs.command"],
    ["C:/Program Files/node/node.exe", "path"],
    ["D:\\data", "x"],
    ["node.exe", "command"],
    ["tools\\bin\\runner.exe", "command"],
    ["powershell", "shellPath"],
    ["pwsh.exe", "shellPath"],
    ["cmd", "shellPath"],
  ] as const) {
    assert.equal(classifyValuePlatform(value, key), "win", `${value} (${key})`);
  }
});

test("classify detects POSIX-specific values", () => {
  for (const [value, key] of [
    ["/home/alice/.pi/agent", "command"],
    ["/Users/bob/tools/node", "command"],
    ["/root/bin/run", "command"],
    ["bash", "shellPath"],
    ["/usr/bin/zsh", "shellPath"],
  ] as const) {
    assert.equal(classifyValuePlatform(value, key), "posix", `${value} (${key})`);
  }
});

test("classify treats portable and unremarkable values as null", () => {
  for (const [value, key] of [
    ["", "x"],
    ["~/bin/run", "x"],
    ["~/.pi/agent", "x"],
    ["$HOME/bin", "x"],
    ["$PI_WEBDAV_PASS", "webdavPass"],
    ["banana", "x"],
    ["node", "command"],
    ["plain value", "x"],
  ] as const) {
    assert.equal(classifyValuePlatform(value, key), null, `${value} (${key})`);
  }
  // shellPath 反例：未知 shell 不判定。
  assert.equal(classifyValuePlatform("nushell", "shellPath"), null);
});

// ── portableHomePath ────────────────────────────────────────────────────

test("portableHomePath maps values under the platform home directory", () => {
  assert.equal(portableHomePath("/home/alice/.pi/agent/foo", "/home/alice", "linux"), "~/.pi/agent/foo");
  assert.equal(portableHomePath("/home/alice", "/home/alice", "linux"), "~");
  assert.equal(portableHomePath("C:\\Users\\u\\.pi\\x.json", "C:\\Users\\u", "win"), "~/.pi/x.json");
  assert.equal(portableHomePath("C:/Users/u/.pi/x.json", "C:\\Users\\U", "win"), "~/.pi/x.json");
  assert.equal(portableHomePath("/home/bob/x", "/home/alice", "linux"), null);
  assert.equal(portableHomePath("C:\\Users\\other\\x", "C:\\Users\\u", "win"), null);
});

// ── scanPlatformIssues ──────────────────────────────────────────────────

test("scan reports win values on linux and posix values on windows", () => {
  const docs = {
    "mcp.json": { servers: { fs: { command: "C:\\tools\\probe.exe" } } },
    "settings.json": { editor: { shell: "/home/alice/bin/sh" }, terminal: { shellPath: "bash" } },
  };
  const onLinux = scanPlatformIssues(docs, "linux", "/home/alice");
  // /home/alice 与 bash 在 linux 上是本机原生，不报；只有 win 值上报。
  assert.equal(onLinux.length, 1);
  assert.equal(onLinux[0]!.key, "servers.fs.command");
  assert.equal(onLinux[0]!.action, "suggest", "mcp command 的 win 值建议去后缀");
  assert.equal(onLinux[0]!.suggested, "C:\\tools\\probe");

  const onWin = scanPlatformIssues(docs, "win", "C:\\Users\\alice");
  assert.equal(onWin.length, 2, "win 值在 win 上是本机原生，不误报；posix 值与 posix shell 上报");
  const shell = onWin.find((issue) => issue.key === "terminal.shellPath")!;
  assert.equal(shell.action, "suggest", "shellPath 走 suggest（清空用 Pi 默认）");
  assert.equal(shell.suggested, "");
  const other = onWin.find((issue) => issue.key === "editor.shell")!;
  assert.equal(other.action, "manual");
});

test("scan does not flag native posix values on linux and passes portable values", () => {
  const docs = {
    "model-config.json": {
      providers: { x: { baseUrl: "/home/alice/.pi/agent/data", home: "~/config", env: "$VAR/bin" } },
    },
  };
  assert.deepEqual(scanPlatformIssues(docs, "linux", "/home/alice"), []);
});

test("scan maps values under the current home directory to auto ~/ suggestions", () => {
  // 家目录下的 .exe 路径（非 command 叶子）：平台分类为 win，但可从本机
  // homedir 反向映射为 ~/。
  const docs = {
    "mcp.json": { servers: { probe: { cwd: "/Users/alice/tools/probe.exe" } } },
  };
  const issues = scanPlatformIssues(docs, "mac", "/Users/alice");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.action, "auto");
  assert.equal(issues[0]!.suggested, "~/tools/probe.exe");

  // command 叶子优先走命令名映射（suggest 去后缀），不走家目录 auto。
  const command = scanPlatformIssues(
    { "mcp.json": { servers: { probe: { command: "/Users/alice/tools/probe.exe" } } } },
    "mac",
    "/Users/alice",
  );
  assert.equal(command.length, 1);
  assert.equal(command[0]!.action, "suggest");
  assert.equal(command[0]!.suggested, "/Users/alice/tools/probe");

  // 另一平台的绝对路径（linux 值出现在 win 上）：.pi/ 前缀走模式识别 B 升
  // auto；其余（如 shell 路径）无法映射 → manual。
  const posixOnWin = scanPlatformIssues(
    { "settings.json": { theme: { cache: "/home/alice/.pi/agent" }, shell: "/home/alice/bin/sh" } },
    "win",
    "C:\\Users\\u",
  );
  assert.equal(posixOnWin.length, 2);
  const cache = posixOnWin.find((issue) => issue.key === "theme.cache")!;
  assert.equal(cache.action, "auto");
  assert.equal(cache.suggested, "~/.pi/agent");
  const shell = posixOnWin.find((issue) => issue.key === "shell")!;
  assert.equal(shell.action, "manual");
});

// ── setValueAtPath / applyRepairSelections / 幂等 ───────────────────────

test("setValueAtPath sets nested object and array leaves without mutating the input", () => {
  const original = { a: { b: 1 }, list: ["x", "y"] };
  const next = setValueAtPath(original, "a.b", 2) as typeof original;
  assert.equal(next.a.b, 2);
  assert.equal(original.a.b, 1, "原对象不被修改");
  const nextList = setValueAtPath(original, "list.0", "z") as typeof original;
  assert.deepEqual(nextList.list, ["z", "y"]);
  const created = setValueAtPath({}, "x.0.y", true) as any;
  assert.deepEqual(created, { x: [{ y: true }] });
});

test("applyRepairSelections counts fixed/skipped/manual across action types", async () => {
  const issues: PlatformIssue[] = [
    { file: "mcp.json", key: "a.path", value: "C:\\x", valuePlatform: "win", action: "auto", suggested: "~/x" },
    { file: "settings.json", key: "shellPath", value: "powershell", valuePlatform: "win", action: "suggest", suggested: "" },
    { file: "model-config.json", key: "p.path", value: "/home/b/x", valuePlatform: "posix", action: "manual" },
    { file: "mcp.json", key: "b.path", value: "C:\\y", valuePlatform: "win", action: "auto", suggested: "~/y" },
  ];
  const docs = {
    "mcp.json": { a: { path: "C:\\x" }, b: { path: "C:\\y" } } as unknown,
    "settings.json": { shellPath: "powershell" } as unknown,
    "model-config.json": { p: { path: "/home/b/x" } } as unknown,
  };
  const outcome = await applyRepairSelections(docs as never, issues, ["0", "2"], async () => "~/fixed");
  assert.deepEqual({ fixed: outcome.fixed, skipped: outcome.skipped, manual: outcome.manual }, { fixed: 2, skipped: 2, manual: 0 });
  assert.equal(outcome.changedFiles.has("mcp.json"), true);
  assert.equal(outcome.changedFiles.has("model-config.json"), true);
  assert.deepEqual(docs["mcp.json"], { a: { path: "~/x" }, b: { path: "C:\\y" } });
  assert.deepEqual(docs["model-config.json"], { p: { path: "~/fixed" } });
  assert.deepEqual(docs["settings.json"], { shellPath: "powershell" }, "suggest 未勾选不改");

  // manual 编辑取消 → 计人工。
  const cancelled = await applyRepairSelections({} as never, [issues[2]!], ["0"], async () => null);
  assert.deepEqual({ fixed: cancelled.fixed, manual: cancelled.manual }, { fixed: 0, manual: 1 });
});

test("repair round-trip is idempotent: apply suggested fixes then rescan yields none", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-repair-"));
  try {
    // 平台取 mac（homedir /Users/alice）：
    // - 家目录下 .exe → auto（转 ~/）
    // - win 盘符路径 → manual（编辑后写入）
    // - shellPath powershell.exe → suggest（清空）
    fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
      servers: {
        probe: { command: "/Users/alice/tools/probe.exe" },
        win: { cwd: "C:\\tools\\probe" },
      },
    }));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ shell: { shellPath: "powershell.exe" } }));

    let docs = readRepairDocs(agentDir);
    let issues = scanPlatformIssues(docs, "mac", "/Users/alice");
    assert.equal(issues.length, 3);
    assert.ok(issues.every((issue) => issue.valuePlatform === "win"));

    const outcome = await applyRepairSelections(docs, issues, issues.map((_, i) => String(i)), async (issue) =>
      issue.action === "manual" ? "~/tools/probe" : undefined);
    assert.equal(outcome.fixed, 3);
    for (const file of outcome.changedFiles) {
      fs.writeFileSync(path.join(agentDir, file), JSON.stringify(docs[file], null, 2));
    }

    docs = readRepairDocs(agentDir);
    issues = scanPlatformIssues(docs, "mac", "/Users/alice");
    assert.deepEqual(issues, [], "修复后再扫描应为 0 项");
    const mcp = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf8"));
    assert.equal(mcp.servers.probe.command, "/Users/alice/tools/probe", "command 建议：去后缀（非 home 映射）");
    assert.equal(mcp.servers.win.cwd, "~/tools/probe");
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.shell.shellPath, "");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("win values on linux all surface as manual or suggest, none as auto", () => {
  const docs = {
    "mcp.json": { servers: { fs: { command: "C:\\tools\\probe.exe", cwd: "C:\\Users\\alice\\x" } } },
  };
  const issues = scanPlatformIssues(docs, "linux", "/home/alice");
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.action !== "auto"), "win 路径在 linux 无法映射家目录，不产生 auto");
});

// ── 源 home 映射（manifest meta 的 sourceHome）──────────────────────────

test("sourceHome maps foreign-home values to portable ~/ form across OSes", () => {
  // win 归档恢复到 linux：sourceHome 为 win 家目录。
  assert.equal(portableHomePath("C:\\Users\\bob\\.pi\\agent\\mcp.json", "/home/alice", "win", "C:\\Users\\bob"), "~/.pi/agent/mcp.json");
  // 正斜杠 win 路径与 sourceHome 也归一匹配。
  assert.equal(portableHomePath("C:/Users/bob/.agents/skills/x", "/home/alice", "win", "C:/Users/Bob"), "~/.agents/skills/x");
  // linux 归档恢复到 win（值平台 posix，sourceHome 为 posix 家目录）。
  assert.equal(portableHomePath("/home/bob/.pi/x.json", "C:\\Users\\u", "posix", "/home/bob"), "~/.pi/x.json");
  // 用户名不同：只有以 sourceHome 开头的值才映射。
  assert.equal(portableHomePath("C:\\Users\\carol\\.pi\\x", "/home/alice", "win", "C:\\Users\\bob"), null);
  assert.equal(portableHomePath("/home/carol/.pi/x", "/home/alice", "posix", "/home/bob"), null);
});

test("scan uses sourceHome for auto mapping regardless of current platform", () => {
  const docs = {
    "settings.json": { theme: { cache: "C:\\Users\\bob\\.pi\\agent\\cache" } },
  };
  const issues = scanPlatformIssues(docs, "linux", "/home/alice", "C:\\Users\\bob");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.action, "auto", "sourceHome 命中即 auto");
  assert.equal(issues[0]!.suggested, "~/.pi/agent/cache");

  // sourceHome 未命中时回落模式识别。
  const miss = scanPlatformIssues(
    { "settings.json": { theme: { cache: "C:\\Users\\carol\\.pi\\x" } } },
    "linux",
    "/home/alice",
    "C:\\Users\\bob",
  );
  assert.equal(miss.length, 1);
  assert.equal(miss[0]!.action, "auto", "模式识别 B 的 .pi/ 前缀仍 auto");
  assert.equal(miss[0]!.suggested, "~/.pi/x");

  // 不传 sourceHome（修复命令独立运行）时行为一致。
  const noMeta = scanPlatformIssues(docs, "linux", "/home/alice");
  assert.equal(noMeta.length, 1);
  assert.equal(noMeta[0]!.action, "auto");
  assert.equal(noMeta[0]!.suggested, "~/.pi/agent/cache");
});

// ── 模式识别 B（无 meta 的保守回落）─────────────────────────────────────

test("fallbackHomePortable only promotes .pi/.agents/.config rests", () => {
  // win → linux。
  assert.equal(fallbackHomePortable("C:\\Users\\bob\\.pi\\agent\\settings.json", "win"), "~/.pi/agent/settings.json");
  assert.equal(fallbackHomePortable("C:/Users/bob/.config/myapp/x.jsonc", "win"), "~/.config/myapp/x.jsonc");
  assert.equal(fallbackHomePortable("C:\\Users\\bob\\Documents\\report.docx", "win"), null, "非配置目录前缀不给 auto");
  assert.equal(fallbackHomePortable("C:\\Git\\repo\\file", "win"), null, "非用户 home 前缀不匹配");
  // linux → win。
  assert.equal(fallbackHomePortable("/home/bob/.agents/skills/run.sh", "posix"), "~/.agents/skills/run.sh");
  assert.equal(fallbackHomePortable("/Users/bob/.pi/agent", "posix"), "~/.pi/agent");
  assert.equal(fallbackHomePortable("/home/bob/projects/x", "posix"), null);
  assert.equal(fallbackHomePortable("/root/.pi/x", "posix"), null, "/root 不在模式识别 B 内");
});

// ── mcp.json 命令名映射 ─────────────────────────────────────────────────

test("command values get suggest-level suffix stripping and cmd /c removal", () => {
  const docs = {
    "mcp.json": {
      servers: {
        a: { command: "node.exe" },
        b: { command: "npx.cmd" },
        c: { command: "run.bat" },
        d: { command: "cmd /c npx.cmd -y pkg" },
        e: { command: ["cmd", "/c", "npx.cmd", "-y", "pkg"] },
        f: { command: ["node.exe", "server.js"] },
        g: { command: "C:\\Program Files\\node\\node.exe" },
      },
    },
  };
  const issues = scanPlatformIssues(docs, "linux", "/home/alice");
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  assert.equal(byKey.get("servers.a.command")!.action, "suggest");
  assert.equal(byKey.get("servers.a.command")!.suggested, "node");
  assert.equal(byKey.get("servers.b.command")!.suggested, "npx");
  assert.equal(byKey.get("servers.c.command")!.suggested, "run");
  assert.equal(byKey.get("servers.d.command")!.suggested, "npx -y pkg");
  const arrayIssue = byKey.get("servers.e.command")!;
  assert.equal(arrayIssue.action, "suggest");
  assert.equal(arrayIssue.isArrayValue, true);
  assert.deepEqual(JSON.parse(arrayIssue.suggested!), ["npx", "-y", "pkg"]);
  assert.equal(byKey.get("servers.f.command")!.action, "suggest");
  assert.deepEqual(JSON.parse(byKey.get("servers.f.command")!.suggested!), ["node", "server.js"]);
  assert.equal(byKey.get("servers.g.command")!.action, "suggest", "带路径的命令同样去后缀后交人工审阅");

  // 非 mcp.json 的 command 字段不做命令名映射（走通用路径规则）。
  const otherFile = scanPlatformIssues(
    { "settings.json": { run: { command: "node.exe" } } },
    "linux",
    "/home/alice",
  );
  assert.equal(otherFile.length, 1);
  assert.equal(otherFile[0]!.action, "manual", "非 mcp.json 不去后缀");
});

test("posix command values on windows surface as manual", () => {
  const issues = scanPlatformIssues(
    {
      "mcp.json": {
        servers: {
          a: { command: "/home/bob/bin/node" },
          b: { command: ["/Users/bob/tools/node", "server.js"] },
        },
      },
    },
    "win",
    "C:\\Users\\u",
  );
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.action === "manual"), "不确定目标 shell，列人工");
});

test("applyRepairSelections writes parsed arrays for array-valued command issues", async () => {
  const issues: PlatformIssue[] = [
    {
      file: "mcp.json",
      key: "servers.e.command",
      value: JSON.stringify(["cmd", "/c", "npx.cmd", "-y", "pkg"]),
      valuePlatform: "win",
      action: "suggest",
      suggested: JSON.stringify(["npx", "-y", "pkg"]),
      isArrayValue: true,
    },
  ];
  const docs = {
    "mcp.json": { servers: { e: { command: ["cmd", "/c", "npx.cmd", "-y", "pkg"] } } as unknown },
  };
  const outcome = await applyRepairSelections(docs as never, issues, ["0"]);
  assert.equal(outcome.fixed, 1);
  assert.deepEqual((docs["mcp.json"] as any).servers.e.command, ["npx", "-y", "pkg"]);

  // manual 编辑非数组 JSON → 计人工，不写坏结构。
  const manual = await applyRepairSelections(
    { "mcp.json": { servers: { e: { command: ["cmd"] } } as unknown } } as never,
    [{ ...issues[0]!, action: "manual", suggested: undefined }],
    ["0"],
    async () => "not-json",
  );
  assert.deepEqual({ fixed: manual.fixed, manual: manual.manual }, { fixed: 0, manual: 1 });
});

test("command suggestion round-trip is idempotent after apply", () => {
  const docs = {
    "mcp.json": { servers: { e: { command: ["cmd", "/c", "npx.cmd", "-y", "pkg"] } } },
  };
  const first = scanPlatformIssues(docs as never, "linux", "/home/alice");
  assert.equal(first.length, 1);
  const applied = JSON.parse(first[0]!.suggested!);
  (docs["mcp.json"] as any).servers.e.command = applied;
  assert.deepEqual(scanPlatformIssues(docs as never, "linux", "/home/alice"), [], "npx -y pkg 为可移植值，再扫描为 0 项");
});

// ── WSL 路径识别 ────────────────────────────────────────────────────────

test("WSL paths are flagged manual with the wsl marker and never auto-rewritten", () => {
  assert.equal(isWslPath("\\\\wsl$\\Ubuntu-22.04\\home\\u\\.pi\\agent", "win"), true);
  assert.equal(isWslPath("\\\\wsl.localhost\\Debian\\home\\u\\x", "win"), true);
  assert.equal(isWslPath("C:\\Users\\u\\.pi\\agent", "win"), false);
  assert.equal(isWslPath("/mnt/c/Users/u/.pi/agent", "posix"), true);
  assert.equal(isWslPath("/mnt/d/blob", "posix"), true);
  assert.equal(isWslPath("/mnt/data/blob", "posix"), false, "多字母目录不是驱动器挂载");
  assert.equal(isWslPath("/home/u/.pi/agent", "posix"), false);

  // win 的 \\wsl$ 值在 linux 上上报；/mnt/x/ 是 posix 值，只在 win 平台上报。
  const issues = scanPlatformIssues(
    { "mcp.json": { servers: { w: { cwd: "\\\\wsl$\\Ubuntu\\home\\u\\.pi\\agent" } } } },
    "linux",
    "/home/alice",
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.action, "manual");
  assert.equal(issues[0]!.wsl, true);

  const mntOnWin = scanPlatformIssues(
    { "settings.json": { theme: { cache: "/mnt/c/Users/u/.pi/agent" } } },
    "win",
    "C:\\Users\\u",
  );
  assert.equal(mntOnWin.length, 1);
  assert.equal(mntOnWin[0]!.action, "manual", "/mnt/ 路径不 auto 改写");
  assert.equal(mntOnWin[0]!.wsl, true);

  // 即使落在 sourceHome 命中范围内也不升级为 auto。
  const underSourceHome = scanPlatformIssues(
    { "mcp.json": { servers: { w: { cwd: "\\\\wsl$\\Ubuntu\\home\\u\\.pi\\x" } } } },
    "linux",
    "/home/alice",
    "\\\\wsl$\\Ubuntu\\home\\u",
  );
  assert.equal(underSourceHome.length, 1);
  assert.equal(underSourceHome[0]!.action, "manual");
  assert.equal(underSourceHome[0]!.wsl, true);
});

test("classify recognizes WSL and /mnt paths and extra Windows extensions", () => {
  assert.equal(classifyValuePlatform("\\\\wsl$\\Ubuntu\\x", "x"), "win");
  assert.equal(classifyValuePlatform("\\\\wsl.localhost\\Ubuntu\\x", "x"), "win");
  assert.equal(classifyValuePlatform("/mnt/c/tools/x", "x"), "posix");
  assert.equal(classifyValuePlatform("/mnt/data/x", "x"), null, "多字母目录不判 posix");
  assert.equal(classifyValuePlatform("npx.cmd", "command"), "win");
  assert.equal(classifyValuePlatform("run.bat", "command"), "win");
});
