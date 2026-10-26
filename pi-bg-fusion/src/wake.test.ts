import { describe, expect, it } from "vitest";
import { pendingForBudgetFailure, pendingWakeFromMatch, removePendingWake, scanWakeWindow, validateWakePatterns, wakeDeliveryDisposition, wakeScanCommitDecision } from "./wake.js";

describe("running output wake", () => {
  it("validates regexes and advances an absolute byte cursor", () => {
    expect(validateWakePatterns(["ERROR", "warn.*"])).toEqual(["ERROR", "warn.*"]);
    expect(() => validateWakePatterns(["["])).toThrow(/valid regular expression/);
    const bytes = new TextEncoder().encode("ok\nERROR one\nwarn two\n");
    const result = scanWakeWindow(bytes, { generation: 0, offset: 0 }, 0, ["ERROR", "warn"]);
    expect(result.matches.map((match) => match.line)).toEqual(["ERROR one", "warn two"]);
    expect(result.matches.map((match) => match.offset)).toEqual([3, 13]);
    expect(result.cursor).toEqual({ generation: 0, offset: bytes.length });
  });

  it("scans only a bounded tail and advances from an absolute offset", () => {
    const prefix = "x".repeat(70 * 1024);
    const bytes = new TextEncoder().encode(`${prefix}\nTAIL ERROR\n`);
    const baseOffset = bytes.length - 64 * 1024;
    const result = scanWakeWindow(bytes.subarray(baseOffset), { generation: 0, offset: baseOffset }, 0, ["ERROR"], baseOffset);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.line).toBe("TAIL ERROR");
    expect(result.matches[0]?.offset).toBe(bytes.length - "TAIL ERROR\n".length);
    expect(result.cursor.offset).toBe(bytes.length);
  });

  it("advances through a long no-newline segment without stalling", () => {
    const bytes = new TextEncoder().encode("x".repeat(70 * 1024));
    const result = scanWakeWindow(bytes.subarray(0, 64 * 1024), { generation: 0, offset: 0 }, 0, ["NEVER"], 0);
    expect(result.cursor.offset).toBe(64 * 1024);
    expect(result.matches).toEqual([]);
  });

  it("resets the offset when log generation changes", () => {
    const bytes = new TextEncoder().encode("rotated ERROR\n");
    const result = scanWakeWindow(bytes, { generation: 0, offset: 999 }, 1, ["ERROR"]);
    expect(result.matches).toHaveLength(1);
    expect(result.cursor.generation).toBe(1);
  });

  it("keeps structured pending matches when delivery is deferred", () => {
    const meta = { id: "task", cwd: ".", callbackOrigin: { cwd: ".", sessionId: "s" } } as import("./types.js").BackgroundTaskMeta;
    const match = { pattern: 0, patternText: "ERROR", line: "ERROR one", offset: 4, generation: 2, key: "task\\0" };
    const pending = pendingWakeFromMatch(meta, match);
    expect(pending.line).toBe("ERROR one");
    expect(removePendingWake([pending, "legacy"], pending.key)).toEqual(["legacy"]);
    expect(wakeDeliveryDisposition(false, true)).toBe("deferred");
    expect(wakeDeliveryDisposition(true, false)).toBe("deferred");
    expect(wakeDeliveryDisposition(true, true)).toBe("delivered");
  });

  it("does not commit scan progress when the budget lock is unavailable", () => {
    expect(wakeScanCommitDecision(false)).toBe("pending");
    expect(wakeScanCommitDecision(true)).toBe("commit");
  });

  it("persists all candidates for a budget-lock retry without changing progress", () => {
    const meta = { id: "task", cwd: "." } as import("./types.js").BackgroundTaskMeta;
    const match = { pattern: 0, patternText: "ERROR", line: "ERROR one", offset: 4, generation: 0, key: "k" };
    expect(pendingForBudgetFailure(meta, [], [match])).toEqual([pendingWakeFromMatch(meta, match)]);
  });
});
