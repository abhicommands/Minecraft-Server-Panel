import { lstat, mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import path from "node:path";
import {
  getTaskStatus,
  startUnzipTask,
  startZipTask,
  TASK_STATUS,
} from "../utils/archiveManager.ts";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_SIZE_MIB = 64;
const DEFAULT_FILE_COUNT = 128;
const DEFAULT_RUNS = 3;
const DEFAULT_COMPRESSION_LEVEL = 6;
const DEFAULT_PROGRESS_INTERVAL_MS = 500;
const DEFAULT_RSS_SAMPLE_INTERVAL_MS = 50;
const DEFAULT_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const FIXTURE_CHUNK_BYTES = MEBIBYTE;

type Dataset = "mixed" | "compressible" | "random";
type Phase = "zip" | "unzip";

interface SourceStats {
  bytes: number;
  files: number;
}

interface TaskSnapshot {
  status: string;
  progress: number;
  processedBytes: number;
  totalBytes: number;
  entriesProcessed: number;
  entriesTotal: number;
  message: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  archiveSize: number | null;
}

interface RssMeasurement {
  baselineBytes: number;
  peakBytes: number;
  increaseBytes: number;
  sampleIntervalMs: number;
}

interface PhaseResult {
  elapsedMs: number;
  throughputMiBPerSecond: number;
  rss: RssMeasurement;
}

interface BenchmarkRun {
  run: number;
  sourceBytes: number;
  sourceFiles: number;
  archiveBytes: number;
  archiveToSourceRatio: number | null;
  spaceSavingsRatio: number | null;
  zip: PhaseResult;
  unzip: PhaseResult;
  extractedBytes: number;
  extractedFiles: number;
}

interface MetricSummary {
  minimum: number;
  median: number;
  mean: number;
  maximum: number;
}

interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  runtime: {
    bunVersion: string;
    bunRevision: string;
    platform: string;
    architecture: string;
    osRelease: string;
    cpu: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
  };
  configuration: {
    sourceMode: "generated" | "existing";
    sourceDirectory: string;
    dataset: Dataset | null;
    requestedFixtureBytes: number | null;
    requestedFixtureFiles: number | null;
    runs: number;
    compressionLevel: number;
    progressIntervalMs: number;
    rssSampleIntervalMs: number;
    taskTimeoutMs: number;
    temporaryDirectory: string;
    keptTemporaryFiles: boolean;
  };
  source: SourceStats;
  runs: BenchmarkRun[];
  summary: {
    zipElapsedMs: MetricSummary;
    zipThroughputMiBPerSecond: MetricSummary;
    unzipElapsedMs: MetricSummary;
    unzipThroughputMiBPerSecond: MetricSummary;
    archiveToSourceRatio: MetricSummary | null;
    zipPeakRssBytes: MetricSummary;
    zipRssIncreaseBytes: MetricSummary;
    unzipPeakRssBytes: MetricSummary;
    unzipRssIncreaseBytes: MetricSummary;
  };
}

function readNumber(
  name: string,
  fallback: number,
  options: { minimum: number; maximum: number; integer?: boolean },
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < options.minimum ||
    value > options.maximum ||
    (options.integer === true && !Number.isInteger(value))
  ) {
    const kind = options.integer === true ? "integer" : "number";
    throw new Error(
      `${name} must be a ${kind} from ${options.minimum} through ${options.maximum}`,
    );
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be one of: 1, 0, true, false, yes, no, on, off`);
}

function readDataset(): Dataset {
  const raw = process.env.ARCHIVE_BENCH_DATASET?.trim().toLowerCase() || "mixed";
  if (raw === "mixed" || raw === "compressible" || raw === "random") return raw;
  throw new Error("ARCHIVE_BENCH_DATASET must be mixed, compressible, or random");
}

function taskNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function taskString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function taskSnapshot(record: Record<string, unknown>): TaskSnapshot {
  return {
    status: taskString(record, "status") || "unknown",
    progress: Math.max(0, Math.min(1, taskNumber(record, "progress"))),
    processedBytes: taskNumber(record, "processedBytes"),
    totalBytes: taskNumber(record, "totalBytes"),
    entriesProcessed: taskNumber(record, "entriesProcessed"),
    entriesTotal: taskNumber(record, "entriesTotal"),
    message: taskString(record, "message"),
    createdAt: taskString(record, "createdAt"),
    finishedAt: taskString(record, "finishedAt"),
    archiveSize:
      typeof record.archiveSize === "number" && Number.isFinite(record.archiveSize)
        ? record.archiveSize
        : null,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 100 ? 1 : 2)} ${unit}`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds >= 1_000
    ? `${(milliseconds / 1_000).toFixed(2)} s`
    : `${milliseconds.toFixed(0)} ms`;
}

