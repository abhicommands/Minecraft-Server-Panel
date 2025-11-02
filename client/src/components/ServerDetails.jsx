import React, { useEffect, useState, useCallback } from "react";
import {
  useParams,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  AppBar,
  Tabs,
  Tab,
  Box,
  Button,
  Container,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Snackbar,
  TextField,
  Typography,
} from "@mui/material";
import FileManager from "./FileManager";
import ServerConsole from "./ServerConsole";
import ServerBackup from "./ServerBackup";
import EditFile from "./EditFile";
import ServerStartup from "./ServerStartup";
import axios from "axios";
import { API_URL } from "../config";

function ServerDetails() {
  const { id } = useParams();
  const [serverExists, setServerExists] = useState(false);
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [tabValue, setTabValue] = useState(0);
  const [openDialog, setOpenDialog] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [feedback, setFeedback] = useState({
    open: false,
    message: "",
    severity: "success",
  });
  const location = useLocation();
  const navigate = useNavigate();

  const checkIfServerExists = useCallback(async () => {
    try {
      await axios.get(`${API_URL}/servers/${id}`, {
        withCredentials: true,
      });
      setServerExists(true);
    } catch {
      setServerExists(false);
    }
  }, [id]);

  useEffect(() => {
    checkIfServerExists();
    setTabValueBasedOnPath(location.pathname);
  }, [checkIfServerExists, location.pathname]);

  const deleteServer = async () => {
    try {
      await axios.delete(`${API_URL}/servers/${id}`, {
        withCredentials: true,
      });
      window.location.href = "/";
    } catch (err) {
      console.error("Failed to delete server:", err);
    }
  };

  const handleNavigation = (event, newValue) => {
    setTabValue(newValue);
    switch (newValue) {
      case 0:
        navigate(`/server/${id}`);
        break;
      case 1:
        navigate(`/server/${id}/files`);
        break;
      case 2:
        navigate(`/server/${id}/startup`);
        break;
      case 3:
        navigate(`/server/${id}/backup`);
        break;
      default:
        navigate(`/server/${id}`);
    }
  };

  const setTabValueBasedOnPath = (pathname) => {
    if (pathname.includes(`/startup`)) {
      setTabValue(2);
    } else if (pathname.includes(`/backup`)) {
      setTabValue(3);
    } else if (pathname.includes(`/files`)) {
      setTabValue(1);
    } else {
      setTabValue(0);
    }
  };

  const handleOpenDialog = () => {
    setMinecraftVersion("");
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const handleUpdateServerVersionChange = (e) => {
    setMinecraftVersion(e.target.value);
  };

  const handleUpdateSubmit = async () => {
    const trimmedVersion = minecraftVersion.trim();
    if (!trimmedVersion) {
      setFeedback({
        open: true,
        message: "Please enter a Minecraft version.",
        severity: "warning",
      });
      return;
    }

    setIsUpdating(true);

    try {
      await axios.post(
        `${API_URL}/servers/${id}/update`,
        { version: trimmedVersion },
        { withCredentials: true }
      );
      setFeedback({
        open: true,
        message: "Server updated successfully!",
        severity: "success",
      });
      setMinecraftVersion("");
      handleCloseDialog();
    } catch (err) {
      console.error("Failed to update server:", err);
      setFeedback({
        open: true,
        message: "Failed to update server. Please try again.",
        severity: "error",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleFeedbackClose = (_, reason) => {
    if (reason === "clickaway") {
      return;
    }
    setFeedback((prev) => ({ ...prev, open: false }));
  };

  return (
    <Container maxWidth="lg">
      {!serverExists ? (
        <Typography variant="h4">Server Doesn't exist!</Typography>
      ) : (
        <>
          <Typography variant="h4" gutterBottom>
            Server Details
          </Typography>
          <Box sx={{ flexGrow: 1 }}>
            <AppBar position="static">
              <Tabs value={tabValue} onChange={handleNavigation}>
                <Tab
                  label="Console"
                  disabled={location.pathname === `/server/${id}/`}
                />
                <Tab
                  label="File Manager"
                  disabled={location.pathname === `/server/${id}/files`}
                />
                <Tab
                  label="Startup"
                  disabled={location.pathname === `/server/${id}/startup`}
                />
                <Tab
                  label="Backup"
                  disabled={location.pathname === `/server/${id}/backup`}
                />
              </Tabs>
            </AppBar>
          </Box>
          <Box sx={{ my: 2 }}>
            <Button
              variant="contained"
              color="secondary"
              onClick={handleOpenDialog}
              sx={{ mr: 2 }}
            >
              Update Server
            </Button>
            <Button variant="contained" color="error" onClick={deleteServer}>
              Delete Server
            </Button>
          </Box>
          <Routes>
            <Route path="files/*" element={<FileManager />} />
            <Route path="files/edit/:encodedPath" element={<EditFile />} />
            <Route path="startup" element={<ServerStartup />} />
            <Route path="backup" element={<ServerBackup />} />
            <Route path="/" element={<ServerConsole />} />
            <Route
              path="*"
              element={<Typography variant="h4">Not Found</Typography>}
            />
          </Routes>
          <Dialog open={openDialog} onClose={handleCloseDialog}>
            <DialogTitle>Update Server</DialogTitle>
            <DialogContent>
              <TextField
                autoFocus
                margin="dense"
                label="Minecraft Version"
                fullWidth
                value={minecraftVersion}
                onChange={handleUpdateServerVersionChange}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={handleCloseDialog} disabled={isUpdating}>
                Cancel
              </Button>
              <Button onClick={handleUpdateSubmit} disabled={isUpdating}>
                {isUpdating ? (
                  <CircularProgress size={24} color="inherit" />
                ) : (
                  "Update"
                )}
              </Button>
            </DialogActions>
          </Dialog>
          <Snackbar
            open={feedback.open}
            autoHideDuration={4000}
            onClose={handleFeedbackClose}
            anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
          >
            <Alert
              onClose={handleFeedbackClose}
              severity={feedback.severity}
              sx={{ width: "100%" }}
            >
              {feedback.message}
            </Alert>
          </Snackbar>
        </>
      )}
    </Container>
  );
}

export default ServerDetails;
