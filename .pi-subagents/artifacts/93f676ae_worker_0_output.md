Implemented the 7 requested pi-cc-tui statusline features.

Changed files: `pi-cc-tui/extensions/statusline.ts`.

Validation:
- TypeScript syntax check passed with Node type stripping.
- `git diff --check` passed.
- Commit `6c54ffa` created and pushed to `origin/master`.
- No staged files remain.

Open risks/questions:
- “Orange” and red both use Pi’s `error` theme token; usage above 95% is additionally bold.
- TTFT/TPS depend on streaming `message_update` usage counters.
- Existing `.pi-subagents/artifacts/*` files remain untracked and were intentionally not modified.

Recommended next step: pull/reload the installed package and test `/cc-tui all`, then restore desired defaults with `/cc-tui only model git context output`.