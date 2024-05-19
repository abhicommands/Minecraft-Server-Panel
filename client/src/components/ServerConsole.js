// ServerConsole.js
import React, { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
// Establish socket connection with the token

function ServerConsole() {
  const { id } = useParams();
  const API_URL = process.env.REACT_APP_API_URL;
  const terminalRef = useRef(null);
  const fitAddon = new FitAddon();
  const socket = io(`${API_URL}`, {
    withCredentials: true,
    extraHeaders: {
      "server-id": id,
    },
  });

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      theme: {
        background: "#000000",
        foreground: "#ffffff",
      },
    });
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    socket.on("output", (data) => {
      term.write(data);
    });

    const handleResize = () => {
      fitAddon.fit();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      socket.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [id, fitAddon]);

  const sendCommand = (command) => {
    if (command.trim() !== "") {
      socket.emit("command", command);
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
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default ServerConsole;
