const pty = require("node-pty");
const fs = require("fs-extra");
const path = require("path");

const composeStartupCommand = (baseCommand = "", flags = "") => {
  const trimmedBase = String(baseCommand || "").trim();
  const trimmedFlags = String(flags || "").trim();
  if (!trimmedFlags) {
    return trimmedBase;
  }

  const jarMatch = trimmedBase.match(/\s-jar\b/i);
  if (!jarMatch || typeof jarMatch.index !== "number") {
    return `${trimmedBase} ${trimmedFlags}`.trim();
  }

  const prefix = trimmedBase.slice(0, jarMatch.index).trimEnd();
  const suffix = trimmedBase.slice(jarMatch.index).trimStart();
  return `${prefix} ${trimmedFlags} ${suffix}`.trim();
};

const createTerminal = (logDir, baseCommand, startupFlags) => {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "powershell.exe" : "bash";
  const pathOfRoot = path.join(logDir, "../root/");
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
  const finalCommand = composeStartupCommand(baseCommand, startupFlags);
  return {
    ptyProcess,
    isServerRunning,
    startupCommand: finalCommand,
    baseCommand: String(baseCommand || "").trim(),
    startupFlags,
    serverPID,
  };
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

module.exports = { createTerminal, initializeTerminal, composeStartupCommand };
