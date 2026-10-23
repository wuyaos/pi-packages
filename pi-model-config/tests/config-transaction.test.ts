import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfigFiles, snapshot, writeConfigTransaction } from "../src/config.ts";
import type { ModelConfigFile, ModelsJsonFile } from "../src/types.ts";

function values(): { models: ModelsJsonFile; config: ModelConfigFile } {
  return {
    models: {
      $schema: "fixture-models-schema",
      providers: {
        fixture: {
          name: "Fixture",
          baseUrl: "http://127.0.0.1/v1",
          apiKey: "$FIXTURE_KEY",
          models: [{ id: "chat-1", name: "Chat 1", api: "openai-completions", custom: "preserved" }],
          providerUnknown: { keep: true },
        },
      },
      rootUnknown: "models-preserved",
    },
    config: {
      $schema: "fixture-config-schema",
      version: 1,
      providers: {
        fixture: {
          authMode: "models-json",
          owned: true,
          managedChatIds: ["chat-1"],
          customConfig: "preserved",
        } as any,
      },
      rootUnknown: "config-preserved",
    },
  };
}

test("双文件事务只在临时 fixture 中提交、备份并清理 lock/tmp", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-transaction-"));
  try {
    const modelsPath = join(dir, "models.json");
    const configPath = join(dir, "model-config.json");
    const originalModels = `${JSON.stringify({ providers: {}, old: "models" }, null, 2)}\n`;
    const originalConfig = `${JSON.stringify({ version: 1, providers: {}, old: "config" }, null, 2)}\n`;
    writeFileSync(modelsPath, originalModels);
    writeFileSync(configPath, originalConfig);
    const before = readConfigFiles(modelsPath, configPath);
    const next = values();

    const result = writeConfigTransaction(before.modelsSnapshot, before.configSnapshot, next.models, next.config);

    assert.equal(result.backups.length, 2);
    assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), next.models);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), next.config);
    assert.deepEqual(new Set(result.backups.map((path) => readFileSync(path, "utf8"))), new Set([originalModels, originalConfig]));
    assert.equal(existsSync(join(dir, "model-config.lock")), false);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".recovery")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("起始快照后发生并发修改时拒绝保存且不改另一文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-concurrent-"));
  try {
    const modelsPath = join(dir, "models.json");
    const configPath = join(dir, "model-config.json");
    const originalModels = "{\"providers\":{}}\n";
    const originalConfig = "{\"version\":1,\"providers\":{}}\n";
    writeFileSync(modelsPath, originalModels);
    writeFileSync(configPath, originalConfig);
    const modelsBefore = snapshot(modelsPath);
    const configBefore = snapshot(configPath);
    const concurrentModels = "{\"providers\":{},\"writtenBy\":\"other-process\"}\n";
    writeFileSync(modelsPath, concurrentModels);
    const next = values();

    assert.throws(
      () => writeConfigTransaction(modelsBefore, configBefore, next.models, next.config),
      (error: any) => error?.code === "MCFG_E_CONCURRENT_CHANGE",
    );
    assert.equal(readFileSync(modelsPath, "utf8"), concurrentModels);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.equal(existsSync(join(dir, "model-config.lock")), false);
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp") || name.includes(".bak-")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config-only transaction keeps models.json bytes and creates only its config backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-config-only-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    const modelsText = "{\n  \"providers\": { \"custom\": { \"models\": [] } }\n}\n";
    const configText = "{\n  \"version\": 1,\n  \"providers\": { \"custom\": { \"authMode\": \"reuse-pi\", \"enabled\": true } }\n}\n";
    writeFileSync(modelsPath, modelsText); writeFileSync(configPath, configText);
    const before = readConfigFiles(modelsPath, configPath);
    const nextConfig = structuredClone(before.config); nextConfig.providers.custom!.enabled = false;
    const result = writeConfigTransaction(before.modelsSnapshot, before.configSnapshot, before.models, nextConfig);
    assert.equal(readFileSync(modelsPath, "utf8"), modelsText);
    assert.equal(result.modelsWritten, false); assert.equal(result.configWritten, true); assert.equal(result.backups.length, 1);
    assert.equal(readFileSync(result.backups[0]!, "utf8"), configText);
    assert.equal(existsSync(join(dir, ".model-config-tx.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("config-only transaction still rejects a concurrent snapshot change", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-config-only-concurrent-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    writeFileSync(modelsPath, "{\"providers\":{\"custom\":{\"models\":[]}}}\n");
    writeFileSync(configPath, "{\"version\":1,\"providers\":{\"custom\":{\"authMode\":\"reuse-pi\",\"enabled\":true}}}\n");
    const before = readConfigFiles(modelsPath, configPath);
    const nextConfig = structuredClone(before.config); nextConfig.providers.custom!.enabled = false;
    writeFileSync(configPath, "{\"version\":1,\"providers\":{\"custom\":{\"authMode\":\"reuse-pi\",\"enabled\":true,\"changedBy\":\"other\"}}}\n");
    assert.throws(() => writeConfigTransaction(before.modelsSnapshot, before.configSnapshot, before.models, nextConfig), (error: any) => error?.code === "MCFG_E_CONCURRENT_CHANGE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup recovery rolls a partial rename back to one old configuration generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-journal-recovery-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    const oldModels = "{\"providers\":{\"old\":{\"models\":[]}}}\n";
    const oldConfig = "{\"version\":1,\"providers\":{\"old\":{\"authMode\":\"reuse-pi\"}}}\n";
    const newModels = "{\"providers\":{\"new\":{\"models\":[]}}}\n";
    writeFileSync(modelsPath, newModels); writeFileSync(configPath, oldConfig);
    const modelsBackup = `${modelsPath}.bak-crash`; const configBackup = `${configPath}.bak-crash`;
    writeFileSync(modelsBackup, oldModels); writeFileSync(configBackup, oldConfig);
    writeFileSync(join(dir, ".model-config-tx.json"), JSON.stringify({ version: 1, txId: "crash-fixture", models: { target: modelsPath, backup: modelsBackup, existed: true, changed: true }, config: { target: configPath, backup: configBackup, existed: true, changed: true } }));
    const recovered = readConfigFiles(modelsPath, configPath);
    assert.equal(recovered.recoveredTxId, "crash-fixture");
    assert.equal(readFileSync(modelsPath, "utf8"), oldModels);
    assert.equal(readFileSync(configPath, "utf8"), oldConfig);
    assert.equal(existsSync(join(dir, ".model-config-tx.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed journal recovery keeps the journal and reports manual recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-journal-failure-"));
  try {
    const modelsPath = join(dir, "models.json"); const configPath = join(dir, "model-config.json");
    writeFileSync(modelsPath, "{\"providers\":{}}\n"); writeFileSync(configPath, "{\"version\":1,\"providers\":{}}\n");
    const journalPath = join(dir, ".model-config-tx.json");
    writeFileSync(journalPath, JSON.stringify({ version: 1, txId: "missing-backup", models: { target: modelsPath, backup: `${modelsPath}.missing`, existed: true, changed: true }, config: { target: configPath, backup: `${configPath}.missing`, existed: true, changed: true } }));
    assert.throws(() => readConfigFiles(modelsPath, configPath), (error: any) => error?.code === "MCFG_E_TX_RECOVERY_FAILED");
    assert.equal(existsSync(journalPath), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("活动事务锁拒绝第二写入者且不会抢锁", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-config-lock-"));
  try {
    const modelsPath = join(dir, "models.json");
    const configPath = join(dir, "model-config.json");
    writeFileSync(modelsPath, "{\"providers\":{}}\n");
    writeFileSync(configPath, "{\"version\":1,\"providers\":{}}\n");
    const modelsBefore = snapshot(modelsPath);
    const configBefore = snapshot(configPath);
    const lockPath = join(dir, "model-config.lock");
    const lock = `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`;
    writeFileSync(lockPath, lock);
    const next = values();

    assert.throws(
      () => writeConfigTransaction(modelsBefore, configBefore, next.models, next.config),
      (error: any) => error?.code === "MCFG_E_LOCK_ACTIVE",
    );
    assert.equal(readFileSync(lockPath, "utf8"), lock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
