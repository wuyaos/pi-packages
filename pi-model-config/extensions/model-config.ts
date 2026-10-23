import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfigFiles } from "../src/config.ts";
import { mcError } from "../src/i18n.ts";
import { registerModelConfigCommand, type StartupIssue } from "../src/command.ts";
import { registerConfiguredProviders } from "../src/runtime.ts";
import { loadUiLanguage } from "../src/ui-config.ts";

/**
 * Single extension entry. Helpers live under src/ so the workspace extension glob
 * does not auto-load them as separate extensions.
 */
export default function modelConfigExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const modelsPath = join(agentDir, "models.json");
  const configPath = join(agentDir, "model-config.json");
  const startupIssues: StartupIssue[] = [];
  try {
    const files = readConfigFiles(modelsPath, configPath);
    if (files.recoveredTxId) startupIssues.push({ error: mcError("MCFG_E_TX_RECOVERED", { txId: files.recoveredTxId }) });
    startupIssues.push(...registerConfiguredProviders(pi, files.config, files.models, loadUiLanguage(agentDir)));
  } catch (error) {
    // Keep the repair command available even when the on-disk files cannot be parsed.
    startupIssues.push({ error });
  }
  registerModelConfigCommand(pi, startupIssues);
}