function renderProgress(label: string, task: TaskSnapshot, final: boolean): void {
  const percent = (task.progress * 100).toFixed(1).padStart(5);
  const bytes = task.totalBytes
    ? `${formatBytes(task.processedBytes)} / ${formatBytes(task.totalBytes)}`
    : formatBytes(task.processedBytes);
  const entries = task.entriesTotal
    ? `${task.entriesProcessed}/${task.entriesTotal} entries`
    : `${task.entriesProcessed} entries`;
  const line = `${label.padEnd(12)} ${percent}%  ${bytes}  ${entries}`;
  if (process.stdout.isTTY) {
    process.stdout.write(`\u001b[2K\r${line}${final ? "\n" : ""}`);
  } else {
    console.log(line);
  }
}

async function waitForTask(
  taskId: string,
  label: string,
  progressIntervalMs: number,
  timeoutMs: number,
): Promise<TaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  let lastDisplayedProgress = -1;

  while (Date.now() <= deadline) {
    const record = getTaskStatus(taskId);
    if (!record) throw new Error(`${label} task ${taskId} disappeared`);
    const task = taskSnapshot(record);
    const terminal = task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.ERROR;
    const now = Date.now();
    if (terminal || now >= nextProgressAt || task.progress === 0 && lastDisplayedProgress < 0) {
      if (terminal || task.progress !== lastDisplayedProgress || now >= nextProgressAt) {
        renderProgress(label, task, terminal);
        lastDisplayedProgress = task.progress;
      }
      nextProgressAt = now + progressIntervalMs;
    }
    if (task.status === TASK_STATUS.COMPLETED) return task;
    if (task.status === TASK_STATUS.ERROR) {
      throw new Error(`${label} failed: ${task.message || "unknown archive error"}`);
    }
    await Bun.sleep(Math.min(100, Math.max(20, Math.floor(progressIntervalMs / 5))));
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
  throw new Error(`${label} exceeded ARCHIVE_BENCH_TASK_TIMEOUT_MS (${timeoutMs} ms)`);
}

function startRssSampler(sampleIntervalMs: number): {
  stop: () => RssMeasurement;
} {
  const baselineBytes = process.memoryUsage().rss;
  let peakBytes = baselineBytes;
  const sample = (): void => {
    peakBytes = Math.max(peakBytes, process.memoryUsage().rss);
  };
  const timer = setInterval(sample, sampleIntervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return {
        baselineBytes,
        peakBytes,
        increaseBytes: Math.max(0, peakBytes - baselineBytes),
        sampleIntervalMs,
      };
    },
  };
}

function taskElapsedMs(task: TaskSnapshot, measuredElapsedMs: number): number {
  if (task.createdAt && task.finishedAt) {
    const elapsed = Date.parse(task.finishedAt) - Date.parse(task.createdAt);
    if (Number.isFinite(elapsed) && elapsed > 0) return elapsed;
  }
  return Math.max(measuredElapsedMs, 0.001);
}

function throughputMiBPerSecond(bytes: number, elapsedMs: number): number {
  return bytes / MEBIBYTE / (elapsedMs / 1_000);
}

async function inspectDirectory(root: string): Promise<SourceStats> {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      const childStats = await lstat(childPath);
      if (childStats.isSymbolicLink()) {
        throw new Error(`Source contains a symbolic link, which production ZIP rejects: ${childPath}`);
      }
      if (childStats.isDirectory()) pending.push(childPath);
      else if (childStats.isFile()) {
        files += 1;
        bytes += childStats.size;
      }
    }
  }
  return { bytes, files };
}

function deterministicRandomBlock(): Uint8Array {
  const block = new Uint8Array(FIXTURE_CHUNK_BYTES);
  let state = 0x6d2b79f5;
  for (let index = 0; index < block.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    block[index] = state & 0xff;
  }
  return block;
}

function compressibleBlock(): Uint8Array {
  const template = new TextEncoder().encode(
    '{"timestamp":"2026-01-01T00:00:00.000Z","level":"INFO","message":"Minecraft panel archive benchmark fixture"}\n',
  );
  const block = new Uint8Array(FIXTURE_CHUNK_BYTES);
  for (let offset = 0; offset < block.length; offset += template.length) {
    block.set(template.subarray(0, Math.min(template.length, block.length - offset)), offset);
  }
  return block;
}

