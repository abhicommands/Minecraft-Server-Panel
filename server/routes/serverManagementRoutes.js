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
const { spawn } = require("child_process");
const {
  createTerminal,
  initializeTerminal,
  composeStartupCommand,
} = require("../utils/terminal");

const SERVERS_BASE_PATH = path.join(__dirname, "../server-directory");
const VANILLA_MANIFEST_URL =
  "https://launchermeta.mojang.com/mc/game/version_manifest.json";
const PAPER_PROJECTS_API = "https://api.papermc.io/v2/projects";
const FABRIC_LOADER_ENDPOINT = "https://meta.fabricmc.net/v2/versions/loader";
const FABRIC_INSTALLER_ENDPOINT =
  "https://meta.fabricmc.net/v2/versions/installer";
const FORGE_PROMOTIONS_URL =
  "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN_BASE =
  "https://maven.minecraftforge.net/net/minecraftforge/forge";

const toDownloadErrorStatus = (error) => {
  const message = (error?.message || "").toLowerCase();
  if (
    message.includes("unsupported server type") ||
    message.includes("was not found") ||
    message.includes("must be") ||
    message.includes("must look like") ||
    message.includes("require a specific")
  ) {
    return 400;
  }
  return 500;
};

const MINECRAFT_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;

const SERVER_TYPE_LABELS = {
  vanilla: "Vanilla",
  paper: "Paper",
  fabric: "Fabric",
  forge: "Forge",
  bungeecord: "BungeeCord",
};

const normalizeServerType = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const getServerTypeLabel = (normalizedType) =>
  SERVER_TYPE_LABELS[normalizedType] || null;

const ensureMinecraftVersion = (value, context) => {
  if (!MINECRAFT_VERSION_PATTERN.test(value || "")) {
    throw new Error(
      `${context} downloads require a specific Minecraft version (e.g., 1.20.1)`
    );
  }
};

const serverCreateSchema = Joi.object({
  name: Joi.string().required(),
  memory: Joi.number()
    .integer()
    .min(1)
    .max(os.totalmem() / 1024 / 1024 / 1024)
    .required(),
  port: Joi.number().required(),
  version: Joi.string()
    .trim()
    .pattern(MINECRAFT_VERSION_PATTERN)
    .required()
    .messages({
      "string.pattern.base": "version must look like '1.21' or '1.20.1'.",
      "any.required": "version is required.",
    }),
  serverType: Joi.string()
    .valid("vanilla", "paper", "fabric", "forge", "bungeecord")
    .required(),
  renderDistance: Joi.number().integer().min(2).max(32).required(),
  startupFlags: Joi.string().allow("").max(600).optional(),
});

