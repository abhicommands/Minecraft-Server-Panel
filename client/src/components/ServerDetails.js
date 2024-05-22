import React, { useEffect, useState } from "react";
import {
  useParams,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import FileManager from "./FileManager";
import ServerConsole from "./ServerConsole";
import ServerBackup from "./ServerBackup";
import axios from "axios";

function ServerDetails() {
  const { id } = useParams();
  const API_URL = process.env.REACT_APP_API_URL;
  const [serverExists, setServerExists] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    checkIfServerExists();
  }, [id]); // Add 'id' as a dependency to re-run when 'id' changes

  const deleteServer = async () => {
    try {
      const response = await axios.delete(`${API_URL}/servers/${id}`, {
        withCredentials: true,
      });
      console.log("Server deleted:", response.data);
      window.location.href = "/";
    } catch (err) {
      console.error("Failed to delete server:", err);
    }
  };

  const checkIfServerExists = async () => {
    try {
      const response = await axios.get(`${API_URL}/servers/${id}`, {
        withCredentials: true,
      });
      console.log("Server exists:", response.data);
      setServerExists(true);
    } catch (err) {
      console.error("Error", err);
      setServerExists(false);
    }
  };

  const handleNavigation = (path) => {
    if (location.pathname !== path) {
      navigate(path);
    }
  };

  return (
    <div>
      {!serverExists ? (
        <h1>Server Doesn't exist!</h1>
      ) : (
        <>
          <h1>Server Details - {id}</h1>
          <nav>
            <button onClick={() => handleNavigation("files")}>
              File Manager
            </button>
            <button onClick={() => handleNavigation(`/server/${id}/`)}>
              Console
            </button>
            <button onClick={() => handleNavigation("backup")}>Backup</button>
            <button onClick={deleteServer}>Delete Server</button>
          </nav>

          {/* Sub-routes */}
          <Routes>
            <Route path="files" element={<FileManager />} />
            <Route path="backup" element={<ServerBackup />} />
            <Route path="/" element={<ServerConsole />} />
            <Route path="*" element={<h1>Not Found</h1>} />
          </Routes>
        </>
      )}
    </div>
  );
}

export default ServerDetails;