async function writeFixtureFile(
  filePath: string,
  size: number,
  content: Uint8Array,
): Promise<void> {
  const file = await open(filePath, "wx", 0o600);
  try {
    let position = 0;
    while (position < size) {
      const length = Math.min(content.length, size - position);
      let offset = 0;
      while (offset < length) {
        const result = await file.write(content, offset, length - offset, position + offset);
        if (result.bytesWritten === 0) throw new Error(`Could not write fixture file: ${filePath}`);
        offset += result.bytesWritten;
      }
      position += length;
    }
  } finally {
    await file.close();
  }
}

async function createFixture(
  root: string,
  totalBytes: number,
  fileCount: number,
  dataset: Dataset,
): Promise<void> {
  if (fileCount > totalBytes) {
    throw new Error("ARCHIVE_BENCH_FILE_COUNT cannot exceed the generated fixture byte count");
  }
  await mkdir(root, { recursive: true });
  const random = deterministicRandomBlock();
  const compressible = compressibleBlock();
  const baseSize = Math.floor(totalBytes / fileCount);
  const remainder = totalBytes % fileCount;

  for (let index = 0; index < fileCount; index += 1) {
    const directory = path.join(root, `group-${String(index % 16).padStart(2, "0")}`);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `fixture-${String(index).padStart(6, "0")}.dat`);
    const size = baseSize + (index < remainder ? 1 : 0);
    const useRandom = dataset === "random" || dataset === "mixed" && index % 2 === 1;
    await writeFixtureFile(filePath, size, useRandom ? random : compressible);
  }
}

async function runZip(
  sourceDirectory: string,
  outputDirectory: string,
  compressionLevel: number,
  sourceBytes: number,
  run: number,
  progressIntervalMs: number,
  rssSampleIntervalMs: number,
  timeoutMs: number,
): Promise<{ result: PhaseResult; archivePath: string; archiveBytes: number }> {
  const fileName = "benchmark.zip";
  const sampler = startRssSampler(rssSampleIntervalMs);
  const startedAt = performance.now();
  let rss: RssMeasurement;
  try {
    const task = startZipTask({
      entries: [{ sourcePath: sourceDirectory, destName: "dataset" }],
      outputDir: outputDirectory,
      fileName,
      cleanup: false,
      compressionLevel,
      meta: { benchmark: true, run },
    });
    const finalTask = await waitForTask(
      task.taskId,
      `run ${run} zip`,
      progressIntervalMs,
      timeoutMs,
    );
    const measuredElapsedMs = performance.now() - startedAt;
    rss = sampler.stop();
    const archivePath = task.outputPath;
    const archiveBytes = finalTask.archiveSize ?? (await stat(archivePath)).size;
    const elapsedMs = taskElapsedMs(finalTask, measuredElapsedMs);
    return {
      result: {
        elapsedMs,
        throughputMiBPerSecond: throughputMiBPerSecond(sourceBytes, elapsedMs),
        rss,
      },
      archivePath,
      archiveBytes,
    };
  } catch (error) {
    rss = sampler.stop();
    throw error;
  }
}

async function runUnzip(
  archivePath: string,
  destination: string,
  sourceBytes: number,
  run: number,
  progressIntervalMs: number,
  rssSampleIntervalMs: number,
  timeoutMs: number,
): Promise<PhaseResult> {
  const sampler = startRssSampler(rssSampleIntervalMs);
  const startedAt = performance.now();
  try {
    const task = startUnzipTask({
      archivePath,
      destination,
      overwrite: true,
      cleanupDestinationOnError: true,
      meta: { benchmark: true, run },
    });
    const finalTask = await waitForTask(
      task.taskId,
      `run ${run} unzip`,
      progressIntervalMs,
      timeoutMs,
    );
    const measuredElapsedMs = performance.now() - startedAt;
    const rss = sampler.stop();
    const elapsedMs = taskElapsedMs(finalTask, measuredElapsedMs);
    return {
      elapsedMs,
      throughputMiBPerSecond: throughputMiBPerSecond(sourceBytes, elapsedMs),
      rss,
    };
  } catch (error) {
    sampler.stop();
    throw error;
  }
}

