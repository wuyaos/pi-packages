import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { mcError, t, type UiLanguage } from "./i18n.ts";
import type {
  ConfigSnapshot,
  ModelConfigFile,
  ModelsJsonFile,
  ModelsJsonProvider,
  ProviderConnectionConfig,
} from "./types.ts";
import { IMAGE_API_NAMES } from "./types.ts";

export const MODELS_SCHEMA = "https://pi.dev/schemas/models.schema.json";
export const MODEL_CONFIG_SCHEMA = "https://raw.githubusercontent.com/wuyaos/pi-packages/main/pi-model-config/model-config.schema.json";

const EMPTY_MODELS: ModelsJsonFile = { $schema: MODELS_SCHEMA, providers: {} };
const EMPTY_CONFIG: ModelConfigFile = { $schema: MODEL_CONFIG_SCHEMA, version: 1, providers: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function snapshot(path: string): ConfigSnapshot {
  try {
    return { path, exists: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false };
    throw error;
  }
}

export function parseModelsJson(source: ConfigSnapshot): ModelsJsonFile {
  if (!source.exists) return structuredClone(EMPTY_MODELS);
  const parsed: unknown = JSON.parse(source.text!);
  if (!isRecord(parsed) || !isRecord(parsed.providers)) throw mcError("MCFG_E_CONFIG_SHAPE", { file: "models.json" });
  for (const [id, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider)) throw mcError("MCFG_E_PROVIDER_SHAPE", { file: "models.json", provider: id });
    if (provider.models !== undefined && !Array.isArray(provider.models)) throw mcError("MCFG_E_MODELS_ARRAY", { file: "models.json", provider: id });
    if (Array.isArray(provider.models) && provider.models.some((model) => !isRecord(model))) throw mcError("MCFG_E_MODELS_ARRAY", { file: "models.json", provider: id });
  }
  return parsed as ModelsJsonFile;
}

export function parseModelConfig(source: ConfigSnapshot): ModelConfigFile {
  if (!source.exists) return structuredClone(EMPTY_CONFIG);
  const parsed: unknown = JSON.parse(source.text!);
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.providers)) {
    throw mcError("MCFG_E_CONFIG_SHAPE", { file: "model-config.json" });
  }
  for (const [id, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider)) throw mcError("MCFG_E_PROVIDER_SHAPE", { file: "model-config.json", provider: id });
    if (!new Set(["models-json", "reuse-pi", "anonymous"]).has(String(provider.authMode))) {
      throw mcError("MCFG_E_AUTH_MODE", { file: "model-config.json", provider: id });
    }
    if (provider.enabled !== undefined && typeof provider.enabled !== "boolean") throw mcError("MCFG_E_PROVIDER_SHAPE", { file: "model-config.json", provider: id });
    if (provider.discoveryAuthHeader !== undefined && !new Set(["auto", "bearer", "x-api-key", "api-key", "x-goog-api-key", "anthropic", "none"]).has(String(provider.discoveryAuthHeader))) {
      throw mcError("MCFG_E_DISCOVERY_AUTH_HEADER", { file: "model-config.json", provider: id });
    }
    if (provider.imageApi !== undefined && !IMAGE_API_NAMES.includes(String(provider.imageApi) as typeof IMAGE_API_NAMES[number])) {
      throw mcError("MCFG_E_UNSUPPORTED_API", { identity: `${id}/image`, api: String(provider.imageApi) });
    }
    if (provider.hiddenRemoteIds !== undefined && (!Array.isArray(provider.hiddenRemoteIds) || provider.hiddenRemoteIds.some((modelId) => typeof modelId !== "string"))) throw mcError("MCFG_E_PROVIDER_SHAPE", { file: "model-config.json", provider: id });
    if (provider.models !== undefined && !Array.isArray(provider.models)) throw mcError("MCFG_E_MODELS_ARRAY", { file: "model-config.json", provider: id });
    if (Array.isArray(provider.models) && provider.models.some((model) => !isRecord(model))) throw mcError("MCFG_E_MODELS_ARRAY", { file: "model-config.json", provider: id });
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!isRecord(model) || (model.type !== "classifier" && model.type !== "image") || typeof model.id !== "string" || typeof model.api !== "string") {
        throw mcError("MCFG_E_MODEL_SHAPE", { file: "model-config.json", provider: id });
      }
    }
  }
  return parsed as ModelConfigFile;
}

