# Changelog

## 0.1.3 - 2026-06-24

### Changed

- Bumped pi peer dependencies to `>=0.80.2`.

## 0.1.2 - 2026-06-23

### Changed

- Bumped package and pi peer/dev dependencies to `0.80.1`.
- Updated advisor completion calls to import the compatibility helper from `@earendil-works/pi-ai/compat`, matching pi-ai `0.80.1`.

## 0.1.1

### Changed

- Bumped package and pi peer/dev dependencies to `0.79.1`.
- Added pi `0.79.1` autocomplete-provider integration for `/advisor ...` and `/advise ...` arguments.
- Honor pi project trust for project-local `.pi/advisor.json`; untrusted projects cannot silently configure advisor or enable auto-triggers.

## 0.1.0

### Added

- Initial release of pi-advisor
- Added runtime config validation and pure-helper tests

### Fixed

- Retry advisor once with visible-text-only prompting when the reviewer returns reasoning-only output, and show diagnostics instead of the vague "returned no text" placeholder
- Treat `timeoutMs: 0` as provider-default timeout when calling the reviewer model
- Remove arbitrary 120-char truncation from loop-detection fingerprint
- Reorder /advise autocomplete — steer/pipe before show
- Robust arg parsing in /advisor autocomplete

### Changed

- Require an explicitly configured advisor model before sending transcripts; removed implicit latest-GPT/current-model fallback
- Documented `/advise` default injection behavior and named transcript truncation limits
- Hardened the reviewer prompt against transcript-borne prompt injection
- Made /advisor model selection scrollable so long model lists stay within the terminal view
- Refreshed the model registry before listing and resolving advisor models so OAuth/subscription-backed providers added via /login are selectable
- Allowed advisor model resolution and execution to use header-only auth as well as API-key auth
- Changed /advise so its default show mode is clearly UI-only and not presented as model-injected chat content; added pipe and steer modes to feed advisor feedback into the active conversation
- Added loop detection to when-stuck trigger
- Clarified /advisor opens interactive model picker + thinking-level selection
- Split /advisor none/default into two lines
- Merged /advisor picker rows into single line
- Updated /advisor when-stuck table row to mention loop detection
