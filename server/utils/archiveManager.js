const archiver = require("archiver");
const StreamZip = require("node-stream-zip");
const fs = require("fs-extra");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const TASK_TYPES = {
  ZIP: "zip",
  UNZIP: "unzip",
};

const TASK_STATUS = {
  QUEUED: "queued",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  ERROR: "error",
};

const tasks = new Map();

const newTimestamp = () => new Date().toISOString();

const createTask = (type, initial = {}) => {
  const id = uuidv4();
  const task = {
    id,
    type,
    status: TASK_STATUS.QUEUED,
    progress: 0,
    totalBytes: 0,
    processedBytes: 0,
    entriesProcessed: 0,
    entriesTotal: 0,
    createdAt: newTimestamp(),
    updatedAt: newTimestamp(),
    message: null,
    ...initial,
  };
  tasks.set(id, task);
  return task;
};

const updateTask = (id, updates) => {
  const task = tasks.get(id);
  if (!task) return;
  Object.assign(task, updates, { updatedAt: newTimestamp() });
};

const calculateTotalSize = async (targets) => {
  let total = 0;
  for (const target of targets) {
    if (!target) continue;
    const exists = await fs.pathExists(target);
    if (!exists) continue;
    const stats = await fs.stat(target);
    if (stats.isDirectory()) {
      const entries = await fs.readdir(target);
      const childTargets = entries.map((entry) => path.join(target, entry));
      total += await calculateTotalSize(childTargets);
    } else {
      total += stats.size;
    }
  }
  return total;
};

const startZipTask = ({
  entries,
  outputDir,
  fileName,
  cleanup = true,
  meta = {},
  compressionLevel = 9,
}) => {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("No entries provided for zip task");
  }

  const taskFileName = fileName || `archive-${Date.now()}.zip`;
  const outputPath = path.join(outputDir, taskFileName);

  const task = createTask(TASK_TYPES.ZIP, {
    fileName: taskFileName,
    outputPath,
    cleanup,
    meta,
  });

  process.nextTick(async () => {
    try {
      await fs.ensureDir(outputDir);
      const sources = entries.filter(Boolean);
      const totalBytes = await calculateTotalSize(
        sources.map((entry) => entry.sourcePath)
      );

      updateTask(task.id, {
        status: TASK_STATUS.IN_PROGRESS,
        totalBytes,
        progress: totalBytes === 0 ? 1 : 0,
        entriesTotal: sources.length,
      });

      const archive = archiver("zip", { zlib: { level: compressionLevel } });
      const outputStream = fs.createWriteStream(outputPath);

      const handleError = async (error) => {
        console.error("Zip task failed:", error);
        updateTask(task.id, {
          status: TASK_STATUS.ERROR,
          message: error.message,
          progress: 0,
        });
        try {
          archive.abort();
        } catch (_) {
          /* ignore */
        }
        outputStream.destroy();
        await fs.remove(outputPath).catch(() => {});
      };

      archive.on("error", handleError);
      outputStream.on("error", handleError);

      archive.on("progress", (data) => {
        const processedBytes = data?.fs?.processedBytes ?? 0;
        const denominator = totalBytes || processedBytes || 1;
        updateTask(task.id, {
          processedBytes,
          progress: Math.min(processedBytes / denominator, 1),
          entriesProcessed: data?.entries?.processed ?? task.entriesProcessed,
        });
      });

      outputStream.on("close", async () => {
        let archiveSize = 0;
        try {
          const stats = await fs.stat(outputPath);
          archiveSize = stats.size;
        } catch (_) {
          /* ignore */
        }
        updateTask(task.id, {
          status: TASK_STATUS.COMPLETED,
          progress: 1,
          processedBytes: task.totalBytes,
          archiveSize,
          finishedAt: newTimestamp(),
        });
      });

      archive.pipe(outputStream);

      for (const entry of sources) {
        const sourcePath = entry.sourcePath;
        const exists = await fs.pathExists(sourcePath);
        if (!exists) continue;
        const stats = await fs.stat(sourcePath);
        if (stats.isDirectory()) {
          archive.directory(
            sourcePath,
            entry.destName === undefined ? path.basename(sourcePath) : entry.destName,
            { dot: true }
          );
          const children = await fs.readdir(sourcePath);
          if (children.length === 0) {
            const dirName =
              entry.destName === undefined
                ? path.basename(sourcePath)
                : entry.destName;
            if (dirName !== false) {
              archive.append(Buffer.alloc(0), {
                name: `${String(dirName).replace(/\\/g, "/")}/`,
              });
            }
          }
        } else if (stats.isFile()) {
          archive.file(sourcePath, {
            name:
              entry.destName === undefined
                ? path.basename(sourcePath)
                : entry.destName,
          });
        }
      }

      archive.finalize();
    } catch (error) {
      console.error("Failed to start zip task:", error);
      updateTask(task.id, {
        status: TASK_STATUS.ERROR,
        message: error.message,
        finishedAt: newTimestamp(),
      });
      await fs.remove(outputPath).catch(() => {});
    }
  });

  return {
    taskId: task.id,
    fileName: taskFileName,
    status: task.status,
    outputPath,
  };
};

