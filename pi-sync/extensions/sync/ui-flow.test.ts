/**
 * /sync 命令流程 smoke：mock ctx 直接驱动 handler，覆盖各层 Esc 路径与
 * registerSyncCommand 的错误上报（不触网络、不读真实配置）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setConfigCacheForTest, type SyncConfig } from "./config.ts";
import { handleSyncCommand, registerSyncCommand } from "./menus.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value, bg: () => "" };

const zhConfig: SyncConfig = {
  webdavUrl: "https://dav.example/dav",
  webdavUser: "u",
  webdavPass: "p",
  language: "zh",
  backupProviders: true,
  backupAgentSkills: true,
  piExcludePaths: [],
  backupOnExit: true,
  maxBackups: 10,
  deviceName: "dev",
  remoteBaseDir: "sync/pibak/",
  exitBackupScope: ["pi", "skills"],
};

type Step = readonly string[];

/**
 * mock 命令上下文：每次 ctx.ui.custom 同步构建组件、记录首帧渲染，
 * 再按脚本逐键注入（enter="\r"、esc="\x1b"、down="\x1b[B"）。
 */
function makeCtx(script: readonly Step[]) {
  const opened: string[] = [];
  const notifications: { message: string; type?: string }[] = [];
  let index = 0;
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      input: async () => undefined,
      confirm: async () => false,
      select: async () => undefined,
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (result?: unknown) => void) => any) =>
        new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, (result?: unknown) => resolve(result));
          opened.push(component.render(90).join("\n"));
          const action = script[index];
          index += 1;
          for (const key of action ?? []) component.handleInput(key);
        }),
    },
  };
  return { ctx, opened, notifications };
}

test("/sync opens the main menu and Esc at the first level exits without throwing", async () => {
  setConfigCacheForTest(zhConfig);
  const { ctx, opened, notifications } = makeCtx([["\x1b"]]);
  await handleSyncCommand(ctx as never);
  assert.equal(opened.length, 1, "仅打开一级菜单");
  assert.match(opened[0]!, /Pi WebDAV 备份/);
  assert.equal(notifications.length, 0);
});

test("Esc in the backup multi-select returns to the main menu, second Esc exits", async () => {
  setConfigCacheForTest(zhConfig);
  const { ctx, opened, notifications } = makeCtx([["\r"], ["\x1b"], ["\x1b"]]);
  await handleSyncCommand(ctx as never);
  assert.equal(opened.length, 3, "一级 → 备份多选 → 一级");
  assert.match(opened[0]!, /Pi WebDAV 备份/);
  assert.match(opened[1]!, /选择要备份的类别/);
  assert.match(opened[2]!, /Pi WebDAV 备份/);
  assert.equal(notifications.length, 0, "取消多选不触发备份");
});

test("Enter in the settings menu opens settings and Esc walks back level by level", async () => {
  setConfigCacheForTest(zhConfig);
  const { ctx, opened } = makeCtx([["\x1b[B", "\x1b[B", "\x1b[B", "\r"], ["\x1b"], ["\x1b"]]);
  await handleSyncCommand(ctx as never);
  assert.match(opened[1]!, /设置/);
  assert.match(opened[2]!, /Pi WebDAV 备份/);
});

test("registerSyncCommand surfaces handler errors via notify instead of staying silent", async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerSyncCommand({
    registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      handler = def.handler;
    },
  } as never);
  assert.ok(handler);
  const notifications: { message: string; type?: string }[] = [];
  const boomCtx = {
    hasUI: true,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      custom: () => {
        throw new Error("boom");
      },
    },
  };
  await handler("", boomCtx as never);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.message, /boom/);
  assert.equal(notifications[0]!.type, "error");
});
