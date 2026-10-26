import assert from "node:assert/strict";
import { test } from "node:test";
import { RestorePanelComponent, type RestorePanelOptions } from "./restore-panel.ts";
import { buildRestoreRows } from "./restore-rows.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value, bg: () => "" };
const tui = { requestRender() { /* noop */ } };

const rows = buildRestoreRows([
  "devA-win-pi_20250102-030405.tar.xz",
  "devA-win-skills_20250102-030405.tar.xz",
  "devB-linux-pi_20250601-000000.tar.xz",
]);

function setup() {
  const picked: (unknown)[] = [];
  const options: RestorePanelOptions = {
    title: "Restore",
    rows,
    texts: { filterLabel: "Device: {value} (←/→)", allDevices: "All devices" },
    formatRow: (row) => `${row.device} ${row.tags.join("+")}`,
  };
  const component = new RestorePanelComponent(options, tui, theme, (row) => picked.push(row));
  return { component, picked };
}

test("restore panel filters rows with left/right and resets the cursor", () => {
  const { component } = setup();
  // 默认全部：最新 devB 在前。
  assert.equal(component.currentRow()!.device, "devB");
  // ←（循环）切到 devA。
  component.handleInput("\x1b[D");
  assert.equal(component.currentDevice(), "devA");
  assert.equal(component.currentRow()!.device, "devA");
  assert.equal(component.currentRow()!.tags.join("+"), "pi+skills");
  // ↓ 在 devA 单行内循环回自身。
  component.handleInput("\x1b[B");
  assert.equal(component.currentRow()!.device, "devA");
  // → 循环回到全部。
  component.handleInput("\x1b[C");
  assert.equal(component.currentDevice(), undefined);
  assert.equal(component.currentRow()!.device, "devB");
});

test("restore panel enter picks the highlighted row", () => {
  const { component, picked } = setup();
  component.handleInput("\r");
  assert.equal((picked[0] as { device: string }).device, "devB");
});

test("restore panel escape cancels and render includes filter and rows", () => {
  const { component, picked } = setup();
  component.handleInput("\x1b");
  assert.deepEqual(picked, [undefined]);
  const text = component.render(100).join("\n");
  assert.ok(text.includes("Device: All devices"));
  assert.ok(text.includes("devA pi+skills"));
});
