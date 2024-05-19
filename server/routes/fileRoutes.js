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
router.delete("/servers/:id/files", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.filePath || "");
  const normalizedPath = path.normalize(fullPath);
  if (
    !normalizedPath.startsWith(req.server.path) ||
    normalizedPath === req.server.path
  ) {
    return res.status(400).send("Invalid path or cannot delete root directory");
  }
  fs.remove(normalizedPath, (err) => {
    if (err) {
      console.error("Failed to delete file:", err);
      return res.status(500).send("Failed to delete file");
    } else {
      res.send("File deleted successfully");
    }
  });
});
router.get("/servers/:id/download", authenticate, findServer, (req, res) => {
  let fullPath = path.join(req.server.path, req.query.filePath || "");
  fullPath = path.normalize(fullPath);
  if (!fullPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid file path");
  }
  if (fs.existsSync(fullPath)) {
    if (fs.lstatSync(fullPath).isDirectory()) {
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=" + path.basename(fullPath) + ".zip"
      );
      const archive = archiver("zip", { zlib: { level: 9 } }); // Compression level: 9 is best compression
      archive.on("error", function (err) {
        res.status(500).send("Error creating zip file: " + err.message);
      });
      archive.pipe(res);
      archive.directory(fullPath, false);
      archive.finalize();
    } else if (fs.lstatSync(fullPath).isFile()) {
      res.download(fullPath);
    }
  } else {
    res.status(404).send("File not found");
  }
});
// unarchive a zip file
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

module.exports = router;
