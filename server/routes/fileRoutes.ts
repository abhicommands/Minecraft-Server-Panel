import Busboy from "@fastify/busboy";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { AppConfig, BunRouteRequest, RouteHandler, RouteTable, ServerRecord } from "../types.ts";
import { PanelDatabase } from "../db/db.ts";
import { AuthService } from "./auth.ts";
import {
  getTask,
  getTaskStatus,
  registerExistingZipTask,
  startUnzipTask,
  startZipTask,
  TASK_TYPES,
  zipDownloadResponse,
} from "../utils/archiveManager.ts";
import {
  attachmentHeaders,
  HttpError,
  jsonResponse,
  query,
  readJson,
  route,
  textResponse,
} from "../utils/http.ts";
import {
  assertRegularFile,
  decodePath,
  normalizeRelativePath,
  resolveSafePath,
  validateLeafName,
} from "../utils/pathSafety.ts";
import { TerminalManager } from "../utils/terminal.ts";
import { serverLayout } from "../utils/serverLayout.ts";

interface FileListBody {
  files?: unknown;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new HttpError(400, "Invalid file list");
  }
  if (value.some((item) => !normalizeRelativePath(item))) {
    throw new HttpError(400, "Invalid file list");
  }
  return value;
}

async function listDirectory(basePath: string, relativePath = ""): Promise<unknown[]> {
  const absolutePath = await resolveSafePath(basePath, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file",
    path: normalizeRelativePath(path.join(relativePath, entry.name)),
  }));
}

function requestedDirectory(request: BunRouteRequest): string {
  const queryPath = query(request, "path");
  if (queryPath) return queryPath;
  const pathname = new URL(request.url).pathname;
  const marker = `/servers/${request.params.id || ""}/files/`;
  const markerIndex = pathname.indexOf(marker);
  return markerIndex === -1 ? "" : decodePath(pathname.slice(markerIndex + marker.length));
}

