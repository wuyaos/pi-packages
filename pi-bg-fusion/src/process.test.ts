import { describe, expect, it } from "vitest";
import { bashSingleQuote, toMsysPath, withWindowsLogRedirect } from "./process.js";

describe("Windows bash launch helpers", () => {
  it("converts drive paths for MSYS redirection", () => {
    expect(toMsysPath("D:\\work dir\\日志.log")).toBe("/d/work dir/日志.log");
  });

  it("quotes shell values without allowing embedded quote injection", () => {
    expect(bashSingleQuote("a'b")).toBe("'a'\\''b'");
  });

  it("redirects shell commands into the durable log without restarting them", () => {
    const result = withWindowsLogRedirect({ command: "printf ready", shell: true }, "C:\\Temp\\task.log");
    expect(result.command).toBe("exec >> '/c/Temp/task.log' 2>&1\nprintf ready");
  });
});
