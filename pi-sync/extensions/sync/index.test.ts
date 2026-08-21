import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import registerSyncExtension, { exitUploadDue, projectDirFromSessionDir, recordExitUpload } from "./index.ts";

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

test("exit upload throttling tolerates missing, invalid, and fresh markers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-exit-"));
  const marker = path.join(root, "state", "marker.txt");
  try {
    const now = 1_800_000_000_000;
    assert.equal(exitUploadDue(marker, now), true, "missing marker should allow upload");
    recordExitUpload(marker, now);
    assert.equal(exitUploadDue(marker, now + 1_000), false, "a fresh marker should throttle the upload");
    assert.equal(exitUploadDue(marker, now + 3600_000), true, "an expired interval should allow the upload");
    fs.writeFileSync(marker, "garbage");
    assert.equal(exitUploadDue(marker, now), true, "an invalid marker should allow the upload");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