async function uploadFiles(
  request: BunRouteRequest,
  destination: string,
  maximumBytes: number,
): Promise<void> {
  if (!request.body) throw new HttpError(400, "Missing upload body");
  const contentType = request.headers.get("content-type");
  if (!contentType) throw new HttpError(400, "Missing multipart content type");
  const headers = { "content-type": contentType };
  const temporaryPaths: string[] = [];
  const pending: Promise<void>[] = [];
  let totalBytes = 0;
  let uploadedFiles = 0;
  let failure: Error | null = null;

  const parser = Busboy({
    headers,
    preservePath: false,
    limits: {
      fileSize: maximumBytes,
      files: 1_000,
      fields: 0,
      parts: 1_000,
      headerPairs: 100,
    },
  });

  parser.on("file", (fieldName, stream, rawFileName) => {
    if (failure || fieldName !== "files") {
      stream.resume();
      return;
    }
    let fileName: string;
    try {
      fileName = validateLeafName(rawFileName);
    } catch (error) {
      failure = error as Error;
      stream.resume();
      return;
    }
    uploadedFiles += 1;
    const target = path.join(destination, fileName);
    const temporary = path.join(destination, `.upload-${crypto.randomUUID()}.part`);
    temporaryPaths.push(temporary);
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    stream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes && !failure) {
        failure = new HttpError(413, "Upload is too large");
        stream.destroy(failure);
      }
    });
    stream.on("limit", () => {
      failure ||= new HttpError(413, "Upload is too large");
    });
    pending.push(
      pipeline(stream, output).then(async () => {
        if (stream.truncated || failure) throw failure || new HttpError(413, "Upload is too large");
        await rename(temporary, target);
        temporaryPaths.splice(temporaryPaths.indexOf(temporary), 1);
      }),
    );
  });

  const input = Readable.fromWeb(request.body as never);
  const parsing = new Promise<void>((resolve, reject) => {
    parser.once("error", reject);
    input.once("error", reject);
    parser.once("finish", resolve);
    request.signal.addEventListener(
      "abort",
      () => {
        const error = new Error("Upload aborted");
        input.destroy(error);
        parser.destroy(error);
      },
      { once: true },
    );
    try {
      input.pipe(parser);
    } catch (error) {
      reject(error);
    }
  });

  try {
    await parsing;
    await Promise.all(pending);
    if (failure) throw failure;
    if (!uploadedFiles) throw new HttpError(400, "No files uploaded");
  } finally {
    await Promise.allSettled(pending);
    await Promise.all(temporaryPaths.map((temporary) => unlink(temporary).catch(() => {})));
  }
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
    now.getHours(),
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export function createFileRoutes(
  config: AppConfig,
  auth: AuthService,
  database: PanelDatabase,
  terminals: TerminalManager,
): RouteTable {
  const layoutFor = (record: ServerRecord) => serverLayout(config.serversPath, record);
  const protectedServerRoute = (
    handler: (request: BunRouteRequest, record: ServerRecord) => Response | Promise<Response>,
  ): RouteHandler =>
    route(
      config,
      auth.authenticated(async (request) => handler(request, database.getServer(request.params.id || "")!)),
    );
  const deleteFilesRoute = protectedServerRoute(async (request, record) => {
    const body = await readJson<FileListBody>(request);
    const targets = await Promise.all(
      stringList(body.files).map((file) => resolveSafePath(layoutFor(record).files, file)),
    );
    await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })));
    return textResponse("Files deleted successfully");
  });

  return {
    "/servers/:id/upload": {
      POST: protectedServerRoute(async (request, record) => {
        const destination = await resolveSafePath(layoutFor(record).files, query(request, "path"));
        await mkdir(destination, { recursive: true });
        await uploadFiles(request, destination, config.uploadMaxBytes);
        return textResponse("Files uploaded successfully");
      }),
    },
    "/servers/:id/files": {
      GET: protectedServerRoute(async (request, record) =>
        jsonResponse(await listDirectory(layoutFor(record).files, requestedDirectory(request))),
      ),
    },
    "/servers/:id/folders": {
      POST: protectedServerRoute(async (request, record) => {
        const body = await readJson<{ name?: unknown }>(request);
        const parent = await resolveSafePath(layoutFor(record).files, query(request, "path"));
        const target = await resolveSafePath(parent, validateLeafName(body.name));
        await mkdir(target, { recursive: true });
        return textResponse("Folder created successfully");
      }),
    },
    "/servers/:id/files/delete": {
      POST: deleteFilesRoute,
    },
    "/servers/:id/files/delete/": {
      POST: deleteFilesRoute,
    },
    "/servers/:id/files/archive": {
      POST: protectedServerRoute(async (request, record) => {
        const body = await readJson<FileListBody>(request);
        const files = stringList(body.files);
        if (!files.length) throw new HttpError(400, "No files selected");
        const detailed = await Promise.all(
          files.map(async (relative) => {
            const sourcePath = await resolveSafePath(layoutFor(record).files, relative);
            const sourceStats = await lstat(sourcePath);
            return {
              sourcePath,
              destName: normalizeRelativePath(relative) || path.basename(sourcePath),
              isFile: sourceStats.isFile(),
              isZip: sourceStats.isFile() && path.extname(sourcePath).toLowerCase() === ".zip",
            };
          }),
        );
        if (detailed.length === 1 && detailed[0]?.isFile && detailed[0].isZip) {
          const single = detailed[0];
          const task = await registerExistingZipTask({
            sourcePath: single.sourcePath,
            fileName: path.basename(single.sourcePath),
            meta: { scope: "files-archive", serverId: record.uuid, passthrough: true },
          });
          return jsonResponse({ taskId: task.taskId, fileName: task.fileName, status: task.status }, 202);
        }
        const task = startZipTask({
          entries: detailed.map(({ sourcePath, destName }) => ({ sourcePath, destName })),
          outputDir: path.join(layoutFor(record).temporary, "archives"),
          cleanup: true,
          meta: { scope: "files-archive", serverId: record.uuid },
        });
        return jsonResponse({ taskId: task.taskId, fileName: task.fileName, status: task.status }, 202);
      }),
    },
    "/servers/:id/files/archive/status/:taskId": {
      GET: protectedServerRoute(async (request, record) => {
        const task = getTask(request.params.taskId || "");
        if (!task || task.type !== TASK_TYPES.ZIP || (task.meta.serverId && task.meta.serverId !== record.uuid)) {
          throw new HttpError(404, "Task not found");
        }
        return jsonResponse(getTaskStatus(task.id));
      }),
    },
    "/servers/:id/files/archive/download/:taskId": {
      GET: protectedServerRoute(async (request, record) => {
        const task = getTask(request.params.taskId || "");
        if (!task || task.type !== TASK_TYPES.ZIP || (task.meta.serverId && task.meta.serverId !== record.uuid)) {
          throw new HttpError(404, "Task not found");
        }
        return zipDownloadResponse(task.id, true);
      }),
    },
    "/servers/:id/files/unarchive": {
      POST: protectedServerRoute(async (request, record) => {
        const body = await readJson<{ filePath?: unknown; destination?: unknown }>(request);
        if (typeof body.filePath !== "string") throw new HttpError(400, "Invalid path");
        const archivePath = await resolveSafePath(layoutFor(record).files, body.filePath);
        await assertRegularFile(archivePath);
        const destination =
          typeof body.destination === "string" && body.destination
            ? await resolveSafePath(layoutFor(record).files, body.destination)
            : path.dirname(archivePath);
        const task = startUnzipTask({
          archivePath,
          destination,
          overwrite: true,
          meta: { scope: "files-unarchive", serverId: record.uuid },
        });
        return jsonResponse(task, 202);
      }),
    },
    "/servers/:id/files/unarchive/status/:taskId": {
      GET: protectedServerRoute(async (request, record) => {
        const task = getTask(request.params.taskId || "");
        if (!task || task.type !== TASK_TYPES.UNZIP || (task.meta.serverId && task.meta.serverId !== record.uuid)) {
          throw new HttpError(404, "Task not found");
        }
        return jsonResponse(getTaskStatus(task.id));
      }),
    },
    "/servers/:id/files/read": {
      GET: protectedServerRoute(async (request, record) => {
        const filePath = await resolveSafePath(layoutFor(record).files, query(request, "filePath"));
        await assertRegularFile(filePath);
        if (![".txt", ".json", ".properties", ".log"].includes(path.extname(filePath).toLowerCase())) {
          throw new HttpError(400, "File is not editable");
        }
        return textResponse(await readFile(filePath, "utf8"));
      }),
    },
    "/servers/:id/files/save": {
      POST: protectedServerRoute(async (request, record) => {
        const body = await readJson<{ path?: unknown; content?: unknown }>(request, 10 * 1024 * 1024);
        if (typeof body.path !== "string" || typeof body.content !== "string") {
          throw new HttpError(400, "Invalid file contents");
        }
        const filePath = await resolveSafePath(layoutFor(record).files, body.path);
        await writeFile(filePath, body.content, "utf8");
        return textResponse("File saved successfully");
      }),
    },
    "/servers/:id/files/move": {
      POST: protectedServerRoute(async (request, record) => {
        const body = await readJson<{ files?: unknown; destination?: unknown }>(request);
        if (typeof body.destination !== "string") throw new HttpError(400, "Invalid path");
        const destination = await resolveSafePath(layoutFor(record).files, body.destination);
        const sources = await Promise.all(
          stringList(body.files).map((file) => resolveSafePath(layoutFor(record).files, file)),
        );
        for (const source of sources) {
          const target = await resolveSafePath(destination, path.basename(source));
          await rename(source, target);
        }
        return textResponse("Files moved successfully");
      }),
    },
    "/servers/:id/backup": {
      POST: protectedServerRoute(async (request, record) => {
        const body = request.body
          ? await readJson<{ allowRunning?: unknown }>(request)
          : {};
        const allowRunning = body.allowRunning === true;
        const serverRunning = await terminals.isRunning(record);
        if (serverRunning && !allowRunning) {
          return jsonResponse(
            {
              code: "SERVER_RUNNING_BACKUP_WARNING",
              message:
                "The server is running. Files may change while they are being archived, so this backup might not restore to a fully consistent state. Stop the server for the safest backup, or confirm that you want to continue anyway.",
              requiresConfirmation: true,
            },
            409,
          );
        }
        const candidates = [
          { sourcePath: path.join(layoutFor(record).files, "world"), destName: "world" },
          { sourcePath: path.join(layoutFor(record).files, "mods"), destName: "mods" },
          { sourcePath: path.join(layoutFor(record).files, "server.jar"), destName: "server.jar" },
        ];
        const entries = [];
        for (const candidate of candidates) {
          try {
            await lstat(candidate.sourcePath);
            entries.push(candidate);
          } catch {}
        }
        if (!entries.length) throw new HttpError(400, "Nothing to backup");
        const task = startZipTask({
          entries,
          outputDir: layoutFor(record).backups,
          fileName: `backup-${formatTimestamp()}.zip`,
          cleanup: false,
          meta: { scope: "backup", serverId: record.uuid, createdWhileRunning: serverRunning },
        });
        return jsonResponse({ taskId: task.taskId, backupName: task.fileName, status: task.status }, 202);
      }),
      DELETE: protectedServerRoute(async (request, record) => {
        const backupPath = await resolveSafePath(
          layoutFor(record).backups,
          validateLeafName(query(request, "backup")),
        );
        await rm(backupPath, { force: true });
        return textResponse("Backup deleted successfully");
      }),
    },
    "/servers/:id/backup/status/:taskId": {
      GET: protectedServerRoute(async (request, record) => {
        const task = getTask(request.params.taskId || "");
        if (!task || task.type !== TASK_TYPES.ZIP || task.meta.serverId !== record.uuid) {
          throw new HttpError(404, "Task not found");
        }
        return jsonResponse(getTaskStatus(task.id));
      }),
    },
    "/servers/:id/backups": {
      GET: protectedServerRoute(async (_request, record) => {
        const backupsDirectory = layoutFor(record).backups;
        await mkdir(backupsDirectory, { recursive: true });
        const names = await readdir(backupsDirectory);
        const backups = await Promise.all(
          names.map(async (name) => {
            try {
              const details = await stat(path.join(backupsDirectory, name));
              return { name, size: details.size, createdAt: details.mtime.toISOString() };
            } catch {
              return { name, size: 0, createdAt: new Date().toISOString() };
            }
          }),
        );
        return jsonResponse(backups);
      }),
    },
    "/servers/:id/backup/restore": {
      POST: protectedServerRoute(async (request, record) => {
        if (await terminals.isRunning(record)) throw new HttpError(409, "Stop the server before restoring a backup");
        const body = await readJson<{ backupName?: unknown }>(request);
        if (typeof body.backupName !== "string") throw new HttpError(400, "Backup not found");
        const backupPath = await resolveSafePath(layoutFor(record).backups, body.backupName);
        await assertRegularFile(backupPath);
        const stagingPath = path.join(
          layoutFor(record).temporary,
          `restore-${crypto.randomUUID()}.part`,
        );
        const task = startUnzipTask({
          archivePath: backupPath,
          destination: stagingPath,
          overwrite: true,
          cleanupDestinationOnError: true,
          onComplete: async () => {
            for (const name of ["server.jar", "world", "mods"]) {
              const staged = path.join(stagingPath, name);
              let stagedExists = true;
              try {
                await lstat(staged);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") stagedExists = false;
                else throw error;
              }
              await rm(path.join(layoutFor(record).files, name), { recursive: true, force: true });
              if (stagedExists) await rename(staged, path.join(layoutFor(record).files, name));
            }
            await rm(stagingPath, { recursive: true, force: true });
          },
          meta: { scope: "backup-restore", serverId: record.uuid },
        });
        return jsonResponse(task, 202);
      }),
    },
    "/servers/:id/backup/restore/status/:taskId": {
      GET: protectedServerRoute(async (request, record) => {
        const task = getTask(request.params.taskId || "");
        if (!task || task.type !== TASK_TYPES.UNZIP || task.meta.serverId !== record.uuid) {
          throw new HttpError(404, "Task not found");
        }
        return jsonResponse(getTaskStatus(task.id));
      }),
    },
    "/servers/:id/backup/download": {
      GET: protectedServerRoute(async (request, record) => {
        const backupPath = await resolveSafePath(
          layoutFor(record).backups,
          query(request, "backup"),
        );
        await assertRegularFile(backupPath);
        return new Response(Bun.file(backupPath), {
          headers: attachmentHeaders(path.basename(backupPath), "application/zip"),
        });
      }),
    },
    "/servers/:id/files/*": {
      GET: protectedServerRoute(async (request, record) => {
        return jsonResponse(await listDirectory(layoutFor(record).files, requestedDirectory(request)));
      }),
    },
  };
}
