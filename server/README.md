# Bun 1.4 backend

This directory contains the Bun-native backend and standalone compiler for
Minecraft Server Panel. It replaces Express, `node-pty`, and `better-sqlite3`
with `Bun.serve`, `Bun.Terminal`, and `bun:sqlite`, while retaining the frontend's
REST, cookie, file-management, backup, and Socket.IO contracts.

Development executes TypeScript directly. Release executables embed the Bun
runtime, backend packages, and production Vite assets. Java and mutable state
remain outside the executable.

## Supported targets

- macOS Apple Silicon: `dist/minecraft-server-panel-darwin-arm64`
- glibc Linux x86_64: `dist/minecraft-server-panel-linux-x64`

Intel macOS, Linux ARM64, musl/Alpine, Windows, public code signing, and macOS
notarization are deferred until native CI coverage is added.

## Source development

The simplest first run is from the repository root:

```sh
brew install oven-sh/bun/bun
bun --version
bun run setup
bun run dev
```

The root setup command runs locked `bun ci` installs here and in `client/`. If
`panel-data/config.toml` and `.env` are both absent, it launches:

```sh
bun server.ts init --development
```

The initializer asks for the administrator username (`admin` by default) and
the chosen login password twice with hidden input, hashes the password using
bcrypt, generates a separate random 256-bit JWT secret, and creates
owner-readable-only configuration. It refuses to replace existing
configuration. The program never chooses a login password itself.

The root development command starts this backend at `127.0.0.1:3001` with
`--watch` and Vite at `localhost:5173`. Vite proxies `/api` and `/socket.io` to
Bun. It does not compile an executable. There is no client `.env`, and Vite is
configured not to load one.

For backend-only work:

```sh
bun ci
bun run init
bun run dev
```

`bun run init` is the development initializer and refuses to overwrite an
existing `panel-data/config.toml` or coexist with a backend `.env`.

## Configuration precedence

The canonical configuration is `panel-data/config.toml`. A development file
looks like:

```toml
root_username = "admin"
root_password_hash = "$2b$10$..."
jwt_secret = "64-character-random-hex-secret"
public_address = "127.0.0.1"
deployment_mode = "test"
listen_host = "127.0.0.1"
port = 3001
secure_cookie = false
allow_insecure_http = false
environment = "test"
upload_max_bytes = 2147483648
```

Running the compiled executable without arguments creates production
configuration on its first run and then starts the app. It asks for a DNS name
or IP address: DNS selects loopback plus secure cookies/Caddy, while an IP
selects a public bind plus explicitly acknowledged direct HTTP. Restart after
editing configuration; no rebuild is required.

Environment values override TOML values. The tracked `.env.example` is
documentation for service/container overrides and compatibility deployments; it
is not an active or required secret file. Copying it to `.env` changes runtime
configuration and causes the interactive initializer to refuse to create TOML,
so prefer generated TOML for normal local and release installs.

Supported overrides include:

```dotenv
ROOT_USERNAME=admin
ROOT_PASSWORD_HASH=\$2b\$10\$...
JWT_SECRET=at-least-32-random-characters
PANEL_HOST=127.0.0.1
PORT=3001
SECURE_STATUS=false
ALLOW_INSECURE_HTTP=false
PANEL_DEPLOYMENT_MODE=test
PANEL_PUBLIC_ADDRESS=127.0.0.1
NODE_ENV=development
PANEL_DATA_DIR=./panel-data
UPLOAD_MAX_BYTES=2147483648
```

`CORSORIGIN` is optional for a genuinely cross-origin client. Normal Vite and
Caddy layouts do not set it because all browser traffic uses one origin. A
relative `PANEL_DATA_DIR` resolves against application home; use an absolute
path only for an intentional external data mount. `.env` values are never
inlined into compiled executables.

`bun run hash-password` remains available for manually maintained environment
configuration. It asks for a chosen password and prints an escaped bcrypt line
suitable for Bun's `.env` expansion rules. It does not generate the login
password.

