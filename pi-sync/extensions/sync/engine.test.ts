import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  formatArchiveName,
  parseArchiveName,
  platformCode,
  sanitizeDeviceName,
  toPlatformCode,
} from "./archive-name.ts";
import {
  DEFAULT_REMOTE_BASE_DIR,
  defaultDeviceName,
  normalizeExitBackupScope,
  normalizeRemoteBaseDir,
  webdavDir,
} from "./config.ts";
import {
  computeFingerprint,
  computeStateKey,
  invalidateSyncState,
  readSyncState,
  writeSyncState,
} from "./fingerprint.ts";
import { lockFileSync, unlockFileSync } from "./lock.ts";
import type { SyncConfig } from "./config.ts";
import { pruneOldBackupsInDir } from "./webdav.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── S1 归档命名 ───────────────────────────────────────────────────────────

test("archive name round-trips through parse with UTC timestamp", () => {
  const ts = Date.UTC(2025, 0, 2, 3, 4, 5);
  const name = formatArchiveName("devA", "win", "pi", ts);
  assert.equal(name, "devA-win-pi_20250102-030405.tar.xz");
  const parsed = parseArchiveName(name);
  assert.ok(parsed);
  assert.deepEqual(
    { device: parsed.device, platform: parsed.platform, tag: parsed.tag, ts: parsed.ts.getTime() },
    { device: "devA", platform: "win", tag: "pi", ts },
  );
  // 非 win 平台简码与 device 清洗（含非法字符）在 format 内生效。
  assert.equal(formatArchiveName("my pc", "macos", "skills", ts), "my-pc-mac-skills_20250102-030405.tar.xz");
  // device 段本身含 - 且与平台段同名时仍唯一解析。
  const tricky = parseArchiveName("my-win-win-pi_20250102-030405.tar.xz");
  assert.ok(tricky);
  assert.equal(tricky.device, "my-win");
  assert.equal(tricky.platform, "win");
  assert.equal(tricky.tag, "pi");
});

test("archive name parse strictly rejects malformed and legacy names", () => {
  const invalid = [
    "pi_agent_windows11_20240101T120000Z.tar.xz", // 旧版命名
    "agent_skills_20240101T120000Z.tar.xz",
    "devA-win-pi_20250102-030405.zip",
    "devA-unix-pi_20250102-030405.tar.xz",
    "devA-win-pi_20250102-0304.tar.xz",
    "devA-win-pi_20250102-030405.tar.gz",
    "devA win-pi_20250102-030405.tar.xz",
    "../evil-win-pi_20250102-030405.tar.xz",
    "/abs/devA-win-pi_20250102-030405.tar.xz",
    "devA-win-pi.tar.xz",
    "",
  ];
  for (const name of invalid) assert.equal(parseArchiveName(name), null, `expected null: ${name}`);
});

test("sanitizeDeviceName maps invalid characters and falls back on empty input", () => {
  assert.equal(sanitizeDeviceName("My PC (dev)!"), "My-PC--dev--");
  assert.equal(sanitizeDeviceName("设备甲"), "---");
  assert.match(sanitizeDeviceName(""), /^pi-(win|mac|linux)$/);
  // 平台简码：现值 windows11/macos 映射到简码，未知归 linux。
  assert.equal(toPlatformCode("windows11"), "win");
  assert.equal(toPlatformCode("windows10"), "win");
  assert.equal(toPlatformCode("macos"), "mac");
  assert.equal(toPlatformCode("linux"), "linux");
  assert.equal(toPlatformCode("whatever"), "linux");
  assert.ok(["win", "mac", "linux"].includes(platformCode()));
});

// ── S2 配置 ───────────────────────────────────────────────────────────────

test("remote base dir normalizes safe relative paths and falls back on unsafe ones", () => {
  assert.equal(normalizeRemoteBaseDir(undefined), DEFAULT_REMOTE_BASE_DIR);
  assert.equal(normalizeRemoteBaseDir("backup"), "backup/");
  assert.equal(normalizeRemoteBaseDir("backup/"), "backup/");
  assert.equal(normalizeRemoteBaseDir("a/b.c-d_e"), "a/b.c-d_e/");
  const unsafe = ["/abs", "C:/x", "C:\\x", "a/../b", "..", ".", "a b", "a$b", "备份", ""];
  for (const value of unsafe) assert.equal(normalizeRemoteBaseDir(value), DEFAULT_REMOTE_BASE_DIR, `expected fallback: ${value}`);
  assert.equal(webdavDir("pi", { remoteBaseDir: "backup/" }), "backup/pi/");
  assert.equal(webdavDir("cortexkit", { remoteBaseDir: "deep/dir/" }), "deep/dir/cortexkit/");
});

