import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../types.ts";
import { PanelDatabase } from "../db/db.ts";

const DEFAULT_ROWS = 10_000;
const DEFAULT_LOOKUPS = 100_000;
const DEFAULT_RUNS = 5;

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function summarize(values: number[]): { minimum: number; median: number; mean: number; maximum: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle] ?? 0
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    minimum: sorted[0] ?? 0,
    median,
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    maximum: sorted.at(-1) ?? 0,
  };
}

function printHelp(): void {
  console.log(`SQLite UUID lookup benchmark (uses the production PanelDatabase)

  bun run benchmark:database

Environment controls:
  DATABASE_BENCH_ROWS       Number of fixture servers (default: ${DEFAULT_ROWS})
  DATABASE_BENCH_LOOKUPS    Indexed UUID lookups per run (default: ${DEFAULT_LOOKUPS})
  DATABASE_BENCH_RUNS       Timed runs (default: ${DEFAULT_RUNS})
  DATABASE_BENCH_OUTPUT     Optional JSON report path`);
}

async function main(): Promise<void> {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    printHelp();
    return;
  }

  const rows = readInteger("DATABASE_BENCH_ROWS", DEFAULT_ROWS, 1, 60_000);
  const lookups = readInteger("DATABASE_BENCH_LOOKUPS", DEFAULT_LOOKUPS, 1, 10_000_000);
  const runs = readInteger("DATABASE_BENCH_RUNS", DEFAULT_RUNS, 1, 100);
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "msp-database-benchmark-"));
  const databasePath = path.join(workingDirectory, "panel.sqlite3");
  const config: AppConfig = {
    rootUsername: "benchmark",
    rootPasswordHash: "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri",
    jwtSecret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
    port: 3001,
    hostname: "127.0.0.1",
    corsOrigin: null,
    secureCookie: false,
    allowInsecureHttp: false,
    deploymentMode: "test",
    publicAddress: "127.0.0.1",
    production: false,
    dataDir: workingDirectory,
    databasePath,
    serversPath: path.join(workingDirectory, "servers"),
    publicDir: path.join(workingDirectory, "public"),
    uploadMaxBytes: 2_147_483_648,
  };

  await mkdir(config.serversPath, { recursive: true });
  const database = new PanelDatabase(config);
  try {
    const uuids = Array.from({ length: rows }, () => crypto.randomUUID());
    const populateStarted = performance.now();
    database.sqlite.transaction(() => {
      for (let index = 0; index < uuids.length; index += 1) {
        database.insertServer({
          uuid: uuids[index]!,
          name: `Benchmark server ${index}`,
          startupCommand: "java -Xmx2G -Xms2G -jar server.jar nogui",
          startupFlags: "",
          version: "1.21.1",
          port: index + 1,
          serverType: "vanilla",
        });
      }
    })();
    const populateElapsedMs = performance.now() - populateStarted;

    const plan = database.sqlite
      .query("EXPLAIN QUERY PLAN SELECT * FROM servers WHERE uuid = ?")
      .all(uuids[0]!) as Array<{ detail: string }>;
    const planDetails = plan.map((step) => step.detail);
    if (!planDetails.some((detail) => detail.includes("SEARCH servers") && detail.includes("uuid"))) {
      throw new Error(`UUID lookup lost its index: ${planDetails.join("; ")}`);
    }

    for (let index = 0; index < Math.min(1_000, lookups); index += 1) {
      database.getServer(uuids[index % rows]!);
    }

    const operationsPerSecond: number[] = [];
    let state = 0x6d2b79f5;
    for (let run = 1; run <= runs; run += 1) {
      const started = performance.now();
      for (let index = 0; index < lookups; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        const record = database.getServer(uuids[state % rows]!);
        if (!record) throw new Error("Indexed UUID lookup returned no row");
      }
      const elapsedMs = performance.now() - started;
      const rate = lookups / (elapsedMs / 1_000);
      operationsPerSecond.push(rate);
      console.log(`Run ${run}/${runs}: ${rate.toFixed(0)} indexed UUID lookups/s (${elapsedMs.toFixed(2)} ms)`);
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        platform: process.platform,
        architecture: process.arch,
      },
      configuration: { rows, lookupsPerRun: lookups, runs },
      population: {
        elapsedMs: populateElapsedMs,
        rowsPerSecond: rows / (populateElapsedMs / 1_000),
      },
      queryPlan: planDetails,
      indexedUuidLookupsPerSecond: summarize(operationsPerSecond),
    };

    console.log(`Query plan: ${planDetails.join("; ")}`);
    console.log(`Median: ${report.indexedUuidLookupsPerSecond.median.toFixed(0)} indexed UUID lookups/s`);

    const output = process.env.DATABASE_BENCH_OUTPUT?.trim();
    if (output) {
      const outputPath = path.resolve(output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`Report written to ${outputPath}`);
    }
  } finally {
    database.close();
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

await main();
