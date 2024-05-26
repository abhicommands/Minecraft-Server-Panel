import React, { useState, useEffect } from "react";
import axios from "axios";
import "./CreateServer.css";

const CreateMinecraftServer = () => {
  const [serverName, setServerName] = useState("");
  const [memoryGB, setMemoryGB] = useState(1); // default to 1GB
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [port, setPort] = useState(25565); // default Minecraft port
  const [loading, setLoading] = useState(false);
  const API_URL = process.env.REACT_APP_API_URL;

  // validate session
  useEffect(() => {
    axios
      .get(`${API_URL}/validate-session`, { withCredentials: true })
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

    setLoading(true);

    axios
      .post(
        `${API_URL}/servers`,
        {
          name: serverName,
          memory: memoryGB,
          version: minecraftVersion,
          port: port,
        },
        { withCredentials: true }
      )
      .then(() => {
        window.location.href = "/";
      })
      .catch((error) => {
        alert("Failed to create the server. Please try again.");
        console.error("Error:", error);
        setLoading(false);
      });
  };

  return (
    <div>
      <h1>Create New Minecraft Server</h1>
      {loading ? (
        <div className="spinner-container">
          <div className="spinner"></div>
          <p>Creating server, please wait...</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <label>
            Server Name:
            <input
              type="text"
              value={serverName}
              onChange={handleServerNameChange}
              disabled={loading}
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
              disabled={loading}
            />
          </label>

          <label>
            Minecraft Version:
            <select
              value={minecraftVersion}
              onChange={handleMinecraftVersionChange}
              disabled={loading}
            >
              <option value="">Select Minecraft Version</option>
              <option value="1.7.10">1.7.10</option>
              <option value="1.8.9">1.8.9</option>
              <option value="1.12.2">1.12.2</option>
              <option value="1.16.5">1.16.5</option>
              <option value="1.17.1">1.17.1</option>
              <option value="1.18.1">1.18.1</option>
              <option value="1.19.3">1.19.3</option>
              <option value="1.20.2">1.20.2</option>
              <option value="1.20.4">1.20.4</option>
              <option value="latest">latest</option>
            </select>
          </label>

          <label>
            Port:
            <input
              type="number"
              value={port}
              onChange={handlePortChange}
              disabled={loading}
            />
          </label>

          <button type="submit" disabled={loading}>
            Create Minecraft Server
          </button>
        </form>
      )}
    </div>
  );
};

export default CreateMinecraftServer;
