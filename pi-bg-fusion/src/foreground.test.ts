import { describe, expect, it } from "vitest";
import { latestForegroundCall, registerForegroundCall, unregisterForegroundCall } from "./foreground.js";

describe("foreground call selection", () => {
  it("selects the most recent live call and preserves earlier calls", () => {
    const first = () => undefined;
    const second = () => undefined;
    registerForegroundCall("first", { background: first });
    registerForegroundCall("second", { background: second });
    expect(latestForegroundCall()).toBe("second");
    unregisterForegroundCall("second");
    expect(latestForegroundCall()).toBe("first");
    unregisterForegroundCall("first");
    expect(latestForegroundCall()).toBeUndefined();
  });
});
