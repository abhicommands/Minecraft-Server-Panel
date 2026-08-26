# Changelog

All notable changes to this project will be documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and release
tags follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0] - 2026-08-26

### Added

- Bun 1.4 backend using native HTTP, terminal, SQLite, password, and compiled
  executable support.
- Standalone Apple Silicon macOS and glibc Linux x86_64 release targets with the
  frontend embedded.
- Same-origin `/api` and `/socket.io` development and production routing.
- Streamed multipart uploads and bounded, validated ZIP backup handling.
- First-run interactive configuration, release installer assets, native smoke
  tests, and tag-driven GitHub Releases.
- Repository contribution, conduct, security, support, and AI-assistance
  policies.
- Reproducible production ZIP/unzip and indexed SQLite lookup benchmarks.
- Reproducible source/compiled/legacy runtime comparison harnesses and a
  documented Apple M1 performance baseline with explicit archive tradeoffs.
- Manual macOS/Linux archive benchmark workflow and release artifact
  attestations.
- One-command production installer with interactive administrator credentials,
  automatic JWT generation, DNS/Caddy HTTPS mode, and explicit direct-IP HTTP
  mode.

### Changed

- Renamed the active Bun backend to `server/`.
- Moved the retired Node backend to `legacy-node-server/` for reference and
  rollback only.
- Replaced npm-based development commands with Bun-managed dependencies and
  repository orchestration scripts.
- Standardized mutable state under the relocatable `panel-data/` layout.
- Added SQLite planner optimization while retaining indexed UUIDv4 API and
  filesystem identifiers.
- Simplified standalone usage to production-by-default with one isolated
  `--test` mode.
- Replaced the running-server backup hard failure with an explicit consistency
  warning and confirmation dialog. Backup and restore API errors now surface
  their backend messages in the backup UI; restoring still requires a stopped
  server.
- Serialized create, update, startup-flag, start, and delete transitions so a
  late download or console event cannot recreate a deleted server instance.
- Made application shutdown abort and await active provisioning downloads,
  disconnect Socket.IO clients, and finalize every managed Java process.
- Made server updates rollback their files when metadata commits fail and made
  interrupted deletions reconcile from SQLite state on the next start.

### Security

- Removed the `node-pty` and `better-sqlite3` native-addon requirements from the
  active backend.
- Added archive containment checks, bounded uploads, explicit process spawning,
  external runtime secrets, and dependency lifecycle-script restrictions.
- Added per-launch JVM identity tokens, detached process-group verification,
  untrusted-marker quarantine, and complete descendant cleanup before deletion.
- Added durable pre-spawn Java reservations and tracked Forge-installer markers,
  including crash recovery and a bounded installer lifetime.

[Unreleased]: https://github.com/abhicommands/Minecraft-Server-Panel/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/abhicommands/Minecraft-Server-Panel/compare/2.1.0...v3.0.0
