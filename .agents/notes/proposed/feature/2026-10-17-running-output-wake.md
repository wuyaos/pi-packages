# Agent Note: Running output wake

Status: proposed

## Problem

`pi-bg-fusion` currently wakes the parent session for terminal completion and existing failure/watch attention, but it does not support configured keyword/regex wakeups while a task is still running. The frozen contract requires bounded, crash-safe, cross-process deduplication without introducing a second delivery surface.

## Proposal

Add `src/wake.ts` as the only wake policy/state module. Scan newly appended log bytes using a cursor keyed by `logGeneration` plus absolute byte offset. Validate wake regexes before task directories are created. Persist the advanced cursor and pending wake summary through the existing fsync-and-rename metadata writer before calling the shared callback batcher, so a crash prefers a missed wake over a duplicate.

Use `UrgentCallbackEvent` with a composite `id` containing task, pattern, generation, and offset; retain the task id as `inspectId`. Reuse `deliverUrgent`, failure attention suppression, and existing callback receipts. Enforce per-task duplicate line/pattern suppression, a 60-second cooldown, ten wakes per task, and a session hourly cap. Store cross-process budget state as atomically replaced JSON under `%TEMP%/pi-bg/wake-budget.json`, protected by the existing `proper-lockfile` dependency. Scan local tasks from the existing one-second retention tick, remote tmux output after append, and command-watch output after append.

## Alternatives considered

Adding a new notification queue was rejected because it would duplicate callback suppression and receipt semantics. SQLite was rejected because the task only needs one small shared budget document and the package already has lockfile plus atomic JSON patterns. Scanning the whole log on every tick was rejected because generation/absolute cursors provide bounded incremental work.

## Acceptance criteria

Wake patterns are validated before task directory creation; local, remote tmux, and command-watch append paths scan incrementally; metadata cursor/pending state is committed before delivery; duplicate lines, cooldown, per-task, and hourly limits hold across processes; typecheck and focused tests pass; existing terminal callback and normal-quit keep behavior remain unchanged.

## Risks

Output append and metadata commits are separate files, so a crash between them can miss a wake but must not create a duplicate. Log rotation changes generation and must reset the scan offset without rereading old bytes. The hourly JSON budget can be contended by multiple Pi processes, so lock acquisition and atomic replacement must be tested.