test("exit backup scope keeps only valid kinds and defaults to all", () => {
  assert.deepEqual(normalizeExitBackupScope(undefined), ["pi", "skills", "cortexkit"]);
  assert.deepEqual(normalizeExitBackupScope(["pi", "pi", "bogus", "skills"]), ["pi", "skills"]);
  assert.deepEqual(normalizeExitBackupScope("nope"), ["pi", "skills", "cortexkit"]);
});

test("default device name is sanitized hostname with platform suffix", () => {
  const device = defaultDeviceName();
  assert.match(device, /^[A-Za-z0-9-]+-(win|mac|linux)$/);
});

// ── S3 fingerprint 与状态 ─────────────────────────────────────────────────

test("fingerprint detects single-file changes and ignores log/pycache noise", () => {
  const root = tempDir("pi-sync-fp-");
  try {
    const agentDir = path.join(root, "agent");
    const skillsDir = path.join(root, "skills");
    const cortexkitDir = path.join(root, "cortexkit");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(cortexkitDir), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "settings.json"), "{}");
    fs.writeFileSync(path.join(agentDir, "mcp.json"), "{}");
    fs.writeFileSync(path.join(skillsDir, "alpha", "SKILL.md"), "v1");
    fs.writeFileSync(path.join(cortexkitDir, "config.json"), "{}");

    const baseline = computeFingerprint(agentDir, skillsDir, cortexkitDir, []);
    assert.equal(computeFingerprint(agentDir, skillsDir, cortexkitDir, []), baseline);

    // 改单个 agent 顶层配置（追加改变 size）→ 指纹变化。
    fs.writeFileSync(path.join(agentDir, "settings.json"), '{"a":1}');
    assert.notEqual(computeFingerprint(agentDir, skillsDir, cortexkitDir, []), baseline);
    const afterConfig = computeFingerprint(agentDir, skillsDir, cortexkitDir, []);

    // 改 skills 内文件 → 指纹变化。
    fs.writeFileSync(path.join(skillsDir, "alpha", "SKILL.md"), "v2-longer");
    assert.notEqual(computeFingerprint(agentDir, skillsDir, cortexkitDir, []), afterConfig);
    const afterSkills = computeFingerprint(agentDir, skillsDir, cortexkitDir, []);

    // *.log 与 __pycache__ 噪声不参与指纹。
    fs.writeFileSync(path.join(skillsDir, "alpha", "debug.log"), "noise");
    fs.mkdirSync(path.join(skillsDir, "__pycache__"));
    fs.writeFileSync(path.join(skillsDir, "__pycache__", "x.pyc"), "noise");
    assert.equal(computeFingerprint(agentDir, skillsDir, cortexkitDir, []), afterSkills);

    // piExcludePaths 命中的相对路径（含树内前缀）不参与指纹。
    fs.mkdirSync(path.join(skillsDir, "node_modules"));
    fs.writeFileSync(path.join(skillsDir, "node_modules", "pkg.js"), "excluded");
    assert.equal(computeFingerprint(agentDir, skillsDir, cortexkitDir, ["skills/node_modules"]), afterSkills);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state key changes with webdavUrl, device, base dir, scope, and excludes", () => {
  const base = {
    webdavUrl: "https://dav.example.com/",
    webdavUser: "u",
    deviceName: "devA",
    remoteBaseDir: "backup/",
    exitBackupScope: ["pi", "skills"],
    piExcludePaths: ["npm"],
  };
  const key = computeStateKey(base);
  assert.equal(computeStateKey({ ...base }), key);
  assert.notEqual(computeStateKey({ ...base, webdavUrl: "https://other.example.com/" }), key);
  assert.notEqual(computeStateKey({ ...base, webdavUser: "v" }), key);
  assert.notEqual(computeStateKey({ ...base, deviceName: "devB" }), key);
  assert.notEqual(computeStateKey({ ...base, remoteBaseDir: "other/" }), key);
  assert.notEqual(computeStateKey({ ...base, exitBackupScope: ["pi"] }), key);
  // scope 顺序无关。
  assert.equal(computeStateKey({ ...base, exitBackupScope: ["skills", "pi"] }), key);
  assert.notEqual(computeStateKey({ ...base, piExcludePaths: ["npm", "git"] }), key);
});