## Application home and mutable layout

In source mode, application home is the process working directory (normally
`server/`). In a compiled executable, it is the directory containing
the actual executable, not Bun's virtual embedded filesystem and not the caller's
current shell directory.

The exact default layout is:

```text
<application-home>/
├── minecraft-server-panel              # compiled deployment only
└── panel-data/
    ├── config.toml
    ├── database/
    │   ├── panel.sqlite3
    │   ├── panel.sqlite3-wal
    │   └── panel.sqlite3-shm
    └── servers/
        └── <server UUID>/
            ├── files/
            │   ├── server.jar
            │   ├── server.properties
            │   └── ...                  # world/plugins/mods/etc.
            ├── backups/
            ├── logs/
            │   └── console.log
            ├── runtime/
            │   └── process.json         # active/orphan process sidecar
            └── temporary/
```

The SQLite schema stores server UUID, name, command/flags, version, port, and
type. It does not store absolute filesystem or backup paths. Code derives every
server path from `panel-data/servers/<uuid>`, making a complete deployment
relocatable. WAL and shared-memory files appear while SQLite is open. The
process marker is removed after a normal child exit; it exists to detect an
orphan after an abnormal backend exit. Every new launch carries a random JVM
identity token recorded in that marker. A live marker that cannot be matched to
that exact server and detached process group is quarantined: the panel refuses
to start a duplicate or kill an unrelated PID and reports that manual cleanup
is required. Temporary archive, upload, and restore staging belongs only under
the server's `temporary`/files area.

The prior `dev-data`, `server-info`, `db/myServers.db`, `server-directory`,
`root`, and singular `backup` names are obsolete. A pre-reset Bun database with
absolute `path` or `backupPath` columns is rejected rather than silently
migrated. The legacy `../legacy-node-server/` implementation remains separate.

## HTTP, frontend, and process behavior

Canonical REST routes are under `/api`, including `/api/login` and
`/api/servers`. Compatibility aliases remain available without the prefix.
Socket.IO remains at `/socket.io` and uses the `server-id` header.

During source development, Vite serves the UI and proxies both route families.
Compiled releases serve embedded Vite assets directly, cache hashed `/assets/*`
files immutably, avoid caching `index.html`, and return the SPA entry for React
Router paths. Unknown `/api/*` routes stay API 404 responses.

Minecraft commands are parsed to argv and passed directly to
`Bun.spawn(["java", ...])` with `Bun.Terminal`; no shell or `node-pty` process is
created. Output is sent to the Socket.IO room and streamed into
`logs/console.log`, with bounded console history and periodic compaction. Server
creation stays invisible until its download is complete. Updates, startup-flag
changes, starts, and deletion share a per-server lifecycle lock. Deletion first
disconnects that server's sockets and proves that the complete Java process
group has exited, then removes its files and database row.

Shutdown first rejects and aborts new provisioning work, closes HTTP and
Socket.IO admission, and awaits download/Forge cleanup. It sends `stop` to each
Minecraft console, waits up to 60 seconds, kills surviving process groups, and
closes terminals, logs, and SQLite. A Forge installer is also launched in a
tracked process group with a durable identity marker and a 30-minute ceiling.
Verified installers left by an abnormal backend exit are killed on the next
startup; ambiguous markers stop startup for manual inspection rather than risk
killing an unrelated process.

## Checks and builds

The root verification command is:

```sh
bun run check
```

It runs backend TypeScript checking/tests and frontend lint/build validation. For
backend-only verification and release hygiene:

```sh
bun run typecheck
bun test --parallel
bun audit
bun pm licenses
```

No backend executable is created by those commands. Executable creation is an
explicit root or local build:

```sh
# From the repository root
bun run build

# Or from this directory
bun run build
```

The builder runs the frontend production build without `VITE_*` deployment
values, stages its files temporarily, embeds them using Bun compiled assets,
compiles both targets, writes `.sha256` files, and removes staging. It deletes
and recreates `dist/`, so never put configuration or mutable data there.