const startUnzipTask = ({
  archivePath,
  destination,
  overwrite = true,
  meta = {},
}) => {
  const task = createTask(TASK_TYPES.UNZIP, {
    archivePath,
    destination,
    overwrite,
    meta,
  });

  process.nextTick(async () => {
    const zip = new StreamZip.async({ file: archivePath });
    try {
      await fs.ensureDir(destination);
      console.log(`[ArchiveManager] unzip task ${task.id} started`);
      const entries = await zip.entries();
      const entryList = Object.values(entries);
      const totalBytes = entryList.reduce(
        (sum, entry) => sum + (entry.size || 0),
        0
      );
      updateTask(task.id, {
        status: TASK_STATUS.IN_PROGRESS,
        totalBytes,
        progress: totalBytes === 0 ? 1 : 0,
        entriesTotal: entryList.length,
      });

      let processedBytes = 0;
      let processedEntries = 0;

      for (const entry of entryList) {
        const entryName = entry.name;
        const targetPath = path.join(destination, entryName);
        if (!targetPath.startsWith(destination)) {
          console.warn(
            `[ArchiveManager] skipping entry outside destination: ${entryName}`
          );
          processedEntries += 1;
          continue;
        }
        console.log(
          `[ArchiveManager] [${task.id}] extracting ${entry.isDirectory ? "dir" : "file"} ${entryName}`
        );
        if (entry.isDirectory) {
          await fs.ensureDir(targetPath);
          processedEntries += 1;
          const entryProgress =
            entryList.length === 0
              ? 1
              : Math.min(processedEntries / entryList.length, 1);
          const byteProgress =
            totalBytes === 0
              ? entryProgress
              : Math.min(processedBytes / totalBytes, 1);
          updateTask(task.id, {
            entriesProcessed: processedEntries,
            processedBytes,
            progress: Math.max(byteProgress, entryProgress),
          });
          continue;
        }
        await fs.ensureDir(path.dirname(targetPath));
        await new Promise((resolve, reject) => {
          zip.stream(entryName, (err, stream) => {
            if (err) return reject(err);
            const writeStream = fs.createWriteStream(targetPath, {
              flags: overwrite ? "w" : "wx",
            });
            stream.on("data", (chunk) => {
              processedBytes += chunk.length;
              const byteProgress =
                totalBytes === 0
                  ? 0
                  : Math.min(processedBytes / totalBytes, 1);
              updateTask(task.id, {
                processedBytes,
                progress: byteProgress,
              });
            });
            stream.on("error", reject);
            writeStream.on("error", reject);
            writeStream.on("finish", resolve);
            stream.pipe(writeStream);
          });
        });
        console.log(
          `[ArchiveManager] [${task.id}] extracted file ${entryName}`
        );
        processedEntries += 1;
        const entryProgress =
          entryList.length === 0
            ? 1
            : Math.min(processedEntries / entryList.length, 1);
        const byteProgress =
          totalBytes === 0 ? entryProgress : Math.min(processedBytes / totalBytes, 1);
        updateTask(task.id, {
          entriesProcessed: processedEntries,
          processedBytes,
          progress: Math.max(byteProgress, entryProgress),
        });
      }

      updateTask(task.id, {
        status: TASK_STATUS.COMPLETED,
        progress: 1,
        processedBytes,
        entriesProcessed: processedEntries,
        finishedAt: newTimestamp(),
      });
      console.log(`[ArchiveManager] unzip task ${task.id} completed`);
    } catch (error) {
      console.error("Unzip task failed:", error);
      updateTask(task.id, {
        status: TASK_STATUS.ERROR,
        message: error.message,
        finishedAt: newTimestamp(),
      });
    } finally {
      await zip.close().catch(() => {});
    }
  });

  return { taskId: task.id, status: task.status };
};

const getTaskStatus = (taskId) => {
  const task = tasks.get(taskId);
  if (!task) return null;
  const {
    cleanup,
    meta,
    outputPath,
    archivePath,
    destination,
    ...publicTask
  } = task;
  return {
    ...publicTask,
    meta: meta || {},
  };
};

const streamZipResult = async (taskId, res, { removeOnComplete = true } = {}) => {
  const task = tasks.get(taskId);
  if (!task || task.type !== TASK_TYPES.ZIP) {
    res.status(404).send("Task not found");
    return;
  }
  if (task.status !== TASK_STATUS.COMPLETED) {
    res.status(409).send("Archive not ready");
    return;
  }
  const readStream = fs.createReadStream(task.outputPath);
  readStream.on("error", (err) => {
    console.error("Failed to stream archive:", err);
    if (!res.headersSent) {
      res.status(500).send("Failed to stream archive");
    } else {
      res.end();
    }
  });
  res.on("close", async () => {
    if (removeOnComplete && task.cleanup !== false) {
      await fs.remove(task.outputPath).catch(() => {});
    }
    tasks.delete(taskId);
  });
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${task.fileName}"`
  );
  res.setHeader("Content-Type", "application/zip");
  readStream.pipe(res);
};

module.exports = {
  TASK_STATUS,
  TASK_TYPES,
  startZipTask,
  startUnzipTask,
  getTaskStatus,
  streamZipResult,
};
