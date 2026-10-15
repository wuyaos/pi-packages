# pi-model-config offline tests

These tests use `node:test` and Pi's own Jiti runtime. They do not contact external providers, require API keys, or read/write `~/.pi`; filesystem cases use OS temporary directories and Discovery cases bind only an ephemeral `127.0.0.1` HTTP server.

Run the three machine-local helpers from the repository root:

```bash
node pi-model-config/tests/typecheck.mjs
node pi-model-config/tests/run.mjs
node pi-model-config/tests/loader-smoke.mjs
```

These helpers are intentionally not root workspace scripts: they validate this package only and depend on this checkout's local TypeScript/Undici installation. Their default Pi SDK 1.2.0 location is:

```text
C:/app/scoop/persist/nodejs24/bin/node_modules/@earendil-works/pi-coding-agent
```

Set `PI_SDK_ROOT` to an equivalent Pi SDK 1.2.0 installation when the location differs.

- `typecheck.mjs` creates and removes a temporary strict TypeScript config covering the extension entry, every `src/*.ts` file, and every `tests/*.test.ts` file. It invokes the real `node_modules/typescript/bin/tsc`, not the broken `.bin` link.
- `run.mjs` aliases Pi host packages and `undici` to the selected SDK for the focused `node:test` unit/integration suite. Command registration is also exercised through SDK `loadExtensionFromFactory()`.
- `loader-smoke.mjs` deliberately adds no Jiti aliases. It calls the selected SDK's real `loadExtensions()` against the package entry with an isolated temporary `PI_CODING_AGENT_DIR`, loads a dummy chat/classifier/image provider fixture, and verifies the command plus pending native provider registration without making a model or network request. The fixture directory is removed in `finally`.

The focused test coverage includes:

- independent Chinese/English dictionaries and isolated UI-language preferences;
- candidate merge precedence, search-scoped selection, type conflicts, external/read-only rows, and language-preserved selection;
- explicit overlay options and the real hierarchy overview → connection/model → preview;
- fixed bottom action bars, no action/provider intermixing, 80/100/48-column and short-height layouts, narrow pane switching, bounded rows, Tab/Shift+Tab, and global page shortcuts from search/list/details/action focus;
- controller state preservation across F2 and preview back: page, focus, search, provider/model selection, draft, and scroll;
- default search-focus Up/Down handling for CSI, SS3, and Kitty sequences, with clamped boundaries, filtered lists, live right-side details, and fixed `→` current-row indicators;
- model Ctrl+R footer visibility at 80/48 columns, action-focus Enter execution, derived Discovery URL normalization/resolved-base fallback, use/edit/cancel routing, and fetch cancel/failure byte preservation;
- existing models.json chat takeover: cancel writes nothing, save preserves unknown metadata, uncheck removes only adopted rows, and other providers remain unchanged;
- masked bracketed paste handling without plaintext rendering;
- two-file transaction success, backups, cleanup, optimistic conflicts, and active locks;
- local HTTP Discovery profiles/candidate ordering, 404/405-only fallback, array/data/models/list/result parsing, string/Codex rows, auto auth headers, cross-origin reuse rejection, redirect containment, 1 MiB streamed-body limits, pagination markers, and HTTP-error redaction;
- mocked `/model-config` cancellation, local validation recovery, temporary-auth save blocking, discard confirmation, current-model disable protection, and explicit-save paths;
- disabled-provider legacy empty-catalog registration and third-party rejection;
- model test concurrency, timeout, global cancellation, chat/classifier defaults, image opt-in confirmation, and in-memory-only results.

- unified ConfirmationPanel contexts, safe defaults, keyboard selection, Esc cancel, and static no-ctx.ui.confirm enforcement.
- compatibility context metadata persistence, explicit 128000/16384 serialization, image exclusion, owned-runtime missing-field issues, and context probe success/overflow/auth/timeout/cancel behavior.
- managed model parameter editing (K/M numeric parsing, invariants, modalities, thinking maps, image output, costs), horizontal action navigation, and opt-in thinking-level probe metadata precedence/terminal classification.
