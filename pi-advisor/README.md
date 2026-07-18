# pi-advisor

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that offers a
parameterless `advisor` tool — inspired by Claude Code's advisor, but expanded with additional
nudges and a manual review procedure. The regular model calls `advisor` to get a second opinion
from an explicitly configured **stronger reviewer model** that sees the *entire* conversation transcript. Beyond the
callable tool, the extension can also **auto-consult** the reviewer when the agent seems stuck
or finishes a task, and the human can invoke a manual review via `/advise`.

## What it does

When the model calls `advisor` (no arguments), the extension serializes the full active branch —
user/assistant text, assistant **reasoning**, every **tool call (with args)** and its **result** —
and forwards it to a stronger reviewer model with a reviewer system prompt. The reviewer returns
direct, actionable advice (flag wrong assumptions, name what's likely to bite, scrutinize "I'm
done" claims). Individual tool-call arguments are truncated at 800 characters and tool results at
2,000 characters so huge outputs do not dominate the review; after that, the transcript is truncated
oldest-first only if it would overflow the reviewer's context window.

Beyond the callable tool, the extension provides two additional ways to get advice:

- **Automatic nudges** — the tool's `promptGuidelines` encourage the model to call advisor
  *before substantive work*, *when stuck*, and *when it believes the task is complete*. Two
  opt-in deterministic triggers (`onDone`, `whenStuck`) go further: they auto-consult the
  reviewer and inject the feedback directly into the conversation so the agent sees it.
- **Manual review via `/advise`** — the human can invoke a one-off review at any time. Feedback
  can be shown UI-only (informal, for the human), piped into the chat as a user message, or
  injected as a steering message so the running agent sees and acts on it.

## Files & install

- `advisor.ts` — canonical source (this repo).
- Package-installed copy: loaded from this package's `pi.extensions` manifest after `pi install`.

Install just this extension from npm:

```bash
pi install npm:@hk_net/pi-advisor
```

Or install the full collection from GitHub:

```bash
pi install git:git@github.com:hknet/pi-extensions@main
pi install https://github.com/hknet/pi-extensions
```

Or install manually (copy just this extension):

```bash
cp packages/pi-advisor/advisor.ts ~/.pi/agent/extensions/advisor.ts
```

> When installed as an npm package, pi loads `advisor.ts` through this package's `pi.extensions`
> manifest. When installed through the GitHub collection, pi loads it through the root package
> manifest. If you manually copy the file instead, that copied production file is separate from this
> source; re-copy it after edits and run `/reload`.

## Configuration

JSON, resolved **project-over-global** (first scope that defines a key wins):

- Project: `<cwd>/.pi/advisor.json` (honored only when pi considers the project trusted)
- Global:  `~/.pi/agent/advisor.json`

```jsonc
{
  "model":     "openai-codex/gpt-5.5",      // "provider/id", or "none" to disable + hide the tool
  "thinking":  "high",                      // off|minimal|low|medium|high|xhigh (default high)
  "onDone":    false,                       // auto-review when the agent finishes a task
  "whenStuck": 0,                           // auto-consult after N consecutive errors or N repeated identical tool calls (0 = off)
  "timeoutMs": 120000                       // advisor call timeout in ms (0 = use provider default)
}
```

**Model precedence:** env `PI_ADVISOR_MODEL` > project > global. If no model is explicitly
configured, advisor remains discoverable but sends no transcript and asks the user to choose a
trusted reviewer model with `/advisor`. Thinking level uses the same order via
`PI_ADVISOR_EFFORT` / project / global, default `high`. Timeout uses env
`PI_ADVISOR_TIMEOUT_MS` > project > global, default 120 000 ms (2 minutes).

**Why the timeout?** When the running model calls `advisor`, it waits for the tool result.
Without a timeout, a slow reviewer model or dropped connection would hang the entire turn.
The timeout ensures the running model always makes progress.

**No implicit reviewer fallback:** the extension does not auto-pick a reviewer model. This avoids
surprising cross-provider transcript sharing. The model picker refreshes the registry before listing
so API-key models and OAuth/subscription-backed models (for example providers added with `/login`)
are selectable.

## Commands

| Command | Effect |
|---|---|
| `/advisor <enter>` | Open the interactive model-picker dialog (scrollable list of available models), then choose project vs global scope, then pick a thinking level |
| `/advisor none` | Disable advisor for a scope → choose scope |
| `/advisor default` | Clear a scope; if no env/lower-scope model remains, advisor becomes not configured |
| `/advisor on-done on\|off` | Toggle auto-review-on-finish → choose scope |
| `/advisor when-stuck off\|<N>` | Trigger advisor on N consecutive errors or N repeated identical tool calls → choose scope |
| `/advisor status` | Show the resolved configuration |
| `/advise [show\|pipe\|steer]` | Run a one-off review now; default is `pipe` when idle and `steer` while the agent is running |

### `/advise` modes

- **`/advise`** — quick advice injection: sends feedback as a user message when idle, or as a
  steering message while the agent is running.
- **`/advise show`** — display advisor feedback to the human only. Clearly marked as
  **not sent to the model** — useful for informal review.
- **`/advise pipe`** — inject the advisor feedback into the active chat as a user message. If the
  agent is already running, it is queued as a follow-up so the agent sees it in the next turn.
- **`/advise steer`** — inject the advisor feedback as a steering message when the agent is running,
  so the agent sees it immediately without waiting for the current turn to complete.

## Automatic triggers

Default **off** — out of the box the regular model decides when to call `advisor`, nudged by the
tool's `promptGuidelines`. Two opt-in deterministic triggers, configurable per project and global:

- **`onDone`** — on `agent_end`, auto-review and steer one follow-up so the agent addresses any
  issues before truly stopping (guarded to at most once per user prompt).
- **`whenStuck: N`** — after N consecutive tool errors **or** N repeated identical tool calls
  (same tool name + same arguments), auto-consult the reviewer and inject the advice as a
  steering message to get unstuck.

## Privacy & security

- **No transcript is sent until a reviewer model is explicitly configured.** Out of the box,
  advisor is discoverable but unconfigured; calls return setup guidance instead of falling back to
  another model.
- **Project config follows pi project trust.** A global install ignores `<cwd>/.pi/advisor.json`
  while the current project is untrusted, so an untrusted checkout cannot silently choose a reviewer
  model or enable auto-triggers.
- **Auto-triggers are off by default.** The `onDone` and `whenStuck` features must be explicitly
  enabled in configuration, and they do nothing unless a reviewer model is configured.
- **Data sent to the reviewer model.** When `advisor` is called, the extension sends the full
  active conversation branch to the configured reviewer model via the provider's API. This
  includes:
  - User messages and assistant text
  - Assistant reasoning/thinking blocks
  - Tool call names, arguments, and results (file paths, command output, etc.; tool-call arguments
    are truncated at 800 characters and tool results at 2,000 characters)
  - Tool result errors
- **You control which model receives the data.** Configure `model` in `advisor.json` to point
  to a provider/model you trust. If no model is configured, no reviewer API call is made.
- **No data is stored or logged by this extension.** The transcript is sent in-memory to the
  reviewer model's API and not persisted locally.
- **Be mindful of secrets.** Tool results may contain secrets (API keys, credentials, tokens)
  from `bash` output or file contents. If your project contains sensitive data, consider
  configuring advisor to use a provider with a strong privacy policy, or disable auto-triggers.

## Implementation notes (pi extension API)

- **Call a model from an extension:** `complete(model, { systemPrompt, messages }, { apiKey, headers,
  signal, reasoningEffort, maxTokens })` from `@earendil-works/pi-ai/compat`. Resolve auth with
  `ctx.modelRegistry.find(provider, id)` → `await ctx.modelRegistry.getApiKeyAndHeaders(model)`
  (`{ ok, apiKey, headers }`). `getAvailable()` lists only auth-configured models; `ctx.model` is the
  current one; `Model` carries `.contextWindow` / `.maxTokens`. `reasoningEffort` is a passthrough
  extra, not in the typed `StreamOptions`.
- **Read the conversation:** `ctx.sessionManager.getBranch()` (active path). Entries are
  `{ type:"message", message }` with `role` `user|assistant|toolResult`; assistant content blocks are
  `text` / `thinking` / `toolCall`; toolResult has `toolName`, `content`, `isError`.
- **Show output to the human without injecting it:** `pi.sendMessage({ customType, content, display:true })` +
  `pi.registerMessageRenderer(customType, …)`. To make the agent *act* on injected advice, use
  `pi.sendUserMessage(text, { deliverAs })` (it reaches the LLM and triggers a turn).
- **Hide/show a tool:** `pi.setActiveTools(pi.getActiveTools()…)`. `promptSnippet`/`promptGuidelines`
  only appear while the tool is active.
- **Argument autocomplete:** the extension keeps `getArgumentCompletions` for command metadata and
  also layers a `ctx.ui.addAutocompleteProvider()` on `session_start` so `/advisor ...` and
  `/advise ...` completions replace the whole argument segment and suppress irrelevant path
  completion while typing command arguments (pi ≥ 0.79.1).
- The package's `examples/extensions/summarize.ts` remains the canonical extension reference; with pi-ai
  `0.80.1`, import legacy `complete()` calls from `@earendil-works/pi-ai/compat`.
