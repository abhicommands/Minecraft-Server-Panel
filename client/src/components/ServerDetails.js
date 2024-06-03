import React, { useEffect, useState } from "react";
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Typography,
} from "@mui/material";
import FileManager from "./FileManager";
import ServerConsole from "./ServerConsole";
import ServerBackup from "./ServerBackup";
import EditFile from "./EditFile";
import axios from "axios";

function ServerDetails() {
  const { id } = useParams();
  const API_URL = process.env.REACT_APP_API_URL;
  const [serverExists, setServerExists] = useState(false);
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [tabValue, setTabValue] = useState(0);
  const [openDialog, setOpenDialog] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    checkIfServerExists();
    setTabValueBasedOnPath(location.pathname);
  }, [id, location.pathname]);

  const checkIfServerExists = async () => {
    try {
      const response = await axios.get(`${API_URL}/servers/${id}`, {
        withCredentials: true,
      });
      setServerExists(true);
    } catch (err) {
      setServerExists(false);
    }
  };

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
        navigate(`/server/${id}/`);
        break;
      case 1:
        navigate(`files`);
        break;
      case 2:
        navigate(`backup`);
        break;
      default:
        navigate(`/server/${id}/`);
    }
  };

  const setTabValueBasedOnPath = (pathname) => {
    if (pathname.endsWith(`/files`)) {
      setTabValue(1);
    } else if (pathname.endsWith(`/backup`)) {
      setTabValue(2);
    } else {
      setTabValue(0);
    }
  };

  const handleOpenDialog = () => {
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const handleUpdateServerVersionChange = (e) => {
    setMinecraftVersion(e.target.value);
  };

  const handleUpdateSubmit = async () => {
    if (!minecraftVersion) {
      alert("Please enter a Minecraft version");
      return;
    }
    try {
      await axios.post(
        `${API_URL}/servers/${id}/update`,
        { version: minecraftVersion },
        { withCredentials: true }
      );
      alert("Server updated successfully!");
      handleCloseDialog();
    } catch (err) {
      console.error("Failed to update server:", err);
      alert("Failed to update server!");
    }
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
            <Route path="files" element={<FileManager />} />
            <Route path="files/edit/:encodedPath" element={<EditFile />} />
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
              <Button onClick={handleCloseDialog}>Cancel</Button>
              <Button onClick={handleUpdateSubmit}>Update</Button>
            </DialogActions>
          </Dialog>
        </>
      )}
    </Container>
  );
}

export default ServerDetails;
