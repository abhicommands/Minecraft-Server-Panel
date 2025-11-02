require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { router: authRoutes, authenticateSocket } = require("./routes/auth");
const fileRoutes = require("./routes/fileRoutes");
const serverManagementRoutes = require("./routes/serverManagementRoutes");
const { db } = require("./db/db");
const fs = require("fs-extra");
const path = require("path");
const { validate } = require("uuid");
const socket = require("socket.io");
const http = require("http");
const cookie = require("cookie");
const kill = require("tree-kill");
const {
  createTerminal,
  initializeTerminal,
  composeStartupCommand,
} = require("./utils/terminal");

let terminals = {};
const SERVERS_BASE_PATH = path.join(__dirname, "./server-directory");

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
const server = http.createServer(app);
const io = socket(server, {
  cors: {
    origin: process.env.CORSORIGIN,
    methods: ["GET", "POST", "DELETE"],
    credentials: true, // Important for sending cookies and headers
  },
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
      "SELECT path, startupCommand, startupFlags FROM servers WHERE uuid = ?",
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
            row.startupCommand,
            row.startupFlags
          );
          initializeTerminal(
            io,
            serverId,
            terminals[serverId],
            path.join(row.path, "../logs")
          );
        } else {
          terminals[serverId].baseCommand = row.startupCommand;
          terminals[serverId].startupFlags = row.startupFlags || "";
          terminals[serverId].startupCommand = composeStartupCommand(
            row.startupCommand,
            row.startupFlags
          );
        }
        fs.ensureFileSync(logFilePath);
        const history = fs.readFileSync(logFilePath, "utf8");
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
      const commandToRun = composeStartupCommand(
        terminal.baseCommand || terminal.startupCommand,
        terminal.startupFlags || ""
      );
      terminal.startupCommand = commandToRun;
      terminal.ptyProcess.write(
        `${commandToRun} & echo $! > ../minecraft_pid.txt; fg\n`
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
app.use(serverManagementRoutes(terminals, io));

server.listen(process.env.PORT, () => {
  console.log(`Server is running on http://localhost:${process.env.PORT}`);
});