test("sync state writes atomically, reads back, and invalidate clears the fingerprint", () => {
  const root = tempDir("pi-sync-state-");
  try {
    const statePath = path.join(root, "nested", "sync-state.json");
    assert.equal(readSyncState(statePath), null);
    writeSyncState({ key: "k1", fingerprint: "f1", remoteFiles: { pi: "devA-win-pi_20250102-030405.tar.xz" }, uploadedAt: 42 }, statePath);
    const state = readSyncState(statePath);
    assert.ok(state);
    assert.deepEqual(state, { key: "k1", fingerprint: "f1", remoteFiles: { pi: "devA-win-pi_20250102-030405.tar.xz" }, uploadedAt: 42 });
    // 原子写不留临时文件。
    assert.deepEqual(fs.readdirSync(path.join(root, "nested")).filter((name) => !name.startsWith("sync-state.json")), []);
    invalidateSyncState(statePath);
    const invalidated = readSyncState(statePath);
    assert.ok(invalidated);
    assert.equal(invalidated.fingerprint, "");
    assert.equal(invalidated.remoteFiles.pi, "devA-win-pi_20250102-030405.tar.xz");
    assert.equal(invalidated.key, "k1");
    // 损坏文件读取安全。
    fs.writeFileSync(statePath, "{broken");
    assert.equal(readSyncState(statePath), null);
    // 不存在的状态 invalidate 为无操作。
    invalidateSyncState(path.join(root, "missing.json"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── S4 文件锁 ─────────────────────────────────────────────────────────────

test("file lock is exclusive, releasable, and steals stale locks", () => {
  const root = tempDir("pi-sync-lock-");
  try {
    const lockPath = path.join(root, "sub", "sync.lock");
    const first = lockFileSync(lockPath);
    assert.ok(first);
    assert.equal(lockFileSync(lockPath), null, "second concurrent lock must fail immediately");
    unlockFileSync(first);
    const second = lockFileSync(lockPath);
    assert.ok(second, "lock is reacquirable after release");

    // 未陈旧的外部锁不可夺。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
    assert.equal(lockFileSync(lockPath), null);

    // 陈旧锁（>60s）可夺。
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() - 61_000 }));
    const stolen = lockFileSync(lockPath);
    assert.ok(stolen, "stale lock must be stealable");
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
    assert.equal(payload.pid, process.pid);

    // 垃圾内容的锁按陈旧处理。
    fs.writeFileSync(lockPath, "garbage");
    assert.ok(lockFileSync(lockPath));

    // 别人重写过的锁不被误删。
    unlockFileSync(stolen); // stolen 的 pid 仍是本进程，会释放；重新制造外部锁
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, ts: Date.now() }));
    unlockFileSync({ path: lockPath, pid: process.pid });
    assert.equal(fs.existsSync(lockPath), true, "unlock must not remove a lock owned by another pid");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── S5 prune 安全 ─────────────────────────────────────────────────────────

interface PruneServer {
  url: string;
  deleted: string[];
  close: () => Promise<void>;
}

async function startPruneServer(names: string[]): Promise<PruneServer> {
  const deleted: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === "PROPFIND") {
      const xml = `<?xml version="1.0"?><D:multistatus>${names.map((name) => `<D:response><D:displayname>${name}</D:displayname></D:response>`).join("")}</D:multistatus>`;
      response.writeHead(207, { "Content-Type": "application/xml" });
      response.end(xml);
      return;
    }
    if (request.method === "DELETE") {
      const name = decodeURIComponent(request.url!.split("/").filter(Boolean).pop()!);
      deleted.push(name);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind prune test server");
  return {
    url: `http://127.0.0.1:${address.port}/dav`,
    deleted,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const ctx = { signal: new AbortController().signal } as never;

test("prune deletes only strictly parsed archives of the local device", async () => {
  const names = [
    "devA-win-pi_20250101-000000.tar.xz",
    "devA-win-pi_20250102-000000.tar.xz",
    "devA-win-pi_20250103-000000.tar.xz",
    "devB-win-pi_20240101-000000.tar.xz", // 其他设备
    "devA-mac-skills_20240101-000000.tar.xz", // 本机但类别目录混入；prune 按设备判断，不按 tag
    "pi_agent_windows11_20240101T120000Z.tar.xz", // 旧版命名
    "random-junk.txt",
  ];
  const server = await startPruneServer(names);
  try {
    const config = {
      webdavUrl: server.url,
      webdavUser: "u",
      webdavPass: "p",
      deviceName: "devA",
      remoteBaseDir: "backup/",
      maxBackups: 2,
    } as SyncConfig;
    const deleted = await pruneOldBackupsInDir(config, ctx, "backup/pi/");
    // 只删 devA 名下超出保留数的两个最旧归档；devB、旧版命名、杂项一律不动。
    assert.deepEqual(deleted, ["devA-win-pi_20250101-000000.tar.xz", "devA-mac-skills_20240101-000000.tar.xz"]);
    assert.deepEqual(server.deleted, ["devA-win-pi_20250101-000000.tar.xz", "devA-mac-skills_20240101-000000.tar.xz"]);

    // maxBackups = 0（保留全部）不发任何删除。
    server.deleted.length = 0;
    const keepAll = await pruneOldBackupsInDir({ ...config, maxBackups: 0 }, ctx, "backup/pi/");
    assert.deepEqual(keepAll, []);
    assert.deepEqual(server.deleted, []);
  } finally {
    await server.close();
  }
});
