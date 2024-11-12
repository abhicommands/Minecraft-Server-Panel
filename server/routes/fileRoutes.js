const express = require("express");
const { authenticate } = require("./auth");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { db, findServer } = require("../db/db");
const archiver = require("archiver");
const yauzl = require("yauzl");

const router = express.Router();

// Files management
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const serverId = req.params.id;
    db.get(
      "SELECT * FROM servers WHERE uuid = ?",
      [serverId],
      (err, server) => {
        if (err) {
          return cb(new Error("Server lookup failed"));
        }
        if (!server) {
          return cb(new Error("Server not found"));
        }
        let uploadPath = path.join(server.path, req.query.path || "");
        uploadPath = path.normalize(uploadPath);
        if (!uploadPath.startsWith(server.path)) {
          return cb(new Error("Invalid path"));
        }
        fs.ensureDirSync(uploadPath);
        cb(null, uploadPath);
      }
    );
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });

router.post(
  "/servers/:id/upload",
  authenticate,
  upload.array("files"),
  (req, res) => {
    res.send("Files uploaded successfully");
  }
);

router.get("/servers/:id/files", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.path || "");
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  fs.readdir(normalizedPath, { withFileTypes: true }, (err, files) => {
    if (err) {
      console.error("Failed to read directory:", err);
      return res.status(500).send("Failed to read directory");
    }
    const items = files.map((file) => ({
      name: file.name,
      type: file.isDirectory() ? "directory" : "file",
      path: path.join(req.query.path || "", file.name),
    }));
    res.json(items);
  });
});

router.post("/servers/:id/folders", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.path || "");
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  const folderPath = path.join(normalizedPath, req.body.name);
  fs.ensureDirSync(folderPath);
  res.send("Folder created successfully");
});

router.post(
  "/servers/:id/files/delete",
  authenticate,
  findServer,
  (req, res) => {
    const filesToDelete = req.body.files.map((file) =>
      path.normalize(path.join(req.server.path, file))
    );
    filesToDelete.forEach((filePath) => {
      if (!filePath.startsWith(req.server.path)) {
        return res.status(400).send("Invalid path");
      }
      fs.removeSync(filePath);
    });
    res.send("Files deleted successfully");
  }
);

router.post(
  "/servers/:id/files/download",
  authenticate,
  findServer,
  (req, res) => {
    const filesToDownload = req.body.files.map((file) =>
      path.normalize(path.join(req.server.path, file))
    );
    if (
      filesToDownload.length === 1 &&
      fs.lstatSync(filesToDownload[0]).isFile() &&
      fs.existsSync(filesToDownload[0]) &&
      filesToDownload[0].startsWith(req.server.path)
    ) {
      res.download(filesToDownload[0]);
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=downloaded_files.zip"
    );
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", function (err) {
      res.status(500).send("Error creating zip file: " + err.message);
    });
    archive.on("error", function (err) {
      res.status(500).send("Error creating zip file: " + err.message);
      archive.abort();
    });
    archive.pipe(res);
    filesToDownload.forEach((filePath) => {
      if (!fs.existsSync(filePath)) {
        res.status(400).send("Invalid path");
        archive.abort();
        return;
      }
      if (!filePath.startsWith(req.server.path)) {
        res.status(400).send("Invalid path");
        archive.abort();
        return;
      }
      if (fs.lstatSync(filePath).isDirectory()) {
        archive.directory(filePath, path.basename(filePath));
      } else if (fs.lstatSync(filePath).isFile()) {
        archive.file(filePath, { name: path.basename(filePath) });
      }
    });

    archive.finalize();
  }
);

function unzipWithYauzl(zipPath, outputDir, res) {
  yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
    if (err) {
      console.error("Failed to open zip file:", err);
      return res.status(500).send("Failed to open zip file");
    }
    zipfile.on("entry", (entry) => {
      const entryPath = path.join(outputDir, entry.fileName);
      if (/\/$/.test(entry.fileName)) {
        fs.ensureDirSync(entryPath);
        zipfile.readEntry();
      } else {
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) {
            console.error("Error reading zip entry:", err);
            return res.status(500).send("Failed to unarchive file");
          }
          fs.ensureDirSync(path.dirname(entryPath));
          const writeStream = fs.createWriteStream(entryPath);
          readStream.pipe(writeStream);
          readStream.on("end", () => zipfile.readEntry());
        });
      }
    });
    zipfile.once("end", () => {
      res.send("File unarchived successfully");
    });
    zipfile.readEntry();
  });
}

router.get("/servers/:id/unarchive", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.filePath || "");
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  const zipName = path.basename(normalizedPath, path.extname(normalizedPath));
  const extractPath = path.join(path.dirname(normalizedPath), zipName);
  fs.ensureDirSync(extractPath);
  unzipWithYauzl(normalizedPath, extractPath, res);
});

