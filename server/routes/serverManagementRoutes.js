const express = require("express");
const { authenticate } = require("./auth");
const { db, findServer } = require("../db/db");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const os = require("os");
const kill = require("tree-kill");
const Joi = require("joi");
const { v4: uuidv4, validate } = require("uuid");
const {
  createTerminal,
  initializeTerminal,
  composeStartupCommand,
} = require("../utils/terminal");

const SERVERS_BASE_PATH = path.join(__dirname, "../server-directory");

const serverCreateSchema = Joi.object({
  name: Joi.string().required(),
  memory: Joi.number()
    .integer()
    .min(1)
    .max(os.totalmem() / 1024 / 1024 / 1024)
    .required(),
  port: Joi.number().required(),
  version: Joi.string().required(),
  serverType: Joi.string()
    .valid("vanilla", "paper", "fabric", "forge", "bungeecord")
    .required(),
  renderDistance: Joi.number().integer().min(2).max(32).required(),
  startupFlags: Joi.string().allow("").max(600).optional(),
});

const serverUpdateSchema = Joi.object({
  version: Joi.string()
    .trim()
    .pattern(/^\d+\.\d+(?:\.\d+)?$/) // 1.x or 1.x.y
    .required()
    .messages({
      "string.pattern.base":
        "version must look like '1.21' or '1.20.1' (no 'latest'/'stable').",
      "any.required": "version is required.",
    }),
});

const MAX_STARTUP_FLAGS_LENGTH = 600;
const DISALLOWED_FLAGS_PATTERN = /[;&|<>`$]/;

const sanitizeStartupFlags = (value) =>
  typeof value === "string" ? value.trim() : "";

const normalizeBaseCommand = (value) =>
  typeof value === "string" ? value.trim() : "";

const ensureValidStartupFlags = (rawFlags) => {
  const flags = sanitizeStartupFlags(rawFlags);
  if (!flags) return "";
  if (flags.length > MAX_STARTUP_FLAGS_LENGTH) {
    throw new Error("Flags are too long");
  }
  if (DISALLOWED_FLAGS_PATTERN.test(flags) || /\r|\n/.test(flags)) {
    throw new Error(
      "Flags contain unsupported characters like shell separators"
    );
  }
  if (/-jar\b/i.test(flags) || /\bserver\.jar\b/i.test(flags)) {
    throw new Error("Flags cannot modify the server jar configuration");
  }
  if (/\b-Xmx/i.test(flags) || /\b-Xms/i.test(flags)) {
    throw new Error("Flags cannot change the allocated memory");
  }
  if (/^java\b/i.test(flags)) {
    throw new Error("Flags cannot override the java executable");
  }
  return flags;
};

const downloadFile = async (url, dest) => {
  const response = await axios({
    method: "get",
    url,
    responseType: "stream",
  });
  fs.ensureFileSync(dest);
  const writer = fs.createWriteStream(dest);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      writer.close(resolve);
    });
    writer.on("error", (err) => {
      writer.close(() => reject(err));
    });
  });
};

const downloadServerJar = async (version, serverRoot) => {
  const fabricUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}/stable/stable/server/jar`;
  const jarPath = path.join(serverRoot, "server.jar");
  if (fs.existsSync(jarPath)) fs.removeSync(jarPath);
  await downloadFile(fabricUrl, jarPath);
};

