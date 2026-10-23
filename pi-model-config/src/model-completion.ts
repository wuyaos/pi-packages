import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t, type UiLanguage } from "./i18n.ts";
import { showConfirmationPanel } from "./panel.ts";
import { matchModelsDirectory, type DirectoryData, type DirectoryResult, type ProviderHint } from "./models-directory.ts";
import type { ManagedChatModel, ManagedModel, ModelMetadataEntry } from "./types.ts";

export function isDirectoryCompletable(model: ManagedModel & { readOnly?: boolean }): model is ManagedChatModel & { readOnly?: boolean } {
  return model.type === "chat" && !model.readOnly;
}

export const completionFields = ["name", "contextWindow", "maxTokens", "input", "reasoning"] as const;
type Field = typeof completionFields[number];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export interface CompletionPlan { changes: Field[]; conflicts: Field[] }
/** Pure policy: concrete false, text-only input, and user names are real values. */
export function planDirectoryCompletion(model: ManagedModel, metadata: ModelMetadataEntry, result: DirectoryResult): CompletionPlan {
  const changes: Field[] = [], conflicts: Field[] = [];
  if (!isDirectoryCompletable(model)) return { changes, conflicts };
  for (const field of completionFields) {
    const suggested = result.fields[field];
    if (suggested === undefined) continue;
    const current = model[field];
    const missing = current === null || current === undefined ||
      field === "contextWindow" && metadata.contextSource === "compat" ||
      field === "maxTokens" && metadata.maxTokensSource === "compat";
    if (missing) changes.push(field);
    else if (!equal(current, suggested)) conflicts.push(field);
  }
  return { changes, conflicts };
}
export interface CompletionSessionEntry {
  attempted: boolean;
  undo?: { model: ManagedModel; metadata: ModelMetadataEntry; after: string };
  result?: DirectoryResult;
}
export type CompletionSession = Map<string, CompletionSessionEntry>;
export interface CompletionSummary { matched: number; exact: number; variant: number; kept: number; missed: number; conflicts: boolean; undone: boolean; invalidLimits: boolean }
const fingerprint = (model: ManagedModel, metadata: ModelMetadataEntry) => JSON.stringify([model, metadata], (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

/** Only called on editable chat rows by the command/editor. No writes outside drafts. */
export async function completeDirectoryModel(
  ctx: ExtensionCommandContext, language: UiLanguage, directory: DirectoryData, hint: ProviderHint,
  model: ManagedModel, metadata: ModelMetadataEntry, session: CompletionSession, single: boolean,
): Promise<CompletionSummary> {
  const summary: CompletionSummary = { matched: 0, exact: 0, variant: 0, kept: 0, missed: 0, conflicts: false, undone: false, invalidLimits: false };
  if (!isDirectoryCompletable(model)) return summary;
  const key = `${model.type}\0${model.id}`;
  const previous = session.get(key);
  if (single && previous?.undo && previous.undo.after === fingerprint(model, metadata)) {
    for (const field of completionFields) Object.assign(model, { [field]: structuredClone(previous.undo.model[field as keyof ManagedModel]) });
    for (const field of ["contextSource", "maxTokensSource", "thinkingSource", "directoryFields", "directoryMatchMethod"] as const) {
      if (previous.undo.metadata[field] === undefined) delete metadata[field];
      else Object.assign(metadata, { [field]: structuredClone(previous.undo.metadata[field]) });
    }
    previous.undo = undefined;
    summary.undone = true;
    return summary;
  }
  const result = matchModelsDirectory(directory, model.id, hint);
  if (result.matchMethod === "none") { summary.missed = 1; return summary; }
  summary.matched = 1;
  if (result.matchMethod === "variant") summary.variant = 1; else summary.exact = 1;
  const plan = planDirectoryCompletion(model, metadata, result);
  summary.conflicts = plan.conflicts.length > 0;
  summary.kept = plan.conflicts.length;
  const before = { model: structuredClone(model), metadata: structuredClone(metadata) };
  const adopted = [...plan.changes];
  if (single && previous?.attempted) {
    for (const field of plan.conflicts) {
      const source = result.sources[field]?.map((entry) => `${entry.provider}/${entry.id}`).join(", ") ?? "Models.dev";
      const answer = await showConfirmationPanel(ctx, {
        title: t(language, "directoryCompareTitle", { model: model.id, field }),
        summary: [t(language, "directoryCompareCurrent", { value: JSON.stringify(model[field]) })],
        details: [t(language, "directoryCompareSuggested", { value: JSON.stringify(result.fields[field]), source }), ...(field === "maxTokens" ? [t(language, "directoryMaxTokensEffect")] : [])],
        defaultActionIndex: 0, cancelActionId: "keep",
        actions: [{ id: "keep", label: t(language, "directoryKeep") }, { id: "adopt", label: t(language, "directoryAdopt"), shortcut: "ctrl+s" }],
      });
      if (answer === "adopt") { adopted.push(field); summary.kept--; }
    }
  }
  const proposed = { ...model, ...Object.fromEntries(adopted.map((field) => [field, result.fields[field]])) };
  if (proposed.maxTokens > proposed.contextWindow) {
    summary.invalidLimits = true;
    for (const field of ["contextWindow", "maxTokens"] as const) {
      const index = adopted.indexOf(field);
      if (index >= 0) adopted.splice(index, 1);
    }
  }
  for (const field of adopted) {
    Object.assign(model, { [field]: structuredClone(result.fields[field]) });
    if (field === "contextWindow") metadata.contextSource = "directory";
    if (field === "maxTokens") metadata.maxTokensSource = "directory";
    if (field === "reasoning") metadata.thinkingSource = "directory";
  }
  if (adopted.length) {
    metadata.directoryFields = [...new Set([...(metadata.directoryFields ?? []), ...adopted])];
    metadata.directoryMatchMethod = result.matchMethod;
  }
  session.set(key, { attempted: true, result, ...(adopted.length ? { undo: { ...before, after: fingerprint(model, metadata) } } : previous?.undo?.after === fingerprint(model, metadata) ? { undo: previous.undo } : {}) });
  return summary;
}

export function directorySourceDetails(language: UiLanguage, result: DirectoryResult): string[] {
  return completionFields.flatMap((field) => result.sources[field]?.length ? [t(language, "directoryFieldSource", {
    field, method: result.matchMethod, source: result.sources[field]!.map((source) => `${source.provider}/${source.id}`).join(", "),
  })] : []).concat(result.effortHint ? [t(language, "directoryEffortHint", { values: result.effortHint.values.join(", ") })] : []);
}
