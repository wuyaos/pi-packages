/**
 * pi-model-roles — Extension entry point.
 *
 * Extension dependency library: provides a ModelRolesAPI singleton and a
 * /roles inspection command. It registers session/model hooks to initialize
 * and keep the singleton current.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { initModelRolesAPI, getModelRolesAPI, updateCurrentModel } from "./api.ts";

export { getModelRolesAPI } from "./api.ts";
export type {
  ModelRolesAPI,
  RoleConfig,
  ResolvedRole,
  ModelRolesConfig,
  ThinkingLevel,
} from "./types.ts";
// Re-export pi-ai types so consumers depend on model-roles alone, not pi-ai.
export type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export default function registerModelRolesExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    initModelRolesAPI(ctx.modelRegistry, ctx.model, ctx.cwd);
  });

  pi.on("model_select", async (event) => {
    updateCurrentModel(event.model);
  });

  pi.registerTool({
    name: "list_models",
    label: "List available models",
    description: "List all available models from pi's model registry. Returns provider/model-id strings (e.g. 'anthropic/claude-sonnet-4'). Useful for confirming model IDs before referencing a model by name.",
    parameters: Type.Object({}),
    async execute() {
      const api = getModelRolesAPI();
      const models = api.listModels();
      return {
        content: [{ type: "text", text: models.join("\n") }],
        details: undefined as any,
      };
    },
  });

  pi.registerTool({
    name: "use_role",
    label: "Switch model role",
    description: "Switch the current model + thinking level to a named role. Use this to pick the right model for the task. Available roles: primary (daily coding, glm-5.2), architect (architecture/security, claude-opus-4.8 high), think (extreme reasoning, claude-opus-4.8 xhigh), codegen (complex code generation, gpt-5.6-sol high), audit (independent code review, deepseek-v4-pro high), quick (simple edits, deepseek-v4-flash low), backup (fallback, gpt-5.6-terra), compact (context compression, deepseek-v4-flash off), image (image generation, gpt-image-2 off), lite (lightweight tasks, gpt-5.6-luna off). Role definitions are in settings.json modelRoles.",
    parameters: Type.Object({
      role: Type.String({ description: "Role name to switch to (e.g. primary, architect, think, codegen, audit, quick, backup)" }),
    }),
    async execute(_toolCallId, params) {
      const api = getModelRolesAPI();
      const roleName = params.role;
      const roleConfig = api.getRole(roleName);
      if (!roleConfig) {
        return {
          content: [{ type: "text", text: `Unknown role: ${roleName}. Available: ${Object.keys(api.getRoles()).join(", ")}` }],
          details: undefined as any,
        };
      }
      const resolved = api.resolveRole(roleName);
      if (!resolved.model) {
        return {
          content: [{ type: "text", text: `Role "${roleName}" model not available: ${roleConfig.model}` }],
          details: undefined as any,
        };
      }
      const success = await pi.setModel(resolved.model);
      if (!success) {
        return {
          content: [{ type: "text", text: `No API key for ${resolved.model.provider}/${resolved.model.id}` }],
          details: undefined as any,
        };
      }
      if (roleConfig.thinking) {
        pi.setThinkingLevel(roleConfig.thinking as any);
      }
      return {
        content: [{ type: "text", text: `Switched to role "${roleName}": ${resolved.model.provider}/${resolved.model.id} [${roleConfig.thinking ?? "off"}]` }],
        details: undefined as any,
      };
    },
  });

  pi.registerCommand("roles", {
    description: "Show model role definitions and resolved models",
    handler: async (_args, ctx) => {
      const api = getModelRolesAPI();
      const roles = api.getRoles();
      const lines: string[] = ["Model Roles:", ""];

      for (const [name, config] of Object.entries(roles)) {
        const resolved = api.resolveRole(name);
        const hidden = config.hidden ? " (hidden)" : "";
        const modelLabel = resolved.model
          ? `${resolved.model.provider}/${resolved.model.id}`
          : config.model === null
            ? "→ current model"
            : `→ NOT FOUND (${config.model})`;
        const thinking = config.thinking ? ` thinking:${config.thinking}` : "";
        lines.push(`  ${name}: ${modelLabel}${thinking}${hidden}`);
      }

      lines.push("");
      lines.push(`Default role: ${api.getDefaultRole()}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
