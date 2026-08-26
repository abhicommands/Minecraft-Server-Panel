"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function requiredPath(name) {
  const value = process.env[name]?.trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    minimum: sorted[0] || 0,
    median: sorted.length % 2
      ? sorted[middle] || 0
      : ((sorted[middle - 1] || 0) + (sorted[middle] || 0)) / 2,
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    maximum: sorted.at(-1) || 0,
  };
}

async function inspectDirectory(root) {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const children = await fsp.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      const stats = await fsp.lstat(childPath);
      if (stats.isSymbolicLink()) throw new Error(`Fixture contains a symlink: ${childPath}`);
      if (stats.isDirectory()) pending.push(childPath);
      else if (stats.isFile()) {
        bytes += stats.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

function rssSampler(intervalMs = 50) {
  const baselineBytes = process.memoryUsage().rss;
  let peakBytes = baselineBytes;
  const sample = () => { peakBytes = Math.max(peakBytes, process.memoryUsage().rss); };
  const timer = setInterval(sample, intervalMs);
  return () => {
    clearInterval(timer);
    sample();
    return { baselineBytes, peakBytes, increaseBytes: Math.max(0, peakBytes - baselineBytes) };
  };
}

async function waitForTask(manager, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = manager.getTaskStatus(taskId);
    if (!task) throw new Error(`Legacy archive task ${taskId} disappeared`);
    if (task.status === manager.TASK_STATUS.COMPLETED) return task;
    if (task.status === manager.TASK_STATUS.ERROR) throw new Error(task.message || "Legacy archive failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Legacy archive task exceeded ${timeoutMs} ms`);
}

async function archiveBenchmark(legacyDirectory) {
  const sourceDirectory = requiredPath("ARCHIVE_BENCH_SOURCE_DIR");
  const outputPath = requiredPath("LEGACY_BENCH_OUTPUT");
  const runs = integerSetting("ARCHIVE_BENCH_RUNS", 5, 1, 100);
  const compressionLevel = integerSetting("ARCHIVE_BENCH_COMPRESSION", 6, 0, 9);
  const timeoutMs = integerSetting("ARCHIVE_BENCH_TASK_TIMEOUT_MS", 3_600_000, 1_000, 86_400_000);
  const manager = require(path.join(legacyDirectory, "utils", "archiveManager.js"));
  const source = await inspectDirectory(sourceDirectory);
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "msp-legacy-archive-"));
  const results = [];
  try {
    for (let run = 1; run <= runs; run += 1) {
      const runDirectory = path.join(temporaryDirectory, `run-${run}`);
      const archiveDirectory = path.join(runDirectory, "archive");
      const extractionDirectory = path.join(runDirectory, "extracted");
      await fsp.mkdir(archiveDirectory, { recursive: true });

      let finishSampling = rssSampler();
      let startedAt = performance.now();
      const zip = manager.startZipTask({
        entries: [{ sourcePath: sourceDirectory, destName: "dataset" }],
        outputDir: archiveDirectory,
        fileName: "benchmark.zip",
        cleanup: false,
        compressionLevel,
      });
      await waitForTask(manager, zip.taskId, timeoutMs);
      const zipElapsedMs = performance.now() - startedAt;
      const zipRss = finishSampling();
      const archiveBytes = (await fsp.stat(zip.outputPath)).size;

      finishSampling = rssSampler();
      startedAt = performance.now();
      const unzip = manager.startUnzipTask({
        archivePath: zip.outputPath,
        destination: extractionDirectory,
        overwrite: true,
      });
      await waitForTask(manager, unzip.taskId, timeoutMs);
      const unzipElapsedMs = performance.now() - startedAt;
      const unzipRss = finishSampling();
      const extracted = await inspectDirectory(extractionDirectory);
      if (extracted.bytes !== source.bytes || extracted.files !== source.files) {
        throw new Error(
          `Legacy ZIP validation failed: expected ${source.files}/${source.bytes}, received ${extracted.files}/${extracted.bytes}`,
        );
      }
      const result = {
        run,
        archiveBytes,
        zipElapsedMs,
        zipThroughputMiBPerSecond: source.bytes / 1048576 / (zipElapsedMs / 1000),
        zipRss,
        unzipElapsedMs,
        unzipThroughputMiBPerSecond: source.bytes / 1048576 / (unzipElapsedMs / 1000),
        unzipRss,
      };
      results.push(result);
      console.log(
        `Legacy archive ${run}/${runs}: ZIP ${result.zipThroughputMiBPerSecond.toFixed(2)} MiB/s; unzip ${result.unzipThroughputMiBPerSecond.toFixed(2)} MiB/s`,
      );
      await fsp.rm(runDirectory, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    configuration: { sourceDirectory, runs, compressionLevel },
    source,
    runs: results,
    summary: {
      zipThroughputMiBPerSecond: summarize(results.map((result) => result.zipThroughputMiBPerSecond)),
      unzipThroughputMiBPerSecond: summarize(results.map((result) => result.unzipThroughputMiBPerSecond)),
      zipPeakRssBytes: summarize(results.map((result) => result.zipRss.peakBytes)),
      unzipPeakRssBytes: summarize(results.map((result) => result.unzipRss.peakBytes)),
    },
  };
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

async function databaseBenchmark(legacyDirectory) {
  const outputPath = requiredPath("LEGACY_BENCH_OUTPUT");
  const rows = integerSetting("DATABASE_BENCH_ROWS", 10_000, 1, 60_000);
  const lookups = integerSetting("DATABASE_BENCH_LOOKUPS", 100_000, 1, 10_000_000);
  const runs = integerSetting("DATABASE_BENCH_RUNS", 5, 1, 100);
  const { db } = require(path.join(legacyDirectory, "db", "db.js"));
  db.run("DELETE FROM servers");
  const uuids = Array.from({ length: rows }, () => crypto.randomUUID());
  const populateStarted = performance.now();
  db.run("BEGIN");
  try {
    for (let index = 0; index < rows; index += 1) {
      db.run(
        "INSERT INTO servers (uuid, name, startupCommand, startupFlags, version, port, serverType) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuids[index], `Benchmark server ${index}`, "java -Xmx2G -Xms2G -jar server.jar nogui", "", "1.21.1", index + 1, "vanilla"],
      );
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
  const populateElapsedMs = performance.now() - populateStarted;
  const queryPlan = db.all("EXPLAIN QUERY PLAN SELECT * FROM servers WHERE uuid = ?", [uuids[0]])
    .map((step) => step.detail);
  for (let index = 0; index < Math.min(1_000, lookups); index += 1) {
    db.get("SELECT * FROM servers WHERE uuid = ?", uuids[index % rows]);
  }
  const rates = [];
  let state = 0x6d2b79f5;
  for (let run = 1; run <= runs; run += 1) {
    const startedAt = performance.now();
    for (let index = 0; index < lookups; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const row = db.get("SELECT * FROM servers WHERE uuid = ?", uuids[state % rows]);
      if (!row) throw new Error("Legacy UUID lookup returned no row");
    }
    const elapsedMs = performance.now() - startedAt;
    const rate = lookups / (elapsedMs / 1000);
    rates.push(rate);
    console.log(`Legacy database ${run}/${runs}: ${rate.toFixed(0)} UUID lookups/s`);
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    configuration: { rows, lookupsPerRun: lookups, runs },
    population: { elapsedMs: populateElapsedMs, rowsPerSecond: rows / (populateElapsedMs / 1000) },
    queryPlan,
    indexedUuidLookupsPerSecond: summarize(rates),
  };
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

async function main() {
  const mode = process.argv[2];
  const legacyDirectory = requiredPath("LEGACY_BENCH_SERVER_DIR");
  const repositoryLegacyDirectory = path.resolve(__dirname, "..", "..", "legacy-node-server");
  if (path.resolve(legacyDirectory) === repositoryLegacyDirectory) {
    throw new Error("Refusing to benchmark in the repository's archived legacy-node-server directory");
  }
  if (mode === "archive") await archiveBenchmark(legacyDirectory);
  else if (mode === "database") await databaseBenchmark(legacyDirectory);
  else throw new Error("Use legacy-worker.cjs archive or legacy-worker.cjs database");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