const serverUpdateSchema = Joi.object({
  version: Joi.string()
    .trim()
    .pattern(MINECRAFT_VERSION_PATTERN)
    .required()
    .messages({
      "string.pattern.base": "version must look like '1.21' or '1.20.1'.",
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

const resolveVanillaDownloadUrl = async (version) => {
  let manifest;
  try {
    const response = await axios.get(VANILLA_MANIFEST_URL);
    manifest = response.data;
  } catch (error) {
    throw new Error("Failed to retrieve vanilla version manifest");
  }

  const entry = manifest?.versions?.find((item) => item.id === version);
  if (!entry) {
    throw new Error(`Vanilla server version '${version}' was not found`);
  }

  try {
    const { data } = await axios.get(entry.url);
    const serverUrl = data?.downloads?.server?.url;
    if (!serverUrl) {
      throw new Error();
    }
    return serverUrl;
  } catch (error) {
    throw new Error(
      "Failed to retrieve vanilla server download information"
    );
  }
};

const resolvePaperProjectDownloadUrl = async (project, version, label = project) => {
  const projectBase = `${PAPER_PROJECTS_API}/${project}`;

  let versionMeta;
  try {
    const { data } = await axios.get(`${projectBase}/versions/${version}`);
    versionMeta = data;
  } catch (error) {
    if (error?.response?.status === 404) {
      throw new Error(`${label} server version '${version}' was not found`);
    }
    throw new Error(`Failed to retrieve ${label} version metadata`);
  }

  const builds = Array.isArray(versionMeta?.builds)
    ? versionMeta.builds
    : [];
  if (!builds.length) {
    throw new Error(`${label} server version '${version}' has no builds`);
  }

  const latestBuild = builds.reduce(
    (max, build) => (typeof build === "number" && build > max ? build : max),
    -Infinity
  );
  const selectedBuild = Number.isFinite(latestBuild)
    ? latestBuild
    : builds[builds.length - 1];

  let buildMeta;
  try {
    const { data } = await axios.get(
      `${projectBase}/versions/${version}/builds/${selectedBuild}`
    );
    buildMeta = data;
  } catch (error) {
    throw new Error(`Failed to retrieve ${label} build metadata`);
  }

  const applicationDownload = buildMeta?.downloads?.application;
  if (!applicationDownload?.name) {
    throw new Error(`${label} build metadata did not include a server jar`);
  }

  return `${projectBase}/versions/${version}/builds/${selectedBuild}/downloads/${applicationDownload.name}`;
};

const resolvePaperDownloadUrl = (version) =>
  resolvePaperProjectDownloadUrl("paper", version, "Paper");

const resolveWaterfallDownloadUrl = (version) =>
  resolvePaperProjectDownloadUrl("waterfall", version, "BungeeCord");

const resolveFabricDownloadUrl = async (version) => {
  let loaderEntries;
  try {
    const { data } = await axios.get(`${FABRIC_LOADER_ENDPOINT}/${version}`);
    loaderEntries = Array.isArray(data) ? data : [];
  } catch (error) {
    throw new Error("Failed to retrieve Fabric loader versions");
  }

  if (!loaderEntries.length) {
    throw new Error(`Fabric loader for Minecraft '${version}' was not found`);
  }

  const preferredLoader =
    loaderEntries.find(
      (entry) => entry?.loader?.stable && entry?.intermediary?.stable
    ) || loaderEntries[0];

  const loaderVersion = preferredLoader?.loader?.version;
  if (!loaderVersion) {
    throw new Error("Fabric loader metadata did not include a loader version");
  }

  let installerEntries;
  try {
    const { data } = await axios.get(FABRIC_INSTALLER_ENDPOINT);
    installerEntries = Array.isArray(data) ? data : [];
  } catch (error) {
    throw new Error("Failed to retrieve Fabric installer versions");
  }

  if (!installerEntries.length) {
    throw new Error("No Fabric installers available for download");
  }

  const installerVersion =
    installerEntries.find((entry) => entry?.stable)?.version ||
    installerEntries[0]?.version;

  if (!installerVersion) {
    throw new Error("Fabric installer metadata did not include a version");
  }

  return `${FABRIC_LOADER_ENDPOINT}/${version}/${loaderVersion}/${installerVersion}/server/jar`;
};

const resolveForgeArtifactDescriptor = async (version) => {
  let promotions;
  try {
    const { data } = await axios.get(FORGE_PROMOTIONS_URL);
    promotions = data?.promos || {};
  } catch (error) {
    throw new Error("Failed to retrieve Forge promotion metadata");
  }

  const recommendedKey = `${version}-recommended`;
  const latestKey = `${version}-latest`;
  const forgeBuild = promotions[recommendedKey] || promotions[latestKey];
  if (!forgeBuild) {
    throw new Error(`Forge build for Minecraft '${version}' was not found`);
  }

  const fullVersion = `${version}-${forgeBuild}`;
  const artifactBase = `${FORGE_MAVEN_BASE}/${fullVersion}`;
  return {
    fullVersion,
    installerUrl: `${artifactBase}/forge-${fullVersion}-installer.jar`,
  };
};

const runForgeInstaller = async ({ installerPath, serverRoot }) =>
  new Promise((resolve, reject) => {
    const child = spawn("java", ["-jar", installerPath, "--installServer"], {
      cwd: serverRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleData = (stream, label) => {
      stream.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          console.log(`[Forge installer:${label}] ${text}`);
        }
      });
    };

    if (child.stdout) handleData(child.stdout, "stdout");
    if (child.stderr) handleData(child.stderr, "stderr");

    child.on("error", (error) => {
      reject(new Error(`Failed to start Forge installer: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Forge installer exited with code ${code}`));
      }
    });
  });

const installForgeServer = async ({ version, serverRoot, jarPath }) => {
  const descriptor = await resolveForgeArtifactDescriptor(version);
  const installerPath = path.join(
    serverRoot,
    `forge-installer-${descriptor.fullVersion}.jar`
  );

  await downloadFile(descriptor.installerUrl, installerPath);
  await runForgeInstaller({ installerPath, serverRoot });

  const files = await fs.readdir(serverRoot);
  const jarCandidates = files.filter(
    (name) =>
      name.endsWith(".jar") &&
      name.startsWith(`forge-${descriptor.fullVersion}`) &&
      !name.includes("installer")
  );

  jarCandidates.sort((a, b) => {
    const aServer = a.includes("-server.jar");
    const bServer = b.includes("-server.jar");
    if (aServer && !bServer) return -1;
    if (!aServer && bServer) return 1;
    return a.length - b.length;
  });

  const forgeJarName = jarCandidates[0];

  if (!forgeJarName) {
    throw new Error(
      "Forge installer completed but the server jar was not found in the installation directory"
    );
  }

  await fs.move(path.join(serverRoot, forgeJarName), jarPath, { overwrite: true });
  await fs.remove(installerPath).catch(() => {});
};

const downloadServerJar = async ({ version, serverRoot, serverType }) => {
  const normalizedVersion = typeof version === "string" ? version.trim() : version;
  const jarPath = path.join(serverRoot, "server.jar");
  const normalizedType = normalizeServerType(serverType);
  const typeLabel = getServerTypeLabel(normalizedType);
  if (!typeLabel) {
    throw new Error(
      `Unsupported server type '${serverType ?? ""}'`
    );
  }
  if (await fs.pathExists(jarPath)) {
    await fs.remove(jarPath);
  }

  switch (normalizedType) {
    case "vanilla": {
      ensureMinecraftVersion(normalizedVersion, typeLabel);
      const downloadUrl = await resolveVanillaDownloadUrl(normalizedVersion);
      await downloadFile(downloadUrl, jarPath);
      return;
    }
    case "paper": {
      ensureMinecraftVersion(normalizedVersion, typeLabel);
      const downloadUrl = await resolvePaperDownloadUrl(normalizedVersion);
      await downloadFile(downloadUrl, jarPath);
      return;
    }
    case "fabric": {
      ensureMinecraftVersion(normalizedVersion, typeLabel);
      const downloadUrl = await resolveFabricDownloadUrl(normalizedVersion);
      await downloadFile(downloadUrl, jarPath);
      return;
    }
    case "forge": {
      ensureMinecraftVersion(normalizedVersion, typeLabel);
      await installForgeServer({
        version: normalizedVersion,
        serverRoot,
        jarPath,
      });
      return;
    }
    case "bungeecord": {
      ensureMinecraftVersion(normalizedVersion, typeLabel);
      const downloadUrl = await resolveWaterfallDownloadUrl(normalizedVersion);
      await downloadFile(downloadUrl, jarPath);
      return;
    }
    default:
      throw new Error(`Unsupported server type '${serverType}'`);
  }
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
    const serverType = normalizeServerType(value.serverType);
    if (!getServerTypeLabel(serverType)) {
      return res.status(400).send("Unsupported server type requested");
    }
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
        await downloadServerJar({
          version,
          serverRoot,
          serverType,
        });
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
        const statusCode = toDownloadErrorStatus(error);
        return res
          .status(statusCode)
          .send(error?.message || "Failed to download server files");
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
      const serverType = normalizeServerType(req.server.serverType);
      const serverTypeLabel = getServerTypeLabel(serverType);
      if (!serverTypeLabel) {
        return res
          .status(400)
          .send("Server type is missing or unsupported; cannot update server");
      }
      if (req.server.serverType !== serverType) {
        db.run("UPDATE servers SET serverType = ? WHERE uuid = ?", [
          serverType,
          req.server.uuid,
        ]);
        req.server.serverType = serverType;
      }
      const version = value.version;
      try {
        await downloadServerJar({
          version,
          serverRoot,
          serverType,
        });
      } catch (error) {
        console.error("Error downloading files:", error);
        const statusCode = toDownloadErrorStatus(error);
        return res
          .status(statusCode)
          .send(error?.message || "Failed to download server files");
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
