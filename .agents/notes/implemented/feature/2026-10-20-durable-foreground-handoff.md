# Agent Note: Durable foreground handoff

Status: implemented

## Problem

The durable background-task kernel started commands only through explicit
background tools. A normal Pi `bash` call could block the turn indefinitely,
and Windows restart recovery could not distinguish a surviving process from a
reused PID.

## Decision

`pi-bg-fusion` overrides the foreground `bash` definition and launches it through
the same durable registry used by `bg_task_spawn`. For its first foreground
phase the extension tails that task's log into tool updates. At the configured
threshold, or on Ctrl+B, it stops waiting without restarting the process; the
same PID, log, metadata, completion callback, and process-tree stop path remain
in force.

Every metadata update is a write/fsync/rename journal commit. Windows task
identity is PID plus CIM `CreationDate`, normalized to UTC. Recovery snapshots
all relevant PIDs in one PowerShell query. An inconclusive query is `unknown`
and never proves death.

Normal quit asks for one keep/stop default and supports per-task overrides.
Reload and session replacement transfer management without stopping work.

## Alternatives considered

Using Pi's native foreground process and adopting it only at timeout would
preserve native rendering, but its process and output handles are private and
cannot be transferred safely. Restarting the command at timeout was rejected
because it duplicates side effects and violates PID continuity. Treating failed
CIM probes as death was rejected because transient PowerShell failure would let
recovery kill or abandon a live task.

## Consequences

Foreground execution now creates durable metadata immediately, even for commands
that finish quickly. This is the cost of an in-place handoff with crash safety.
The extension keeps the established `bg_task*` tools and Windows `taskkill /T /F`
termination path. Completed metadata remains subject to the existing seven-day
maintenance policy; running tasks are never retention-deleted.
