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
const { createTerminal, initializeTerminal } = require("../utils/terminal");

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
  mshConfig: Joi.boolean().required(),
  renderDistance: Joi.number().integer().min(2).max(32).required(),
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

const downloadMsh = async (serverRoot, port, version) => {
  const isWindows = process.platform === "win32";
  const isLinux = process.platform === "linux";
  const isArm = process.arch === "arm64";
  const isX64 = process.arch === "x64";

  const mshUrl = isWindows
    ? "https://msh.gekware.net/builds/egg/msh-windows-amd64.exe"
    : isLinux && isX64
    ? "https://msh.gekware.net/builds/egg/msh-linux-amd64.bin"
    : isLinux && isArm
    ? "https://msh.gekware.net/builds/egg/msh-linux-arm64.bin"
    : isLinux
    ? "https://msh.gekware.net/builds/egg/msh-linux-arm.bin"
    : isArm
    ? "https://msh.gekware.net/builds/egg/msh-darwin-arm64.osx"
    : "https://msh.gekware.net/builds/egg/msh-darwin-amd64.osx";
  const mshPath = path.join(
    serverRoot,
    isWindows ? "msh_server.exe" : isLinux ? "msh_server.bin" : "msh_server.osx"
  );
  const startupCommand = isWindows
    ? `./msh_server.exe -port ${port} -version ${version}`
    : isLinux
    ? `./msh_server.bin -port ${port} -version ${version}`
    : `./msh_server.osx -port ${port} -version ${version}`;
  await downloadFile(mshUrl, mshPath);
  fs.chmodSync(mshPath, 0o755);
  return startupCommand;
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
    if (value.mshConfig) {
      try {
        startupCommand = await downloadMsh(serverPath, port, version);
      } catch (error) {
        console.error("Error downloading files:", error);
      }
    } else {
      startupCommand = `java -Xms${value.memory}G -Xmx${value.memory}G -XX:+AlwaysPreTouch -XX:+DisableExplicitGC -XX:+ParallelRefProcEnabled -XX:+PerfDisableSharedMem -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1HeapRegionSize=8M -XX:G1HeapWastePercent=5 -XX:G1MaxNewSizePercent=40 -XX:G1MixedGCCountTarget=4 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1NewSizePercent=30 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:G1ReservePercent=20 -XX:InitiatingHeapOccupancyPercent=15 -XX:MaxGCPauseMillis=200 -XX:MaxTenuringThreshold=1 -XX:SurvivorRatio=32 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true -jar server.jar nogui`;
    }
    const backupPath = path.join(serverPath, "backup");
    fs.ensureDirSync(serverPath);
    fs.ensureDirSync(serverRoot);
    fs.ensureDirSync(backupPath);
    fs.ensureDirSync(path.join(serverPath, "logs"));
    const logDir = path.join(serverPath, "logs");
    try {
      await new Promise((resolve, reject) => {
        db.run(
          "INSERT INTO servers (uuid, name, path, backupPath, startupCommand, version, port, serverType, mshConfig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            serverId,
            name,
            serverRoot,
            backupPath,
            startupCommand,
            version,
            port,
            serverType,
            value.mshConfig,
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
      let minecraftPort;
      if (value.mshConfig) {
        const mshConfPath = path.join(serverPath, "msh-config.json");
        fs.ensureFileSync(mshConfPath);
        const mshStartParam = `-Xmx${value.memory}G -Xms${value.memory}G`;
        minecraftPort = parseInt(port, 10) + 1;
        const mshConf = {
          Server: {
            Folder: "./root/",
            FileName: "server.jar",
            Version: version,
            Protocol: 766,
          },
          Commands: {
            StartServer:
              "java <Commands.StartServerParam> -jar <Server.FileName> nogui",
            StartServerParam: mshStartParam,
            StopServer: "stop",
            StopServerAllowKill: 60,
          },
          Msh: {
            Debug: 2,
            ID: "",
            MshPort: 0,
            MshPortQuery: 0,
            EnableQuery: true,
            TimeBeforeStoppingEmptyServer: 1000,
            SuspendAllow: false,
            SuspendRefresh: -1,
            InfoHibernation:
              "                   §fserver status:\n                   §b§lHIBERNATING",
            InfoStarting:
              "                   §fserver status:\n                    §6§lWARMING UP",
            NotifyUpdate: true,
            NotifyMessage: true,
            Whitelist: [],
            WhitelistImport: false,
            ShowResourceUsage: false,
            ShowInternetUsage: false,
          },
        };
        fs.writeFileSync(mshConfPath, JSON.stringify(mshConf, null, 2));
      } else {
        minecraftPort = port;
      }
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
      const terminal = createTerminal(logDir, startupCommand, value.mshConfig);
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
      db.run(
        "UPDATE servers SET version = ?, startupCommand = ? WHERE uuid = ?",
        [
          version,
          `./msh_server.osx -port ${req.server.port} -version ${version}`,
          req.server.uuid,
        ]
      );
      //change startupcommand of the terminal
      const terminal = terminals[req.server.uuid];
      terminal.startupCommand = `./msh_server.osx -port ${req.server.port} -version ${version}`;
      res.send("Server updated successfully");
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
