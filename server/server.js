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
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const pty = require("node-pty");
const socket = require("socket.io");
const http = require("http");
const cookie = require("cookie");

const app = express();
app.set("trust proxy", 1);
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

const server = http.createServer(app);
const io = socket(server, {
  cors: {
    origin: process.env.CORSORIGIN,
    methods: ["GET", "POST", "DELETE"],
    credentials: true, // Important for sending cookies and headers
  },
});

let terminals = {};

const createTerminal = (logDir, startupCommand) => {
  const shell = "bash";
  const pathOfRoot = path.join(logDir, "../root");
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-color",
    cwd: pathOfRoot,
    env: process.env,
  });
  fs.ensureDirSync(logDir);
  let serverPID = null;
  let isServerRunning = false; // Ensure the log directory exists
  return { ptyProcess, isServerRunning, startupCommand, serverPID };
};
const initializeTerminal = (serverId, terminalPty, logDir) => {
  const logFile = fs.createWriteStream(path.join(logDir, "server.log"), {
    flags: "a",
  });
  terminalPty.ptyProcess.on("data", function (rawOutput) {
    if (io.sockets.adapter.rooms.get(serverId))
      io.to(serverId).emit("output", rawOutput);
    logFile.write(rawOutput);
    if (fs.existsSync(path.join(logDir, "../minecraft_pid.txt")))
      terminalPty.serverPID = parseInt(
        fs.readFileSync(path.join(logDir, "../minecraft_pid.txt"), "utf8")
      );
    if (terminalPty.serverPID) {
      try {
        process.kill(terminalPty.serverPID, 0);
        terminalPty.isServerRunning = true;
        if (io.sockets.adapter.rooms.get(serverId))
          io.to(serverId).emit("serverStatus", true);
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

const SERVERS_BASE_PATH = path.join(__dirname, "server-directory");
//create new server
app.post("/servers", authenticate, async (req, res) => {
  const serverId = uuidv4();
  const serverPath = path.join(SERVERS_BASE_PATH, serverId);
  const serverRoot = path.join(serverPath, "root");
  const backupPath = path.join(serverPath, "backup");
  fs.ensureDirSync(serverPath);
  fs.ensureDirSync(serverRoot);
  fs.ensureDirSync(backupPath);
  fs.ensureDirSync(path.join(serverPath, "logs")); //create a logs directory
  // Extracting request data with default values
  const name = req.body.name || "Minecraft Server";
  const startupCommand = `java -Xmx${req.body.memory}G -jar server.jar nogui`;
  const port = req.body.port || 25565;
  const version =
    req.body.version === "latest" || !req.body.version
      ? "stable"
      : req.body.version;
  const logDir = path.join(serverPath, "logs");
  const terminal = createTerminal(logDir, startupCommand);
  //create the ptyprocess.on
  terminals[serverId] = terminal;
  terminalPty = terminals[serverId];
  initializeTerminal(serverId, terminalPty, logDir);
  terminals[serverId] = terminal;
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
        version,
        port,
      });
    }
  );
  try {
    const fabricUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}/stable/stable/server/jar`;
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
    //write the port to the server.properties file
    const propertiesPath = path.join(serverRoot, "server.properties");
    fs.ensureFileSync(propertiesPath);
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
query.port=${port}
rate-limit=0
rcon.password=
rcon.port=25575
require-resource-pack=false
resource-pack=
resource-pack-id=
resource-pack-prompt=
resource-pack-sha1=
server-ip=
server-port=${port}
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
//get server list
app.get("/servers", authenticate, (req, res) => {
  db.all("SELECT * FROM servers", [], (err, rows) => {
    if (err) {
      res.status(500).send("Failed to retrieve servers");
    } else {
      const servers = rows.map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        port: row.port,
      }));
      res.json({ servers, username: req.user.username });
    }
  });
});
//get server by id
app.get("/servers/:id", authenticate, findServer, (req, res) => {
  //dont send all the information just send crucial information that the user inputted when creating the server
  res.json({
    id: req.server.id,
    name: req.server.name,
    version: req.server.version,
    port: req.server.port,
  });
});
//delete server
app.delete("/servers/:id", authenticate, (req, res) => {
  const serverId = req.params.id;
  db.run("DELETE FROM servers WHERE id = ?", serverId, function (err) {
    if (err) {
      res.status(500).send("Failed to delete server");
    } else if (this.changes === 0) {
      res.status(404).send("Server not found");
    } else {
      const terminal = terminals[serverId];
      if (terminal) {
        if (terminal.isServerRunning)
          process.kill(terminal.serverPID, "SIGKILL");
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
  authenticateSocket(token, (error, user) => {
    if (error) {
      return next(new Error("Authentication error"));
    }
    socket.user = user;
    db.get(
      "SELECT path, startupCommand FROM servers WHERE id = ?",
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
        `${terminal.startupCommand} & echo $! > ../minecraft_pid.txt; fg\n`
      );
    } else {
      socket.emit(
        "output",
        "Error: command isn't valid or server is already running"
      );
    }
  });
  socket.on("stopServer", () => {
    if (terminal && terminal.isServerRunning) {
      terminal.ptyProcess.write("stop\n");
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
      terminal.ptyProcess.kill();
      //kill any child processes that were created during the terminals process
      if (terminal.serverPID) {
        process.kill(terminal.serverPID);
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
