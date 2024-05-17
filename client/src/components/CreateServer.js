import React, { useState, useEffect } from "react";
import axios from "axios";

const CreateMinecraftServer = () => {
  const [serverName, setServerName] = useState("");
  const [memoryGB, setMemoryGB] = useState(1); // default to 1GB
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [port, setPort] = useState(25565); // default Minecraft port

  // validate session
  useEffect(() => {
    axios
      .get("http://localhost:3001/validate-session", { withCredentials: true })
      .catch((error) => {
        window.location.href = "/";
      });
  }, []);

  const handleServerNameChange = (e) => {
    setServerName(e.target.value);
  };

  const handleMemoryGBChange = (e) => {
    setMemoryGB(e.target.value);
  };

  const handleMinecraftVersionChange = (e) => {
    setMinecraftVersion(e.target.value);
  };

  const handlePortChange = (e) => {
    setPort(e.target.value);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!serverName || !memoryGB || !minecraftVersion || !port) {
      alert("Please fill all fields before submitting!");
      return;
    }

    const startupCommand = `java -Xmx${memoryGB}G -Xms${memoryGB}G -jar server.jar nogui`;

    // posts the data to the server using axios
    axios
      .post(
        "http://localhost:3001/servers",
        {
          name: serverName,
          memory: memoryGB,
          version: minecraftVersion,
          port: port,
          startupCommand: startupCommand,
        },
        { withCredentials: true }
      )
      .then(() => {
        window.location.href = "/";
      })
      .catch((error) => {
        alert("Failed to create the server. Please try again.");
        console.error("Error:", error);
      });
  };

  return (
    <div>
      <h1>Create New Minecraft Server</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Server Name:
          <input
            type="text"
            value={serverName}
            onChange={handleServerNameChange}
          />
        </label>

        <label>
          Memory (GB):
          <input
            type="number"
            value={memoryGB}
            min="1"
            max="32" // Assuming a reasonable maximum for memory
            onChange={handleMemoryGBChange}
          />
        </label>

        <label>
          Minecraft Version:
          <select
            value={minecraftVersion}
            onChange={handleMinecraftVersionChange}
          >
            <option value="">Select Minecraft Version</option>
            <option value="1.7.10">1.7.10</option>
            <option value="1.8.9">1.8.9</option>
            <option value="1.12.2">1.12.2</option>
            <option value="1.16.5">1.16.5</option>
            <option value="1.20.4">1.20.4</option>
            <option value="latest">latest</option>
          </select>
        </label>

        <label>
          Port:
          <input type="number" value={port} onChange={handlePortChange} />
        </label>

        <button type="submit">Create Minecraft Server</button>
      </form>
    </div>
  );
};

export default CreateMinecraftServer;
