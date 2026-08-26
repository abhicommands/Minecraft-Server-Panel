# Contributing

Thank you for helping improve Minecraft Server Panel. Contributions are
welcome as focused bug fixes, tests, documentation, and carefully scoped
features.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security vulnerabilities must be reported through the process in
[SECURITY.md](SECURITY.md), not in a public issue.

## Before opening a change

Search existing issues and pull requests before starting. For a substantial
feature, protocol change, data-layout change, or new runtime dependency, open a
feature request first so the design can be discussed before implementation.

Keep these project boundaries in mind:

- `server/` is the active Bun backend and standalone executable source.
- `client/` is the React/Vite frontend.
- `legacy-node-server/` is retained only for reference and rollback. Avoid
  modifying it unless an issue explicitly targets the legacy implementation.
- The browser-facing `/api` and `/socket.io` contracts must remain compatible
  unless a reviewed change intentionally updates both sides.
- Never commit `panel-data/`, credentials, JWT secrets, databases, Minecraft
  worlds, generated archives, build output, or local `.env` files.

## Development setup

The project requires Bun 1.4 and Java. From the repository root:

```sh
bun run setup
bun run dev
```

The initializer asks you to choose a local administrator password and creates
ignored development state under `server/panel-data/`. See the
[README](README.md) for installation details, data layout, and individual
process commands.

## Make a focused change

1. Fork the repository and create a descriptive branch from the repository's
   current default branch.
2. Limit the branch to one coherent change.
3. Match the surrounding TypeScript, JavaScript, React, and Markdown style.
4. Add or update tests for behavior changes and regression fixes.
5. Update documentation when commands, configuration, API behavior, data
   layout, or deployment behavior changes.
6. Do not weaken path-containment, archive, authentication, process-management,
   or upload limits to make a test pass.

Dependencies need a clear reason. Pin versions exactly, use Bun rather than the
npm CLI, preserve `ignoreScripts = true`, and avoid native addons or lifecycle
installers that compromise standalone builds. Commit the affected `bun.lock`
file after reviewing the dependency graph and license output.

## Verify locally

Run the full repository checks before opening a pull request:

```sh
bun run check
```

For backend work, also run:

```sh
bun run --cwd server typecheck
bun run --cwd server test
```

For frontend work, also run:

```sh
bun run --cwd client lint
bun run --cwd client build
```

Changes to executable compilation, embedded assets, PTY behavior, SQLite,
Socket.IO, uploads, archives, or installers should be tested on every affected
native target. CI provides macOS ARM64 and Linux x64 coverage. Local binary
creation remains explicit through `bun run build`.

## Pull requests

Complete the pull request template, explain the problem and solution, and list
the exact checks performed. Include screenshots or a short recording for
visible UI changes. Call out compatibility, security, migration, performance,
and deployment effects even when the answer is "none."

Pull requests must pass required CI checks and review before merge. A green
workflow is evidence, not a substitute for review: keep the diff understandable
and respond to feedback with new commits rather than hiding unrelated rewrites.

AI-assisted contributions are welcome when the contributor understands and
verifies every submitted change. Follow [AGENTS.md](AGENTS.md) and disclose
material AI assistance in the pull request.