Build one target when needed:

```sh
PANEL_BUILD_TARGET=darwin-arm64 bun run build
PANEL_BUILD_TARGET=linux-x64 bun run build
```

The matching Bun target names (`bun-darwin-arm64` and `bun-linux-x64`) are also
accepted internally. Test the executable native to the current host:

```sh
bun run smoke:compiled
```

The smoke test uses a disposable temporary directory. It verifies external
`panel-data/config.toml`, the embedded UI and SPA fallback, API login, the exact
frontend Socket.IO client version, a fake Java PTY start/command/stop cycle, and
clean shutdown. `doctor` checks resolved configuration and embedded frontend
availability without printing secrets:

```sh
./dist/minecraft-server-panel-darwin-arm64 doctor
```

## Production Caddy topology

Caddy is recommended as the public TLS edge. Bun listens only on loopback and
serves the complete application; Caddy proxies the whole origin:

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

This includes the embedded frontend, `/api`, and `/socket.io`. Caddy handles
HTTPS, certificate renewal, response compression, and WebSocket forwarding.
`stream_close_delay 5m` reduces Socket.IO disruption on configuration reload;
`keepalive 20s` remains below Bun's 30-second idle timeout. A deliberate IP
deployment instead uses `deployment_mode = "direct-http"`, binds on port 3001,
sets non-secure cookies, and requires `allow_insecure_http = true`; this is
supported for users without a domain but does not encrypt credentials or
sessions.

## Release archive installer

`.github/workflows/release.yml` packages each native executable under the
canonical name `minecraft-server-panel` with:

```text
minecraft-server-panel-vX.Y.Z-<target>/
├── minecraft-server-panel
├── install.sh
├── SHA256SUMS
└── install/
    ├── README.md
    ├── Caddyfile.example
    └── minecraft-server-panel.service
```

The production installer supports glibc Linux x86_64 with systemd:

```sh
sudo ./install.sh
```

It verifies the bundled checksums, installs/upgrades the binary atomically in
`/opt/minecraft-server-panel`, creates the `minecraft-panel` system account,
initializes the username, password, random JWT secret, and public address
interactively on the first install, validates the app with `doctor`, installs a
sandboxed systemd unit, and starts the service. Existing `panel-data` is
preserved during an upgrade.

For a DNS name, the installer installs Caddy from its official apt/dnf package
source if necessary, writes `/etc/caddy/conf.d/minecraft-server-panel.caddy`,
adds a narrowly managed import to `/etc/caddy/Caddyfile`, validates the complete
configuration, and reloads Caddy. The previous main configuration is backed up
before editing and restored if validation fails. For an IP address it skips
Caddy and exposes Bun directly over HTTP after a security confirmation. It does
not alter DNS records or firewall rules. The bundled `install/README.md` has the
exact behavior and troubleshooting steps.

For a non-service test on macOS ARM64 or Linux x64:

```sh
./install.sh --local
```

This installs to the current user's platform application-data directory and
prints the `./minecraft-server-panel --test` command. That single flag creates
and uses isolated `panel-test-data` on loopback, leaving `panel-data` untouched.
The script in the source tree is a release asset; it
expects the canonical binary, `SHA256SUMS`, and its `install/` assets beside it,
so use it from an extracted GitHub release rather than directly from this
directory.

## GitHub workflow behavior

`.github/workflows/ci.yml` verifies pull requests and default-branch pushes. It
builds the environment-neutral frontend once, then installs locked backend
dependencies, typechecks/tests, audits, rejects `.node` addons, and compiles and
smoke-tests the native target on macOS ARM64 and Linux x64. The Linux job also
runs the complete direct-IP production installer on its disposable hosted
runner and verifies systemd, health, login, cookie, and session behavior.
Temporary workflow artifacts are not GitHub Releases.

