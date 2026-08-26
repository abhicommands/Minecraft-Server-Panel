# Benchmarking

Minecraft Server Panel includes reproducible benchmarks for the two performance
questions most likely to matter on real installations: ZIP round trips and
SQLite server lookup. They call the production implementation rather than a
mock or a different library.

Benchmarks are measurements, not CI pass/fail gates. Compare results only on the
same hardware, operating system, filesystem, Bun version, power mode, dataset,
and compression level. Close unrelated heavy processes and keep the generated
JSON reports with the commit SHA being tested.

## Recorded Bun rewrite baseline

The following application-level baseline was measured on August 25, 2026. It is
evidence for this rewrite on one machine, not a general claim that Bun is faster
than Node for every workload.

| Environment | Value |
|---|---|
| Host | Apple M1, 8 logical CPUs, 8 GiB RAM |
| OS | macOS ARM64, Darwin 25.6.0 |
| Bun | 1.4.0, revision `34cbb9a40b4bd1bd767d134a7065e66c2432a676` |
| Runtime comparison | Node 24.19.0 LTS |
| Legacy database/archive comparison | Node 22.23.2 LTS |
| HTTP load | 5 runs of 5,000 requests per endpoint, concurrency 32 |
| SQLite load | 50,000 rows; 7 runs of 1,000,000 indexed UUID lookups |
| Archive load | 256 MiB mixed fixture, 512 files, level 6, 5 round trips |

### Runtime and authenticated HTTP

These requests exercise the complete application route, cookie/JWT
authentication, response handling, and—in the server-list case—the production
database wrapper. The startup result is time from process creation until the
session endpoint accepted a request. Idle RSS was sampled after login and a
one-second settling interval.

| Measurement (median unless noted) | Bun source | Bun executable | Legacy Node 24 |
|---|---:|---:|---:|
| Ready time | 70.82 ms | 43.00 ms | 201.17 ms |
| Idle RSS | 56.47 MiB | 51.13 MiB | 90.55 MiB |
| Authenticated session validation | 45,478 req/s | 44,808 req/s | 14,300 req/s |
| Authenticated empty server list | 39,944 req/s | 39,175 req/s | 11,777 req/s |

On this host the compiled application reached readiness 4.68 times sooner, used
43.5% less idle RSS, handled 3.13 times as many session validations per second,
and handled 3.33 times as many server-list requests per second as the archived
backend. Source-mode Bun was also 2.84 times faster to readiness. These numbers
measure the two real implementations, so they include library choices (`jose`
versus `jsonwebtoken`, native Bun HTTP versus Express, and native Bun SQLite
versus the legacy wrapper); they are deliberately not synthetic runtime-only
microbenchmarks.

The native macOS executable was 66.45 MiB and already contained the frontend,
backend packages, and Bun runtime. The Node 24 executable alone was 115.69 MiB,
before the legacy `node_modules` tree and separately built frontend. Installed
filesystem size is packaging-dependent, so this is not presented as a precise
deployment-size ratio; it does show that the Bun artifact meets the standalone
single-file goal.

### Indexed SQLite UUID lookup

| Measurement (median unless noted) | Bun 1.4 `bun:sqlite` | Legacy Node 22 `better-sqlite3` wrapper |
|---|---:|---:|
| UUID lookup | 213,862 lookups/s | 66,687 lookups/s |
| Transactional population | 376,780 rows/s | 136,265 rows/s |
| Query plan | `sqlite_autoindex_servers_1 (uuid=?)` | `idx_uuid (uuid=?)` |

Both implementations used an indexed text UUID lookup. Bun's production path
was 3.21 times faster for lookup and 2.77 times faster for fixture insertion on
this run. That leaves enormous headroom for a panel with tens or hundreds of
servers and confirms that changing the public UUID format would add migration
cost without a user-visible database benefit.

Node 24.19.0 completed the runtime/HTTP test, but the sustained legacy database
test aborted inside the manually rebuilt `better-sqlite3@12.4.1` native binding
with a Node environment-cleanup assertion. The comparison was therefore rerun
on the latest Node 22 LTS line, where all seven runs completed. This is a result
of this exact archived dependency/build combination, not a claim that every
version of `better-sqlite3` fails on Node 24. It does demonstrate the native ABI
and build maintenance the Bun rewrite removes.

### ZIP round trip

The same generated directory was used for both implementations. Throughput is
uncompressed source bytes divided by elapsed time.

