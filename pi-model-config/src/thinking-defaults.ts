import type { ThinkingLevelMap, ThinkingMetadataSource } from "./types.ts";

const PROTOCOL_THINKING_MAPS: Readonly<Record<string, Readonly<ThinkingLevelMap>>> = {
  "anthropic-messages": { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  // pi-ai accepts these standard OpenAI-compatible reasoning_effort values. xhigh/max
  // remain model-specific opt-ins, so a generic protocol default must not claim support.
  "openai-completions": { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  "openai-responses": { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  "openai-codex-responses": { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  "azure-openai-responses": { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  "pi-messages": { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};

export function protocolThinkingMap(api: string): ThinkingLevelMap | undefined {
  const map = PROTOCOL_THINKING_MAPS[api];
  return map ? { ...map } : undefined;
}

export function defaultChatThinking(
  api: string,
  observed: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap },
  observedSource: Extract<ThinkingMetadataSource, "existing" | "remote" | "catalog">,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap; thinkingSource?: ThinkingMetadataSource } {
  const observedMap = observed.thinkingLevelMap;
  // An empty local/catalog map conveys no per-level information. Remote discovery,
  // however, can explicitly declare an empty map, which must remain authoritative.
  if (observedMap !== undefined && (observedSource === "remote" || Object.keys(observedMap).length > 0)) {
    return {
      reasoning: observed.reasoning ?? true,
      thinkingLevelMap: { ...observedMap },
      thinkingSource: observedSource,
    };
  }
  const protocol = protocolThinkingMap(api);
  return {
    reasoning: observed.reasoning ?? true,
    ...(protocol ? { thinkingLevelMap: protocol, thinkingSource: "protocol" as const } : {}),
  };
}
