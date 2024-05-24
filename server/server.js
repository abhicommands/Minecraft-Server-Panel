require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const {
  router: authRoutes,
  authenticate,
  authenticateSocket,
} = require("./routes/auth");
const fileRoutes = require("./routes/fileRoutes");
const { db, findServer } = require("./db/db");
const fs = require("fs-extra");
const path = require("path");
const { v4: uuidv4, validate } = require("uuid");
const axios = require("axios");
const pty = require("node-pty");
const socket = require("socket.io");
const http = require("http");
const cookie = require("cookie");
const os = require("os");
const kill = require("tree-kill");
const Joi = require("joi");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: process.env.CORSORIGIN,
    methods: ["GET", "POST", "DELETE"],
    credentials: true,
  })
);
app.use(cookieParser());
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = socket(server, {
  cors: {
    origin: process.env.CORSORIGIN,
    methods: ["GET", "POST", "DELETE"],
    credentials: true, // Important for sending cookies and headers
  },
});

const MAX_LOG_SIZE = 1024 * 1024;
const serverCreateSchema = Joi.object({
  name: Joi.string().required(),
  memory: Joi.number()
    .integer()
    .min(1)
    .max(os.totalmem() / 1024 / 1024 / 1024)
    .required(),
  port: Joi.number().required(),
  version: Joi.string()
    .custom((value, helpers) => {
      // Custom rule to transform 'latest' to 'stable'
      if (value === "latest") {
        return "stable";
      }
      return value; // Return the value unchanged if it's not 'latest'
    })
    .required(),
});
const serverUpdateSchema = Joi.object({
  version: Joi.string()
    .custom((value, helpers) => {
      // Custom rule to transform 'latest' to 'stable'
      if (value === "latest") {
        return "stable";
      }
      return value; // Return the value unchanged if it's not 'latest'
    })
    .required(),
});

let terminals = {};

const createTerminal = (logDir, startupCommand) => {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "powershell.exe" : "bash";
  const pathOfRoot = path.join(logDir, "../");
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cwd: pathOfRoot,
    env: {
      ...process.env,
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    },
  });
  fs.ensureDirSync(logDir);
  let serverPID = null;
  let isServerRunning = false; // Ensure the log directory exists
  return { ptyProcess, isServerRunning, startupCommand, serverPID };
};
const initializeTerminal = (serverId, terminalPty, logDir) => {
  const logFilePath = path.join(logDir, "server.log");
  fs.ensureFileSync(logFilePath);
  fs.removeSync(path.join(logDir, "../minecraft_pid.txt"));
  const truncateLogFile = (filePath) => {
    const data = fs.readFileSync(filePath, "utf8");
    if (data.length > MAX_LOG_SIZE) {
      const truncatedData = data.slice(data.length - MAX_LOG_SIZE);
      fs.writeFileSync(filePath, truncatedData, "utf8");
    }
  };
  terminalPty.ptyProcess.on("data", function (rawOutput) {
    if (io.sockets.adapter.rooms.get(serverId))
      io.to(serverId).emit("output", rawOutput);
    fs.appendFileSync(logFilePath, rawOutput);
    truncateLogFile(logFilePath);
    if (fs.existsSync(path.join(logDir, "../minecraft_pid.txt")))
      terminalPty.serverPID = parseInt(
        fs.readFileSync(path.join(logDir, "../minecraft_pid.txt"), "utf8")
      );
    if (terminalPty.serverPID) {
      try {
        process.kill(terminalPty.serverPID, 0);
        terminalPty.isServerRunning = true;
        if (rawOutput.includes("MINECRAFT SERVER IS ONLINE!")) {
          if (io.sockets.adapter.rooms.get(serverId))
            io.to(serverId).emit("serverStatus", true);
        } else if (rawOutput.includes("MINECRAFT SERVER IS OFFLINE!")) {
          if (io.sockets.adapter.rooms.get(serverId))
            io.to(serverId).emit("serverStatus", false);
        }
      } catch (error) {
        terminalPty.isServerRunning = false;
        if (io.sockets.adapter.rooms.get(serverId))
          io.to(serverId).emit("serverStatus", false);
      }
    } else {
      terminalPty.isServerRunning = false;
      if (io.sockets.adapter.rooms.get(serverId))
        io.to(serverId).emit("serverStatus", false);
    }
  });
};