function metricSummary(values: number[]): MetricSummary {
  if (!values.length) throw new Error("Cannot summarize an empty benchmark metric");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
  return {
    minimum: sorted[0] ?? 0,
    median,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    maximum: sorted.at(-1) ?? 0,
  };
}

function summarize(runs: BenchmarkRun[]): BenchmarkReport["summary"] {
  const ratios = runs
    .map((run) => run.archiveToSourceRatio)
    .filter((ratio): ratio is number => ratio !== null);
  return {
    zipElapsedMs: metricSummary(runs.map((run) => run.zip.elapsedMs)),
    zipThroughputMiBPerSecond: metricSummary(
      runs.map((run) => run.zip.throughputMiBPerSecond),
    ),
    unzipElapsedMs: metricSummary(runs.map((run) => run.unzip.elapsedMs)),
    unzipThroughputMiBPerSecond: metricSummary(
      runs.map((run) => run.unzip.throughputMiBPerSecond),
    ),
    archiveToSourceRatio: ratios.length ? metricSummary(ratios) : null,
    zipPeakRssBytes: metricSummary(runs.map((run) => run.zip.rss.peakBytes)),
    zipRssIncreaseBytes: metricSummary(runs.map((run) => run.zip.rss.increaseBytes)),
    unzipPeakRssBytes: metricSummary(runs.map((run) => run.unzip.rss.peakBytes)),
    unzipRssIncreaseBytes: metricSummary(runs.map((run) => run.unzip.rss.increaseBytes)),
  };
}

