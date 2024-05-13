import React, { useState, useEffect } from "react";
import axios from "axios";

const CreateServer = () => {
  const [serverName, setServerName] = useState("");
  const [storageGB, setStorageGB] = useState(0);
  const [serverType, setServerType] = useState("");

  //validate session
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

  const handleStorageGBChange = (e) => {
    setStorageGB(e.target.value);
  };

  const handleServerTypeChange = (e) => {
    setServerType(e.target.value);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    //posts the data to the server using axios
    axios.post(
      "http://localhost:3001/servers",
      {
        name: serverName,
        storage: storageGB,
        type: serverType,
      },
      { withCredentials: true }
    );
    //redirects to the servers page
    window.location.href = "/";
    // TODO: Handle server creation logic here
  };

  return (
    <div>
      <h1>Create New Server</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Server Name:
          <input
            type="text"
            value={serverName}
            onChange={handleServerNameChange}
          />
        </label>
        <br />
        <label>
          Storage (GB):
          <input
            type="number"
            value={storageGB}
            onChange={handleStorageGBChange}
          />
        </label>
        <br />
        <label>
          Server Type:
          <select value={serverType} onChange={handleServerTypeChange}>
            <option value="">Select Server Type</option>
            <option value="web">Web Server</option>
            <option value="database">Database Server</option>
            <option value="application">Application Server</option>
          </select>
        </label>
        <br />
        <button type="submit">Create Server</button>
      </form>
    </div>
  );
};

export default CreateServer;
