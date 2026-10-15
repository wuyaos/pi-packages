import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  showConnectionPanel,
  showConfirmationPanel,
  showPreviewPanel,
  showProviderPanel,
  type MenuPanelState,
  type OverviewPanelState,
  type PanelItem,
} from "../src/panel.ts";

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

function context<T>(rows: number, drive: (component: any) => void, columns = 100, onOptions?: (options: any) => void): any {
  return {
    ui: {
      custom: async (factory: any, options?: any): Promise<T> => new Promise<T>((resolve, reject) => {
        onOptions?.(options);
        const tui = { requestRender() {}, terminal: { rows, columns } };
        Promise.resolve(factory(tui, theme, {}, resolve)).then(drive, reject);
      }),
    },
  };
}

function items(count: number): PanelItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `provider-${index}`,
    label: `Provider ${index} (provider-${index}) [Custom]`,
    details: [`Provider ID: provider-${index}`, `Base URL: https://example.test/${index}`],
    modelDetails: [`Models: Chat ${index}`],
    canTakeoverExisting: index % 2 === 0,
  }));
}

function overviewState(overrides: Partial<OverviewPanelState> = {}): OverviewPanelState {
  return { search: "", focus: "list", actionIndex: 0, detailScroll: 0, ...overrides };
}

function menuState(overrides: Partial<MenuPanelState> = {}): MenuPanelState {
  return { focus: "list", actionIndex: 0, detailScroll: 0, ...overrides };
}

test("overview keeps providers in the list and actions in a fixed bottom footer", async () => {
  const state = overviewState({ focus: "list" });
  let rendered: string[] = [];
  let overlayOptions: any;
  const result = await showProviderPanel(context(18, (component) => {
    for (let index = 0; index < 12; index++) component.handleInput("\x1b[B");
    rendered = component.render(76);
    component.handleInput("\x1b");
  }, 80, (options) => { overlayOptions = options; }), "en", items(30), state);
  assert.equal(result.action, "close");
  assert.equal(overlayOptions.overlay, true);
  assert.equal(overlayOptions.overlayOptions.width, "96%");
  assert.ok(rendered[0]?.includes("╭") && rendered.at(-1)?.includes("╯"));
  assert.ok(rendered.some((line) => line.includes("provider-12")));
  const providerRow = rendered.findIndex((line) => line.includes("provider-12"));
  const footerRow = rendered.findIndex((line) => line.includes("[Enter] Open provider"));
  assert.ok(providerRow >= 0 && footerRow > providerRow, "footer actions must not be inserted before provider rows");
  assert.ok(rendered.at(-2)?.includes("[Enter] Open provider") || rendered.some((line, index) => index >= footerRow && line.includes("[Esc] Close")));
  assert.ok(rendered.every((line) => visibleWidth(line) <= 76));
});

test("overview search focus handles CSI, SS3, and Kitty arrows with clamped selection and live details", async () => {
  const state = overviewState({ focus: "search" });
  let middle = "";
  let filtered = "";
  await showProviderPanel(context(18, (component) => {
    component.focused = true;
    component.handleInput("\x1b[B"); // CSI down -> 1
    component.handleInput("\x1bOB"); // SS3 down -> 2
    component.handleInput("\x1b[1;1B"); // Kitty down -> 3
    component.handleInput("\x1b[1;1B"); // clamp at bottom
    assert.equal(state.selectedId, "provider-3");
    component.handleInput("\x1b[1;1A"); // Kitty up -> 2
    middle = component.render(76).join("\n");
    component.handleInput("provider-1");
    filtered = component.render(76).join("\n");
    component.handleInput("\x1b[A"); // clamp at filtered top
    component.handleInput("\x1b");
  }), "en", items(4), state);
  assert.equal(state.focus, "search");
  assert.match(middle, /→ Provider 2/u);
  assert.match(middle, /Provider ID: provider-2/u);
  assert.match(filtered, /Provider ID: provider-1/u);
  assert.doesNotMatch(filtered, /Provider ID: provider-2/u);
  assert.equal(state.selectedId, "provider-1");
});

test("overview action focus has a visible arrow and Enter executes it", async () => {
  const state = overviewState({ focus: "actions", actionIndex: 4 });
  let rendered = "";
  const result = await showProviderPanel(context(18, (component) => {
    rendered = component.render(76).join("\n");
    component.handleInput("\r");
  }), "en", items(2), state);
  assert.equal(result.action, "add");
  assert.match(rendered, /→ \[Ctrl\+N\] Add provider/u);
});

test("overview exposes a global Ctrl+Delete provider action", async () => {
  const result = await showProviderPanel(context(18, (component) => component.handleInput("\x1b[3^")), "en", items(2), overviewState());
  assert.deepEqual(result, { action: "delete", providerId: "provider-0" });
});

test("overview defaults to list and slash explicitly focuses search", async () => {
  const state = overviewState();
  await showProviderPanel(context(18, (component) => { component.handleInput("/"); assert.equal(state.focus, "search"); component.handleInput(""); }), "en", items(2), state);
});