export interface ConfigFilesRead {
  modelsSnapshot: ConfigSnapshot;
  configSnapshot: ConfigSnapshot;
  models: ModelsJsonFile;
  config: ModelConfigFile;
  recoveredTxId?: string;
}

interface TransactionJournalEntry {
  target: string;
  backup?: string;
  existed: boolean;
  changed: boolean;
}

interface TransactionJournal {
  version: 1;
  txId: string;
  models: TransactionJournalEntry;
  config: TransactionJournalEntry;
}

const TRANSACTION_JOURNAL = ".model-config-tx.json";

function transactionJournalPath(configPath: string): string { return join(dirname(configPath), TRANSACTION_JOURNAL); }

function isJournalEntry(value: unknown): value is TransactionJournalEntry {
  return isRecord(value)
    && typeof value.target === "string"
    && typeof value.existed === "boolean"
    && typeof value.changed === "boolean"
    && (value.backup === undefined || typeof value.backup === "string");
}

function readTransactionJournal(path: string, modelsPath: string, configPath: string): TransactionJournal {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw mcError("MCFG_E_TX_RECOVERY_FAILED", { path, reason: "journal is unreadable" }, error); }
  if (!isRecord(value) || value.version !== 1 || typeof value.txId !== "string" || !isJournalEntry(value.models) || !isJournalEntry(value.config)
    || value.models.target !== modelsPath || value.config.target !== configPath) {
    throw mcError("MCFG_E_TX_RECOVERY_FAILED", { path, reason: "journal does not match this agent directory" });
  }
  return value as unknown as TransactionJournal;
}

function writeTransactionJournal(path: string, journal: TransactionJournal): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(journal)}\n`, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function recoverJournalEntry(entry: TransactionJournalEntry): void {
  if (!entry.changed) return;
  if (!entry.existed) { rmSync(entry.target, { force: true }); return; }
  if (!entry.backup || !existsSync(entry.backup)) throw new Error(`missing backup for ${entry.target}`);
  copyFileSync(entry.backup, entry.target);
}

/** Recover a process that died after one of the two replacement renames. */
export function recoverPendingConfigTransaction(modelsPath: string, configPath: string): string | undefined {
  const journalPath = transactionJournalPath(configPath);
  if (!existsSync(journalPath)) return undefined;
  let lockFd: number | undefined;
  let ownsLock = false;
  try {
    try {
      lockFd = acquireTransactionLock(join(dirname(configPath), "model-config.lock"));
      ownsLock = true;
    } catch (error) {
      throw mcError("MCFG_E_TX_RECOVERY_ACTIVE", { path: journalPath }, error);
    }
    const journal = readTransactionJournal(journalPath, modelsPath, configPath);
    try {
      // Always restore both changed files to the same known old generation.
      recoverJournalEntry(journal.models);
      recoverJournalEntry(journal.config);
      unlinkSync(journalPath);
      return journal.txId;
    } catch (error) {
      throw mcError("MCFG_E_TX_RECOVERY_FAILED", { path: journalPath, reason: sanitizeError(error) }, error);
    }
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    if (ownsLock) { try { unlinkSync(join(dirname(configPath), "model-config.lock")); } catch { /* best effort */ } }
  }
}

export function readConfigFiles(modelsPath: string, configPath: string): ConfigFilesRead {
  const recoveredTxId = recoverPendingConfigTransaction(modelsPath, configPath);
  const modelsSnapshot = snapshot(modelsPath);
  const configSnapshot = snapshot(configPath);
  return {
    modelsSnapshot,
    configSnapshot,
    models: parseModelsJson(modelsSnapshot),
    config: parseModelConfig(configSnapshot),
    ...(recoveredTxId ? { recoveredTxId } : {}),
  };
}

export function validateProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    throw mcError("MCFG_E_PROVIDER_ID");
  }
  return normalized;
}

export function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw mcError("MCFG_E_URL_INVALID", { label });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw mcError("MCFG_E_URL_PROTOCOL", { label });
  if (url.username || url.password) throw mcError("MCFG_E_URL_CREDENTIALS", { label });
  for (const key of url.searchParams.keys()) {
    if (/^(?:api[_-]?key|key|token|access[_-]?token)$/iu.test(key)) {
      throw mcError("MCFG_E_URL_SECRET_QUERY", { label });
    }
  }
  return url.toString();
}

export function redactUrl(value: string | undefined, language: UiLanguage): string {
  if (!value) return t(language, "valueDefault");
  try {
    const url = new URL(value);
    if (url.search) url.search = `?${t(language, "valueRedacted")}`;
    url.hash = "";
    return url.toString();
  } catch {
    return t(language, "valueInvalidUrl");
  }
}

export function authDescription(language: UiLanguage, config: ProviderConnectionConfig | undefined, provider: ModelsJsonProvider | undefined): string {
  if (config?.authMode === "anonymous") return t(language, "valueAnonymous");
  if (config?.authMode === "reuse-pi") return t(language, "valueReuseAuth");
  const value = provider?.apiKey;
  if (!value) return t(language, "valueUnset");
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(value)) return t(language, "valueEnv", { value });
  return t(language, "valueLiteralMasked");
}

export function sanitizeError(error: unknown, secrets: Array<string | undefined> = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (!secret) continue;
    const variants = [secret, ...(secret.startsWith("$$") || secret.startsWith("$!") ? [secret.slice(1)] : [])];
    for (const variant of variants) if (variant.length >= 3) message = message.split(variant).join("[REDACTED]");
  }
  message = message
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^"'\s,;}]+/giu, "$1[REDACTED]")
    .replace(/(["']?(?:x-api-key|x-goog-api-key|api[-_ ]?key|token)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .trim();
  return message.slice(0, 400);
}

function snapshotMatches(expected: ConfigSnapshot): boolean {
  const current = snapshot(expected.path);
  return current.exists === expected.exists && current.text === expected.text;
}

function writeTemp(target: string, value: unknown, tx: string): string {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.${target.split(/[\\/]/u).pop()}.${tx}.tmp`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(text);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

