# AI Contribution Guidelines

These instructions apply to automated coding agents and to contributors using
AI assistance anywhere in this repository. They supplement
`CONTRIBUTING.md`; the repository documentation and maintainer direction take
precedence if instructions conflict.

## Understand the architecture first

- `server/` is the active Bun 1.4 TypeScript backend and executable source.
- `client/` is the React/Vite frontend. It calls relative `/api` and
  `/socket.io` paths; do not add frontend environment URLs without an approved
  architecture change.
- `legacy-node-server/` is reference/rollback code. Do not modify, migrate, or
  delete it unless the task explicitly requires that exact scope.
- `server/panel-data/`, `server/dist/`, and `client/dist/` are generated or
  mutable. Never commit them.

Read the nearest README, relevant tests, package scripts, configuration, and all
call sites before editing behavior. Preserve existing user work and keep a
change focused on the requested outcome.

## Safety and compatibility

- Do not expose or invent credentials, tokens, cookies, private contact details,
  database contents, paths from user systems, or Minecraft world data.
- Never embed `.env` values or `panel-data/config.toml` in frontend or compiled
  assets.
- Preserve authentication, cookie, CORS, REST response, Socket.IO event, and
  same-origin contracts unless both sides and their tests intentionally change.
- Treat file paths, multipart input, ZIP entries, subprocess arguments, and
  persisted state as untrusted. Maintain containment, size, count, symlink,
  duplicate-entry, CRC, and command-validation checks.
- Spawn Java with an argument array. Do not introduce a shell, `eval`, or string
  command execution.
- Do not perform destructive data migrations or delete mutable data without
  explicit authorization, an exact target, and a documented rollback.

## Dependencies and generated files

- Use Bun only. Do not run npm, npx, yarn, or pnpm.
- Pin dependency versions exactly and keep `ignoreScripts = true` and the
  release-age gate intact.
- Avoid native addons, lifecycle-installed binaries, unpinned executors, and new
  runtime dependencies unless their standalone-binary, license, security, and
  maintenance tradeoffs are documented.
- Update the correct `bun.lock` through Bun after an approved dependency change.
  Do not hand-edit lockfiles or generated build output.
- Never commit local databases, logs, archives, Java server files, binaries,
  temporary files, or secrets.

## Implementation quality

- Prefer a small, typed change over a broad rewrite. Follow surrounding naming,
  module boundaries, error shapes, and formatting.
- Add regression tests for fixes and boundary tests for parsers, paths, archives,
  authentication, and process state.
- Update README, configuration examples, changelog, and release/install docs
  whenever user-facing behavior changes.
- Comments should explain constraints or reasoning, not restate the code.
- Do not claim benchmarks, security guarantees, platform support, or migration
  compatibility without reproducible evidence.

## Required verification

Run the narrowest relevant checks while iterating, then run:

```sh
bun run check
```

Backend executable, embedded-asset, terminal, SQLite, archive, upload, Socket.IO,
or installer changes also require the applicable native build and compiled smoke
test. If a target cannot be tested locally, state that clearly and rely on its
CI job; never report an unrun check as passing.

Before handoff, inspect `git diff --check` and `git status --short`, distinguish
pre-existing edits from your own, and summarize files changed, tests run, and
remaining risks. Contributors must review and understand AI-generated changes
and disclose material AI assistance in their pull request.