router.get("/servers/:id/files/read", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.filePath || "");
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  if (
    !fs.existsSync(normalizedPath) ||
    fs.lstatSync(normalizedPath).isDirectory()
  ) {
    return res.status(400).send("Invalid file path");
  }
  const editableExtensions = [".txt", ".json", ".properties", ".log"]; // Add other extensions as needed
  if (!editableExtensions.some((ext) => normalizedPath.endsWith(ext))) {
    return res.status(400).send("File is not editable");
  }
  fs.readFile(normalizedPath, "utf8", (err, data) => {
    if (err) {
      console.error("Failed to read file:", err);
      return res.status(500).send("Failed to read file");
    }
    res.send(data);
  });
});

router.post("/servers/:id/files/save", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.body.path || "");
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  fs.writeFile(normalizedPath, req.body.content, "utf8", (err) => {
    if (err) {
      console.error("Failed to save file:", err);
      return res.status(500).send("Failed to save file");
    }
    res.send("File saved successfully");
  });
});
//move selected files to a new location
router.post("/servers/:id/files/move", authenticate, findServer, (req, res) => {
  const filesToMove = req.body.files.map((file) =>
    path.normalize(path.join(req.server.path, file))
  );
  const destination = path.normalize(
    path.join(req.server.path, req.body.destination)
  );
  if (!destination.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  filesToMove.forEach((filePath) => {
    if (!filePath.startsWith(req.server.path)) {
      return res.status(400).send("Invalid path");
    }
    fs.moveSync(filePath, path.join(destination, path.basename(filePath)));
  });
  res.send("Files moved successfully");
});

//create backups
router.post("/servers/:id/backup", authenticate, findServer, (req, res) => {
  const backupPath = path.join(req.server.backupPath);
  fs.ensureDirSync(backupPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = fs.createWriteStream(
    path.join(backupPath, `backup-${Date.now()}.zip`)
  );
  archive.on("error", function (err) {
    res.status(500).send("Error creating backup: " + err.message);
  });
  archive.pipe(output);
  //create a backupmeta file
  const worldPath = path.join(req.server.path, "world");
  const modPath = path.join(req.server.path, "mods");
  const serverJarPath = path.join(req.server.path, "server.jar");
  archive.directory(worldPath, "world");
  archive.directory(modPath, "mods");
  archive.file(serverJarPath, { name: "server.jar" });
  archive.finalize();
  output.on("close", function () {
    res.send("Backup created successfully");
  });
});
//delete backup
router.delete("/servers/:id/backup", authenticate, findServer, (req, res) => {
  const backupPath = path.normalize(
    path.join(req.server.backupPath, req.query.backup)
  );
  if (!backupPath.startsWith(req.server.backupPath)) {
    return res.status(400).send("Invalid path");
  }
  fs.removeSync(backupPath);
  res.send("Backup deleted successfully");
});
//get backups
router.get("/servers/:id/backups", authenticate, findServer, (req, res) => {
  const backupPath = path.join(req.server.backupPath);
  fs.readdir(backupPath, (err, files) => {
    if (err) {
      console.error("Failed to read backups:", err);
      return res.status(500).send("Failed to read backups");
    }
    const backups = files.map((file) => ({
      name: file,
      path: path.join(backupPath, file),
    }));
    res.json(backups);
  });
});
//restore backup
router.post(
  "/servers/:id/backup/restore",
  authenticate,
  findServer,
  (req, res) => {
    const backupPath = path.normalize(
      path.join(req.server.backupPath, req.body.backupName)
    );
    if (!backupPath.startsWith(req.server.backupPath)) {
      return res.status(400).send("Invalid path");
    }
    if (!fs.existsSync(backupPath)) {
      return res.status(400).send("Backup not found");
    }

    const serverJarPath = path.join(req.server.path, "server.jar");
    const worldPath = path.join(req.server.path, "world");
    const modsPath = path.join(req.server.path, "mods");

    // Clean up existing files
    if (fs.existsSync(serverJarPath)) fs.removeSync(serverJarPath);
    if (fs.existsSync(worldPath)) fs.removeSync(worldPath);
    if (fs.existsSync(modsPath)) fs.removeSync(modsPath);
    unzipWithYauzl(backupPath, req.server.path, res);
  }
);
//download backup
router.get(
  "/servers/:id/backup/download",
  authenticate,
  findServer,
  (req, res) => {
    const backupPath = path.normalize(
      path.join(req.server.backupPath, req.query.backup)
    );
    if (!backupPath.startsWith(req.server.backupPath)) {
      return res.status(400).send("Invalid path");
    }
    if (fs.existsSync(backupPath)) res.download(backupPath);
    else return res.status(400).send("Backup not found");
  }
);

module.exports = router;