function restore(target: string, before: ConfigSnapshot, rollback: string | undefined): void {
  if (before.exists && rollback && existsSync(rollback)) copyFileSync(rollback, target);
  else if (!before.exists) rmSync(target, { force: true });
}

export interface TransactionResult {
  backups: string[];
  modelsWritten: boolean;
  configWritten: boolean;
}

const DEAD_LOCK_GRACE_MS = 30_000;
const UNREADABLE_LOCK_GRACE_MS = 10 * 60_000;

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM and unknown platform errors are treated as alive: never steal a lock
    // merely because this process cannot inspect its owner.
    return true;
  }
}

function staleLockReason(lockPath: string): string | undefined {
  let ageMs: number;
  try {
    ageMs = Math.max(0, Date.now() - statSync(lockPath).mtimeMs);
  } catch {
    return undefined;
  }
  let pid: number | undefined;
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const parsed = raw.startsWith("{") ? JSON.parse(raw) as { pid?: unknown } : { pid: Number(raw.split(/\s/u)[0]) };
    if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid;
  } catch {
    // An unreadable lock needs a much longer age threshold before cleanup.
  }
  if (pid !== undefined) {
    if (processIsAlive(pid) || ageMs < DEAD_LOCK_GRACE_MS) return undefined;
    return `dead-pid:${pid};age-seconds:${Math.round(ageMs / 1000)}`;
  }
  if (ageMs >= UNREADABLE_LOCK_GRACE_MS) return `unreadable-lock;age-seconds:${Math.round(ageMs / 1000)}`;
  return undefined;
}

function acquireTransactionLock(lockPath: string): number {
  try {
    return openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stale = staleLockReason(lockPath);
    if (!stale) throw mcError("MCFG_E_LOCK_ACTIVE", { path: lockPath });

    // Serialize stale-lock reclamation so two cleaners cannot delete each other's
    // newly acquired transaction lock. A normal writer may still win after rename;
    // in that case the exclusive retry fails and its lock remains untouched.
    const recoveryPath = `${lockPath}.recovery`;
    let recoveryFd: number | undefined;
    const quarantinePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
    try {
      try {
        recoveryFd = openSync(recoveryPath, "wx", 0o600);
        writeFileSync(recoveryFd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
        fsyncSync(recoveryFd);
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") {
          throw mcError("MCFG_E_LOCK_RECOVERY");
        }
        throw recoveryError;
      }
      const rechecked = staleLockReason(lockPath);
      if (!rechecked) throw mcError("MCFG_E_LOCK_CHANGED");
      renameSync(lockPath, quarantinePath);
      try {
        return openSync(lockPath, "wx", 0o600);
      } catch (retryError) {
        throw mcError("MCFG_E_LOCK_RACE", {}, retryError);
      } finally {
        rmSync(quarantinePath, { force: true });
      }
    } finally {
      if (recoveryFd !== undefined) {
        closeSync(recoveryFd);
        try { unlinkSync(recoveryPath); } catch { /* best-effort cleanup of our recovery lock */ }
      }
    }
  }
}