test("overview shortcuts work globally from search, list, details, and actions", async () => {
  const cases: Array<{ focus: OverviewPanelState["focus"]; input: string; expected: string }> = [
    { focus: "search", input: "\r", expected: "enter" },
    { focus: "list", input: "\x0e", expected: "add" }, // Ctrl+N
    { focus: "details", input: "\x1bOQ", expected: "language" }, // F2
    { focus: "actions", input: "\x1b", expected: "close" },
  ];
  for (const row of cases) {
    const result = await showProviderPanel(context(18, (component) => component.handleInput(row.input)), "en", items(2), overviewState({ focus: row.focus }));
    assert.equal(result.action, row.expected);
  }
});

test("overview preserves search, selected provider, focus, and scroll state across reopen", async () => {
  const state = overviewState({ search: "provider 1", selectedId: "provider-1", focus: "details", detailScroll: 1 });
  let rendered = "";
  await showProviderPanel(context(18, (component) => {
    rendered = component.render(76).join("\n");
    component.handleInput("\x1bOQ");
  }), "en", items(5), state);
  assert.equal(state.search, "provider 1");
  assert.equal(state.selectedId, "provider-1");
  assert.equal(state.focus, "details");
  assert.match(rendered, /Provider ID: provider-1/u);
});

test("connection fields beyond viewport remain reachable and footer shortcuts are global", async () => {
  const fields = Array.from({ length: 20 }, (_, index) => ({ id: `field-${index}`, label: `Field ${index}`, details: [`Description ${index}`] }));
  let rendered = "";
  const field = await showConnectionPanel(context(10, (component) => {
    for (let index = 0; index < 17; index++) component.handleInput("\x1b[B");
    rendered = component.render(76).join("\n");
    component.handleInput("\r");
  }), "en", "fixture", fields, menuState());
  assert.deepEqual(field, { action: "field", fieldId: "field-17" });
  assert.match(rendered, /→ Field 17/u);
  assert.match(rendered, /\[Enter\] Modify field/u);

  for (const [focus, input, expected] of [
    ["list", "\x13", "preview"],
    ["details", "\x1b", "back"],
    ["actions", "\r", "preview"],
  ] as const) {
    const result = await showConnectionPanel(context(12, (component) => component.handleInput(input)), "en", "fixture", fields, menuState({ focus, ...(focus === "actions" ? { actionIndex: 3 } : {}) }));
    assert.equal(result.action, expected);
  }
});

test("preview footer shortcuts work globally and Enter only changes category focus", async () => {
  const state = menuState({ selectedId: "provider", focus: "list" });
  let rendered = "";
  const save = await showPreviewPanel(context(12, (component) => {
    rendered = component.render(76).join("\n");
    component.handleInput("\r"); // list -> details, must not resolve
    component.handleInput("\x13"); // Ctrl+S
  }), "en", "fixture", ["settings"], ["models"], state);
  assert.equal(save.action, "save");
  assert.equal(state.focus, "details");
  assert.match(rendered, /→ Provider Settings: fixture/u);
  assert.match(rendered, /\[Ctrl\+S\] Confirm Save/u);
  assert.match(rendered, /\[Esc\] Back to Editing/u);
  assert.match(rendered, /\[Ctrl\+D\] Discard All Changes/u);

  const back = await showPreviewPanel(context(12, (component) => component.handleInput("\x1b")), "en", "fixture", ["settings"], ["models"], menuState({ focus: "details" }));
  assert.equal(back.action, "back");
  const discard = await showPreviewPanel(context(12, (component) => component.handleInput("\x04")), "en", "fixture", ["settings"], ["models"], menuState({ focus: "actions" }));
  assert.equal(discard.action, "discard");
});


test("unified confirmation panel has one box, safe default, keyboard selection, and Esc cancel", async () => {
  const options = { title: "Danger", summary: ["Summary"], details: ["Details"], severity: "error" as const, defaultActionIndex: 0, cancelActionId: "cancel", actions: [{ id: "cancel", label: "[Esc] Cancel" }, { id: "confirm", label: "[Ctrl+S] Confirm", shortcut: "ctrl+s" }] };
  let rendered = "";
  const confirmed = await showConfirmationPanel(context(14, (component) => { rendered = component.render(76).join("\n"); component.handleInput("\x1b[C"); component.handleInput("\r"); }), options);
  assert.equal(confirmed, "confirm"); assert.match(rendered, /╭/u); assert.match(rendered, /→ \[Esc\] Cancel/u);
  const cancelled = await showConfirmationPanel(context(10, (component) => component.handleInput("\x1b"), 48), options);
  assert.equal(cancelled, "cancel");
});

test("connection action focus uses horizontal arrows only", async () => {
  const state = menuState({ focus: "actions", actionIndex: 1 });
  const result = await showConnectionPanel(context(14, (component) => {
    component.handleInput("\x1b[B"); assert.equal(state.actionIndex, 1);
    component.handleInput("\x1b[C"); assert.equal(state.actionIndex, 2);
    component.handleInput("\x1b[D"); assert.equal(state.actionIndex, 1);
    component.handleInput("\r");
  }), "en", "fixture", [{ id: "x", label: "X", details: [] }], state);
  assert.equal(result.action, "models");
});
