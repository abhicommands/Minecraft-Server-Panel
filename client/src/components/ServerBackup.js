import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";

const ServerBackup = () => {
  const { id } = useParams();
  const API_URL = process.env.REACT_APP_API_URL;
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchBackups();
  }, [id]);

  const fetchBackups = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/servers/${id}/backups`, {
        withCredentials: true,
      });
      setBackups(response.data);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch backups:", err);
      setError("Failed to fetch backups");
      setLoading(false);
    }
  };

  const createBackup = async () => {
    try {
      setLoading(true);
      await axios.post(
        `${API_URL}/servers/${id}/backup`,
        {},
        {
          withCredentials: true,
        }
      );
      fetchBackups();
    } catch (err) {
      console.error("Failed to create backup:", err);
      setError("Failed to create backup");
      setLoading(false);
    }
  };
  const downloadBackup = async (backup) => {
    try {
      setLoading(true);
      const response = await axios.get(
        `${API_URL}/servers/${id}/backup/download`,
        {
          params: { backup },
          responseType: "blob",
          withCredentials: true,
        }
      );
      const fileName = `${backup}`;
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", fileName);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      fetchBackups();
    } catch (err) {
      console.error("Failed to download backup:", err);
      setError("Failed to download backup");
      setLoading(false);
    }
  };

  const deleteBackup = async (backup) => {
    try {
      setLoading(true);
      await axios.delete(`${API_URL}/servers/${id}/backup`, {
        params: { backup },
        withCredentials: true,
      });
      fetchBackups();
    } catch (err) {
      console.error("Failed to delete backup:", err);
      setError("Failed to delete backup");
      setLoading(false);
    }
  };

  const restoreBackup = async (backup) => {
    try {
      setLoading(true);
      await axios.post(
        `${API_URL}/servers/${id}/backup/restore`,
        { backupName: backup },
        {
          withCredentials: true,
        }
      );
      setLoading(false);
    } catch (err) {
      console.error("Failed to restore backup:", err);
      setError("Failed to restore backup");
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>Server Backups</h2>
      <button onClick={createBackup} disabled={loading}>
        Create Backup
      </button>
      {loading && <p>Loading...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
      <ul>
        {backups.map((backup) => (
          <li key={backup.name}>
            {backup.name}
            <button
              onClick={() => restoreBackup(backup.name)}
              disabled={loading}
            >
              Restore
            </button>
            <button
              onClick={() => deleteBackup(backup.name)}
              disabled={loading}
            >
              Delete
            </button>
            <button
              onClick={() => downloadBackup(backup.name)}
              disabled={loading}
            >
              Download
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default ServerBackup;
