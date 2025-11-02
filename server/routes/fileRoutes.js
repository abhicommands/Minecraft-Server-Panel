const express = require("express");
const { authenticate } = require("./auth");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { db, findServer } = require("../db/db");
const {
  startZipTask,
  startUnzipTask,
  getTaskStatus,
  streamZipResult,
  TASK_STATUS,
  TASK_TYPES,
} = require("../utils/archiveManager");

const router = express.Router();

const normalizeRelativePath = (value = "") =>
  value.replace(/\\/g, "/").replace(/^\/+/, "");

const decodePath = (raw = "") =>
  raw
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch (error) {
        throw new Error("Invalid path segment");
      }
    })
    .join("/");

const resolveServerPath = (basePath, relativePath = "") => {
  const baseResolved = path.resolve(basePath);
  const normalizedRelative = normalizeRelativePath(relativePath);
  const target = normalizedRelative ? normalizedRelative : ".";
  const absolutePath = path.resolve(baseResolved, target);
  const relativeToBase = path.relative(baseResolved, absolutePath);
  if (relativeToBase.startsWith("..") || path.isAbsolute(relativeToBase)) {
    throw new Error("Invalid path");
  }
  return absolutePath;
};

const listDirectory = async (basePath, relativePath = "") => {
  const absolutePath = resolveServerPath(basePath, relativePath);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file",
    path: normalizeRelativePath(path.join(relativePath, entry.name)),
  }));
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const handleServer = (server) => {
      if (!server) {
        return cb(new Error("Server not found"));
      }
      try {
        const uploadPath = resolveServerPath(
          server.path,
          req.query.path || ""
        );
        fs.ensureDirSync(uploadPath);
        cb(null, uploadPath);
      } catch (error) {
        cb(new Error("Invalid path"));
      }
    };

    if (req.server) {
      return handleServer(req.server);
    }

    const serverId = req.params.id;
    db.get(
      "SELECT * FROM servers WHERE uuid = ?",
      [serverId],
      (err, server) => {
        if (err) {
          return cb(new Error("Server lookup failed"));
        }
        handleServer(server);
      }
    );
  },
  filename(req, file, cb) {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });
const uploadFilesMiddleware = upload.array("files");

router.post(
  "/servers/:id/upload",
  authenticate,
  findServer,
  (req, res) => {
    uploadFilesMiddleware(req, res, (error) => {
      if (error) {
        if (error instanceof multer.MulterError) {
          return res.status(400).send(error.message);
        }
        console.error("Failed to upload files:", error);
        return res.status(500).send("Failed to upload files");
      }
      res.send("Files uploaded successfully");
    });
  }
);

router.get("/servers/:id/files", authenticate, findServer, async (req, res) => {
  try {
    const items = await listDirectory(req.server.path, req.query.path || "");
    res.json(items);
  } catch (error) {
    if (error.message === "Invalid path" || error.message === "Invalid path segment") {
      return res.status(400).send("Invalid path");
    }
    console.error("Failed to read directory:", error);
    res.status(500).send("Failed to read directory");
  }
});

router.post("/servers/:id/folders", authenticate, findServer, async (req, res) => {
  try {
    const directoryPath = resolveServerPath(
      req.server.path,
      req.query.path || ""
    );
    const newFolderPath = path.join(directoryPath, req.body.name);
    fs.ensureDirSync(newFolderPath);
    res.send("Folder created successfully");
  } catch (error) {
    if (error.message === "Invalid path") {
      return res.status(400).send("Invalid path");
    }
    console.error("Error creating folder:", error);
    res.status(500).send("Failed to create folder");
  }
});

router.post(
  "/servers/:id/files/delete",
  authenticate,
  findServer,
  (req, res) => {
    try {
      const targets = (req.body.files || []).map((file) =>
        resolveServerPath(req.server.path, file)
      );
      targets.forEach((filePath) => {
        fs.removeSync(filePath);
      });
      res.send("Files deleted successfully");
    } catch (error) {
      if (error.message === "Invalid path") {
        return res.status(400).send("Invalid path");
      }
      console.error("Failed to delete files:", error);
      res.status(500).send("Failed to delete files");
    }
  }
);

router.post(
  "/servers/:id/files/archive",
  authenticate,
  findServer,
  async (req, res) => {
    const relativePaths = req.body.files || [];
    if (!relativePaths.length) {
      return res.status(400).send("No files selected");
    }
    try {
      const entries = relativePaths.map((relative) => {
        const sourcePath = resolveServerPath(req.server.path, relative);
        return {
          sourcePath,
          destName: normalizeRelativePath(relative) || path.basename(sourcePath),
        };
      });
      const tempDir = path.join(req.server.path, "..", "tmp-archives");
      const { taskId, fileName, status } = startZipTask({
        entries,
        outputDir: tempDir,
        cleanup: true,
        meta: {
        scope: "files-archive",
        serverId: req.params.id,
        },
      });
      res.status(202).json({ taskId, fileName, status });
    } catch (error) {
      if (error.message === "Invalid path") {
        return res.status(400).send("Invalid path");
      }
      console.error("Failed to start archive task:", error);
      res.status(500).send("Failed to start archive task");
    }
  }
);

