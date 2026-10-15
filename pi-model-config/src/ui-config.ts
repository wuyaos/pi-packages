import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeUiLanguage, type UiLanguage } from "./i18n.ts";

export interface ModelConfigUiPreferences {
  version: 1;
  language: UiLanguage;
}

export function uiPreferencesPath(agentDir: string): string {
  return join(agentDir, "model-config-ui.json");
}

export function loadUiLanguage(agentDir: string): UiLanguage {
  try {
    const value: unknown = JSON.parse(readFileSync(uiPreferencesPath(agentDir), "utf8"));
    if (typeof value === "object" && value !== null && (value as { version?: unknown }).version === 1) {
      return normalizeUiLanguage((value as { language?: unknown }).language);
    }
  } catch {
    // Missing or invalid UI preferences never block model configuration.
  }
  return "zh-CN";
}

/** Only call after an explicit user language selection. */
export function saveUiLanguage(agentDir: string, language: UiLanguage): void {
  const path = uiPreferencesPath(agentDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    const value: ModelConfigUiPreferences = { version: 1, language };
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