| Measurement (median) | Bun/zip.js | Legacy Node |
|---|---:|---:|
| ZIP creation | 87.10 MiB/s | 74.33 MiB/s |
| Extraction | 317.22 MiB/s | 637.63 MiB/s |
| ZIP peak process RSS | 114.72 MiB | 136.81 MiB |
| Extraction peak process RSS | 116.75 MiB | 137.28 MiB |
| Output archive | 129.09 MiB | 128.58 MiB |

The Bun implementation created ZIPs 17.2% faster and used less peak process RSS
in this fixture. Its extraction throughput was 2.01 times slower, and its output
was 0.39% larger. That extraction regression is real. It is not an equal-safety
comparison: the active implementation additionally enforces CRC, entry and
expanded-size limits, duplicate/overlap and ambiguous-name rejection, ZIP-slip
containment, and symlink containment, while the archived extractor does not do
all of that work. For ordinary backups, 317 MiB/s remains above typical network
upload speeds and many storage paths, but very fast local NVMe extraction is the
clearest area to watch on larger real-world worlds.

#### Level 6 versus level 9 spot check

A separate one-run diagnostic on the same host used the deterministic 32 MiB
mixed fixture across 128 files. It exists to verify codec selection, not as a
statistically strong performance baseline:

| Setting | ZIP creation | Output | Sampled ZIP RSS |
| --- | ---: | ---: | ---: |
| Level 6, native `CompressionStream` | 93.57 MiB/s | 16.16 MiB (50.50%) | 68.84 MiB |
| Level 9, JavaScript fallback | 36.32 MiB/s | 16.10 MiB (50.32%) | 78.55 MiB |

On that fixture level 9 was 2.58 times slower and reduced the archive by only
about 0.37%. A single run should not be generalized to every world, but it
confirms that changing the production default to 9 would violate the speed goal
for a very small gain on this mixed workload. Use the commands below with a real
stopped server tree before choosing a different level.

### Decision

The rewrite is justified on the measured host. The main gains are the
self-contained release, removal of native addon compilation/ABI failures,
faster startup, lower idle memory, and substantially faster authenticated and
SQLite paths. ZIP creation also improved. Safe ZIP extraction is slower, so a
native helper or Rust/libarchive implementation should be reconsidered only if
representative production fixtures show that extraction—not Java, disk, or the
network—is a practical bottleneck.

The first isolated install of the archived backend also failed when
`node-pty@1.0.0` was built against Bun's newer compatibility headers. Making it
run required a pinned build tool and ABI-targeted native rebuilds for both
addons. The active backend and its executable required none of those steps.

## Archive benchmark

From the repository root:

```sh
bun run benchmark:archive
```

The default run generates 64 MiB across 128 files, then performs three ZIP and
unzip round trips at compression level 6. It validates the extracted file count
and total byte count and reports elapsed time, MiB/s, archive ratio, and sampled
process RSS. Temporary data is deleted after the run.

Use a larger representative fixture and save a machine-readable report:

```sh
ARCHIVE_BENCH_SIZE_MIB=1024 \
ARCHIVE_BENCH_FILE_COUNT=10000 \
ARCHIVE_BENCH_DATASET=mixed \
ARCHIVE_BENCH_RUNS=5 \
ARCHIVE_BENCH_OUTPUT=benchmark-results/archive-local.json \
bun run benchmark:archive
```

To measure an existing tree without modifying it, stop its Minecraft server and
point the benchmark at the directory:

```sh
ARCHIVE_BENCH_SOURCE_DIR=/absolute/path/to/server/files \
ARCHIVE_BENCH_OUTPUT=benchmark-results/archive-real-world.json \
bun run benchmark:archive
```

Run `bun run --cwd server benchmark:archive --help` for every control. The
generated datasets are:

- `compressible`: repeated log-like data, useful for maximum compression work;
- `random`: deterministic incompressible data, useful for stream overhead; and
- `mixed`: an even combination and the recommended comparison fixture.

The manual **Archive benchmark** GitHub Actions workflow runs the same code on
macOS ARM64 and Linux x64 and uploads 30-day JSON artifacts. It is intentionally
manual: shared hosted runners are useful for cross-platform regressions, not
stable absolute performance claims.

## SQLite lookup benchmark

Run:

```sh
bun run benchmark:database
```

This creates a disposable database with 10,000 server rows, validates that
`EXPLAIN QUERY PLAN` reports an indexed UUID search, warms the production query,
and measures 100,000 UUID lookups across five runs. Override the scale and save
a report when needed:

