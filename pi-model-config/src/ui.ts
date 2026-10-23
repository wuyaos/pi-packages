import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CancellableLoader,
  CURSOR_MARKER,
  Key,
  decodeKittyPrintable,
  matchesKey,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { t, type UiLanguage } from "./i18n.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function stripPastedControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b[P_X^][\s\S]*?\x1b\\/gu, "")
    .replace(/\x1b(?:\]|[P_X^])[\s\S]*$/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1bO./gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
}

function trailingMarkerPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length--) if (marker.startsWith(value.slice(-length))) return length;
  return 0;
}

class MaskedInput implements Component, Focusable {
  private value = "";
  private inputBuffer = "";
  private isInPaste = false;
  private pasteBuffer = "";
  private _focused = false;
  private finished = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly language: UiLanguage,
    private readonly title: string,
    private readonly done: (value: string | undefined) => void,
  ) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  private finish(value: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.done(value);
  }

  private append(value: string): void {
    if (value) this.value += value;
  }

  private handleOrdinaryInput(data: string): void {
    if (!data) return;
    if (matchesKey(data, Key.enter)) { this.finish(this.value); return; }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.finish(undefined); return; }
    if (matchesKey(data, Key.backspace)) {
      this.value = [...this.value].slice(0, -1).join("");
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.value = "";
      return;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.append(kittyPrintable);
      return;
    }
    const hasControl = [...data].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
    if (!hasControl) this.append(data);
  }

  private drainInputBuffer(): void {
    while (this.inputBuffer) {
      if (this.isInPaste) {
        const end = this.inputBuffer.indexOf(PASTE_END);
        if (end < 0) {
          const keep = trailingMarkerPrefixLength(this.inputBuffer, PASTE_END);
          this.pasteBuffer += this.inputBuffer.slice(0, this.inputBuffer.length - keep);
          this.inputBuffer = this.inputBuffer.slice(this.inputBuffer.length - keep);
          return;
        }
        this.pasteBuffer += this.inputBuffer.slice(0, end);
        this.append(stripPastedControls(this.pasteBuffer));
        this.pasteBuffer = "";
        this.isInPaste = false;
        this.inputBuffer = this.inputBuffer.slice(end + PASTE_END.length);
        continue;
      }

      const start = this.inputBuffer.indexOf(PASTE_START);
      if (start >= 0) {
        this.handleOrdinaryInput(this.inputBuffer.slice(0, start));
        if (this.finished) return;
        this.inputBuffer = this.inputBuffer.slice(start + PASTE_START.length);
        this.isInPaste = true;
        continue;
      }
      const keep = trailingMarkerPrefixLength(this.inputBuffer, PASTE_START);
      const ordinary = this.inputBuffer.slice(0, this.inputBuffer.length - keep);
      this.inputBuffer = this.inputBuffer.slice(this.inputBuffer.length - keep);
      this.handleOrdinaryInput(ordinary);
      return;
    }
  }

  handleInput(data: string): void {
    // A standalone Esc is an actual cancel key, not a fragmented paste marker.
    if (!this.isInPaste && !this.inputBuffer && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
      this.finish(undefined);
      return;
    }
    this.inputBuffer += data;
    this.drainInputBuffer();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const label = safeWidth >= 8 ? this.theme.fg("muted", t(this.language, "maskedLabel")) : "";
    const cursor = this._focused ? `${CURSOR_MARKER}${renderFakeCursor(" ")}` : "";
    const available = Math.max(0, safeWidth - visibleWidth(label) - 1);
    const count = [...this.value].length;
    const hidden = count > available;
    const showEllipsis = hidden && available > 0;
    const visibleCount = Math.max(0, available - (showEllipsis ? 1 : 0));
    const mask = `${showEllipsis ? "…" : ""}${"•".repeat(Math.min(count, visibleCount))}`;
    return [
      truncateToWidth(this.theme.fg("accent", this.theme.bold(this.title)), safeWidth, ""),
      truncateToWidth(`${label}${mask}${cursor}`, safeWidth, ""),
      truncateToWidth(this.theme.fg("muted", t(this.language, "maskedHelp")), safeWidth, ""),
    ];
  }

  invalidate(): void {}
}

/** Secret input never delegates to ordinary ctx.ui.input, so plaintext is never rendered. */
export async function secretInput(ctx: ExtensionCommandContext, language: UiLanguage, title: string): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new MaskedInput(tui, theme, language, title, done));
}

export async function withCancellableLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ cancelled: true } | { cancelled: false; value?: T; error?: unknown }> {
  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const loader = new CancellableLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), message);
    let settled = false;
    const finish = (result: { cancelled: true } | { cancelled: false; value?: T; error?: unknown }) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    loader.onAbort = () => finish({ cancelled: true });
    void work(loader.signal).then((value) => finish({ cancelled: false, value })).catch((error) => {
      if (loader.signal.aborted) finish({ cancelled: true });
      else finish({ cancelled: false, error });
    });
    return loader;
  });
}