router.get(
  "/servers/:id/files/archive/status/:taskId",
  authenticate,
  findServer,
  (req, res) => {
    const task = getTaskStatus(req.params.taskId);
    if (!task || task.type !== TASK_TYPES.ZIP) {
      return res.status(404).send("Task not found");
    }
    if (task.meta?.serverId && task.meta.serverId !== req.params.id) {
      return res.status(404).send("Task not found");
    }
    res.json(task);
  }
);

router.get(
  "/servers/:id/files/archive/download/:taskId",
  authenticate,
  findServer,
  (req, res) => {
    const task = getTaskStatus(req.params.taskId);
    if (!task || task.type !== TASK_TYPES.ZIP) {
      return res.status(404).send("Task not found");
    }
    if (task.meta?.serverId && task.meta.serverId !== req.params.id) {
      return res.status(404).send("Task not found");
    }
    streamZipResult(req.params.taskId, res, { removeOnComplete: true });
  }
);

router.post(
  "/servers/:id/files/unarchive",
  authenticate,
  findServer,
  (req, res) => {
    try {
      const archivePath = resolveServerPath(
        req.server.path,
        req.body.filePath || ""
      );
      const destination = req.body.destination
        ? resolveServerPath(req.server.path, req.body.destination)
        : path.dirname(archivePath);
      const { taskId, status } = startUnzipTask({
        archivePath,
        destination,
        overwrite: true,
        meta: {
        scope: "files-unarchive",
        serverId: req.params.id,
        },
      });
      res.status(202).json({ taskId, status });
    } catch (error) {
      if (error.message === "Invalid path") {
        return res.status(400).send("Invalid path");
      }
      console.error("Failed to start unarchive task:", error);
      res.status(500).send("Failed to start unarchive task");
    }
  }
);

router.get(
  "/servers/:id/files/unarchive/status/:taskId",
  authenticate,
  findServer,
  (req, res) => {
    const task = getTaskStatus(req.params.taskId);
    if (!task || task.type !== TASK_TYPES.UNZIP) {
      return res.status(404).send("Task not found");
    }
    if (task.meta?.serverId && task.meta.serverId !== req.params.id) {
      return res.status(404).send("Task not found");
    }
    res.json(task);
  }
);

router.get("/servers/:id/files/read", authenticate, findServer, (req, res) => {
  try {
    const filePath = resolveServerPath(
      req.server.path,
      req.query.filePath || ""
    );
    if (
      !fs.existsSync(filePath) ||
      fs.lstatSync(filePath).isDirectory()
    ) {
      return res.status(400).send("Invalid file path");
    }
    const editableExtensions = [".txt", ".json", ".properties", ".log"];
    if (!editableExtensions.some((ext) => filePath.endsWith(ext))) {
      return res.status(400).send("File is not editable");
    }
    const data = fs.readFileSync(filePath, "utf8");
    res.send(data);
  } catch (error) {
    if (error.message === "Invalid path") {
      return res.status(400).send("Invalid path");
    }
    console.error("Failed to read file:", error);
    res.status(500).send("Failed to read file");
  }
});

router.post("/servers/:id/files/save", authenticate, findServer, (req, res) => {
  try {
    const filePath = resolveServerPath(req.server.path, req.body.path || "");
    fs.writeFileSync(filePath, req.body.content, "utf8");
    res.send("File saved successfully");
  } catch (error) {
    if (error.message === "Invalid path") {
      return res.status(400).send("Invalid path");
    }
    console.error("Failed to save file:", error);
    res.status(500).send("Failed to save file");
  }
});

router.post(
  "/servers/:id/files/move",
  authenticate,
  findServer,
  (req, res) => {
    try {
      const destination = resolveServerPath(
        req.server.path,
        req.body.destination || ""
      );
      const targets = (req.body.files || []).map((file) =>
        resolveServerPath(req.server.path, file)
      );
      targets.forEach((filePath) => {
        fs.moveSync(filePath, path.join(destination, path.basename(filePath)));
      });
      res.send("Files moved successfully");
    } catch (error) {
      if (error.message === "Invalid path") {
        return res.status(400).send("Invalid path");
      }
      console.error("Failed to move files:", error);
      res.status(500).send("Failed to move files");
    }
  }
);

router.get(
  "/servers/:id/files/*",
  authenticate,
  findServer,
  async (req, res) => {
    try {
      const decodedPath = decodePath(req.params[0] || "");
      const items = await listDirectory(req.server.path, decodedPath);
      res.json(items);
    } catch (error) {
      if (error.message === "Invalid path" || error.message === "Invalid path segment") {
        return res.status(400).send("Invalid path");
      }
      console.error("Failed to read directory:", error);
      res.status(500).send("Failed to read directory");
    }
  }
);

