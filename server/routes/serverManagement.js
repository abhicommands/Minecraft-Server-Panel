const express = require("express");
const { authenticate } = require("./auth");
const fs = require("fs-extra");
const path = require("path");
const { db } = require("../db/db");
const { SERVERS_BASE_PATH } = require("../config/config");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const router = express.Router();

//get server list
router.get("/servers", authenticate, (req, res) => {
  db.all("SELECT * FROM servers", [], (err, rows) => {
    if (err) {
      res.status(500).send("Failed to retrieve servers");
    } else {
      res.json({ username: req.user.username, servers: rows });
    }
  });
});

//create new server
router.post("/servers", authenticate, async (req, res) => {
  const serverId = uuidv4();
  const serverPath = path.join(SERVERS_BASE_PATH, serverId);
  const serverRoot = path.join(serverPath, "root");
  const backupPath = path.join(serverPath, "backup");

  // if the user either provides a latest or no version, we will use the latest version getting from the fabric api
  const latestMinecraftVersion = "1.17.1";
  fs.ensureDirSync(serverPath);
  fs.ensureDirSync(serverRoot);
  fs.ensureDirSync(backupPath);
  // Extracting request data with default values
  const name = req.body.name || "Minecraft Server";
  const startupCommand = req.body.startupCommand || defaultStartupCommand;
  const port = req.body.port || 25565;
  const version = req.body.version === "latest" || !req.body.version ? "stable" : req.body.version;
  db.run(
    "INSERT INTO servers (id, name, path, backupPath, startupCommand, version, port) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [serverId, name, serverRoot, backupPath, startupCommand, version, port],
    function (err) {
      if (err) {
        res.status(500).send("Failed to create server");
        return;
      }
      res.status(201).json({
        id: serverId,
        name,
        path: serverRoot,
        backupPath,
        startupCommand,
        version,
        port,
      });
    }
  );
  try {
    const fabricUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}/stable/stable/server/jar`;
    try {
      const response = await axios({
      method: "get",
      url: fabricUrl,
      responseType: "stream",
      });
      const jarPath = path.join(serverRoot, "server.jar");
      const writer = fs.createWriteStream(jarPath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
      });
    } catch (error) {
      console.error("Failed to download or create the server:", error);
      res.status(500).send("Server setup failed");
      db.run("DELETE FROM servers WHERE id = ?", serverId, function (err) {
      if (err) {
        res.status(500).send("Failed to delete server");
      } else if (this.changes === 0) {
        res.status(404).send("Server not found");
      } else {
        const serverPath = path.join(SERVERS_BASE_PATH, serverId);
        fs.removeSync(serverPath, (err) => {
        if (err) {
          console.error("Failed to delete server directory:", err);
          res.status(500).send("Failed to delete server directory");
        } else {
          res.send("Server deleted successfully");
        }
        });
      }
      });
      return;
    }
    const jarPath = path.join(serverRoot, "server.jar");
    const writer = fs.createWriteStream(jarPath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    console.error("Failed to download or create the server:", error);
    res.status(500).send("Server setup failed");
    db.run("DELETE FROM servers WHERE id = ?", serverId, function (err) {
      if (err) {
        res.status(500).send("Failed to delete server");
      } else if (this.changes === 0) {
        res.status(404).send("Server not found");
      } else {
        const serverPath = path.join(SERVERS_BASE_PATH, serverId);
        fs.removeSync(serverPath, (err) => {
          if (err) {
            console.error("Failed to delete server directory:", err);
            res.status(500).send("Failed to delete server directory");
          } else {
            res.send("Server deleted successfully");
          }
        });
      }
    });
  }
});

//delete server
router.delete("/servers/:id", authenticate, (req, res) => {
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
module.exports = router;
