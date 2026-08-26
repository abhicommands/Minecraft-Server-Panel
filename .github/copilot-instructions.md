# GitHub Copilot instructions

Follow `/AGENTS.md` and `/CONTRIBUTING.md` for every suggestion.

- Active backend: Bun 1.4 TypeScript in `server/`.
- Frontend: React/Vite in `client/` using relative `/api` and `/socket.io` paths.
- Legacy Node code: `legacy-node-server/`; leave it unchanged unless explicitly
  requested.
- Package manager and task runner: Bun only. Keep dependency versions exact,
  lifecycle scripts disabled, and standalone compilation free of native addons.
- Mutable/generated paths such as `server/panel-data/`, `server/dist/`, and
  `client/dist/` must not be committed.

Preserve REST, Socket.IO, authentication, cookie, CORS, and persisted-schema
contracts. Treat paths, uploads, archives, subprocess input, and stored values
as untrusted. Never add shell execution, weaken archive/path limits, expose
secrets, or embed runtime configuration in the frontend or binary.

Use existing utilities and typed interfaces before adding abstractions. Add
tests for changed behavior, document user-visible changes, and run `bun run
check`. Never claim a test or platform passed unless it was actually run.
