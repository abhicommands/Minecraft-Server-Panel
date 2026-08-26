import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import {
  Backdrop,
  Box,
  CircularProgress,
  Typography,
  Button,
  Stack,
  Paper,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { API_URL } from "../config";

const apiErrorMessage = (error, fallback) => {
  const data = error.response?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (typeof data?.message === "string" && data.message.trim()) {
    return data.message;
  }
  if (typeof data?.error === "string" && data.error.trim()) return data.error;
  return fallback;
};

const ServerBackup = () => {
  const { id } = useParams();
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [backupTask, setBackupTask] = useState(null);
  const [restoreTask, setRestoreTask] = useState(null);
  const [backupWarning, setBackupWarning] = useState(null);
  const backupPollRef = useRef(null);
  const restorePollRef = useRef(null);

  const clearBackupPolling = () => {
    if (backupPollRef.current) {
      clearInterval(backupPollRef.current);
      backupPollRef.current = null;
    }
  };

  const clearRestorePolling = () => {
    if (restorePollRef.current) {
      clearInterval(restorePollRef.current);
      restorePollRef.current = null;
    }
  };

  const fetchBackups = useCallback(async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/servers/${id}/backups`, {
        withCredentials: true,
      });
      setBackups(response.data);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch backups:", err);
      setError(apiErrorMessage(err, "Failed to fetch backups"));
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchBackups();
    return () => {
      clearBackupPolling();
      clearRestorePolling();
    };
  }, [fetchBackups]);

  const createBackup = async ({ allowRunning = false } = {}) => {
    clearBackupPolling();
    try {
      setError(null);
      setBackupWarning(null);
      const response = await axios.post(
        `${API_URL}/servers/${id}/backup`,
        { allowRunning },
        {
          withCredentials: true,
        }
      );
      const { taskId, backupName, status } = response.data;
      setBackupTask({ taskId, backupName, status, progress: 0 });

      const pollStatus = async () => {
        try {
          const { data } = await axios.get(
            `${API_URL}/servers/${id}/backup/status/${taskId}`,
            {
              withCredentials: true,
            }
          );
          const percent = Math.round((data.progress || 0) * 100);
          setBackupTask({
            taskId,
            backupName: data.fileName || backupName,
            status: data.status,
            progress: percent,
            message: data.message,
          });
          if (data.status === "completed") {
            clearBackupPolling();
            setBackupTask(null);
            fetchBackups();
            return false;
          } else if (data.status === "error") {
            clearBackupPolling();
            setBackupTask(null);
            setError(data.message || "Failed to create backup");
            return false;
          }
          return true;
        } catch (pollError) {
          console.error("Failed to poll backup status:", pollError);
          clearBackupPolling();
          setBackupTask(null);
          setError(
            apiErrorMessage(pollError, "Failed to retrieve backup status")
          );
          return false;
        }
      };

      const shouldContinue = await pollStatus();
      if (shouldContinue) {
        backupPollRef.current = setInterval(() => {
          pollStatus().then((continuePolling) => {
            if (!continuePolling) clearBackupPolling();
          });
        }, 1500);
      }
    } catch (err) {
      console.error("Failed to create backup:", err);
      const data = err.response?.data;
      if (
        err.response?.status === 409 &&
        data?.code === "SERVER_RUNNING_BACKUP_WARNING" &&
        data?.requiresConfirmation === true
      ) {
        setBackupWarning(
          data.message || "The server is running. Continue with the backup?"
        );
      } else {
        setError(apiErrorMessage(err, "Failed to create backup"));
      }
    }
  };
  const formatBytes = (bytes) => {
    if (!bytes && bytes !== 0) return "-";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const formatDate = (iso) => {
    if (!iso) return "-";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString();
  };

  const downloadBackup = (backup) => {
    const link = document.createElement("a");
    link.href = `${API_URL}/servers/${id}/backup/download?backup=${encodeURIComponent(
      backup
    )}`;
    link.setAttribute("download", backup);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
      setError(apiErrorMessage(err, "Failed to delete backup"));
      setLoading(false);
    }
  };

  const restoreBackup = async (backup) => {
    clearRestorePolling();
    try {
      setError(null);
      const response = await axios.post(
        `${API_URL}/servers/${id}/backup/restore`,
        { backupName: backup },
        {
          withCredentials: true,
        }
      );
      const { taskId, status } = response.data;
      setRestoreTask({ taskId, backupName: backup, status, progress: 0 });

      const pollStatus = async () => {
        try {
          const { data } = await axios.get(
            `${API_URL}/servers/${id}/backup/restore/status/${taskId}`,
            {
              withCredentials: true,
            }
          );
          const percent = Math.round((data.progress || 0) * 100);
          setRestoreTask({
            taskId,
            backupName: backup,
            status: data.status,
            progress: percent,
            message: data.message,
          });
          if (data.status === "completed") {
            clearRestorePolling();
            setRestoreTask(null);
            return false;
          } else if (data.status === "error") {
            clearRestorePolling();
            setRestoreTask(null);
            setError(data.message || "Failed to restore backup");
            return false;
          }
          return true;
        } catch (pollError) {
          console.error("Failed to poll restore status:", pollError);
          clearRestorePolling();
          setRestoreTask(null);
          setError(
            apiErrorMessage(pollError, "Failed to retrieve restore status")
          );
          return false;
        }
      };

      const shouldContinue = await pollStatus();
      if (shouldContinue) {
        restorePollRef.current = setInterval(() => {
          pollStatus().then((continuePolling) => {
            if (!continuePolling) clearRestorePolling();
          });
        }, 1500);
      }
    } catch (err) {
      console.error("Failed to restore backup:", err);
      setError(apiErrorMessage(err, "Failed to restore backup"));
    }
  };

  return (
    <Box p={3} display="flex" flexDirection="column" gap={2}>
      <Box display="flex" alignItems="center" justifyContent="space-between">
        <Typography variant="h5">Server Backups</Typography>
        <Button
          variant="contained"
          onClick={() => createBackup()}
          disabled={loading || Boolean(backupTask)}
        >
          Create Backup
        </Button>
      </Box>
      {loading && <Typography>Loading...</Typography>}
      {error && (
        <Typography color="error" variant="body2">
          {error}
        </Typography>
      )}
      <Stack spacing={2}>
        {backups.map((backup) => (
          <Paper
            key={backup.name}
            elevation={2}
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              p: 2,
            }}
          >
            <Box>
              <Typography variant="h6">{backup.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                Created: {formatDate(backup.createdAt)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Size: {formatBytes(backup.size)}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                onClick={() => downloadBackup(backup.name)}
              >
                Download
              </Button>
              <Button
                variant="outlined"
                onClick={() => restoreBackup(backup.name)}
                disabled={loading || Boolean(restoreTask)}
              >
                Restore
              </Button>
              <Button
                variant="contained"
                color="error"
                onClick={() => deleteBackup(backup.name)}
                disabled={
                  loading || Boolean(backupTask) || Boolean(restoreTask)
                }
              >
                Delete
              </Button>
            </Stack>
          </Paper>
        ))}
      </Stack>
      <Backdrop
        open={Boolean(backupTask || restoreTask)}
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, color: "#fff" }}
      >
        <Box display="flex" flexDirection="column" alignItems="center" gap={2}>
          <CircularProgress
            variant="determinate"
            value={Math.min(
              Math.max(backupTask?.progress ?? restoreTask?.progress ?? 0, 0),
              100
            )}
            size={80}
            thickness={4}
          />
          <Box textAlign="center">
            {backupTask && <p>Preparing backup... {backupTask.progress}%</p>}
            {restoreTask && <p>Restoring backup... {restoreTask.progress}%</p>}
          </Box>
        </Box>
      </Backdrop>
      <Dialog
        open={Boolean(backupWarning)}
        onClose={() => setBackupWarning(null)}
        aria-labelledby="running-backup-warning-title"
      >
        <DialogTitle id="running-backup-warning-title">
          Server is still running
        </DialogTitle>
        <DialogContent>
          <DialogContentText>{backupWarning}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBackupWarning(null)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => createBackup({ allowRunning: true })}
          >
            Continue Anyway
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ServerBackup;
