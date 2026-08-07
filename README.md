# `dlm`

Service-backed download manager built with Bun, TypeScript, SQLite, and OpenTUI.

## What It Does

- Runs a local background daemon over a Unix domain socket
- Accepts plain URLs, pasted `curl` commands, pasted `fetch(...)` snippets, and HAR files
- Persists downloads, history, events, auth profiles, rulesets, and settings in SQLite
- Supports pause, resume, cancel, retry, and queue restoration across restarts
- Uses adaptive downloading:
  - single-stream by default
  - segmented range downloads when the server supports it and the file is large enough
- Exposes both a CLI and a full-screen OpenTUI dashboard
- Includes post-download verification, extraction, notifications, and open-file/open-folder hooks

## Install

```bash
bun install
```

## Run

Start the daemon in the foreground:

```bash
bun run daemon
```

Open the TUI:

```bash
bun run tui
```

Basic CLI usage:

```bash
bun run src/bin/dlm.ts add https://example.com/file.zip
bun run src/bin/dlm.ts import --queue ./capture.har
bun run src/bin/dlm.ts list
bun run src/bin/dlm.ts show <download-id>
bun run src/bin/dlm.ts pause <download-id>
bun run src/bin/dlm.ts resume <download-id>
bun run src/bin/dlm.ts watch
```

Daemon control:

```bash
bun run src/bin/dlmd.ts status
bun run src/bin/dlmd.ts stop
bun run src/bin/dlmd.ts logs
```

## Build

Bundle JS entrypoints:

```bash
bun run build
```

Compile standalone binaries:

```bash
bun run build:bin
```

This produces:

- `dist/dlm`
- `dist/dlmd`

## Features In This Implementation

- Unix-socket HTTP API with JSON endpoints and SSE events
- Auto-spawned daemon from the CLI client
- SQLite-backed state and migration bootstrap
- Local rulesets and auth profiles
- Clipboard intake support through platform shell tools
- HAR parsing from inline JSON or `.har` file paths, including multi-request queue imports
- OpenTUI dashboard with queue/history/rules/auth/settings/activity tabs
- Unit tests for parser and rules logic
- Integration test for a full daemon-driven download

## Current Limitations

- macOS and Linux only
- No browser extension yet
- No OS keychain integration yet
- TUI editing flows for rules/auth/settings are lighter than the CLI surface
- Notification and extraction features depend on system tools being available

## Test

```bash
bun test
bun run typecheck
```
