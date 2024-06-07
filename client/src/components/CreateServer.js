import React, { useState, useEffect } from "react";
import axios from "axios";
import {
  Box,
  Button,
  Card,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { styled } from "@mui/system";

const FormContainer = styled(Box)`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
`;

const CreateMinecraftServer = () => {
  const [serverName, setServerName] = useState("");
  const [memoryGB, setMemoryGB] = useState(1); // default to 1GB
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [port, setPort] = useState(25565); // default Minecraft port
  const [loading, setLoading] = useState(false);
  const [serverType, setServerType] = useState("vanilla");
  const [mshConfig, setMshConfig] = useState(false);
  const [renderDistance, setRenderDistance] = useState(10);
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

  const handleServerTypeChange = (e) => {
    setServerType(e.target.value);
  };

  const handleMshConfigChange = (e) => {
    setMshConfig(e.target.checked);
  };

  const handleRenderDistanceChange = (e) => {
    setRenderDistance(e.target.value);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (
      !serverName ||
      !memoryGB ||
      !minecraftVersion ||
      !port ||
      !serverType ||
      !renderDistance
    ) {
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
          serverType: serverType,
          mshConfig: mshConfig,
          renderDistance: renderDistance,
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
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
      }}
    >
      <Card sx={{ padding: "24px", maxWidth: "600px", width: "100%" }}>
        <Typography variant="h4" gutterBottom>
          Create New Minecraft Server
        </Typography>
        {loading ? (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <CircularProgress />
            <Typography>Creating server, please wait...</Typography>
          </Box>
        ) : (
          <form onSubmit={handleSubmit}>
            <FormContainer>
              <TextField
                label="Server Name"
                value={serverName}
                onChange={handleServerNameChange}
                fullWidth
                disabled={loading}
              />
              <TextField
                label="Memory (GB)"
                type="number"
                value={memoryGB}
                onChange={handleMemoryGBChange}
                fullWidth
                disabled={loading}
                inputProps={{ min: 1, max: 32 }}
              />
              <FormControl fullWidth>
                <InputLabel>Minecraft Version</InputLabel>
                <Select
                  value={minecraftVersion}
                  onChange={handleMinecraftVersionChange}
                  disabled={loading}
                >
                  <MenuItem value="">Select Minecraft Version</MenuItem>
                  <MenuItem value="1.7.10">1.7.10</MenuItem>
                  <MenuItem value="1.8.9">1.8.9</MenuItem>
                  <MenuItem value="1.12.2">1.12.2</MenuItem>
                  <MenuItem value="1.16.5">1.16.5</MenuItem>
                  <MenuItem value="1.17.1">1.17.1</MenuItem>
                  <MenuItem value="1.18.1">1.18.1</MenuItem>
                  <MenuItem value="1.19.3">1.19.3</MenuItem>
                  <MenuItem value="1.20.2">1.20.2</MenuItem>
                  <MenuItem value="1.20.4">1.20.4</MenuItem>
                  <MenuItem value="latest">latest</MenuItem>
                </Select>
              </FormControl>
              <TextField
                label="Port"
                type="number"
                value={port}
                onChange={handlePortChange}
                fullWidth
                disabled={loading}
              />
              <FormControl fullWidth>
                <InputLabel>Server Type</InputLabel>
                <Select
                  value={serverType}
                  onChange={handleServerTypeChange}
                  disabled={loading}
                >
                  <MenuItem value="vanilla">Vanilla</MenuItem>
                  <MenuItem value="paper">Paper</MenuItem>
                  <MenuItem value="fabric">Fabric</MenuItem>
                  <MenuItem value="forge">Forge</MenuItem>
                  <MenuItem value="bungeecord">BungeeCord</MenuItem>
                </Select>
              </FormControl>
              <FormControlLabel
                control={
                  <Switch
                    checked={mshConfig}
                    onChange={(e) => setMshConfig(e.target.checked)}
                    disabled={loading}
                  />
                }
                label="Enable MSH Config"
              />
              <TextField
                label="Render Distance"
                type="number"
                value={renderDistance}
                onChange={handleRenderDistanceChange}
                fullWidth
                disabled={loading}
                inputProps={{ min: 2, max: 32 }}
              />
              <Button
                type="submit"
                variant="contained"
                color="primary"
                fullWidth
                disabled={loading}
              >
                Create Minecraft Server
              </Button>
            </FormContainer>
          </form>
        )}
      </Card>
    </Box>
  );
};

export default CreateMinecraftServer;
