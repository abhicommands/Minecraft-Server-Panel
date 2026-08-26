# Minecraft Server Panel frontend

This is the existing React frontend, built with Vite and managed with Bun. Node.js
and the npm CLI are not required for frontend development.

## Local development

Install Bun 1.4 once on macOS:

```sh
brew install oven-sh/bun/bun
bun --version
```

Run the frontend from this directory:

```sh
cd client
bun ci
bun run dev
```

Vite serves the application at <http://localhost:5173>. Start the Bun backend on
port 3001 in a separate terminal. No frontend `.env` file is required. During
development, Vite proxies relative `/api` requests and `/socket.io` HTTP and
WebSocket traffic to `http://localhost:3001`.

Vite environment-file loading is disabled for this frontend. An old ignored
`client/.env` is no longer used and can be removed after confirming no unrelated
local tooling depends on it.

The browser always uses its current origin:

- REST endpoints are under `/api`, for example `/api/login` and `/api/servers`.
- Socket.IO connects to the same origin at `/socket.io`.

For production, the repository's explicit backend release build embeds this
Vite output into each Bun executable. That executable serves the frontend,
`/api`, and `/socket.io` from one public origin, so there is no separate static
deployment and no frontend URL configuration to rebuild or inject. `bun run
build` here still creates `client/dist/` when a standalone static build is useful.

## Checks and production build

```sh
bun run check
bun run audit
bun run build
bun run preview
```

`check` runs ESLint and a production build. The build output is written to
`client/dist/`; `preview` serves that output locally. For reproducible installs,
commit `bun.lock` and use `bun ci`. Use `bun install` only when intentionally
changing dependencies so the lockfile is refreshed.

Bun is the package manager and script runner, but these browser packages are
still fetched from the npm-compatible public registry. Dependency lifecycle
scripts are disabled and newly published packages are held back for 48 hours by
`bunfig.toml`.

The Bun migration removed the old npm lockfile and upgraded compatible packages
within their current major versions. Deliberate breaking-major migrations (for
example Vite 8, ESLint 10, MUI 9, xterm 6, and react-dropzone 20) are deferred
until they can be tested as separate UI changes. The production build currently
reports a non-failing large-chunk warning; route-level lazy loading should be
handled as a dedicated performance change rather than hidden by raising the
warning threshold.
