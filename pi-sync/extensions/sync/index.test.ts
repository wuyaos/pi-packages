import assert from "node:assert/strict";
import { test } from "node:test";
import registerSyncExtension, { projectDirFromSessionDir } from "./index.ts";

test("projectDirFromSessionDir accepts only Pi project session directories", () => {
  assert.equal(
    projectDirFromSessionDir("/home/user/.pi/agent/sessions/--mnt-d-work-project--"),
    "--mnt-d-work-project--",
  );
  assert.equal(projectDirFromSessionDir("/tmp/not-a-project"), undefined);
  assert.equal(projectDirFromSessionDir(undefined), undefined);
});

test("archive-only entrypoint registers no per-turn or live-sync hooks", () => {
  const events: string[] = [];
  let command = "";
  registerSyncExtension({
    on: (event: string) => { events.push(event); },
    registerCommand: (name: string) => { command = name; },
  } as never);
  assert.deepEqual(events, ["session_start", "session_shutdown"]);
  assert.equal(command, "sync");
});
