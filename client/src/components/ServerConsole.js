// ServerConsole.js
import React, { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import io from "socket.io-client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
// Establish socket connection with the token
const socket = io("http://localhost:3001", {
  withCredentials: true,
});

function ServerConsole() {
  const { id } = useParams();
  const terminalRef = useRef(null);
  const fitAddon = new FitAddon();

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

    socket.emit("join", id);

    socket.on("output", (data) => {
      term.write(data);
    });

    const handleResize = () => {
      fitAddon.fit();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      socket.off("output");
      socket.emit("leave", id);
      window.removeEventListener("resize", handleResize);
    };
  }, [id, fitAddon]);

  const sendCommand = (command) => {
    if (command.trim() !== "") {
      socket.emit("command", { serverId: id, command });
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