const createServerRoutes = (terminals, io) => {
  const router = express.Router();
  router.post("/servers", authenticate, async (req, res) => {
    const { error, value } = serverCreateSchema.validate(req.body);
    if (error) {
      return res.status(400).send(error.details[0].message);
    }
    const name = value.name;
    const port = value.port;
    const version = value.version;
    const serverType = value.serverType;
    const serverId = uuidv4();
    const serverPath = path.join(SERVERS_BASE_PATH, serverId);
    const serverRoot = path.join(serverPath, "root");
    let startupCommand;
    let startupFlags = "";
    try {
      startupFlags = ensureValidStartupFlags(value.startupFlags);
    } catch (error) {
      return res.status(400).send(error.message);
    }
    const memoryFlagString = `-Xmx${value.memory}G -Xms${value.memory}G`;
    startupCommand = `java ${memoryFlagString} -jar server.jar nogui`;
    const backupPath = path.join(serverPath, "backup");
    fs.ensureDirSync(serverPath);
    fs.ensureDirSync(serverRoot);
    fs.ensureDirSync(backupPath);
    fs.ensureDirSync(path.join(serverPath, "logs"));
    const logDir = path.join(serverPath, "logs");
    try {
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO servers (uuid, name, path, backupPath, startupCommand, startupFlags, version, port, serverType) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            serverId,
            name,
            serverRoot,
            backupPath,
            startupCommand,
            startupFlags,
            version,
            port,
            serverType,
          ],
          function (err) {
            if (err) {
              reject(new Error(`Database error: ${err.message}`));
            }
            resolve();
          }
        );
      });
    } catch (error) {
      fs.remove(serverPath, (err) => {
        if (err) {
          console.error("Failed to delete server directory:", err);
          return res
            .status(500)
            .send("Failed to delete server directory from database error");
        }
      });
      return res.status(500).send(error.message);
    }
    try {
      try {
        await downloadServerJar(version, serverRoot);
      } catch (error) {
        fs.remove(serverPath, (err) => {
          if (err) {
            console.error("Failed to delete server directory:", err);
            return res.status(500).send("Failed to delete server directory");
          }
        });
        db.run("DELETE FROM servers WHERE uuid = ?", serverId, function (err) {
          if (err) {
            console.error("Failed to delete server from database:", err);
            return res
              .status(500)
              .send("Failed to delete server from database");
          }
        });
        console.error("Error downloading files:", error);
        return res.status(500).send("Failed to download server files");
      }
      //write the port to the server.properties file
      const propertiesPath = path.join(serverRoot, "server.properties");
      fs.ensureFileSync(propertiesPath);
      const minecraftPort = port;
      const propertiesContent = `
#Minecraft server properties
#Thu May 16 21:56:35 EDT 2024
allow-flight=false
allow-nether=true
broadcast-console-to-ops=true
broadcast-rcon-to-ops=true
difficulty=easy
enable-command-block=false
enable-jmx-monitoring=false
enable-query=false
enable-rcon=false
enable-status=true
enforce-secure-profile=true
enforce-whitelist=false
entity-broadcast-range-percentage=100
force-gamemode=false
function-permission-level=2
gamemode=survival
generate-structures=true
generator-settings={}
hardcore=false
hide-online-players=false
initial-disabled-packs=
initial-enabled-packs=vanilla
level-name=world
level-seed=
level-type=minecraft\:normal
log-ips=true
max-chained-neighbor-updates=1000000
max-players=20
max-tick-time=60000
max-world-size=29999984
motd=A Minecraft Server
network-compression-threshold=256
online-mode=true
op-permission-level=4
player-idle-timeout=0
prevent-proxy-connections=false
pvp=true
query.port=${minecraftPort}
rate-limit=0
rcon.password=
rcon.port=25575
require-resource-pack=false
resource-pack=
resource-pack-id=
resource-pack-prompt=
resource-pack-sha1=
server-ip=
server-port=${minecraftPort}
simulation-distance=10
spawn-animals=true
spawn-monsters=true
spawn-npcs=true
spawn-protection=16
sync-chunk-writes=true
text-filtering-config=
use-native-transport=true
view-distance=10
white-list=false
`;
      fs.writeFileSync(propertiesPath, propertiesContent);
      //create eula.txt file
      const eulaPath = path.join(serverRoot, "eula.txt");
      fs.ensureFileSync(eulaPath);
      const eulaContent = `
#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).
#Thu May 16 21:56:35 EDT 2024
eula=true
`;
      fs.writeFileSync(eulaPath, eulaContent);
      const terminal = createTerminal(logDir, startupCommand, startupFlags);
      terminals[serverId] = terminal;
      initializeTerminal(io, serverId, terminal, logDir);
      return res.json({
        id: serverId,
        name,
        version,
        port,
        serverType,
      });
    } catch (error) {
      console.error("Failed to download or create the server:", error);
      fs.remove(serverPath, (err) => {
        if (err) {
          console.error("Failed to delete server directory:", err);
          return res.status(500).send("Failed to delete server directory");
        }
      });
      db.run("DELETE FROM servers WHERE uuid = ?", serverId, function (err) {
        if (err) {
          console.error("Failed to delete server from database:", err);
          return res.status(500).send("Failed to delete server from database");
        }
      });
      return res.status(500).send("Failed to download or create the server");
    }
  });
  router.get("/servers", authenticate, (req, res) => {
    db.all("SELECT * FROM servers", [], (err, rows) => {
      if (err) {
        res.status(500).send("Failed to retrieve servers");
      } else {
        const servers = rows.map((row) => ({
          id: row.uuid,
          name: row.name,
          version: row.version,
          port: row.port,
        }));
        res.json({ servers, username: req.user.username });
      }
    });
  });
  //update server or change versions just deletes the server.jar file and redownloads the version specified by the user
  router.post(
    "/servers/:id/update",
    authenticate,
    findServer,
    async (req, res) => {
      let { error, value } = serverUpdateSchema.validate(req.body);
      if (error) {
        return res.status(400).send(error.details[0].message);
      }
      const serverRoot = req.server.path;
      if (value.version !== "latest") {
        const response = await axios.get(
          `https://meta.fabricmc.net/v1/versions/game/${value.version}`
        );
        if (!response.data.length) {
          res.status(400).send("Invalid version number");
          return;
        }
      } else {
        value.version = "stable";
      }
      const version = value.version;
      try {
        await downloadServerJar(version, serverRoot);
      } catch (error) {
        console.error("Error downloading files:", error);
      }
      //change the version from the server database
      db.run("UPDATE servers SET version = ? WHERE uuid = ?", [
        version,
        req.server.uuid,
      ]);
      const terminal = terminals[req.server.uuid];
      if (terminal) {
        terminal.baseCommand = req.server.startupCommand;
        terminal.startupFlags =
          typeof req.server.startupFlags === "string"
            ? req.server.startupFlags
            : terminal.startupFlags;
        terminal.startupCommand = composeStartupCommand(
          terminal.baseCommand,
          terminal.startupFlags
        );
      }
      res.send("Server updated successfully");
    }
  );

  router.get(
    "/servers/:id/startup-flags",
    authenticate,
    findServer,
    (req, res) => {
      const baseCommand = normalizeBaseCommand(req.server.startupCommand);
      const flags = sanitizeStartupFlags(req.server.startupFlags);
      res.json({
        baseCommand,
        startupFlags: flags,
        effectiveCommand: composeStartupCommand(baseCommand, flags),
        allowCustomFlags: true,
        requiresRestart: true,
      });
    }
  );

  router.put(
    "/servers/:id/startup-flags",
    authenticate,
    findServer,
    (req, res) => {
      const baseCommand = normalizeBaseCommand(req.server.startupCommand);
      let flags;
      try {
        flags = ensureValidStartupFlags(req.body.flags);
      } catch (error) {
        return res.status(400).send(error.message);
      }
      db.run(
        "UPDATE servers SET startupFlags = ? WHERE uuid = ?",
        [flags, req.server.uuid],
        (err) => {
          if (err) {
            console.error("Failed to update startup flags:", err);
            return res.status(500).send("Failed to update startup flags");
          }
          req.server.startupFlags = flags;
          const terminal = terminals[req.server.uuid];
          if (terminal) {
            terminal.startupFlags = flags;
            terminal.startupCommand = composeStartupCommand(
              normalizeBaseCommand(terminal.baseCommand || baseCommand),
              flags
            );
          }
          res.json({
            baseCommand,
            startupFlags: flags,
            effectiveCommand: composeStartupCommand(baseCommand, flags),
            allowCustomFlags: true,
            requiresRestart: true,
          });
        }
      );
    }
  );

  //get server by id
  router.get("/servers/:id", authenticate, findServer, (req, res) => {
    //dont send all the information just send crucial information that the user inputted when creating the server
    res.json({
      id: req.server.uuid,
      name: req.server.name,
      version: req.server.version,
      port: req.server.port,
    });
  });
  //delete server
  router.delete("/servers/:id", authenticate, (req, res) => {
    const serverId = req.params.id;
    if (!validate(serverId)) {
      res.status(400).send("Invalid UUID");
      return;
    }
    db.run("DELETE FROM servers WHERE uuid = ?", serverId, function (err) {
      if (err) {
        res.status(500).send("Failed to delete server");
        return;
      }
    });
    const terminal = terminals[serverId];
    if (terminal) {
      if (terminal.serverPID) kill(terminal.serverPID, "SIGKILL");
      terminal.ptyProcess.kill();
      delete terminals[serverId];
    }
    const serverPath = path.join(SERVERS_BASE_PATH, serverId);
    if (fs.existsSync(serverPath)) {
      fs.remove(serverPath, (err) => {
        if (err) {
          console.error("Failed to delete server directory:", err);
          res.status(500).send("Failed to delete server directory");
        }
      });
      res.status(204).send("Server deleted successfully");
    }
  });
  return router;
};

module.exports = createServerRoutes;
