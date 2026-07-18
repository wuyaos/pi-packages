Implemented the remaining `pi-cc-tui` merge work.

Changed files:
- Added Codex editor, unified commands, statusline, package manifest, and README.
- Updated monorepo manifest to discover themes.
- Updated root README package list.
- Removed legacy `pi-themes` and `pi-statusline` directories.
- Commit `3b49f4b` pushed to `origin/master`.

Validation:
- All 6 extension files contain default exports.
- TypeScript syntax checks passed.
- All 99 theme JSON files parsed successfully.
- Git tree is clean and synchronized with remote.

Open risks/questions: Full interactive Pi/Jiti runtime loading was not performed because the task prohibited modifying `~/.pi/agent`; runtime validation remains advisable.

Recommended next step: Update the installed Pi git package and test `/use-cc-tui`, `/use-default-tui`, `/theme`, and Ctrl+T interactively.