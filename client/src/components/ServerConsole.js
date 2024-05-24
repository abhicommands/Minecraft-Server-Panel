import React, { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function ServerConsole() {
  const { id } = useParams();
  const API_URL = process.env.REACT_APP_SOCKET_URL;
  const socketPath = process.env.REACT_APP_SOCKET_PATH;
  const terminalRef = useRef(null);
  const term = useRef(null);
  const fitAddon = useRef(new FitAddon());
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [socket, setSocket] = useState(null);
  const [serverStopped, setServerStopped] = useState(false);

  useEffect(() => {
    const socketInstance = io(`${API_URL}`, {
      withCredentials: true,
      extraHeaders: {
        "server-id": id,
      },
      path: socketPath,
    });

    setSocket(socketInstance);

    socketInstance.on("serverStatus", (status) => {
      setIsServerRunning(status);
      if (!status) setServerStopped(false); // Reset the button state when server is running
    });

    socketInstance.on("output", (data) => {
      if (term.current) {
        term.current.write(data);
      }
    });

    return () => {
      socketInstance.disconnect();
    };
  }, [id, API_URL]);

  useEffect(() => {
    if (terminalRef.current) {
      if (!term.current) {
        term.current = new Terminal({
          cursorBlink: true,
          theme: {
            background: "#000000",
            foreground: "#ffffff",
          },
        });
        term.current.loadAddon(fitAddon.current);
        term.current.open(terminalRef.current);
        fitAddon.current.fit();
      } else {
        fitAddon.current.fit();
      }
    }
  }, [terminalRef]);

  const sendCommand = (command) => {
    if (command.trim() !== "" && isServerRunning && socket) {
      socket.emit("command", command);
    }
  };

  const startServer = () => {
    if (socket) {
      socket.emit("startServer");
    }
  };

  const stopServer = () => {
    if (socket) {
      socket.emit("stopServer");
      setServerStopped(true);
    }
  };

  const killServer = () => {
    if (socket) {
      socket.emit("killServer");
      setServerStopped(false); // Reset the button state after killing the server
    }
  };

  return (
    <div>
      <h2>Console - Server {id}</h2>
      <div
        ref={terminalRef}
        style={{ height: "300px", width: "100%", backgroundColor: "#000" }}
      ></div>
      <div>
        <input
          type="text"
          disabled={!isServerRunning}
          onKeyPress={(e) => {
            if (e.key === "Enter") {
              sendCommand(e.target.value);
              e.target.value = "";
            }
          }}
        />
        <button
          onClick={(e) => {
            const input = e.target.previousSibling;
            sendCommand(input.value);
            input.value = "";
          }}
          disabled={!isServerRunning}
        >
          Send
        </button>
      </div>
      <button onClick={startServer} disabled={isServerRunning}>
        Start Server
      </button>
      <button
        onClick={serverStopped ? killServer : stopServer}
        disabled={!isServerRunning && !serverStopped}
      >
        {serverStopped ? "Kill Server" : "Stop Server"}
      </button>
    </div>
  );
}

export default ServerConsole;
