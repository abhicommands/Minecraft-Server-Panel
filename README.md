# Minecraft Server Panel

[![Continuous integration](https://github.com/abhicommands/Minecraft-Server-Panel/actions/workflows/ci.yml/badge.svg)](https://github.com/abhicommands/Minecraft-Server-Panel/actions/workflows/ci.yml)
[![Release](https://github.com/abhicommands/Minecraft-Server-Panel/actions/workflows/release.yml/badge.svg)](https://github.com/abhicommands/Minecraft-Server-Panel/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A self-hosted Minecraft server control panel with a React interface and a Bun
backend that compiles into standalone macOS and Linux executables.

[Getting started](#start-a-fresh-development-environment) ·
[Production](#production-release-and-reverse-proxy) ·
[Releases](#github-actions-and-release-notes) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Benchmarks](docs/BENCHMARKING.md) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

Minecraft Server Panel has a React/Vite frontend in `client/` and a Bun 1.4
backend in `server/`. The legacy Node implementation is preserved in
`legacy-node-server/` for reference and rollback; it is not used by the new development or release
commands.

Source development does not compile an executable. An explicit release build
creates self-contained macOS ARM64 and Linux x64 executables with the production
frontend embedded. A deployed release needs Java, but it does not need Bun,
Node, npm, `node_modules`, application `.env` files, or separate static files.

## Repository map

| Path | Purpose |
|---|---|
| [`client/`](client/) | React/Vite browser interface |
| [`server/`](server/) | Active Bun backend, tests, compiler, and release installer assets |
| [`legacy-node-server/`](legacy-node-server/) | Retired Node backend retained for reference and rollback only |
| [`scripts/`](scripts/) | Repository-level setup and development orchestration |
| [`.github/workflows/`](.github/workflows/) | Pull-request, branch, native-binary, and tagged-release automation |

The project is under active development. Review the [security
policy](SECURITY.md) and deployment guidance before exposing a panel to the
internet.

## Prerequisites

On Apple Silicon macOS, install the pinned Bun 1.4 toolchain through Homebrew:

```sh
brew install oven-sh/bun/bun
bun --version
bun --revision
```

The version must be at least `1.4.0` and below `1.5.0`. This repository uses Bun
for dependency installation, scripts, tests, and compilation; no npm CLI command
is required. Java is also required when actually creating and running Minecraft
servers:

```sh
java -version
```

Use a Java version supported by the Minecraft server version being installed.

## Start a fresh development environment

From the repository root, run:

```sh
bun run setup
```

Setup performs locked `bun ci` installs in both projects. On the first run it
also starts the interactive backend initializer. You choose the administrator
username (`admin` is the default), then choose and confirm the login password.
The initializer stores only a bcrypt hash of that password and independently
generates a cryptographically random JWT secret. It does not invent or print a
login password for you.

The initializer creates `server/panel-data/config.toml` with mode
`0600`. If configuration already exists, setup preserves it. It never resets a
password or mutable server data during an ordinary dependency update.

Then start both source processes:

```sh
bun run dev
```

Open <http://localhost:5173> and log in using the password chosen during setup.
The processes are:

- React/Vite at `http://localhost:5173`
- Bun at `http://localhost:3001`

`bun run dev` runs TypeScript and Vite source with watchers. It does not run the
frontend production build, `build.ts`, or Bun's executable compiler, and it does
not create a binary. Press Ctrl-C once to stop both children.

The browser always calls relative `/api` and `/socket.io` URLs. Vite proxies both
paths to Bun in development, preserving one browser origin. `client/vite.config.js`
sets `envDir: false`, so there is intentionally no `client/.env` or
`client/.env.example` and no frontend host/port configuration to maintain.

To debug one process at a time, use two terminals from the repository root:

```sh
bun run --cwd server dev
```

```sh
bun run --cwd client dev
```

## Command behavior

| Command | Result |
|---|---|
| `bun run setup` | Locked installs plus first-run interactive development configuration |
| `bun run dev` | Backend and frontend source watchers; no production build or binary |
| `bun run init` | Runs the development initializer only; refuses to overwrite configuration |
| `bun run check` | Backend typecheck/tests plus frontend lint/production-build validation |
| `bun run build` | Explicitly builds the frontend and standalone executables |

`bun run check` may leave the ordinary static test output in `client/dist/`, but
it never compiles a backend executable. Run the supply-chain checks before a
release as well:

```sh
bun run check
cd server
bun audit
bun pm licenses
cd ../client
bun audit
bun pm licenses
```

## Data nomenclature and ownership

The canonical name for all mutable Bun-panel state is `panel-data`. In source
mode it is under the backend process working directory (normally
`server/`). In a standalone release it is adjacent to the
executable, independent of the directory from which the binary is launched.

```text
<application-home>/
├── minecraft-server-panel              # compiled deployment only
└── panel-data/
    ├── config.toml                      # credentials and runtime settings
    ├── database/
    │   ├── panel.sqlite3
    │   ├── panel.sqlite3-wal            # present while WAL is active
    │   └── panel.sqlite3-shm
    └── servers/
        └── <server UUID>/
            ├── files/                   # Minecraft working directory/server.jar
            ├── backups/                 # completed backup ZIP files
            ├── logs/
            │   └── console.log
            ├── runtime/
            │   └── process.json         # present while tracking a Java process
            └── temporary/               # upload/archive/restore staging
```

The fresh SQLite schema stores stable server metadata and UUIDs, not absolute
filesystem or backup paths. Runtime paths are derived from this fixed layout,
so moving a complete deployment directory does not leave stale paths in the
database. Temporary files use `.part`/staging names and are not release assets.
The old experimental `dev-data` and `server-info` names are obsolete and are not
recreated.

Java is spawned directly in a detached process group with a unique per-launch
identity recorded in `runtime/process.json`. Start, update, and deletion are
serialized per server; deletion disconnects its Socket.IO room and verifies the
whole Java group has exited before removing data. Provisioning downloads and
Forge installers are abortable and awaited during shutdown. Both launch paths
write durable pre-spawn identity markers; verified installers left by a backend
crash are terminated on restart. A stale live marker that cannot be verified is
quarantined instead of risking a duplicate launch or killing an unrelated PID.
Updates roll back staged files when their metadata commit fails, and interrupted
deletions reconcile from SQLite state during the next startup.

UUID lookups are already backed by SQLite's unique index and Bun's cached
prepared statement. The separate integer primary key keeps ordered listing
cheap. Shortening or sequentializing the public UUID would not materially help
an installation with a small number of servers, but it would break URLs and
directory names. `bun run benchmark:database` validates the query plan and
measures the production lookup path; see [Benchmarking](docs/BENCHMARKING.md).

Application configuration is TOML-only. The backend always resolves
`panel-data` from application home, so configuration, database, servers, and
backups move and restore as one explicit unit. Environment variables are used
only by development/build tooling and are not runtime application settings.

## Build standalone full-stack executables

Executable creation is always explicit:

```sh
bun run build
```

That command builds a configuration-free Vite frontend, embeds its files in each
backend executable, and writes:

```text
server/dist/
├── minecraft-server-panel-darwin-arm64
├── minecraft-server-panel-darwin-arm64.sha256
├── minecraft-server-panel-linux-x64
└── minecraft-server-panel-linux-x64.sha256
```

The current targets are Apple Silicon macOS and glibc Linux x86_64. Windows,
Intel macOS, Linux ARM64, and Alpine/musl are not release targets. To build only
one artifact, set `PANEL_BUILD_TARGET`:

```sh
PANEL_BUILD_TARGET=darwin-arm64 bun run build
PANEL_BUILD_TARGET=linux-x64 bun run build
```

The frontend's `client/dist/` is an intermediate static build. It is useful for
Vite checks, but users do not deploy it separately because those files are
embedded in the executable. `server/dist/` is local build output,
not mutable runtime storage; each build deletes and recreates it.

Run the compiled smoke test only after building the executable native to the
current machine:

```sh
bun run --cwd server smoke:compiled
```

For a manual binary test, copy the binary out of `dist` so the next build cannot
delete its data:

```sh
mkdir -p releases/local-darwin-arm64
cp server/dist/minecraft-server-panel-darwin-arm64 releases/local-darwin-arm64/minecraft-server-panel
cd releases/local-darwin-arm64
./minecraft-server-panel --test
```

Open <http://127.0.0.1:3001>. This compiled process serves the embedded UI, API,
and Socket.IO from the same origin. Its first run asks for a username/password
and creates isolated `panel-test-data` beside the copied binary. Production data
in `panel-data` is never touched. Changing configuration requires a restart, not
recompilation.

The release binary has only one normal mode flag:

| Invocation | Behavior |
|---|---|
| `./minecraft-server-panel` | Production first-run wizard if needed, then start the full application |
| `./minecraft-server-panel --test` | Isolated loopback-only test wizard, then start the full application |

`doctor`, `init`, and `serve` remain compatibility/diagnostic commands for the
installer and CI, not steps an ordinary user needs to run.

Running the raw binary is enough for an IP-based deployment: its production
wizard binds directly and stores all state beside the executable. For a DNS
name, the raw binary safely stays on loopback; use `sudo ./install.sh` from the
release archive to perform the root-owned systemd and Caddy integration. The
application binary never silently elevates itself or edits `/etc`.

## Production release and reverse proxy

Caddy is the production edge for DNS deployments because it provides automatic HTTPS,
safe certificate renewal, compression, and WebSocket forwarding with a small
configuration. Bun remains the application/static server. An extra proxy is not
required for application performance, but public secure cookies require HTTPS,
and keeping Bun on loopback gives the deployment a clean TLS boundary.

Proxy the entire origin, not only `/api`:

```caddyfile
panel.example.com {
	encode zstd gzip

	reverse_proxy 127.0.0.1:3001 {
		stream_close_delay 5m
		transport http {
			keepalive 20s
		}
	}
}
```

This sends the embedded UI, `/api`, and `/socket.io` through the same HTTPS
origin. Bun's generated production configuration binds to `127.0.0.1:3001` and
uses secure cookies. `stream_close_delay` avoids immediately dropping long-lived
Socket.IO streams during a Caddy reload, while the 20-second upstream keepalive
stays below Bun's 30-second idle timeout.

Each GitHub release archive contains a canonical `minecraft-server-panel`
binary, checksums, `install.sh`, a hardened systemd unit, and the Caddy template.
On glibc Linux x86_64 with systemd, run the interactive installer:

```sh
tar -xzf minecraft-server-panel-v3.0.0-linux-x64.tar.gz
cd minecraft-server-panel-v3.0.0-linux-x64
sudo ./install.sh
```

The script verifies every bundled file, installs atomically under
`/opt/minecraft-server-panel`, creates the locked `minecraft-panel` service
account, asks for the administrator username and password, generates the JWT
secret, asks for a public DNS name or IP address, runs `doctor`, and enables the
systemd service. An upgrade preserves `panel-data`.

- A DNS name selects HTTPS mode. Bun stays on `127.0.0.1:3001`; the installer
  installs Caddy from its [official apt/dnf
  source](https://caddyserver.com/docs/install) when needed, adds a managed site
  import, validates the complete Caddy configuration, and reloads it. Caddy then
  handles [automatic HTTPS](https://caddyserver.com/docs/automatic-https).
- An IPv4/IPv6 address selects direct HTTP mode. Caddy is not needed; Bun binds
  publicly on port 3001 only after an explicit warning and confirmation.

The IP option is operationally supported but unencrypted: passwords and session
cookies can be observed in transit. Prefer a domain, VPN, or private network.
The installer does not buy/configure DNS or alter firewall rules. HTTPS still
requires the DNS record to point at the host and inbound ports 80/443 to reach
Caddy. See the bundled `install/README.md` for supported package managers,
backups, and troubleshooting.

To inspect a release binary without installing a service or proxy:

```sh
./install.sh --local
```

Local mode supports macOS ARM64 and Linux x64. It installs under
`~/Library/Application Support/MinecraftServerPanel` on macOS or
`${XDG_DATA_HOME:-~/.local/share}/minecraft-server-panel` on Linux and prints
the `./minecraft-server-panel --test` command. That command creates isolated
localhost configuration on its first run. The macOS release is currently
unsigned and unnotarized.

## GitHub Actions and release notes

The workflows have separate responsibilities:

- `.github/workflows/ci.yml` runs on pull requests and pushes to `main` or
  `master`. It builds/audits the frontend once, then typechecks, tests, audits,
  compiles, checksum-verifies, and smoke-tests the macOS ARM64 and Linux x64
  standalone executables. Linux additionally runs the real interactive
  direct-IP installer on its disposable hosted runner and verifies systemd,
  health, login, cookies, and session validation. Its uploaded frontend is a
  temporary workflow artifact, not a GitHub Release.
- `.github/workflows/archive-benchmark.yml` is a manual cross-platform
  performance workflow. It runs the production ZIP implementation and uploads
  JSON reports; timing is informational and does not block ordinary pull
  requests.
- `.github/workflows/release.yml` runs only for a semantic tag whose version
  matches all package manifests and whose commit belongs to the release branch.
  It repeats release-grade checks, assembles full installer archives and
  checksums, attests them, and publishes a GitHub Release.

Create a release after the intended commit is on the default branch. This
example assumes the recommended `main` name; use `master` while that remains the
repository default:

```sh
git switch main
git pull --ff-only
git tag -a v3.0.0 -m "Minecraft Server Panel v3.0.0"
git push origin v3.0.0
```

Tags must match `vMAJOR.MINOR.PATCH`, with an optional suffix such as
`v1.2.3-rc.1`. The release is published only after both native jobs succeed and
will not overwrite an existing tag release. Generated notes group merged pull
requests using `.github/release.yml`; use `feature`/`enhancement`, `bug`/`fix`,
`breaking-change`, `dependencies`/`maintenance`, or `skip-changelog` labels.
Edit the generated notes afterward when a release needs hand-written migration
instructions or a more useful overview.

Before tagging, update the version in all three package manifests and promote
the changelog entries for that version. Repository rules, required check names,
artifact verification, and the complete maintainer sequence are documented in
[the release guide](docs/RELEASING.md).

## Upload and archive performance

Uploads are streamed through `@fastify/busboy` into bounded `.part` files and
atomically renamed. A complete multi-gigabyte upload is not held in memory, so
network speed and filesystem throughput will normally dominate. This design is
appropriate for a panel, but it is not a claim that this repository has been
benchmarked on every filesystem or concurrent workload.

ZIP creation and extraction use zip.js with Web Streams, Bun's native
compression stream path, Zip64, CRC verification, and archive/path limits. It is
also designed for bounded streaming rather than whole-archive buffering. The
extra safety and ZIP compatibility can cost some CPU compared with a dedicated
native archiver. Bun's `Bun.Archive` is a native tar API, but it is not a ZIP API
and currently materializes archive data in memory, so it is not a suitable
replacement for large downloadable ZIP backups.

The production default is DEFLATE level 6. That is intentional: it keeps
zip.js on Bun's native zlib-ng-backed `CompressionStream` path. Level 9 is a
maximum-ratio setting, not a simultaneous maximum-speed setting, and in the
current sidecar-free zip.js build it leaves that native fast path. For Minecraft
data, many JARs and region payloads are already compressed, so the extra CPU can
produce very little additional size reduction.

Run the production round-trip benchmark locally with:

```sh
bun run benchmark:archive
```

It measures ZIP and unzip throughput, archive ratio, sampled RSS, and validates
the extracted file count/bytes. It can generate compressible, random, or mixed
fixtures or read an existing stopped server tree. Exact controls and current
limitations are in [Benchmarking](docs/BENCHMARKING.md).

The recorded Apple M1 baseline found that the compiled Bun application reached
readiness 4.68 times sooner, used 43.5% less idle RSS, and served the measured
authenticated routes at roughly 3.1–3.3 times the legacy rate. Indexed UUID
lookup was 3.21 times faster. ZIP creation improved by 17.2%, while the stricter
ZIP extractor was 2.01 times slower; that is the main measured performance
tradeoff. See the benchmarking guide for fixtures, exact medians, native-addon
failures, safety differences, and interpretation rather than treating these
single-machine results as universal.

If measurements later show ZIP work to be a bottleneck, the first standalone
optimization is bounded concurrent zip.js entry processing with disk-backed
temporary streams, followed by bounded parallel extraction after a complete
security preflight. Native alternatives include an installed `bsdtar`/7-Zip
process, an embedded platform-specific Node-API addon, a bundled Rust/C helper,
or a Rust backend. Each changes the dependency, signing, memory, or one-binary
contract. The complete compatibility and performance decision table is in
[Benchmarking](docs/BENCHMARKING.md#zip-speed-compression-and-standalone-options).

## Fresh Bun reset versus legacy rollback

The Bun rewrite now intentionally starts with a fresh schema and layout. It does
not store the old absolute `path`/`backupPath` columns and rejects the earlier
pre-reset Bun schema. Never copy legacy data directly into `server/panel-data`,
and never run the legacy and Bun backends against the same data directory.

For another fresh Bun-only reset, first stop the panel and every Java child,
back up anything wanted from `server/panel-data`, then remove or move
only these generated paths from the repository root:

```text
server/panel-data
server/dist
client/dist
```

Do not remove `legacy-node-server/`; that is the preserved legacy application and rollback
data. After a Bun-data reset, `bun run setup` recreates configuration and asks
for a new chosen password. Build outputs are recreated only by `bun run check`
(frontend static output) or the explicit `bun run build` command (full binaries).

There is currently no automatic legacy database/world importer. Safe cutover is
therefore a fresh Bun deployment: stop the legacy backend and its Java children,
back up `legacy-node-server/db`, `legacy-node-server/server-directory`, and its `.env`, initialize Bun in
a separate deployment, and acceptance-test a fresh server. Rollback is stopping
Bun and restarting the preserved legacy backend. Do not claim a data migration
has occurred until a dedicated, tested importer is implemented.

See `server/README.md` for backend configuration and implementation
details.

## Project policies

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Support guide](SUPPORT.md)
- [Changelog](CHANGELOG.md)
- [AI contribution guidelines](AGENTS.md)
- [Maintainer and release guide](docs/RELEASING.md)
- [Benchmarking guide](docs/BENCHMARKING.md)
- [MIT License](LICENSE)
