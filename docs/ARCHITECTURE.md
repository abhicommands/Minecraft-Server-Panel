# Backend architecture

The active backend is split by responsibility so security-sensitive filesystem,
archive, process, and deployment rules have one implementation instead of being
repeated inside large route handlers. The extra files are boundaries, not extra
services: production still runs one `minecraft-server-panel` process plus the
Java processes it manages.

## Request and process flow

```text
React browser
  │ relative /api and /socket.io
  ▼
Bun.serve in server.ts ── Socket.IO Bun engine
  │
  ├── routes/auth.ts
  ├── routes/serverManagementRoutes.ts
  └── routes/fileRoutes.ts
          │
          ├── db/db.ts                 SQLite metadata
          ├── utils/serverProvisioner  downloads and Forge installation
          ├── utils/terminal           Java lifecycle and console PTY
          └── utils/archiveManager     archives and backups
```

In development Vite listens on port 5173 and proxies the two relative paths to
Bun on port 3001. In a compiled release Bun serves the embedded Vite build and
the API from one port. For a DNS deployment Caddy terminates TLS and forwards
that same traffic to Bun on loopback; it does not contain application logic.

## File ownership

| File or directory | Responsibility |
|---|---|
| `server.ts` | Composition root: HTTP routing, Socket.IO wiring, startup, and coordinated shutdown |
| `config.ts` | TOML parsing, validation, application-home resolution, and derived data paths |
| `types.ts` | Shared backend contracts |
| `routes/` | HTTP contract and input/response handling; delegates stateful work |
| `db/db.ts` | Schema initialization and prepared SQLite operations |
| `utils/http.ts` | Authentication, cookies, CORS, and common HTTP responses |
| `utils/pathSafety.ts` | Containment and untrusted path validation |
| `utils/serverLayout.ts` | The one canonical directory layout for a managed server |
| `utils/terminal.ts` | Serialized Java process state, PTY I/O, logs, orphan detection, and shutdown |
| `utils/provisionProcess.ts` | Safe lifecycle for short-lived installer processes |
| `utils/serverProvisioner.ts` | Validated Minecraft distribution downloads and installation |
| `utils/archiveManager.ts` | Streaming ZIP/backup work, limits, task state, and extraction defenses |
| `utils/staticFiles.ts` | Embedded or source-mode frontend asset serving and SPA fallback |
| `utils/deployment.ts` | DNS/IP classification and deployment-mode rules |
| `utils/initializeConfiguration.ts` | Interactive first-run TOML creation and secret/password hashing |
| `build.ts` | Explicit frontend build and standalone executable compilation |
| `release/` | Packaging assets; not additional runtime code |

## Fundamental changes from the legacy Node backend

| Legacy Node design | Bun design | Reason |
|---|---|---|
| Express and Node HTTP middleware | `Bun.serve` with explicit route dispatch | Smaller runtime graph and direct compiled-executable support |
| `node-pty` native addon and a persistent shell | `Bun.Terminal` with direct Java argv spawning | No addon compilation and no shell-command injection boundary |
| `better-sqlite3` native addon | `bun:sqlite` | SQLite is included in the executable runtime |
| Middleware packages for cookies, CORS, validation, upload, and helpers | Focused local HTTP/validation utilities plus streaming Busboy | Makes browser and security contracts visible and removes general-purpose dependencies |
| Axios | Built-in `fetch` with abort timeouts and streamed temporary files | No duplicate HTTP client and bounded downloads |
| `jsonwebtoken` and `bcryptjs` | `jose` and `Bun.password` | Standards-based tokens and Bun-native password verification |
| Mutable absolute paths stored across code/database | One `panel-data/servers/<uuid>` layout derived by `serverLayout.ts` | Relocatable deployments and fewer stale-path failures |
| Process status inferred from shell/PID/log behavior | Per-server serialized manager plus durable identity marker | Prevents duplicate starts and avoids killing an unrelated reused PID |
| Route handlers performing long operations directly | Provision/archive managers with abort, staging, rollback, and task state | Clean shutdown and recoverable interrupted work |
| Runtime `.env` precedence | One validated `panel-data/config.toml` | No hidden configuration source or accidental credential override |
| Node installation plus `node_modules` and separate frontend | Bun-compiled executable with embedded production frontend | A release needs only the executable, Java, and mutable `panel-data` |

## Configuration boundary

Development and production use the same schema in
`panel-data/config.toml`. The interactive initializer hashes the password and
generates the JWT secret; plaintext credentials are never written. The loader
validates the entire deployment before opening the listening socket.

The frontend intentionally has no environment configuration. Relative URLs let
Vite provide the development proxy and let the compiled server or Caddy provide
the production origin without rebuilding React for a hostname.

Environment variables that remain in scripts select build targets, tune
benchmarks, or pass a test-only child `PATH`. They do not override application
credentials, ports, deployment mode, or data paths.

## Why the modules should remain separate

Combining these files would not make the executable smaller: Bun bundles the
reachable code either way. Separation keeps route contracts readable while the
complex invariants—ZIP containment, child-process identity, atomic filesystem
replacement, and SQLite transactions—can be tested independently. Contributors
should add behavior to the owner above rather than duplicating it in a route.
