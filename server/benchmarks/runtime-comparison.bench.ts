import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";

const DEFAULT_STARTUP_RUNS = 7;
const DEFAULT_HTTP_RUNS = 5;
const DEFAULT_HTTP_REQUESTS = 5_000;
const DEFAULT_HTTP_CONCURRENCY = 32;
const READY_TIMEOUT_MS = 15_000;
const TEST_PASSWORD = "test-password";
const TEST_PASSWORD_HASH = "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri";
const TEST_SECRET = "0123456789abcdef0123456789abcdef";

interface RuntimeDefinition {
  name: string;
  runtime: "bun" | "legacy-node";
  command: string[];
  cwd: string;
  dataDirectory: string;
}

interface RunningServer {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  origin: string;
  startupMs: number;
}

interface MetricSummary {
  minimum: number;
  median: number;
  mean: number;
  maximum: number;
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function summarize(values: number[]): MetricSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    minimum: sorted[0] ?? 0,
    median: sorted.length % 2
      ? sorted[middle] ?? 0
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2,
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    maximum: sorted.at(-1) ?? 0,
  };
}

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a benchmark port");
  return address.port;
}

async function streamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : "";
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  const timeout = Bun.sleep(5_000).then(() => "timeout" as const);
  if ((await Promise.race([server.child.exited.then(() => "exit" as const), timeout])) === "timeout") {
    server.child.kill("SIGKILL");
    await server.child.exited;
  }
}

async function startServer(definition: RuntimeDefinition): Promise<RunningServer> {
  const port = await unusedPort();
  await Promise.all([
    mkdir(definition.cwd, { recursive: true }),
    mkdir(definition.dataDirectory, { recursive: true }),
  ]);
  if (definition.runtime === "bun") {
    // The Bun server intentionally accepts application configuration only from
    // TOML; benchmark tuning variables remain separate harness inputs.
    await writeFile(
      path.join(definition.dataDirectory, "config.toml"),
      Bun.TOML.stringify({
        root_username: "benchmark",
        root_password_hash: TEST_PASSWORD_HASH,
        jwt_secret: TEST_SECRET,
        port,
        listen_host: "127.0.0.1",
        deployment_mode: "test",
        environment: "test",
        secure_cookie: false,
        allow_insecure_http: false,
      })!,
    );
  }
  const childEnvironment = definition.runtime === "legacy-node"
    ? {
        ...process.env,
        ROOT_USERNAME: "benchmark",
        ROOT_PASSWORD_HASH: TEST_PASSWORD_HASH,
        JWT_SECRET: TEST_SECRET,
        PORT: String(port),
        PANEL_HOST: "127.0.0.1",
        PANEL_DATA_DIR: definition.dataDirectory,
        PANEL_PUBLIC_DIR: path.join(definition.dataDirectory, "public"),
        PANEL_DEPLOYMENT_MODE: "test",
        NODE_ENV: "test",
        SECURE_STATUS: "false",
        ALLOW_INSECURE_HTTP: "false",
        CORSORIGIN: "",
      }
    : process.env;
  const child = Bun.spawn(definition.command, {
    cwd: definition.cwd,
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const origin = `http://127.0.0.1:${port}`;
  const startedAt = performance.now();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const [stdout, stderr] = await Promise.all([streamText(child.stdout), streamText(child.stderr)]);
      throw new Error(`${definition.name} exited during startup (${child.exitCode})\n${stdout}\n${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/validate-session`);
      await response.body?.cancel();
      if (response.status === 401) {
        return { child, origin, startupMs: performance.now() - startedAt };
      }
    } catch {
      // The listen socket is not ready yet.
    }
    await Bun.sleep(5);
  }
  const running = { child, origin, startupMs: performance.now() - startedAt };
  await stopServer(running);
  const [stdout, stderr] = await Promise.all([streamText(child.stdout), streamText(child.stderr)]);
  throw new Error(`${definition.name} did not become ready in ${READY_TIMEOUT_MS} ms\n${stdout}\n${stderr}`);
}

