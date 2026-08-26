import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import {
  BlobReader,
  ZipReader,
  ZipWriter,
  configure,
} from "@zip.js/zip.js/index-native.js";
import { attachmentHeaders, HttpError } from "./http.ts";
import { normalizeRelativePath, resolveSafePath } from "./pathSafety.ts";

configure({ useWebWorkers: false });

export const TASK_TYPES = { ZIP: "zip", UNZIP: "unzip" } as const;
export const TASK_STATUS = {
  QUEUED: "queued",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

type TaskType = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];
type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

interface ArchiveTask {
  id: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  totalBytes: number;
  processedBytes: number;
  entriesProcessed: number;
  entriesTotal: number;
  createdAt: string;
  updatedAt: string;
  message: string | null;
  finishedAt?: string;
  archiveSize?: number;
  fileName?: string;
  outputPath?: string;
  cleanup?: boolean;
  archivePath?: string;
  destination?: string;
  overwrite?: boolean;
  onComplete: (() => Promise<void>) | undefined;
  cleanupDestinationOnError: boolean | undefined;
  meta: Record<string, unknown>;
}

export interface ZipSourceEntry {
  sourcePath: string;
  destName?: string;
}

interface ExpandedEntry {
  sourcePath?: string;
  archiveName: string;
  size: number;
  directory: boolean;
}

const tasks = new Map<string, ArchiveTask>();
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024 * 1024;
const FINISHED_TASK_RETENTION_MS = 60 * 60 * 1_000;

setInterval(() => {
  const cutoff = Date.now() - FINISHED_TASK_RETENTION_MS;
  for (const [taskId, task] of tasks) {
    if (task.finishedAt && Date.parse(task.finishedAt) < cutoff) tasks.delete(taskId);
  }
}, 10 * 60 * 1_000).unref();

const timestamp = (): string => new Date().toISOString();

function createTask(type: TaskType, initial: Partial<ArchiveTask> = {}): ArchiveTask {
  const now = timestamp();
  const task: ArchiveTask = {
    id: crypto.randomUUID(),
    type,
    status: TASK_STATUS.QUEUED,
    progress: 0,
    totalBytes: 0,
    processedBytes: 0,
    entriesProcessed: 0,
    entriesTotal: 0,
    createdAt: now,
    updatedAt: now,
    message: null,
    meta: {},
    onComplete: undefined,
    cleanupDestinationOnError: undefined,
    ...initial,
  };
  tasks.set(task.id, task);
  return task;
}

function updateTask(task: ArchiveTask, updates: Partial<ArchiveTask>): void {
  Object.assign(task, updates, { updatedAt: timestamp() });
}

function archiveName(value: string): string {
  const portable = value.replace(/\\/g, "/");
  if (portable.startsWith("/") || /^[a-z]:\//i.test(portable) || portable.includes("\0")) {
    throw new HttpError(400, "Invalid archive path");
  }
  const normalized = normalizeRelativePath(portable);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new HttpError(400, "Invalid archive path");
  }
  return normalized;
}

async function expandSource(
  sourcePath: string,
  destinationName: string,
  result: ExpandedEntry[],
): Promise<void> {
  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isSymbolicLink()) throw new HttpError(400, "Symbolic links cannot be archived");
  if (sourceStats.isFile()) {
    result.push({
      sourcePath,
      archiveName: archiveName(destinationName),
      size: sourceStats.size,
      directory: false,
    });
    return;
  }
  if (!sourceStats.isDirectory()) return;

  const children = await readdir(sourcePath, { withFileTypes: true });
  const normalizedDirectory = `${archiveName(destinationName).replace(/\/$/, "")}/`;
  if (children.length === 0) {
    result.push({ archiveName: normalizedDirectory, size: 0, directory: true });
  }
  for (const child of children) {
    await expandSource(
      path.join(sourcePath, child.name),
      `${normalizedDirectory}${child.name}`,
      result,
    );
    if (result.length > MAX_ARCHIVE_ENTRIES) throw new HttpError(413, "Archive has too many entries");
  }
}