```sh
DATABASE_BENCH_ROWS=50000 \
DATABASE_BENCH_LOOKUPS=1000000 \
DATABASE_BENCH_RUNS=7 \
DATABASE_BENCH_OUTPUT=benchmark-results/database-local.json \
bun run benchmark:database
```

The public UUID remains a UUIDv4 string for API, Socket.IO, and filesystem
compatibility. SQLite's `UNIQUE` constraint creates the lookup index, Bun caches
the compiled prepared statement, and the panel also stores an integer rowid for
ordered listing. At the expected tens or hundreds of servers, shorter or
sequential public IDs do not provide a meaningful user-visible gain. They do
reduce opacity and require a destructive URL/directory migration. A 16-byte UUID
BLOB or UUIDv7 should be reconsidered only if measurements on a much larger
database establish that identifier index size or insertion locality is a real
bottleneck.

## Maintainer-only legacy comparison harnesses

The recorded baseline used `benchmarks/runtime-comparison.bench.ts` plus
`benchmarks/legacy-worker.cjs`. They are intentionally not part of `bun run
check`: a legacy comparison requires downloading a particular official Node
runtime, installing old packages, and allowing the archived native-addon build
scripts. It must use a disposable copy, never `legacy-node-server/` in the
working tree.

Inspect the runtime harness controls with:

```sh
bun run benchmark:runtime-comparison --help
```

It refuses the repository's legacy directory and requires absolute paths for an
isolated, dependency-installed copy and its Node executable. The optional
`BUN_BENCH_BINARY` includes a native compiled artifact. The legacy worker accepts
`archive` or `database` and writes JSON through `LEGACY_BENCH_OUTPUT`. These
tools exist to reproduce or challenge the table above; ordinary contributors
should run the production Bun benchmarks instead.

## Current archive limitations to measure

ZIP payloads stream to and from disk, but archive work is still CPU and I/O
intensive. The most relevant stress cases are:

- very many tiny files, where recursive metadata scans and ZIP entry overhead
  dominate;
- already-compressed JARs, world data, or media, where deflate adds CPU for
  little size reduction;
- simultaneous archive jobs, which can compete for the same CPU and disk; and
- very large central directories during extraction. Entry count and total
  expanded size are bounded, but metadata still consumes memory.

The production implementation currently submits ZIP entries and extracts them
sequentially. This preserves predictable memory and makes task progress simple,
but it does not use all available cores when an archive contains several
independent files. zip.js supports concurrent `add()` and `getData()` work; the
safe implementation must bound concurrency and, for creation, spill buffered
compressed entries to temporary files rather than allowing its default
in-memory buffers to grow with large entries.

Task state currently lives in backend memory for one hour after completion. The
current UI displays percentage progress while its page remains mounted, but a
browser reload loses the task ID and a backend restart loses the task record.
Uploads also abort when the browser connection is lost. Durable, resumable
operations require a persisted operation table and resumable transfer protocol;
they are a separate product change, not a benchmark feature.

The compatibility backup action currently includes `world/`, `mods/`, and
`server.jar`, matching the legacy backend. Plugins, configuration, additional
worlds, and other root files are not part of that backup action. Use the file
manager archive operation for explicitly selected extra paths until backup scope
is redesigned and migration-tested.

## ZIP speed, compression, and standalone options

There is no setting that is both literal maximum compression and maximum speed.
DEFLATE level 9 spends more CPU searching for a smaller representation; level 6
is normally the useful speed/ratio point. zip.js documents that Bun can process
independent native `CompressionStream` instances on its thread pool, but the
native API is used only when the level is omitted or is 6. In this repository,
`index-native.js` deliberately avoids worker/WASM sidecars, so a non-6 level
uses the slower JavaScript fallback.

The realistic choices are:

| Option | Best use | Standalone Bun executable | Principal cost or limitation |
| --- | --- | --- | --- |
| Current zip.js, level 6 | Large streamed files; balanced ratio | Yes, already shipped | Entry work is currently sequential |
| Bounded concurrent zip.js `add()` | Several medium/large entries | Yes | Concurrent entries must use file-backed temporary streams to retain bounded RSS; tune 2-4 workers against the disk |
| Bounded concurrent `getData()` | Extraction with several independent entries | Yes | Validate every destination before writing; extra I/O and RSS can hurt HDDs and single-entry archives |
| Store already-compressed extensions at level 0 | JAR, ZIP, PNG and similar payloads | Yes | Fastest for those entries, but intentionally gives up any small secondary compression gain |
| zip.js WASM + workers at level 9 | Maximum standard-DEFLATE ratio without native code | Yes, if the worker entry point and WASM are embedded and smoke-tested | Usually much slower than Bun's native level-6 path; larger executable and more build complexity |
| fflate fast path | Thousands of tiny, sub-4-GiB entries | Yes; pure JavaScript | Not a drop-in replacement for the current Zip64 writer and strict archive validation; its worker path must also be embedded |
| WebAssembly libarchive/codec | Portable native-language implementation | Yes; Bun can embed WASM | WASM/stream bridging often erases the expected speed win; must be benchmarked and security-wrapped |
| Installed `bsdtar`/libarchive or `7zz` | Native tooling, especially many tiny files | The panel binary remains standalone, but the feature has a host dependency | Version/platform differences, subprocess hardening, progress parsing, and installer work |
| Embedded Node-API addon using zlib-ng/libarchive/libdeflate | Native code in one downloadable Bun executable | Technically yes, per Bun's executable support | Reintroduces a native addon and per-target compilation/signing; libdeflate is whole-buffer rather than streaming |
| Bun FFI to a shared library | Experiments only | No—the shared library is external | Bun labels FFI experimental and says not to rely on it in production |
| Bundled Rust/C archive helper | Native predictable implementation | No at runtime; it is a multi-binary release (or must extract an embedded helper before execution) | Second toolchain, IPC, signing, cleanup, and platform-specific artifacts |
| Rust backend with statically linked archive code | Maximum control and a genuinely native single binary | Not a Bun executable; it replaces the backend | Largest rewrite and maintenance cost |
| `.tar.zst` or solid `.7z` instead of ZIP | Better cross-file ratio and potentially high throughput | Depends on implementation | Breaks the existing ZIP download/restore and user-tool compatibility contract |

Upstream zip.js measurements show why the first experiment should remain in
zip.js: on an 8-by-8-MiB compressible workload, concurrent native `add()` on Bun
fell from 1.80 seconds to 0.36 seconds, without Web Workers. The same benchmark
also reports zip.js as strong for large-stream decompression but much slower than
fflate or 7-Zip for thousands of tiny files. Those are upstream fixtures, not a
promise of a five-times panel speedup; disk staging, CRC checks, safe path
resolution, file creation, and the shape of a Minecraft server tree all matter.

For a future optimization branch, use this order:

1. Keep level 6 and the native `CompressionStream` path.
2. Preflight all names, limits, symlinks, collisions, and overwrite decisions
   before any parallel extraction starts.
3. Add configurable concurrency, beginning at two workers and benchmarking up
   to four; never equate logical CPU count with a safe disk concurrency.
4. Use file-backed temporary streams for concurrent ZIP creation and clean them
   on success, abort, and process failure.
5. Benchmark mixed, compressible, random, many-tiny-file, single-large-file,
   SSD, and HDD/network-storage fixtures while recording RSS and output size.
6. Only then compare fflate or a native helper with identical safety and
   round-trip checks.

Primary references: [zip.js upstream benchmarks](https://github.com/gildas-lormeau/zip.js/blob/master/BENCHMARKS.md),
[zip.js writer options](https://gildas-lormeau.github.io/zip.js/api/interfaces/ZipWriterConstructorOptions.html),
[Bun standalone assets, workers, WASM, and Node-API addons](https://bun.com/docs/bundler/executables),
[Bun FFI production warning](https://bun.com/docs/runtime/ffi),
[libarchive's streaming design](https://github.com/libarchive/libarchive/blob/master/README.md),
[libdeflate's whole-buffer limitation](https://github.com/ebiggers/libdeflate),
and [fflate's ZIP/worker tradeoffs](https://github.com/101arrowz/fflate/blob/master/README.md).

## Native alternatives

Do not replace ZIP code based on package reputation alone. If the production
benchmark establishes an unacceptable bottleneck, compare these options with
the same fixtures:

- an installed `bsdtar`/libarchive process is mature and fast, but makes the
  release depend on a compatible external executable;
- a bundled platform-specific helper keeps installation predictable but turns
  the release into a multi-binary package and expands signing/security work;
- Bun FFI to libarchive still requires a platform library and does not make Bun
  link arbitrary C archives into its compiled executable; and
- a Rust/C helper or backend can statically link native archive code into a
  native executable, at the cost of a second toolchain and larger rewrite.

Bun's native archive API is aimed at tar-family archives, not the downloadable
ZIP contract used by this panel. Node's single-executable application support
also does not remove native PTY/addon packaging concerns. The current Bun design
therefore remains the best standalone baseline until measurements justify a
native helper or Rust implementation.