async function rssBytes(pid: number): Promise<number> {
  const processInfo = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(pid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await streamText(processInfo.stdout);
  if ((await processInfo.exited) !== 0) throw new Error(`Could not read RSS for PID ${pid}`);
  const kibibytes = Number(output.trim());
  if (!Number.isFinite(kibibytes)) throw new Error(`Invalid RSS value for PID ${pid}`);
  return kibibytes * 1024;
}

async function login(origin: string): Promise<string> {
  const response = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "benchmark", password: TEST_PASSWORD }),
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`Benchmark login failed with HTTP ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie?.startsWith("token=")) throw new Error("Benchmark login did not return a token cookie");
  return cookie;
}

async function requestBatch(
  url: string,
  cookie: string,
  requestCount: number,
  concurrency: number,
): Promise<number> {
  let nextRequest = 0;
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const requestNumber = nextRequest;
        nextRequest += 1;
        if (requestNumber >= requestCount) return;
        const response = await fetch(url, { headers: { cookie } });
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      }
    }),
  );
  return requestCount / ((performance.now() - startedAt) / 1_000);
}

async function benchmarkRuntime(
  definition: RuntimeDefinition,
  startupRuns: number,
  httpRuns: number,
  httpRequests: number,
  httpConcurrency: number,
): Promise<Record<string, unknown>> {
  console.log(`\n${definition.name}`);
  const warmup = await startServer(definition);
  await stopServer(warmup);

  const startupTimes: number[] = [];
  for (let run = 1; run <= startupRuns; run += 1) {
    const server = await startServer(definition);
    startupTimes.push(server.startupMs);
    console.log(`  startup ${run}/${startupRuns}: ${server.startupMs.toFixed(2)} ms`);
    await stopServer(server);
  }

  const server = await startServer(definition);
  try {
    const cookie = await login(server.origin);
    await Bun.sleep(1_000);
    const idleRssBytes = await rssBytes(server.child.pid);
    await requestBatch(`${server.origin}/validate-session`, cookie, 500, httpConcurrency);
    await requestBatch(`${server.origin}/servers`, cookie, 500, httpConcurrency);

    const sessionRates: number[] = [];
    const listRates: number[] = [];
    for (let run = 1; run <= httpRuns; run += 1) {
      const sessionRate = await requestBatch(
        `${server.origin}/validate-session`,
        cookie,
        httpRequests,
        httpConcurrency,
      );
      const listRate = await requestBatch(
        `${server.origin}/servers`,
        cookie,
        httpRequests,
        httpConcurrency,
      );
      sessionRates.push(sessionRate);
      listRates.push(listRate);
      console.log(
        `  HTTP ${run}/${httpRuns}: session ${sessionRate.toFixed(0)} req/s; list ${listRate.toFixed(0)} req/s`,
      );
    }
    return {
      startupMs: summarize(startupTimes),
      idleRssBytes,
      validateSessionRequestsPerSecond: summarize(sessionRates),
      listServersRequestsPerSecond: summarize(listRates),
    };
  } finally {
    await stopServer(server);
  }
}

async function main(): Promise<void> {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(`Runtime comparison benchmark

Required:
  LEGACY_BENCH_NODE        Absolute path to a Node executable
  LEGACY_BENCH_SERVER_DIR  Isolated legacy-node-server copy with dependencies installed

