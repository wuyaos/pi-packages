# pi-sync

**English** | [简体中文](./README.zh-CN.md)

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

WebDAV archive backup and restore for [Pi](https://github.com/earendil-works/pi-coding-agent).

`pi-sync` creates versioned `.tar.xz` archives for Pi agent data, shared skills, and project sessions. It is intentionally **archive-only**: there are no live uploads, per-turn hooks, interval synchronization, or multi-machine merge conflicts.

## Features

- Back up `~/.pi/agent` directly without a staging copy
- Exclude reinstallable or transient trees through a configurable blacklist
- Keep `~/.agents/skills` in an independent, optional archive
- Archive sessions separately per project
- Automatically archive the current project when Pi exits
- Back up or restore every enabled category in one action
- English and Simplified Chinese `/sync` menus
- Stream WebDAV uploads/downloads instead of buffering whole archives in memory
- Reject unsafe archive paths, symbolic links, special nodes, and unsafe restore destinations

## Install

Install the package from npm:

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
- Upload or restore **Sessions Archive**
- Configure backup settings
- Switch the menu between English and Chinese

The first run opens a WebDAV setup wizard when the URL, username, or password is missing.

## Archive model

### Pi backup

The Pi archive packs `~/.pi/agent` directly. Its default blacklist is:

```json
["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"]
```

This keeps configuration and extension state while excluding installed package sources, temporary extension caches, sessions (archived separately), workspace history, background-task state, and Web UI RPC runtime sockets. `config/sync.json` is included unless explicitly blacklisted.

Archive name:

```text
backup/pi/pi_agent_<platform>_<timestamp>.tar.xz
```

### Shared skills backup

`~/.agents/skills` is stored in a separate archive and is disabled by default.

```text
backup/skills/agent_skills_<timestamp>.tar.xz
```

### Session archives

Sessions are archived by project. There is no live synchronization or `_latest.json` marker.

```text
backup/sessions/<projectDir>/sessions_<platform>_<timestamp>.tar.xz
```

Project selection supports:

- **Whitelist**: only listed projects are archived; an empty list means none.
- **Blacklist**: listed projects are excluded; an empty list means all projects.

When `backupOnExit` is enabled, Pi archives the current allowed project during `session_shutdown`. Manual session backup remains available from `/sync`.

## WebDAV layout

```text
<webdavUrl>/
└── backup/
    ├── pi/
    │   └── pi_agent_<platform>_<timestamp>.tar.xz
    ├── skills/
    │   └── agent_skills_<timestamp>.tar.xz
    └── sessions/
        └── <projectDir>/
            └── sessions_<platform>_<timestamp>.tar.xz
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
  "backupSessions": true,
  "backupAgentSkills": false,
  "piExcludePaths": ["npm", "git", "sessions", "state", "tmp", "webui-rpc-supervisor", "vstack"],
  "backupOnExit": true,
  "sessionProjectMode": "blacklist",
  "sessionProjects": [],
  "maxBackups": 10
}
```

The password may reference an environment variable (`$PI_WEBDAV_PASS`). When `language` is absent, pi-sync uses `settings.json → piSwitch.language` and falls back to English.

## Restore behavior and safety

- Every archive path is checked for absolute paths and traversal.
- Symlinks and non-regular filesystem nodes are rejected before extraction.
- Archives are extracted to a temporary directory before merging.
- Restore refuses symbolic links or type conflicts in destination paths.
- Pi restore only touches files present in the archive; excluded directories remain unchanged.
- Skills restore moves the existing `~/.agents/skills` to a timestamped backup first.
- Session restore merges files into `~/.pi/agent/sessions`.
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
| Exit backup is skipped | Check `backupOnExit`, `backupSessions`, project mode/list, and WebDAV credentials. |
| Packages missing after Pi restore | Re-run `pi update --extensions` or reinstall packages from `settings.json`. |

## Development

```bash
cd /mnt/d/work/project/person/pi-packages
node --import tsx --test pi-sync/extensions/sync/*.test.ts
npm run typecheck
```

The monorepo typecheck may report unrelated errors from other packages; pi-sync-specific errors are identified by paths beginning with `pi-sync/`.

### WebDAV smoke test

The committed smoke harness creates uniquely named temporary Pi and session archives, uploads/list/downloads/validates them, then deletes them. It never prints credentials. It is intentionally write-protected:

```bash
cd /mnt/d/work/project/person/pi-packages
PI_SYNC_SMOKE_WRITE=1 bash --noprofile --norc pi-sync/scripts/verify.sh
```

`verify.sh` also runs the unit tests, strict pi-sync typecheck, extension-load check, package whitelist check, and diff check. It uses `~/.pi/agent/config/sync.json`; optionally set `PI_SYNC_SMOKE_PROJECT` to a permitted local session directory name (such as `--home-user--`).

## Changelog

### v1.2.0

- Replace live synchronization with versioned archive-only backup/restore
- Add direct Pi-home tar backup with blacklist exclusions
- Separate Pi, shared skills, and per-project session archives
- Add exit-time session archiving and manual all-category backup/restore
- Add English/Chinese menu switching
- Add streamed WebDAV transfer, config caching, and archive/restore safety checks
- Remove live sync, interval sync, custom-path, memory, and legacy monolithic code

### v1.1.1

- Cache WebDAV directory creation and loaded configuration to reduce repeated I/O

### v1.0.0

- Initial WebDAV backup/restore release

## License

MIT — see [LICENSE](./LICENSE).