`.github/workflows/archive-benchmark.yml` is manual and runs the production ZIP
round trip on both native platforms. It uploads JSON measurements without
turning variable hosted-runner timing into a merge gate.

Pushing a semantic version tag such as `v1.2.3` (or prerelease
`v1.2.3-rc.1`) invokes `.github/workflows/release.yml`. It validates the tag,
builds the frontend once without environment-specific URLs, verifies both native
jobs, builds full archives and checksums, and publishes a GitHub Release only
after both succeed. It refuses to overwrite an existing release. Generated
release-note categories come from `.github/release.yml` and merged pull-request
labels.

See `../docs/RELEASING.md` for required branch checks, version preparation,
tagging, checksums, and attestations.

## Streaming performance and alternatives

`@fastify/busboy` parses uploads as request streams. Each file is written to a
bounded `.part` path, the configured byte limit is enforced, aborted transfers
are cleaned up, and completion uses atomic rename. This avoids buffering a
multi-gigabyte upload in RAM. Real speed will mostly depend on network,
filesystem, antivirus, and concurrency; no repository benchmark claims a
specific throughput figure.

Measure the production archive and database paths from the repository root:

```sh
bun run benchmark:archive
bun run benchmark:database
```

The archive benchmark performs and validates ZIP/unzip round trips while
reporting throughput, compression ratio, and sampled RSS. The database
benchmark verifies that UUID lookup remains an indexed SQLite search. See
`../docs/BENCHMARKING.md` for fixtures, reports, interpretation, and limitations.

That guide also records the August 2026 Apple M1 comparison against the archived
Node backend. The compiled Bun server was faster to readiness, lower in idle
RSS, and faster on the measured authenticated and SQLite paths. ZIP creation was
faster, but strict extraction was about twice as slow as the less-defensive
legacy extractor. Keep that regression visible when evaluating large local
restore workloads.

zip.js creates ZIP/Zip64 output through Web Streams and Bun's native
`CompressionStream` path and streams output to disk. Extraction enforces CRC,
entry-count, decompressed-size, ambiguity, traversal, and symlink containment
checks. This is a strong standalone/security tradeoff, not a promise that
JavaScript ZIP orchestration beats every native archiver.

DEFLATE level 6 is the production default because it uses Bun's native
zlib-ng-backed compression path. Selecting level 9 is not a free increase in
compression: it disables the native `CompressionStream` path in zip.js and is
substantially more CPU-intensive, often for little benefit on JARs and already
compressed Minecraft data.

`Bun.Archive` is native and useful for tar, but it does not produce the ZIP files
expected by downloads/backups and currently materializes archive output in
memory. It is therefore not suitable for large panel ZIPs. The prioritized
standalone and native optimization choices, including bounded concurrency,
WASM, fflate, libarchive, native addons, and Rust, are documented in
`../docs/BENCHMARKING.md`. Keep the current implementation until measurements
on real server trees justify a tradeoff.

## Fresh reset, cutover, and rollback

This branch intentionally starts the Bun rewrite fresh. To reset only Bun state,
stop the backend and all Java children, back up anything needed, then move or
remove `panel-data/`. Run `bun run init` or root `bun run setup` to generate a new
password hash, JWT secret, empty database, and servers directory. `dist/` and
`../client/dist/` are disposable build outputs; deleting them does not reset
runtime data.

Do not delete or repurpose `../legacy-node-server/`. The legacy database stores absolute
paths and has a different schema/layout; this backend deliberately will not open
it as if it were fresh Bun data. There is no automatic legacy importer yet.

For a safe acceptance test, stop the legacy backend and its Java processes,
back up `../legacy-node-server/db`, `../legacy-node-server/server-directory`, and the legacy `.env`, then
initialize and test this backend in its separate `panel-data`. Never run both
backends against one mutable tree. Rollback is stopping Bun and restarting the
preserved legacy backend. Moving existing worlds and records should wait for a
dedicated importer with explicit validation and rollback tests.