router.post("/servers/:id/backup", authenticate, findServer, (req, res) => {
  const formatTimestamp = () => {
    const now = new Date();
    const pad = (value) => value.toString().padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate()
    )}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(
      now.getSeconds()
    )}`;
  };

  const worldPath = path.join(req.server.path, "world");
  const modPath = path.join(req.server.path, "mods");
  const serverJarPath = path.join(req.server.path, "server.jar");

  const entries = [];
  if (fs.existsSync(worldPath)) entries.push({ sourcePath: worldPath, destName: "world" });
  if (fs.existsSync(modPath)) entries.push({ sourcePath: modPath, destName: "mods" });
  if (fs.existsSync(serverJarPath)) entries.push({ sourcePath: serverJarPath, destName: "server.jar" });

  if (!entries.length) {
    return res.status(400).send("Nothing to backup");
  }

  try {
    const backupDir = path.join(req.server.backupPath);
    const backupName = `backup-${formatTimestamp()}.zip`;
    const { taskId, fileName, status } = startZipTask({
      entries,
      outputDir: backupDir,
      fileName: backupName,
      cleanup: false,
      meta: {
        scope: "backup",
        serverId: req.params.id,
      },
    });
    res.status(202).json({ taskId, backupName: fileName, status });
  } catch (error) {
    console.error("Failed to start backup:", error);
    res.status(500).send("Failed to start backup");
  }
});

router.get(
  "/servers/:id/backup/status/:taskId",
  authenticate,
  findServer,
  (req, res) => {
    const task = getTaskStatus(req.params.taskId);
    if (!task || task.type !== TASK_TYPES.ZIP || task.meta?.serverId !== req.params.id) {
      return res.status(404).send("Task not found");
    }
    res.json(task);
  }
);

router.delete("/servers/:id/backup", authenticate, findServer, (req, res) => {
  try {
    const target = resolveServerPath(
      req.server.backupPath,
      req.query.backup || ""
    );
    fs.removeSync(target);
    res.send("Backup deleted successfully");
  } catch (error) {
    if (error.message === "Invalid path") {
      return res.status(400).send("Invalid path");
    }
    console.error("Failed to delete backup:", error);
    res.status(500).send("Failed to delete backup");
  }
});

router.get("/servers/:id/backups", authenticate, findServer, (req, res) => {
  const backupPath = path.join(req.server.backupPath);
  fs.readdir(backupPath, (err, files) => {
    if (err) {
      console.error("Failed to read backups:", err);
      return res.status(500).send("Failed to read backups");
    }
    const backups = files.map((file) => {
      const filePath = path.join(backupPath, file);
      try {
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          createdAt: stats.mtime.toISOString(),
        };
      } catch (statError) {
        console.error("Failed to stat backup:", statError);
        return { name: file, size: 0, createdAt: new Date().toISOString() };
      }
    });
    res.json(backups);
  });
});

router.post(
  "/servers/:id/backup/restore",
  authenticate,
  findServer,
  (req, res) => {
    try {
      const backupPath = resolveServerPath(
        req.server.backupPath,
        req.body.backupName || ""
      );
      if (!fs.existsSync(backupPath)) {
        return res.status(400).send("Backup not found");
      }

      const serverJarPath = path.join(req.server.path, "server.jar");
      const worldPath = path.join(req.server.path, "world");
      const modsPath = path.join(req.server.path, "mods");

      if (fs.existsSync(serverJarPath)) fs.removeSync(serverJarPath);
      if (fs.existsSync(worldPath)) fs.removeSync(worldPath);
      if (fs.existsSync(modsPath)) fs.removeSync(modsPath);

      const { taskId, status } = startUnzipTask({
        archivePath: backupPath,
        destination: req.server.path,
        overwrite: true,
        meta: {
        scope: "backup-restore",
        serverId: req.params.id,
        },
      });
      res.status(202).json({ taskId, status });
    } catch (error) {
      if (error.message === "Invalid path") {
        return res.status(400).send("Invalid path");
      }
      console.error("Failed to restore backup:", error);
      res.status(500).send("Failed to restore backup");
    }
  }
);

router.get(
  "/servers/:id/backup/restore/status/:taskId",
  authenticate,
  findServer,
  (req, res) => {
    const task = getTaskStatus(req.params.taskId);
    if (!task || task.type !== TASK_TYPES.UNZIP || task.meta?.serverId !== req.params.id) {
      return res.status(404).send("Task not found");
    }
    res.json(task);
  }
);

router.get(
  "/servers/:id/backup/download",
  authenticate,
  findServer,
  (req, res) => {
    try {
      const backupPath = resolveServerPath(
        req.server.backupPath,
        req.query.backup || ""
      );
      if (!fs.existsSync(backupPath)) {
        return res.status(400).send("Backup not found");
      }
      res.download(backupPath);
    } catch (error) {
      if (error.message === "Invalid path") {
        return res.status(400).send("Invalid path");
      }
      console.error("Failed to download backup:", error);
      res.status(500).send("Failed to download backup");
    }
  }
);

module.exports = router;