/** Optimistic transaction with a crash-recovery journal, staged JSON, backups, and rollback. */
export function writeConfigTransaction(
  modelsBefore: ConfigSnapshot,
  configBefore: ConfigSnapshot,
  modelsValue: ModelsJsonFile,
  configValue: ModelConfigFile,
): TransactionResult {
  const dir = dirname(configBefore.path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, "model-config.lock");
  const journalPath = transactionJournalPath(configBefore.path);
  let lockFd: number | undefined;
  let ownsLock = false;
  const tx = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let modelsTemp: string | undefined;
  let configTemp: string | undefined;
  let modelsRollback: string | undefined;
  let configRollback: string | undefined;
  let journalCreated = false;
  const backups: string[] = [];
  const modelsChanged = !modelsBefore.exists || JSON.stringify(parseModelsJson(modelsBefore)) !== JSON.stringify(modelsValue);
  const configChanged = !configBefore.exists || JSON.stringify(parseModelConfig(configBefore)) !== JSON.stringify(configValue);

  if (!modelsChanged && !configChanged) return { backups, modelsWritten: false, configWritten: false };
  try {
    lockFd = acquireTransactionLock(lockPath);
    ownsLock = true;
    writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    fsyncSync(lockFd);
    if (!snapshotMatches(modelsBefore) || !snapshotMatches(configBefore)) throw mcError("MCFG_E_CONCURRENT_CHANGE");

    if (modelsChanged) modelsTemp = writeTemp(modelsBefore.path, modelsValue, tx);
    if (configChanged) configTemp = writeTemp(configBefore.path, configValue, tx);
    if (!snapshotMatches(modelsBefore) || !snapshotMatches(configBefore)) throw mcError("MCFG_E_STAGING_CHANGE");
    if (modelsChanged && modelsBefore.exists) {
      modelsRollback = `${modelsBefore.path}.bak-${tx}`;
      copyFileSync(modelsBefore.path, modelsRollback);
      backups.push(modelsRollback);
    }
    if (configChanged && configBefore.exists) {
      configRollback = `${configBefore.path}.bak-${tx}`;
      copyFileSync(configBefore.path, configRollback);
      backups.push(configRollback);
    }
    writeTransactionJournal(journalPath, {
      version: 1,
      txId: tx,
      models: { target: modelsBefore.path, backup: modelsRollback, existed: modelsBefore.exists, changed: modelsChanged },
      config: { target: configBefore.path, backup: configRollback, existed: configBefore.exists, changed: configChanged },
    });
    journalCreated = true;

    if (modelsTemp) { renameSync(modelsTemp, modelsBefore.path); modelsTemp = undefined; }
    if (configTemp) { renameSync(configTemp, configBefore.path); configTemp = undefined; }
    unlinkSync(journalPath);
    journalCreated = false;
    return { backups, modelsWritten: modelsChanged, configWritten: configChanged };
  } catch (error) {
    if (!journalCreated) throw error;
    const rollbackErrors: string[] = [];
    if (journalCreated) {
      if (modelsChanged) try { restore(modelsBefore.path, modelsBefore, modelsRollback); } catch (e) { rollbackErrors.push(String(e)); }
      if (configChanged) try { restore(configBefore.path, configBefore, configRollback); } catch (e) { rollbackErrors.push(String(e)); }
      if (!rollbackErrors.length) {
        try { unlinkSync(journalPath); journalCreated = false; } catch (e) { rollbackErrors.push(String(e)); }
      }
    }
    if (rollbackErrors.length) throw mcError("MCFG_E_ROLLBACK_INCOMPLETE", { errors: rollbackErrors.join("; ") }, error);
    if (journalCreated) throw mcError("MCFG_E_TX_RECOVERY_FAILED", { path: journalPath, reason: "journal retained after failed rollback" }, error);
    throw mcError("MCFG_E_TRANSACTION_ROLLED_BACK", {}, error);
  } finally {
    if (modelsTemp) rmSync(modelsTemp, { force: true });
    if (configTemp) rmSync(configTemp, { force: true });
    if (lockFd !== undefined) closeSync(lockFd);
    if (ownsLock) { try { unlinkSync(lockPath); } catch { /* best effort */ } }
  }
}