Optional:
  BUN_BENCH_RUNTIME        Absolute Bun executable path (defaults to current runtime)
  BUN_BENCH_BINARY         Compiled panel executable to include
  RUNTIME_BENCH_OUTPUT     JSON report path
  RUNTIME_BENCH_STARTUPS   Startup repetitions (default: ${DEFAULT_STARTUP_RUNS})
  RUNTIME_BENCH_HTTP_RUNS  HTTP repetitions (default: ${DEFAULT_HTTP_RUNS})
  RUNTIME_BENCH_REQUESTS   Requests per endpoint/run (default: ${DEFAULT_HTTP_REQUESTS})
  RUNTIME_BENCH_CONCURRENCY Concurrent requests (default: ${DEFAULT_HTTP_CONCURRENCY})`);
    return;
  }

  const nodeBinary = process.env.LEGACY_BENCH_NODE?.trim();
  const legacyDirectory = process.env.LEGACY_BENCH_SERVER_DIR?.trim();
  if (!nodeBinary || !path.isAbsolute(nodeBinary)) {
    throw new Error("LEGACY_BENCH_NODE must be an absolute Node executable path");
  }
  if (!legacyDirectory || !path.isAbsolute(legacyDirectory)) {
    throw new Error("LEGACY_BENCH_SERVER_DIR must be an absolute isolated legacy copy");
  }
  if (path.resolve(legacyDirectory) === path.resolve(import.meta.dir, "..", "..", "legacy-node-server")) {
    throw new Error("Refusing to benchmark in the repository's archived legacy-node-server directory");
  }

  const startupRuns = integerSetting("RUNTIME_BENCH_STARTUPS", DEFAULT_STARTUP_RUNS, 1, 100);
  const httpRuns = integerSetting("RUNTIME_BENCH_HTTP_RUNS", DEFAULT_HTTP_RUNS, 1, 100);
  const httpRequests = integerSetting("RUNTIME_BENCH_REQUESTS", DEFAULT_HTTP_REQUESTS, 1, 1_000_000);
  const httpConcurrency = integerSetting(
    "RUNTIME_BENCH_CONCURRENCY",
    DEFAULT_HTTP_CONCURRENCY,
    1,
    1_000,
  );
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "msp-runtime-benchmark-"));
  try {
    const bunRuntime = process.env.BUN_BENCH_RUNTIME?.trim() || process.execPath;
    const definitions: RuntimeDefinition[] = [
      {
        name: `Bun ${Bun.version} source`,
        runtime: "bun",
        command: [bunRuntime, path.resolve(import.meta.dir, "..", "server.ts"), "serve"],
        cwd: path.join(temporaryDirectory, "bun-source-home"),
        dataDirectory: path.join(temporaryDirectory, "bun-source-home", "panel-data"),
      },
      {
        name: "Node legacy",
        runtime: "legacy-node",
        command: [nodeBinary, "server.js"],
        cwd: legacyDirectory,
        dataDirectory: path.join(legacyDirectory, "benchmark-data"),
      },
    ];
    const binary = process.env.BUN_BENCH_BINARY?.trim();
    if (binary) {
      if (!path.isAbsolute(binary)) throw new Error("BUN_BENCH_BINARY must be absolute");
      const binaryHome = path.join(temporaryDirectory, "bun-binary-home");
      const benchmarkBinary = path.join(binaryHome, path.basename(binary));
      await mkdir(binaryHome, { recursive: true });
      await copyFile(binary, benchmarkBinary);
      await chmod(benchmarkBinary, 0o755);
      definitions.splice(1, 0, {
        name: "Bun compiled executable",
        runtime: "bun",
        command: [benchmarkBinary, "serve"],
        cwd: binaryHome,
        dataDirectory: path.join(binaryHome, "panel-data"),
      });
    }

    const results: Record<string, unknown> = {};
    for (const definition of definitions) {
      results[definition.name] = await benchmarkRuntime(
        definition,
        startupRuns,
        httpRuns,
        httpRequests,
        httpConcurrency,
      );
    }
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        release: release(),
        architecture: arch(),
        cpu: cpus()[0]?.model || "unknown",
        logicalCpuCount: cpus().length,
      },
      configuration: { startupRuns, httpRuns, httpRequests, httpConcurrency },
      runtimes: {
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        legacyNodeVersion: Bun.spawnSync([nodeBinary, "--version"]).stdout.toString().trim(),
      },
      results,
    };
    const output = process.env.RUNTIME_BENCH_OUTPUT?.trim();
    if (output) {
      const outputPath = path.resolve(output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\nReport written to ${outputPath}`);
    } else {
      console.log(`\n${JSON.stringify(report, null, 2)}`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