function decimal(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function markdownReport(report: BenchmarkReport): string {
  const lines = [
    "# Archive benchmark",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Runtime: Bun ${report.runtime.bunVersion} (${report.runtime.bunRevision}), ${report.runtime.platform} ${report.runtime.architecture}`,
    "",
    `CPU: ${report.runtime.cpu} (${report.runtime.logicalCpuCount} logical CPUs)` ,
    "",
    `Source: \`${report.configuration.sourceDirectory.replace(/`/g, "\\`")}\` — ${formatBytes(report.source.bytes)}, ${report.source.files} files`,
    "",
    `Compression level: ${report.configuration.compressionLevel}; runs: ${report.configuration.runs}`,
    "",
    "| Run | ZIP time | ZIP MiB/s | Archive size | Archive/source | ZIP peak RSS | ZIP RSS increase | Unzip time | Unzip MiB/s | Unzip peak RSS | Unzip RSS increase |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const run of report.runs) {
    lines.push(
      `| ${run.run} | ${formatDuration(run.zip.elapsedMs)} | ${decimal(run.zip.throughputMiBPerSecond)} | ${formatBytes(run.archiveBytes)} | ${run.archiveToSourceRatio === null ? "n/a" : `${decimal(run.archiveToSourceRatio * 100)}%`} | ${formatBytes(run.zip.rss.peakBytes)} | ${formatBytes(run.zip.rss.increaseBytes)} | ${formatDuration(run.unzip.elapsedMs)} | ${decimal(run.unzip.throughputMiBPerSecond)} | ${formatBytes(run.unzip.rss.peakBytes)} | ${formatBytes(run.unzip.rss.increaseBytes)} |`,
    );
  }
  lines.push(
    "",
    "## Summary",
    "",
    `- Median ZIP throughput: ${decimal(report.summary.zipThroughputMiBPerSecond.median)} MiB/s`,
    `- Median unzip throughput: ${decimal(report.summary.unzipThroughputMiBPerSecond.median)} MiB/s`,
    `- Median archive/source ratio: ${report.summary.archiveToSourceRatio === null ? "n/a" : `${decimal(report.summary.archiveToSourceRatio.median * 100)}%`}`,
    `- Maximum sampled ZIP RSS: ${formatBytes(report.summary.zipPeakRssBytes.maximum)}`,
    `- Maximum sampled unzip RSS: ${formatBytes(report.summary.unzipPeakRssBytes.maximum)}`,
    "",
    `RSS was sampled every ${report.configuration.rssSampleIntervalMs} ms and describes the complete benchmark process, not only the compression library.`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function writeReport(report: BenchmarkReport, requestedPath: string): Promise<string> {
  const outputPath = path.resolve(requestedPath);
  const extension = path.extname(outputPath).toLowerCase();
  if (extension !== ".json" && extension !== ".md") {
    throw new Error("ARCHIVE_BENCH_OUTPUT must end in .json or .md");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const content = extension === ".json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : markdownReport(report);
  await Bun.write(outputPath, content);
  return outputPath;
}

function printHelp(): void {
  console.log(`Archive benchmark (uses production startZipTask/startUnzipTask)

  bun run benchmark:archive

Environment controls:
  ARCHIVE_BENCH_SOURCE_DIR       Existing source directory; otherwise generate a fixture
  ARCHIVE_BENCH_SIZE_MIB         Generated size in MiB (default: ${DEFAULT_SIZE_MIB})
  ARCHIVE_BENCH_FILE_COUNT       Generated file count (default: ${DEFAULT_FILE_COUNT})
  ARCHIVE_BENCH_DATASET          mixed, compressible, or random (default: mixed)
  ARCHIVE_BENCH_RUNS             Timed ZIP/unzip repetitions (default: ${DEFAULT_RUNS})
  ARCHIVE_BENCH_COMPRESSION      ZIP compression level 0-9 (default: ${DEFAULT_COMPRESSION_LEVEL})
  ARCHIVE_BENCH_OUTPUT           Optional .json or .md result path
  ARCHIVE_BENCH_KEEP             Keep the temporary work tree when true (default: false)
  ARCHIVE_BENCH_PROGRESS_MS      Progress print interval (default: ${DEFAULT_PROGRESS_INTERVAL_MS})
  ARCHIVE_BENCH_RSS_SAMPLE_MS    Process RSS sample interval (default: ${DEFAULT_RSS_SAMPLE_INTERVAL_MS})
  ARCHIVE_BENCH_TASK_TIMEOUT_MS  Per-phase timeout (default: ${DEFAULT_TASK_TIMEOUT_MS})`);
}

async function main(): Promise<void> {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    printHelp();
    return;
  }

  const existingSourceRaw = process.env.ARCHIVE_BENCH_SOURCE_DIR?.trim() || null;
  const dataset = readDataset();
  const sizeMiB = readNumber("ARCHIVE_BENCH_SIZE_MIB", DEFAULT_SIZE_MIB, {
    minimum: 0.001,
    maximum: 1024 * 1024,
  });
  const requestedFixtureBytes = Math.floor(sizeMiB * MEBIBYTE);
  const requestedFixtureFiles = readNumber("ARCHIVE_BENCH_FILE_COUNT", DEFAULT_FILE_COUNT, {
    minimum: 1,
    maximum: 100_000,
    integer: true,
  });
  const runs = readNumber("ARCHIVE_BENCH_RUNS", DEFAULT_RUNS, {
    minimum: 1,
    maximum: 100,
    integer: true,
  });
  const compressionLevel = readNumber(
    "ARCHIVE_BENCH_COMPRESSION",
    DEFAULT_COMPRESSION_LEVEL,
    { minimum: 0, maximum: 9, integer: true },
  );
  const progressIntervalMs = readNumber(
    "ARCHIVE_BENCH_PROGRESS_MS",
    DEFAULT_PROGRESS_INTERVAL_MS,
    { minimum: 50, maximum: 60_000, integer: true },
  );
  const rssSampleIntervalMs = readNumber(
    "ARCHIVE_BENCH_RSS_SAMPLE_MS",
    DEFAULT_RSS_SAMPLE_INTERVAL_MS,
    { minimum: 10, maximum: 60_000, integer: true },
  );
  const taskTimeoutMs = readNumber(
    "ARCHIVE_BENCH_TASK_TIMEOUT_MS",
    DEFAULT_TASK_TIMEOUT_MS,
    { minimum: 1_000, maximum: 24 * 60 * 60 * 1_000, integer: true },
  );
  const keep = readBoolean("ARCHIVE_BENCH_KEEP", false);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "msp-archive-benchmark-"));
  let sourceDirectory = "";

  try {
    if (existingSourceRaw) {
      sourceDirectory = path.resolve(existingSourceRaw);
      const sourcePathStats = await stat(sourceDirectory);
      if (!sourcePathStats.isDirectory()) {
        throw new Error("ARCHIVE_BENCH_SOURCE_DIR must identify a directory");
      }
    } else {
      sourceDirectory = path.join(temporaryDirectory, "fixture");
      console.log(
        `Creating ${formatBytes(requestedFixtureBytes)} ${dataset} fixture with ${requestedFixtureFiles} files...`,
      );
      await createFixture(sourceDirectory, requestedFixtureBytes, requestedFixtureFiles, dataset);
    }

    const source = await inspectDirectory(sourceDirectory);
    if (!source.files) throw new Error("Benchmark source directory contains no files");
    console.log(
      `Benchmark source: ${sourceDirectory} (${formatBytes(source.bytes)}, ${source.files} files)`,
    );
    console.log(`Compression level ${compressionLevel}; ${runs} run${runs === 1 ? "" : "s"}`);

    const benchmarkRuns: BenchmarkRun[] = [];
    for (let run = 1; run <= runs; run += 1) {
      const runDirectory = path.join(temporaryDirectory, `run-${run}`);
      const archiveDirectory = path.join(runDirectory, "archive");
      const extractionDirectory = path.join(runDirectory, "extracted");
      await mkdir(archiveDirectory, { recursive: true });
      console.log(`\nRun ${run}/${runs}`);

      const zip = await runZip(
        sourceDirectory,
        archiveDirectory,
        compressionLevel,
        source.bytes,
        run,
        progressIntervalMs,
        rssSampleIntervalMs,
        taskTimeoutMs,
      );
      const unzip = await runUnzip(
        zip.archivePath,
        extractionDirectory,
        source.bytes,
        run,
        progressIntervalMs,
        rssSampleIntervalMs,
        taskTimeoutMs,
      );
      const extracted = await inspectDirectory(extractionDirectory);
      if (extracted.bytes !== source.bytes || extracted.files !== source.files) {
        throw new Error(
          `Round-trip validation failed: expected ${source.files} files/${source.bytes} bytes, ` +
          `received ${extracted.files} files/${extracted.bytes} bytes`,
        );
      }
      const ratio = source.bytes ? zip.archiveBytes / source.bytes : null;
      benchmarkRuns.push({
        run,
        sourceBytes: source.bytes,
        sourceFiles: source.files,
        archiveBytes: zip.archiveBytes,
        archiveToSourceRatio: ratio,
        spaceSavingsRatio: ratio === null ? null : 1 - ratio,
        zip: zip.result,
        unzip,
        extractedBytes: extracted.bytes,
        extractedFiles: extracted.files,
      });
      console.log(
        `ZIP ${decimal(zip.result.throughputMiBPerSecond)} MiB/s, ` +
        `unzip ${decimal(unzip.throughputMiBPerSecond)} MiB/s, ` +
        `archive ${formatBytes(zip.archiveBytes)} (${ratio === null ? "n/a" : `${decimal(ratio * 100)}%`})`,
      );
      if (!keep) await rm(runDirectory, { recursive: true, force: true });
    }

    const firstCpu = cpus()[0];
    const report: BenchmarkReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        cpu: firstCpu?.model || "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      configuration: {
        sourceMode: existingSourceRaw ? "existing" : "generated",
        sourceDirectory,
        dataset: existingSourceRaw ? null : dataset,
        requestedFixtureBytes: existingSourceRaw ? null : requestedFixtureBytes,
        requestedFixtureFiles: existingSourceRaw ? null : requestedFixtureFiles,
        runs,
        compressionLevel,
        progressIntervalMs,
        rssSampleIntervalMs,
        taskTimeoutMs,
        temporaryDirectory,
        keptTemporaryFiles: keep,
      },
      source,
      runs: benchmarkRuns,
      summary: summarize(benchmarkRuns),
    };

    console.log("\nSummary");
    console.log(
      `ZIP median ${decimal(report.summary.zipThroughputMiBPerSecond.median)} MiB/s ` +
      `(range ${decimal(report.summary.zipThroughputMiBPerSecond.minimum)}-${decimal(report.summary.zipThroughputMiBPerSecond.maximum)})`,
    );
    console.log(
      `Unzip median ${decimal(report.summary.unzipThroughputMiBPerSecond.median)} MiB/s ` +
      `(range ${decimal(report.summary.unzipThroughputMiBPerSecond.minimum)}-${decimal(report.summary.unzipThroughputMiBPerSecond.maximum)})`,
    );
    console.log(
      `Peak sampled RSS: ZIP ${formatBytes(report.summary.zipPeakRssBytes.maximum)}, ` +
      `unzip ${formatBytes(report.summary.unzipPeakRssBytes.maximum)}`,
    );

    const outputRaw = process.env.ARCHIVE_BENCH_OUTPUT?.trim();
    if (outputRaw) {
      const outputPath = await writeReport(report, outputRaw);
      console.log(`Report written to ${outputPath}`);
    }
    if (keep) console.log(`Temporary files retained at ${temporaryDirectory}`);
  } finally {
    if (!keep) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
