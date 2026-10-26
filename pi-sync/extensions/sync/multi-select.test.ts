import assert from "node:assert/strict";
import { test } from "node:test";
import { MultiSelectComponent, type MultiSelectItem, type MultiSelectResult } from "./multi-select.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value, bg: () => "" };
const tui = { requestRender() { /* noop */ } };

function setup(items: MultiSelectItem[]) {
  const results: (MultiSelectResult | undefined)[] = [];
  const component = new MultiSelectComponent("title", items, "[Ctrl+S Run]", tui, theme, (result) => results.push(result));
  return { component, results };
}

test("multi-select toggles with space and skips disabled items", () => {
  const items: MultiSelectItem[] = [
    { id: "pi", label: "Pi", checked: true },
    { id: "skills", label: "Skills", checked: true },
    { id: "other", label: "Other (missing)", disabled: true },
  ];
  const { component, results } = setup(items);
  assert.deepEqual(component.checkedIds(), ["pi", "skills"]);
  // 初始光标落在第一个可选项上；space 取消勾选 pi。
  component.handleInput(" ");
  assert.deepEqual(component.checkedIds(), ["skills"]);
  // 下移到 skills 并取消。
  component.handleInput("\x1b[B");
  component.handleInput(" ");
  assert.deepEqual(component.checkedIds(), []);
  // 下移到 disabled 项，space 无效。
  component.handleInput("\x1b[B");
  component.handleInput(" ");
  assert.deepEqual(component.checkedIds(), []);
  // 确认（Ctrl+S）返回勾选集合。
  component.handleInput("\x13");
  assert.deepEqual(results, [{ checked: [] }]);
});

test("multi-select resolves ctrl+s with checked ids and escape with undefined", () => {
  const items: MultiSelectItem[] = [
    { id: "pi", label: "Pi", checked: true },
    { id: "skills", label: "Skills" },
  ];
  const { component, results } = setup(items);
  component.handleInput("j"); // 非 space/导航键忽略
  assert.deepEqual(component.checkedIds(), ["pi"]);
  component.handleInput("\x1b"); // Esc 取消
  assert.deepEqual(results, [undefined]);
  // 渲染不抛错且包含标题与 footer。
  const lines = component.render(100);
  assert.ok(lines.join("\n").includes("title"));
  assert.ok(lines.join("\n").includes("[Ctrl+S Run]"));
});
