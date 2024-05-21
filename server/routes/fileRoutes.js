const express = require("express");
const { authenticate } = require("./auth");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const { db, findServer } = require("../db/db");
const archiver = require("archiver");

const router = express.Router();

// Files management
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const serverId = req.params.id;
    db.get("SELECT * FROM servers WHERE id = ?", [serverId], (err, server) => {
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
    });
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

router.get("/servers/:id/unarchive", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.filePath || "");
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  const extractPath = path.join(
    req.server.path,
    path.basename(normalizedPath, ".zip")
  );
  fs.ensureDirSync(extractPath);
  fs.createReadStream(normalizedPath)
    .pipe(require("unzipper").Extract({ path: extractPath }))
    .promise()
    .then(() => {
      res.send("File unarchived successfully");
    })
    .catch((err) => {
      console.error("Failed to unarchive file:", err);
      res.status(500).send("Failed to unarchive file");
    });
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

module.exports = router;
