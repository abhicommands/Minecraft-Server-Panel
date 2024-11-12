const pty = require("node-pty");
const fs = require("fs-extra");
const path = require("path");

const createTerminal = (logDir, startupCommand, isMsh) => {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "powershell.exe" : "bash";
  const pathOfRoot = isMsh
    ? path.join(logDir, "../")
    : path.join(logDir, "../root/");
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
  return { ptyProcess, isServerRunning, startupCommand, serverPID, isMsh };
};

const truncateLogFile = (logFilePath, maxLines = 1000) => {
  try {
    const data = fs.readFileSync(logFilePath, "utf8");
    const lines = data.split("\n");
    if (lines.length > maxLines) {
      const truncatedData = lines.slice(-maxLines).join("\n");
      fs.writeFileSync(logFilePath, truncatedData, "utf8");
    }
  } catch (err) {
    console.error("Error truncating log file:", err);
  }
};

const initializeTerminal = (io, serverId, terminalPty, logDir) => {
  const logFilePath = path.join(logDir, "server.log");
  const logFile = fs.createWriteStream(logFilePath, { flags: "a" });
  fs.removeSync(path.join(logDir, "../minecraft_pid.txt"));

  terminalPty.ptyProcess.on("data", function (rawOutput) {
    if (io.sockets.adapter.rooms.get(serverId)) {
      io.to(serverId).emit("output", rawOutput);
    }

    logFile.write(rawOutput);

    // Check and truncate log file if it exceeds the max line count
    truncateLogFile(logFilePath);

    if (fs.existsSync(path.join(logDir, "../minecraft_pid.txt"))) {
      terminalPty.serverPID = parseInt(
        fs.readFileSync(path.join(logDir, "../minecraft_pid.txt"), "utf8")
      );
    }
    if (terminalPty.serverPID) {
      try {
        process.kill(terminalPty.serverPID, 0);
        terminalPty.isServerRunning = true;
        if (terminalPty.isMsh) {
          if (rawOutput.includes("MINECRAFT SERVER IS ONLINE!")) {
            if (io.sockets.adapter.rooms.get(serverId))
              io.to(serverId).emit("serverStatus", true);
          } else if (rawOutput.includes("MINECRAFT SERVER IS OFFLINE!")) {
            if (io.sockets.adapter.rooms.get(serverId))
              io.to(serverId).emit("serverStatus", false);
          }
        } else {
          if (io.sockets.adapter.rooms.get(serverId))
            io.to(serverId).emit("serverStatus", true);
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

module.exports = { createTerminal, initializeTerminal };
