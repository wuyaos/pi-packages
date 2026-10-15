# pi-sync

**English** | [简体中文](./README.zh-CN.md)

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

WebDAV archive backup and restore for [Pi](https://github.com/earendil-works/pi-coding-agent).

`pi-sync` creates versioned `.tar.xz` archives for Pi agent data and shared skills. It is intentionally **archive-only**: there are no live uploads, per-turn hooks, interval synchronization, or multi-machine merge conflicts.

## Features

- Back up `~/.pi/agent` directly without a staging copy
- Exclude reinstallable or transient trees through a configurable blacklist
- Keep `~/.agents/skills` in an independent, optional archive
- Automatically back up enabled categories when Pi exits
- Back up or restore every enabled category in one action
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

Run `/sync`. The interactive menu contains:

- **Back Up All** / **Restore All (latest)**
- Upload or restore **Pi Backup**
- Upload or restore **Skills Backup**
- Configure backup settings
- Switch the menu between English and Chinese

The first run opens a WebDAV setup wizard when the URL, username, or password is missing.

## Archive model

### Pi backup

The Pi archive packs `~/.pi/agent` directly. Its default blacklist is:

```json
["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"]
```

This keeps configuration and extension state while excluding installed package sources, temporary extension caches, conversation history, background-task state, and Web UI RPC runtime sockets. `config/sync.json` is included unless explicitly blacklisted.

```text
backup/pi/pi_agent_<platform>_<timestamp>.tar.xz
```

### Shared skills backup

`~/.agents/skills` is stored in a separate archive and is disabled by default.

```text
backup/skills/agent_skills_<timestamp>.tar.xz
```

## WebDAV layout

```text
<webdavUrl>/
└── backup/
    ├── pi/
    │   └── pi_agent_<platform>_<timestamp>.tar.xz
    └── skills/
        └── agent_skills_<timestamp>.tar.xz
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
  "piExcludePaths": ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"],
  "backupOnExit": true,
  "maxBackups": 10
}
```

Old configuration keys for removed archive categories are ignored. The password may reference an environment variable (`$PI_WEBDAV_PASS`). When `language` is absent, pi-sync uses `settings.json → piSwitch.language` and falls back to English.

## Restore behavior and safety

- Every archive path is checked for absolute paths and traversal.
- Symlinks and non-regular filesystem nodes are rejected before extraction.
- Archives are extracted to a temporary directory before merging.
- Restore refuses symbolic links or type conflicts in destination paths.
- Pi restore only touches files present in the archive; excluded directories remain unchanged.
- Skills restore moves the existing `~/.agents/skills` to a timestamped backup first.
- Pi restore shows a plan and offers `/reload` afterward.

Treat archives as sensitive: Pi backups may contain WebDAV credentials, API keys, provider settings, and other secrets.

## New Windows machine

`pi-bootstrap.ps1` downloads the latest archive from `backup/pi/` and merges it into `%USERPROFILE%\.pi\agent`:

> **Trusted archives only:** this bootstrap helper does not perform pi-sync's TypeScript path and link validation. Use `/sync` restore for normal recovery, and use the script only with a trusted WebDAV endpoint and archive.

```powershell
$env:PI_WEBDAV_URL  = "https://example.com/dav/pi"
$env:PI_WEBDAV_USER = "user"
$env:PI_WEBDAV_PASS = "app-password"
.\pi-bootstrap.ps1
```

The script is intended for trusted archives and new-machine bootstrap. Install/update packages afterward so excluded `npm/` and `git/` trees are rebuilt.

## Troubleshooting

| Symptom | Fix |
|---|---|
| HTTP 401 / 403 | Verify the WebDAV URL and use an app-specific password. |
| PROPFIND fails | Ensure the server supports WebDAV `PROPFIND` with `Depth: 1`. |
| tar errors | Install a `tar` implementation with xz support. |
| Exit backup is skipped | Check `backupOnExit`, enabled categories, and WebDAV credentials. |
| Packages missing after Pi restore | Re-run `pi update --extensions` or reinstall packages from `settings.json`. |

## Development

```bash
node pi-sync/tests/run.mjs
```

The dedicated runner uses the installed Pi SDK's `jiti`, creates only test temporary files, and uses a local `127.0.0.1` fixture for transfer tests.

## Changelog

### v1.4.0

- Remove project-conversation archive backup and restore support.
- Keep Pi and shared Skills archive backup/restore, including exit-time backup for enabled categories.

### v1.2.0

- Replace live synchronization with versioned archive-only backup/restore.

## License

MIT — see [LICENSE](./LICENSE).