async function createZip(task: ArchiveTask, entries: ZipSourceEntry[], compressionLevel: number): Promise<void> {
  const expanded: ExpandedEntry[] = [];
  for (const entry of entries) {
    await expandSource(
      entry.sourcePath,
      entry.destName === undefined ? path.basename(entry.sourcePath) : entry.destName,
      expanded,
    );
  }
  const totalBytes = expanded.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new HttpError(413, "Archive contents are too large");
  updateTask(task, {
    status: TASK_STATUS.IN_PROGRESS,
    totalBytes,
    entriesTotal: expanded.length,
  });

  const outputPath = task.outputPath;
  if (!outputPath) throw new Error("Missing archive output path");
  const temporary = `${outputPath}.part`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  const nodeStream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const writable = Writable.toWeb(nodeStream) as WritableStream<Uint8Array>;
  const writer = new ZipWriter(writable, {
    level: Math.max(0, Math.min(9, compressionLevel)),
    zip64: true,
    bufferedWrite: false,
  });
  let processedBytes = 0;
  let entriesProcessed = 0;

  try {
    for (const entry of expanded) {
      if (entry.directory) {
        await writer.add(entry.archiveName);
      } else if (entry.sourcePath) {
        const baseProcessed = processedBytes;
        await writer.add(entry.archiveName, Bun.file(entry.sourcePath).stream(), {
          onprogress: (index) => {
            updateTask(task, {
              processedBytes: Math.min(baseProcessed + index, totalBytes),
              progress: totalBytes ? Math.min((baseProcessed + index) / totalBytes, 1) : 0,
            });
          },
        });
        processedBytes += entry.size;
      }
      entriesProcessed += 1;
      updateTask(task, {
        processedBytes,
        entriesProcessed,
        progress: totalBytes ? Math.min(processedBytes / totalBytes, 1) : entriesProcessed / expanded.length,
      });
    }
    await writer.close();
    await rename(temporary, outputPath);
    const outputStats = await stat(outputPath);
    updateTask(task, {
      status: TASK_STATUS.COMPLETED,
      progress: 1,
      processedBytes: totalBytes,
      entriesProcessed: expanded.length,
      archiveSize: outputStats.size,
      finishedAt: timestamp(),
    });
  } catch (error) {
    nodeStream.destroy();
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function startZipTask(options: {
  entries: ZipSourceEntry[];
  outputDir: string;
  fileName?: string;
  cleanup?: boolean;
  meta?: Record<string, unknown>;
  compressionLevel?: number;
}): { taskId: string; fileName: string; status: TaskStatus; outputPath: string } {
  if (!options.entries.length) throw new HttpError(400, "No entries provided for zip task");
  const fileName = options.fileName || `archive-${Date.now()}.zip`;
  const outputPath = path.join(options.outputDir, fileName);
  const task = createTask(TASK_TYPES.ZIP, {
    fileName,
    outputPath,
    cleanup: options.cleanup ?? true,
    meta: options.meta || {},
  });
  queueMicrotask(async () => {
    try {
      // Level 6 keeps zip.js on Bun's native CompressionStream fast path.
      await createZip(task, options.entries, options.compressionLevel ?? 6);
    } catch (error) {
      console.error("Zip task failed:", error);
      updateTask(task, {
        status: TASK_STATUS.ERROR,
        message: error instanceof Error ? error.message : "Archive failed",
        finishedAt: timestamp(),
      });
      await unlink(outputPath).catch(() => {});
    }
  });
  return { taskId: task.id, fileName, status: task.status, outputPath };
}

export async function registerExistingZipTask(options: {
  sourcePath: string;
  fileName?: string;
  meta?: Record<string, unknown>;
}): Promise<{ taskId: string; fileName: string; status: TaskStatus; outputPath: string }> {
  const sourceStats = await stat(options.sourcePath);
  if (!sourceStats.isFile()) throw new HttpError(400, "Selected path is not a file");
  const fileName = options.fileName || path.basename(options.sourcePath);
  const task = createTask(TASK_TYPES.ZIP, {
    fileName,
    outputPath: options.sourcePath,
    cleanup: false,
    meta: options.meta || {},
  });
  updateTask(task, {
    status: TASK_STATUS.COMPLETED,
    progress: 1,
    totalBytes: sourceStats.size,
    processedBytes: sourceStats.size,
    entriesTotal: 1,
    entriesProcessed: 1,
    archiveSize: sourceStats.size,
    finishedAt: timestamp(),
  });
  return { taskId: task.id, fileName, status: task.status, outputPath: options.sourcePath };
}

async function extractZip(task: ArchiveTask): Promise<void> {
  if (!task.archivePath || !task.destination) throw new Error("Missing extraction paths");
  await mkdir(task.destination, { recursive: true });
  const destinationBase = path.basename(task.destination).toLowerCase();
  const reader = new ZipReader(new BlobReader(Bun.file(task.archivePath)), {
    checkAmbiguity: true,
    checkSignature: true,
    checkOverlappingEntry: true,
    strictness: "strict",
  });
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new HttpError(413, "Archive has too many entries");
    const totalBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new HttpError(413, "Archive contents are too large");
    updateTask(task, {
      status: TASK_STATUS.IN_PROGRESS,
      totalBytes,
      entriesTotal: entries.length,
    });

    const destinations = new Set<string>();
    let processedBytes = 0;
    let entriesProcessed = 0;
    for (const entry of entries) {
      if (entry.encrypted) throw new HttpError(400, "Encrypted archives are not supported");
      if (entry.unixMode && (entry.unixMode & 0o170000) === 0o120000) {
        throw new HttpError(400, "Archive symbolic links are not supported");
      }
      const normalized = entry.filename.replace(/\\/g, "/");
      if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.includes("\0")) {
        throw new HttpError(400, "Archive contains an absolute path");
      }
      let segments = normalized.split("/").filter(Boolean);
      if (segments[0]?.toLowerCase() === destinationBase) segments = segments.slice(1);
      if (!segments.length) {
        entriesProcessed += 1;
        continue;
      }
      const relativeName = archiveName(segments.join("/"));
      const destination = await resolveSafePath(task.destination, relativeName);
      const collisionKey = process.platform === "darwin" ? destination.toLowerCase() : destination;
      if (destinations.has(collisionKey)) throw new HttpError(400, "Archive contains duplicate paths");
      destinations.add(collisionKey);

      if (entry.directory) {
        await mkdir(destination, { recursive: true });
      } else {
        await mkdir(path.dirname(destination), { recursive: true });
        if (!task.overwrite) {
          try {
            await lstat(destination);
            throw new HttpError(409, "Archive entry already exists");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const temporaryDestination = `${destination}.extract-${crypto.randomUUID()}.part`;
        const output = createWriteStream(temporaryDestination, {
          flags: "wx",
          mode: entry.unixMode ? entry.unixMode & 0o777 : 0o600,
        });
        try {
          await entry.getData(Writable.toWeb(output) as WritableStream<Uint8Array>, {
            checkSignature: true,
            onprogress: (index) => {
              updateTask(task, {
                processedBytes: processedBytes + index,
                progress: totalBytes ? Math.min((processedBytes + index) / totalBytes, 1) : 0,
              });
            },
          });
          await rename(temporaryDestination, destination);
        } catch (error) {
          output.destroy();
          await unlink(temporaryDestination).catch(() => {});
          throw error;
        }
        processedBytes += entry.uncompressedSize;
      }
      entriesProcessed += 1;
      updateTask(task, {
        processedBytes,
        entriesProcessed,
        progress: totalBytes ? Math.min(processedBytes / totalBytes, 1) : entriesProcessed / entries.length,
      });
    }
    await task.onComplete?.();
    updateTask(task, {
      status: TASK_STATUS.COMPLETED,
      progress: 1,
      processedBytes,
      entriesProcessed,
      finishedAt: timestamp(),
    });
  } finally {
    await reader.close();
  }
}

export function startUnzipTask(options: {
  archivePath: string;
  destination: string;
  overwrite?: boolean;
  onComplete?: () => Promise<void>;
  cleanupDestinationOnError?: boolean;
  meta?: Record<string, unknown>;
}): { taskId: string; status: TaskStatus } {
  const task = createTask(TASK_TYPES.UNZIP, {
    archivePath: options.archivePath,
    destination: options.destination,
    overwrite: options.overwrite ?? true,
    onComplete: options.onComplete,
    cleanupDestinationOnError: options.cleanupDestinationOnError,
    meta: options.meta || {},
  });
  queueMicrotask(async () => {
    try {
      await extractZip(task);
    } catch (error) {
      console.warn(`Unzip task failed: ${error instanceof Error ? error.message : "Extraction failed"}`);
      if (task.cleanupDestinationOnError && task.destination) {
        await rm(task.destination, { recursive: true, force: true }).catch(() => {});
      }
      updateTask(task, {
        status: TASK_STATUS.ERROR,
        message: error instanceof Error ? error.message : "Extraction failed",
        finishedAt: timestamp(),
      });
    }
  });
  return { taskId: task.id, status: task.status };
}

export function getTaskStatus(taskId: string): Record<string, unknown> | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const {
    cleanup: _cleanup,
    outputPath: _outputPath,
    archivePath: _archivePath,
    destination: _destination,
    overwrite: _overwrite,
    onComplete: _onComplete,
    cleanupDestinationOnError: _cleanupDestinationOnError,
    ...publicTask
  } = task;
  return publicTask;
}

export function getTask(taskId: string): ArchiveTask | null {
  return tasks.get(taskId) || null;
}

export function zipDownloadResponse(taskId: string, removeOnComplete = true): Response {
  const task = tasks.get(taskId);
  if (!task || task.type !== TASK_TYPES.ZIP) throw new HttpError(404, "Task not found");
  if (task.status !== TASK_STATUS.COMPLETED || !task.outputPath || !task.fileName) {
    throw new HttpError(409, "Archive not ready");
  }
  const source = Bun.file(task.outputPath);
  const reader = source.stream().getReader();
  const cleanup = async (): Promise<void> => {
    if (removeOnComplete && task.cleanup !== false && task.outputPath) {
      await unlink(task.outputPath).catch(() => {});
    }
    tasks.delete(taskId);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await cleanup();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await cleanup();
      }
    },
    async cancel() {
      await reader.cancel();
      await cleanup();
    },
  });
  return new Response(stream, {
    headers: attachmentHeaders(task.fileName, "application/zip"),
  });
}
