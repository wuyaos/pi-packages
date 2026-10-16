import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  applyRepairSelections,
  classifyValuePlatform,
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
  assert.equal(onLinux[0]!.action, "manual", "另一操作系统的绝对路径无法映射，列人工");

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
  // 家目录下的 .exe 路径：平台分类为 win，但可从本机 homedir 反向映射为 ~/。
  const docs = {
    "mcp.json": { servers: { probe: { command: "/Users/alice/tools/probe.exe" } } },
  };
  const issues = scanPlatformIssues(docs, "mac", "/Users/alice");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.action, "auto");
  assert.equal(issues[0]!.suggested, "~/tools/probe.exe");

  // 另一平台的绝对路径（linux 值出现在 win 上）无法映射 → manual。
  const posixOnWin = scanPlatformIssues(
    { "settings.json": { theme: { cache: "/home/alice/.pi/agent" } } },
    "win",
    "C:\\Users\\u",
  );
  assert.equal(posixOnWin.length, 1);
  assert.equal(posixOnWin[0]!.action, "manual");
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
    assert.equal(mcp.servers.probe.command, "~/tools/probe.exe");
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
