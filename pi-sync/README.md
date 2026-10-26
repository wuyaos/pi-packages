# pi-sync

**English** | [简体中文](./README.zh-CN.md)

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

WebDAV archive backup and restore for [Pi](https://github.com/earendil-works/pi-coding-agent).

`pi-sync` creates versioned `.tar.xz` archives for Pi agent data and shared skills. It is intentionally **archive-only**: there are no live uploads, per-turn hooks, interval synchronization, or multi-machine merge conflicts.

## Features

- Back up `~/.pi/agent` directly without a staging copy
- Exclude reinstallable or transient trees through a configurable blacklist, plus fixed noise-file globs (`*.log`, `*.bak`, `*.tmp`, `*.swp`, `sync-state.json`, `*.bak-*`)
- Keep `~/.agents/skills` in an independent, optional archive
- Automatically back up enabled categories when Pi exits; a fingerprint check skips the upload when nothing changed
- Multi-select categories for one-shot backups, and merged archive rows (per device/platform/timestamp) for one-shot restores with a device filter and a per-row category multi-select
- Cross-platform repair scans `settings.json` / `mcp.json` / `model-config.json` for foreign-OS paths and rewrites them to portable `~/` form
- English and Simplified Chinese `/sync` menus
- Stream WebDAV uploads/downloads instead of buffering whole archives in memory
- Reject unsafe archive paths, symbolic links, special nodes, and unsafe restore destinations

## Install

```bash
pi install npm:@wuyaos/pi-sync
```

Or install the complete monorepo:

```bash
pi install git:github.com/wuyaos/pi-packages
```

Restart Pi or run `/reload` after installation.

## Usage

Run `/sync`. The top-level menu contains five actions:

- **Back Up** — multi-select Pi / Skills (categories whose local directory is missing are disabled), then `Ctrl+S` runs them serially under a file lock
- **Restore** — scans the per-category remote directories, merges archives that share device + platform + timestamp into one row (device/platform/time/local badge only), sorts newest first, and filters by device (`←`/`→`); pressing Enter opens a second multi-select over that row's categories (all pre-selected, foreign-device/cross-platform notes shown as disabled hint rows), then `Ctrl+S` restores the checked categories serially (pi → skills), stopping after a failure
- **Repair Cross-Platform Issues** — see [Cross-platform repair](#cross-platform-repair)
- **Settings** — WebDAV credentials, exit backup switch, archive retention, exit backup categories, device name, archive directory prefix, Pi exclusions, and language; every change is saved immediately (each editor offers its own cancel)
- **Quit**

The first run opens a WebDAV setup wizard when the URL, username, or password is missing.

## Archive model

### Pi backup

The Pi archive packs `~/.pi/agent` directly. Its default blacklist is:

```json
["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack", "install"]
```

This keeps configuration and extension state while excluding installed package sources, temporary extension caches, conversation history, background-task state, Web UI RPC runtime sockets, and the on-disk package install tree. On top of the blacklist, fixed name globs are excluded everywhere: `*.log`, `*.bak`, `*.tmp`, `*.swp`, `sync-state.json`, and `*.bak-*` (transactional backups such as `model-config.json.bak-123`). `config/sync.json` is included unless explicitly blacklisted.

```text
<remoteBaseDir>pi/<device>-<platform>-pi_<YYYYMMDD-HHMMSS>.tar.xz  (default: pibak/pi/…)
```

### Shared skills backup

`~/.agents/skills` is stored in a separate archive. `__pycache__/`, `*.pyc`, and the shared noise-file globs are excluded.

```text
<remoteBaseDir>skills/<device>-<platform>-skills_<YYYYMMDD-HHMMSS>.tar.xz  (default: pibak/skills/…)
```

Archive names are `<device>-<platform>-<tag>_<UTC timestamp>.tar.xz`, where `device` is the configured device name, `platform` is `win` / `mac` / `linux`, and the timestamp is UTC so archives sort consistently across machines.

## WebDAV layout

```text
<webdavUrl>/
└── <remoteBaseDir>/   (full path from the WebDAV app root, with optional leading `/`; default "pibak/", e.g. "sync/pibak/" or "/sync/pibak/")
    ├── pi/
    │   └── <device>-<platform>-pi_<timestamp>.tar.xz
    └── skills/
        └── <device>-<platform>-skills_<timestamp>.tar.xz
```

`maxBackups` is enforced independently in each backup directory. `0` keeps every archive.

## Configuration

Configuration is stored at `~/.pi/agent/config/sync.json`:

```json
{
  "webdavUrl": "https://example.com/dav/pi",
  "webdavUser": "user",
  "webdavPass": "$PI_WEBDAV_PASS",
  "language": "en",
  "backupProviders": true,
  "backupAgentSkills": false,
  "piExcludePaths": ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack", "install"],
  "backupOnExit": true,
  "maxBackups": 10,
  "deviceName": "DESKTOP-JK3-win",
  "remoteBaseDir": "pibak/",
  "exitBackupScope": ["pi", "skills"]
}
```

Old configuration keys for removed archive categories are ignored. The password may reference an environment variable (`$PI_WEBDAV_PASS`). When `language` is absent, pi-sync uses `settings.json → piSwitch.language` and falls back to English. `deviceName` defaults to a sanitized hostname plus platform suffix and is used in archive names and remote pruning. `remoteBaseDir` is the full archive base path starting from the WebDAV application root (the directory `webdavUrl` points to); archives live under `<remoteBaseDir><kind>/`. It may carry a leading `/` (root-relative), its segments may contain only letters, digits, dot, dash, and underscore, and it always ends with `/` — e.g. `"sync/pibak/"` or `"/sync/pibak/"`, which join with `webdavUrl` to `https://dav.example.com/dav/sync/pibak/pi/`. `exitBackupScope` limits which categories the exit backup uploads.

## Restore behavior and safety

- Restore rows merge every archive that shares device + platform + exact timestamp, so one entry covers Pi + Skills together. Restoring is a two-step flow: pick the row, then check the categories to restore (all pre-selected) in a multi-select; the checked categories run serially in the fixed order pi → skills, and a failure stops the run and reports the completed items.
- Cross-platform and foreign-device rows warn before restoring; after any successful restore the sync fingerprint is invalidated so the next exit backup re-uploads.
- Every archive path is checked for absolute paths and traversal.
- Symlinks and non-regular filesystem nodes are rejected before extraction.
- Archives are extracted to a temporary directory before merging.
- Restore refuses symbolic links or type conflicts in destination paths.
- Pi restore only touches files present in the archive; excluded directories remain unchanged.
- Skills restore moves the existing `~/.agents/skills` to a timestamped backup first.

Treat archives as sensitive: Pi backups may contain WebDAV credentials, API keys, provider settings, and other secrets.

## Cross-platform repair

**Repair** scans `settings.json`, `mcp.json`, and `model-config.json` for values that belong to another OS:

- Windows-specific: drive-letter paths (`C:\` / `C:/`), backslash path separators, `*.exe` / `*.cmd` / `*.bat` binaries, WSL paths (`\\wsl$\`, `\\wsl.localhost\`), and Windows `shellPath` values (powershell/pwsh/cmd)
- POSIX-specific: `/home`, `/Users`, or `/root` absolute paths, `/mnt/<drive>/` paths, and POSIX `shellPath` values (bash/zsh/sh/fish)
- Portable values (`~/…`, `$VAR…`, empty) and native values for the current platform are never flagged

Each issue shows its action type and is classified as:

- **auto** — the value can be mapped to a known home and is rewritten to portable `~/` form (checked by default). Mapping sources, in order: the current home directory; the archive's source home (`sourceHome` recorded in the manifest `meta` of skills archives, used when repairing right after a cross-device restore); a conservative pattern match on foreign home prefixes (`C:\Users\x\`, `/home/x/`, `/Users/x/`) that only promotes paths under `.pi/`, `.agents/`, or `.config/`
- **suggest** — reviewed fixes: `shellPath` is cleared so Pi falls back to its platform default; `mcp.json` `command` values (leaf strings and array first elements) lose their Windows wrapper (`node.exe` → `node`, `npx.cmd` → `npx`, `cmd /c …` unwrapped)
- **manual** — no safe automatic mapping: unknown-home absolute paths, WSL paths (`\\wsl$\…`, `/mnt/<drive>/…` — flagged with a WSL warning and never rewritten), and POSIX `command` values on Windows (target shell unknown)

Fixes are written back atomically (with a `.bak` backup) and the scan is idempotent: re-running it after applying the suggested fixes reports no issues. Standalone **Repair** runs (without a restore) have no source-home info and fall back to the conservative pattern match.

## New Windows machine

`pi-bootstrap.ps1` downloads the latest archive from `pibak/pi/` and merges it into `%USERPROFILE%\.pi\agent`:

> **Trusted archives only:** this bootstrap helper does not perform pi-sync's TypeScript path and link validation. Use `/sync` restore for normal recovery, and use the script only with a trusted WebDAV endpoint and archive.

```powershell
$env:PI_WEBDAV_URL  = "https://example.com/dav/pi"
$env:PI_WEBDAV_USER = "user"
$env:PI_WEBDAV_PASS = "app-password"
.\pi-bootstrap.ps1
```

Set `PI_SYNC_REMOTE_BASE_DIR` if your archive prefix differs from the default `pibak`.

The script is intended for trusted archives and new-machine bootstrap. Install/update packages afterward so excluded `npm/` and `git/` trees are rebuilt.

## Troubleshooting

| Symptom | Fix |
|---|---|
| HTTP 401 / 403 | Verify the WebDAV URL and use an app-specific password. |
| PROPFIND fails | Ensure the server supports WebDAV `PROPFIND` with `Depth: 1`. |
| tar errors | Install a `tar` implementation with xz support. |
| Exit backup is skipped | Check `backupOnExit`, `exitBackupScope`, and WebDAV credentials; an unchanged fingerprint or a concurrent backup lock also skips it silently. |
| Packages missing after Pi restore | Re-run `pi update --extensions` or reinstall packages from `settings.json`. |

## Development

```bash
node pi-sync/tests/run.mjs
```

The dedicated runner uses the installed Pi SDK's `jiti`, creates only test temporary files, and uses a local `127.0.0.1` fixture for transfer tests.

## Changelog

### v1.6.0

- Rework the `/sync` menu into Back Up / Restore / Repair / Settings / Quit; the language switch moved into Settings.
- Unified archive naming `<device>-<platform>-<tag>_<UTC timestamp>.tar.xz` under a configurable `remoteBaseDir` (default `pibak/`), with per-category WebDAV directories and device-scoped pruning.
- Back Up is a multi-select over Pi / Skills executed serially under a file lock; Restore merges archives by device + platform + timestamp with a device filter.
- Added cross-platform repair for foreign-OS paths in Pi configuration files.
- Exit backup now skips the upload when the sync fingerprint is unchanged and honors `exitBackupScope`.

### v1.4.0

- Remove project-conversation archive backup and restore support.
- Keep Pi and shared Skills archive backup/restore, including exit-time backup for enabled categories.

### v1.2.0

- Replace live synchronization with versioned archive-only backup/restore.

## License

MIT — see [LICENSE](./LICENSE).
