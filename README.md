# Plaud to Obsidian

One note per [Plaud](https://www.plaud.ai/) recording in your Obsidian vault: the AI summary, and optionally the transcript. The notes sync automatically through Plaud's **official** API.

> Unofficial project, not affiliated with PLAUD Inc. or Obsidian.

## Why another Plaud plugin?

The existing Obsidian plugins for Plaud call Plaud's undocumented web API with a token copied from the browser. That token stops working when Plaud changes its web app or stops renewing it, and the sync silently dies.

This project uses the official API that Plaud released with its [CLI and MCP server](https://docs.plaud.ai/plaud-mcp-cli/cli.md) in May 2026. You sign in once with Plaud's official CLI, and the session renews itself.

## Features

- **One Markdown note per recording**, containing:
  - Plaud's AI summary, with other Plaud notes or templates as extra sections;
  - optionally, the transcript, with speakers and timestamps.
- **No empty notes.** A note is written only once Plaud has finished processing the recording. Recordings that are not transcribed yet are checked again on every sync.
- **Never overwrites anything.** You can edit, move or delete notes freely, and a deleted note is not recreated.
- **Automatic sync** when Obsidian starts and at a set interval, plus a "Sync now" command.
- **Note template in English or French**: headings, properties and file names.
- **Migration from the old Plaud Sync plugin.** Notes it left empty ("No summary available") are replaced, with a backup kept. Its other notes are kept and not duplicated.
- **Respects Plaud's rate limits**, and runs one sync at a time.
- **Desktop only**: macOS, Windows and Linux.

## Requirements

- Obsidian desktop
- A Plaud account
- [Node.js](https://nodejs.org/) 20 or later. It is only needed to sign in with Plaud's official CLI.

## Setup

### 1. Sign in to Plaud (once)

In a terminal (Terminal on macOS, PowerShell on Windows):

```bash
npm install -g @plaud-ai/cli
plaud login
```

A browser window opens for you to sign in to Plaud.
- **Where the session is stored:** `~/.plaud/tokens.json`, or `%USERPROFILE%\.plaud\tokens.json` on Windows.
- **Renewal:** the plugin renews it automatically.
- **Signing out:** run `plaud logout`.

### 2. Install the plugin

The plugin is not in Obsidian's community store yet. Install it in one of two ways:

- **With [BRAT](https://github.com/TfTHacker/obsidian42-brat)** (recommended, updates automatically):
  1. Install and enable BRAT.
  2. Run *BRAT: Add a beta plugin for testing* and paste `https://github.com/SRM44/plaud-to-obsidian`.
- **Manually:**
  1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/SRM44/plaud-to-obsidian/releases/latest).
  2. Put both files in `<your vault>/.obsidian/plugins/plaud-recordings-sync/`.
  3. Enable **Plaud Recordings Sync** in *Settings → Community plugins*.

### 3. Configure

Open *Settings → Plaud Recordings Sync*:

| Setting | Default | |
|---|---|---|
| Plaud connection | | Shows whether the Plaud CLI session was found |
| Destination folder | `Plaud` | Folder of the vault where notes are created |
| Include transcript | on | Off: summary only. The transcript is still used when a recording has no summary |
| Note language | Obsidian's language | English or French template |
| Only recordings since | empty | `YYYY-MM-DD`, to skip older recordings |
| Automatic sync | every 30 min | At startup, then at this interval while Obsidian is open |

The first sync imports your whole Plaud library, at roughly one recording per second because of Plaud's rate limit. After that, only new recordings are fetched.

## What a note looks like

```markdown
---
plaud_id: of_0123456789abcdef0123456789abcdef
title: "Weekly team meeting"
date: 2026-10-01T14:02
duration_min: 34
source: plaud
tags:
  - plaud
---

# Weekly team meeting

> [!info] Plaud recording · 2026-10-01 14:02 · 34 min

## Summary

(Plaud's AI summary: overview, sections, action items…)

## Transcript

**[00:03] Speaker 1**: Good morning everyone…
```

The file name is `2026-10-01 14.02 - Weekly team meeting.md`, or `14h02` with the French template.

## How it works

- **Finding what to import.** The plugin lists your recordings through the official API and fetches the details of the ones it has not handled yet.
- **When a recording is ready.** It counts as ready when Plaud's summary exists, or 24 hours after this tool first observes a transcript without a summary. The upload date does not shorten this wait. Otherwise it stays pending and is checked again on the next sync. Pending entries from older versions start this observation window again; imported notes are unaffected.
- **Concurrent imports.** The plugin and the command line on the same computer never import at the same time. The lock is kept outside the vault (in `~/.plaud-to-obsidian-locks`), so vault sync services do not copy it to other devices. It is renewed every 10 seconds during an import, and a lock left by a crash expires after 30 minutes. Several computers syncing the same vault are not coordinated; the sync state and the `plaud_id` of existing notes still prevent duplicates.
- **Destination paths.** The destination and configuration folders must stay inside the vault, including when existing folders are symbolic links.
- **Sync state.** Handled and pending recordings are tracked in `<vault>/.obsidian/plaud-to-obsidian.json`. This file travels with your vault, so several computers do not duplicate notes.
- **Privacy.** Requests only go to Plaud: `platform.plaud.ai` and Plaud's file storage. There is no telemetry, and everything else stays in your vault.

To re-import a recording, delete its note, then remove its entry from the `done` list in `plaud-to-obsidian.json`.

## Command line (optional)

The same sync, without opening Obsidian:

```bash
npx github:SRM44/plaud-to-obsidian --dry-run
```

| Option | |
|---|---|
| `--vault <path>` | Vault to sync. Defaults to the only vault Obsidian knows |
| `--folder <path>` | Destination folder (default `Plaud`) |
| `--language en\|fr` | Note template language (default `en`) |
| `--transcript` / `--no-transcript` | Include the transcript or not |
| `--since YYYY-MM-DD` | Ignore older recordings |
| `--dry-run` | Show what would be done, write nothing |
| `--limit <n>` | Create at most *n* notes |

The options are remembered in `~/.plaud-to-obsidian.json`. Exit codes:
- `0`: success;
- `1`: errors or bad options;
- `2`: not signed in to Plaud (run `plaud login`);
- `3`: network.

## Limitations

- **Desktop only.** The plugin needs local files and the Plaud CLI session. On mobile, notes arrive through your vault sync (iCloud, Obsidian Sync…).
- **No live updates.** Notes are not updated when a recording changes in Plaud after import. See "How it works" to re-import one.
- **Sign-in depends on the CLI.** It relies on the official Plaud CLI session. If Plaud changes it, run `plaud login` again.

## Development

The CLI uses `proper-lockfile` for renewable filesystem locks. The plugin bundles it, so manual plugin installation still needs only `main.js` and `manifest.json`. Development uses `esbuild` to bundle standard JavaScript modules.

```bash
npm ci
npm test         # engine, command line, and the bundled plugin loaded in a fake Obsidian
npm run build    # → dist/main.js and dist/manifest.json
```

- `src/core.mjs`: sync orchestration and public entry point shared by the plugin and command line
- `src/plaud.mjs`: API requests and authentication
- `src/render.mjs`: Markdown rendering and content extraction
- `src/vault.mjs`: note discovery, writing, migration and destination validation
- `src/lock.mjs`: renewable import lock
- `src/json.mjs`, `src/errors.mjs`, `src/utils.mjs`: shared storage and helpers
- `src/request.mjs`: bounded waiting for Obsidian requests (the underlying request cannot be cancelled)
- `plugin/main.mjs`: Obsidian plugin (settings, timer, notices)
- `cli.mjs`: command line
- `scripts/build-plugin.mjs`: bundles the plugin into the single `main.js` Obsidian loads

## License

[MIT](LICENSE). "Plaud" is a trademark of PLAUD Inc. This project is not affiliated with or endorsed by PLAUD Inc. or Obsidian.