const downloadFile = async (url, dest) => {
  const response = await axios({
    method: "get",
    url,
    responseType: "stream",
  });

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
const downloadMsh = async (serverRoot) => {
  const mshUrl =
    "https://msh.gekware.net/builds/darwin/arm64/msh-v2.5.0-350c73e-darwin-arm64.osx";
  const mshPath = path.join(serverRoot, "msh_server.osx");
  await downloadFile(mshUrl, mshPath);
  fs.chmodSync(mshPath, 0o755);
};
const SERVERS_BASE_PATH = path.join(__dirname, "server-directory");
//create new server
app.post("/servers", authenticate, async (req, res) => {
  const { error, value } = serverCreateSchema.validate(req.body);
  if (error) {
    return res.status(400).send(error.details[0].message);
  }
  const name = value.name;
  const port = value.port;
  const startupCommand = `./msh_server.osx -port ${port}`;
  const response = await axios.get(
    `https://meta.fabricmc.net/v1/versions/game/${value.version}`
  );
  if (!response.data.length) {
    res.status(400).send("Invalid version number");
    return;
  }
  const version = value.version;
  const serverId = uuidv4();
  const serverPath = path.join(SERVERS_BASE_PATH, serverId);
  const serverRoot = path.join(serverPath, "root");
  const backupPath = path.join(serverPath, "backup");
  fs.ensureDirSync(serverPath);
  fs.ensureDirSync(serverRoot);
  fs.ensureDirSync(backupPath);
  fs.ensureDirSync(path.join(serverPath, "logs"));
  const logDir = path.join(serverPath, "logs");
  const terminal = createTerminal(logDir, startupCommand);
  terminals[serverId] = terminal;
  terminalPty = terminals[serverId];
  initializeTerminal(serverId, terminalPty, logDir);
  terminals[serverId] = terminal;
  db.run(
    "INSERT INTO servers (uuid, name, path, backupPath, startupCommand, version, port) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [serverId, name, serverRoot, backupPath, startupCommand, version, port],
    function (err) {
      if (err) {
        res.status(500).send("Failed to create server");
        return;
      }
      res.status(201).json({ id: serverId, name, version, port }); // Return uuid instead of id
    }
  );
  try {
    try {
      await downloadServerJar(version, serverRoot);
      await downloadMsh(serverPath);
    } catch (error) {
      console.error("Error downloading files:", error);
    }
    //write the port to the server.properties file
    const propertiesPath = path.join(serverRoot, "server.properties");
    fs.ensureFileSync(propertiesPath);
    const mshConfPath = path.join(serverPath, "msh-config.json");
    fs.ensureFileSync(mshConfPath);
    const mshStartParam = `-Xmx${value.memory}G -Xms${value.memory}G`;
    const minecraftPort = parseInt(port, 10) + 1;
    const mshConf = {
      Server: {
        Folder: "./root/",
        FileName: "server.jar",
        Version: version,
        Protocol: 760,
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
  }
});
//get server list
app.get("/servers", authenticate, (req, res) => {
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
app.post("/servers/:id/update", authenticate, findServer, async (req, res) => {
  const { error, value } = serverUpdateSchema.validate(req.body);
  if (error) {
    return res.status(400).send(error.details[0].message);
  }
  const serverRoot = req.server.path;
  const response = await axios.get(
    `https://meta.fabricmc.net/v1/versions/game/${version}`
  );
  if (!response.data.length) {
    res.status(400).send("Invalid version number");
    return;
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
  res.send("Server updated successfully");
});

//get server by id
app.get("/servers/:id", authenticate, findServer, (req, res) => {
  //dont send all the information just send crucial information that the user inputted when creating the server
  res.json({
    id: req.server.uuid,
    name: req.server.name,
    version: req.server.version,
    port: req.server.port,
  });
});
//delete server
app.delete("/servers/:id", authenticate, (req, res) => {
  const serverId = req.params.id;
  if (!validate(serverId)) {
    res.status(400).send("Invalid UUID");
    return;
  }
  db.run("DELETE FROM servers WHERE uuid = ?", serverId, function (err) {
    if (err) {
      res.status(500).send("Failed to delete server");
    } else if (this.changes === 0) {
      res.status(404).send("Server not found");
    } else {
      const terminal = terminals[serverId];
      if (terminal) {
        kill(terminal.serverPID, "SIGKILL");
        terminal.ptyProcess.kill();
        delete terminals[serverId];
      }
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
//authenticate io
io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || "");
  const token = cookies.token;
  const serverId = socket.handshake.headers["server-id"] || "";
  if (!token) return next(new Error("Authentication error"));
  if (!serverId) return next(new Error("Server ID not found"));
  if (validate(serverId) === false)
    return next(new Error("Server ID not found"));
  authenticateSocket(token, (error, user) => {
    if (error) {
      return next(new Error("Authentication error"));
    }
    socket.user = user;
    db.get(
      "SELECT path, startupCommand FROM servers WHERE uuid = ?",
      [serverId],
      (err, row) => {
        if (err || !row) {
          socket.emit("output", "Error: Server not found");
          return next(new Error("Server ID not found"));
        }
        const logFilePath = path.join(row.path, "../logs", "server.log");
        if (!terminals[serverId]) {
          terminals[serverId] = createTerminal(
            path.join(row.path, "../logs"),
            row.startupCommand
          );
          initializeTerminal(
            serverId,
            terminals[serverId],
            path.join(row.path, "../logs")
          );
        }
        fs.ensureFileSync(logFilePath);
        const history = fs.readFileSync(logFilePath, "utf8");
        socket.path = row.path;
        socket.emit("output", history);
        if (terminals[serverId].isServerRunning) {
          socket.emit("serverStatus", true);
        }
      }
    );
    socket.serverId = serverId;
    next();
  });
});
io.on("connection", (socket) => {
  socket.join(socket.serverId);
  const terminal = terminals[socket.serverId];
  socket.on("command", (data) => {
    if (terminal && terminal.isServerRunning) {
      terminal.ptyProcess.write(`${data}\n`);
    } else {
      socket.emit("output", "Error: Terminal not found");
    }
  });
  socket.on("startServer", () => {
    if (terminal && !terminal.isServerRunning) {
      fs.ensureFileSync(
        path.join(SERVERS_BASE_PATH, socket.serverId, "./minecraft_pid.txt")
      );
      terminal.ptyProcess.write(
        `${terminal.startupCommand} & echo $! > ./minecraft_pid.txt; fg\n`
      );
      setTimeout(() => {
        terminal.ptyProcess.write("msh start\n");
      }, 2000);
    } else if (terminal && terminal.isServerRunning) {
      terminal.ptyProcess.write("msh start\n");
    } else {
      socket.emit(
        "output",
        "Error: command isn't valid or server is already running"
      );
    }
  });
  socket.on("stopServer", () => {
    if (terminal && terminal.isServerRunning) {
      terminal.ptyProcess.write("msh exit\n");
      fs.removeSync(
        path.join(SERVERS_BASE_PATH, socket.serverId, "./minecraft_pid.txt")
      );
    } else {
      socket.emit(
        "output",
        "Error: Command isn't valid or server isn't running"
      );
    }
  });
  socket.on("killServer", () => {
    if (terminal && terminal.isServerRunning) {
      if (terminal.serverPID) {
        kill(terminal.serverPID, "SIGKILL");
      }
      terminal.isServerRunning = false;
      io.to(socket.serverId).emit("serverStatus", false);
    } else {
      socket.emit(
        "output",
        "Error: Command isn't valid or server isn't running"
      );
    }
  });
  socket.on("disconnect", () => {
    socket.disconnect();
  });
  socket.on("error", (error) => {
    console.error("Socket.IO error:", error);
  });
});

app.use(authRoutes);
app.use(fileRoutes);

server.listen(process.env.PORT, () => {
  console.log(`Server is running on http://localhost:${process.env.PORT}`);
});
