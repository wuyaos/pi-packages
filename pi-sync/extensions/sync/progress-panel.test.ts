import assert from "node:assert/strict";
import { test } from "node:test";
import { ProgressPanelComponent, showProgressPanel, type ProgressPanelState } from "./progress-panel.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value, bg: () => "" };

test("progress panel renders status, current and completed rows", () => {
  const state: ProgressPanelState = {
    status: "进度：1/2",
    current: "当前：Skills",
    rows: [{ ok: true, text: "✅ Pi：pi.tar.xz" }],
  };
  const component = new ProgressPanelComponent("备份中…", state, { requestRender() {} }, theme);
  const text = component.render(80).join("\n");
  assert.match(text, /备份中…/);
  assert.match(text, /进度：1\/2/);
  assert.match(text, /当前：Skills/);
  assert.match(text, /pi\.tar\.xz/);

  // 状态被原地修改后，必须 refresh（清缓存）才反映到渲染。
  state.rows.push({ ok: false, text: "❌ Skills：failed" });
  assert.doesNotMatch(component.render(80).join("\n"), /failed/);
  component.refresh();
  assert.match(component.render(80).join("\n"), /failed/);
});

test("showProgressPanel closes via finish and resolves the custom promise once", async () => {
  let doneCount = 0;
  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) =>
        new Promise<void>((resolve) => {
          factory({ requestRender() {} }, theme, {}, () => {
            doneCount += 1;
            resolve();
          });
        }),
    },
  };
  const panel = showProgressPanel(ctx as never, "备份中…");
  panel.update({ status: "进度：0/1", current: "当前：Pi", rows: [] });
  await panel.finish();
  assert.equal(doneCount, 1);
});

test("showProgressPanel is a no-op without UI", async () => {
  const panel = showProgressPanel({ hasUI: false } as never, "备份中…");
  panel.update({ status: "s", current: "c", rows: [] });
  await panel.finish();
});
