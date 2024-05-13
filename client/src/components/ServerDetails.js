// ServerDetails.js
import React from "react";
import { useParams, Link, Route, Routes } from "react-router-dom";
import FileManager from "./FileManager";
import axios from "axios";
// import ServerConsole from './ServerConsole';
// import ServerBackup from './ServerBackup';

function ServerDetails() {
  const { id } = useParams();

  const deleteServer = async () => {
    try {
      const response = await axios.delete(
        `http://localhost:3001/servers/${id}`,
        {
          withCredentials: true,
        }
      );
      console.log("Server deleted:", response.data);
      window.location.href = "/";
    } catch (err) {
      console.error("Failed to delete server:", err);
    }
  };

  return (
    <div>
      <h1>Server Details - {id}</h1>
      <nav>
        <Link to="files">File Manager</Link>
        <Link to="console">Console</Link>
        <Link to="backup">Backup</Link>
        <button onClick={deleteServer}>Delete Server</button>
      </nav>

      {/* Sub-routes */}
      <Routes>
        <Route path="files" element={<FileManager />} />
        {/* Uncomment and implement these routes when components are available */}
        {/* <Route path="console" element={<ServerConsole />} />
        <Route path="backup" element={<ServerBackup />} /> */}
        <Route path="/" element={<FileManager />} />
      </Routes>
    </div>
  );
}

export default ServerDetails;
