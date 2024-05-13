require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const fs = require("fs-extra");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const archiver = require("archiver");

fs.ensureFileSync(path.join(__dirname, "myServers.db"));
const db = new sqlite3.Database(path.join(__dirname, "myServers.db"), (err) => {
  if (err) {
    console.error("Error opening database", err.message);
  } else {
    console.log("Database connected.");
    db.run(
      `
            CREATE TABLE IF NOT EXISTS servers (
                id TEXT PRIMARY KEY,
                name TEXT,
                path TEXT,
                backupPath TEXT
            )
        `,
      (err) => {
        if (err) {
          console.error("Error creating table", err.message);
        }
      }
    );
  }
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(cookieParser());

const SERVERS_BASE_PATH = path.join(__dirname, "../server-directory");
fs.ensureDirSync(SERVERS_BASE_PATH);

const user = {
  admin: {
    username: "admin",
    password: process.env.ROOT_PASSWORD_HASH,
  },
};

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

//authentication.
const authenticate = (req, res, next) => {
  try {
    const token = req.cookies.token;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { username: decoded.username };
    next();
  } catch (error) {
    console.log("Invalid session for some reason.");
    res.status(401).json({ error: "Invalid session." });
  }
};
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (
    username === user.admin.username &&
    bcrypt.compareSync(password, user.admin.password)
  ) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 604800000,
    });
    res.json({ message: "Login successful" });
  } else {
    res.status(401).json({ error: "Invalid username or password" });
  }
});
app.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logout successful" });
});
app.get("/validate-session", authenticate, (req, res) => {
  res.json({ message: "Valid session" });
});

//server management.
app.get("/servers", authenticate, (req, res) => {
  db.all("SELECT * FROM servers", [], (err, rows) => {
    if (err) {
      res.status(500).send("Failed to retrieve servers");
    } else {
      res.json({ username: req.user.username, servers: rows });
    }
  });
});

app.post("/servers", authenticate, (req, res) => {
  const serverId = uuidv4();
  const serverPath = path.join(SERVERS_BASE_PATH, serverId);
  const serverRoot = path.join(serverPath, "root");
  const backupPath = path.join(serverPath, "backup");
  fs.ensureDirSync(serverPath);
  fs.ensureDirSync(serverRoot);
  fs.ensureDirSync(backupPath);
  db.run(
    "INSERT INTO servers (id, name, path, backupPath) VALUES (?, ?, ?, ?)",
    [serverId, req.body.name, serverRoot, backupPath],
    function (err) {
      if (err) {
        res.status(500).send("Failed to create server");
      } else {
        res.status(201).json({
          id: serverId,
          name: req.body.name,
          path: serverRoot,
          backupPath: backupPath,
        });
      }
    }
  );
});
app.delete("/servers/:id", authenticate, (req, res) => {
  const serverId = req.params.id;
  db.run("DELETE FROM servers WHERE id = ?", serverId, function (err) {
    if (err) {
      res.status(500).send("Failed to delete server");
    } else if (this.changes === 0) {
      res.status(404).send("Server not found");
    } else {
      const serverPath = path.join(SERVERS_BASE_PATH, serverId);
      fs.remove(serverPath, (err) => {
        if (err) {
          console.error("Failed to delete server directory:", err);
          res.status(500).send("Failed to delete server directory");
        } else {
          res.send("Server deleted successfully");
        }
      });
    }
  });
});

//files managment.
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

      // Ensure the requested path is valid
      let uploadPath = path.join(server.path, req.query.path || "");
      uploadPath = path.normalize(uploadPath);
      if (!uploadPath.startsWith(server.path)) {
        return cb(new Error("Invalid path"));
      }

      // Ensure the directory exists before uploading
      fs.ensureDirSync(uploadPath);
      cb(null, uploadPath);
    });
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });
app.post(
  "/servers/:id/upload",
  authenticate,
  upload.array("files"),
  (req, res) => {
    res.send("Files uploaded successfully");
  }
);
//middleware to find the server from database:
function findServer(req, res, next) {
  const serverId = req.params.id;
  db.get("SELECT * FROM servers WHERE id = ?", [serverId], (err, server) => {
    if (err) {
      res.status(500).send("Failed to retrieve server");
    } else if (!server) {
      res.status(404).send("Server not found");
    } else {
      req.server = server;
      next();
    }
  });
}
app.get("/servers/:id/files", authenticate, findServer, (req, res) => {
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
app.post("/servers/:id/folders", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.path || "");
  const normalizedPath = path.normalize(fullPath);
  if (!normalizedPath.startsWith(req.server.path)) {
    return res.status(400).send("Invalid path");
  }
  const folderPath = path.join(normalizedPath, req.body.name);
  fs.ensureDirSync(folderPath);
  res.send("Folder created successfully");
});
app.delete("/servers/:id/files", authenticate, findServer, (req, res) => {
  const fullPath = path.join(req.server.path, req.query.filePath || "");
  const normalizedPath = path.normalize(fullPath);
  if (
    !normalizedPath.startsWith(req.server.path) ||
    fullPath === req.server.path
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
app.get("/servers/:id/download", authenticate, findServer, (req, res) => {
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
app.get("/servers/:id/unarchive", authenticate, findServer, (req, res) => {
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
