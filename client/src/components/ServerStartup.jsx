import React, { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { API_URL } from "../config";

const composeStartupCommand = (baseCommand = "", flags = "") => {
  const trimmedBase = String(baseCommand || "").trim();
  const trimmedFlags = String(flags || "").trim();
  if (!trimmedFlags) return trimmedBase;
  const jarMatch = trimmedBase.match(/\s-jar\b/i);
  if (!jarMatch || typeof jarMatch.index !== "number") {
    return `${trimmedBase} ${trimmedFlags}`.trim();
  }
  const prefix = trimmedBase.slice(0, jarMatch.index).trimEnd();
  const suffix = trimmedBase.slice(jarMatch.index).trimStart();
  return `${prefix} ${trimmedFlags} ${suffix}`.trim();
};

const ServerStartup = () => {
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseCommand, setBaseCommand] = useState("");
  const [flags, setFlags] = useState("");
  const [effectiveCommand, setEffectiveCommand] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [allowCustomFlags, setAllowCustomFlags] = useState(true);
  const [initialFlags, setInitialFlags] = useState("");

  const refreshEffectiveCommand = useCallback(
    (nextFlags) => {
      setEffectiveCommand(composeStartupCommand(baseCommand, nextFlags));
    },
    [baseCommand]
  );

  const fetchStartupConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const { data } = await axios.get(
        `${API_URL}/servers/${id}/startup-flags`,
        { withCredentials: true }
      );
      const base = data.baseCommand || "";
      const flagValue = data.startupFlags || "";
      setBaseCommand(base);
      setFlags(flagValue);
      setInitialFlags(flagValue);
      setAllowCustomFlags(Boolean(data.allowCustomFlags));
      setEffectiveCommand(data.effectiveCommand || base);
    } catch (err) {
      console.error("Failed to fetch startup flags:", err);
      setError(
        err.response?.data || "Failed to load startup configuration."
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchStartupConfig();
  }, [fetchStartupConfig]);

  useEffect(() => {
    if (!loading) {
      refreshEffectiveCommand(flags);
    }
  }, [flags, loading, refreshEffectiveCommand]);

  const handleSave = async () => {
    if (!allowCustomFlags) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { data } = await axios.put(
        `${API_URL}/servers/${id}/startup-flags`,
        { flags },
        { withCredentials: true }
      );
      const base = data.baseCommand || "";
      const flagValue = data.startupFlags || "";
      setBaseCommand(base);
      setFlags(flagValue);
      setInitialFlags(flagValue);
      setEffectiveCommand(data.effectiveCommand || base);
      setAllowCustomFlags(Boolean(data.allowCustomFlags));
      setSuccess("Startup flags saved. Restart the server to apply changes.");
    } catch (err) {
      console.error("Failed to update startup flags:", err);
      setError(err.response?.data || "Failed to update startup flags.");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (allowCustomFlags) {
      setFlags(initialFlags);
      setSuccess(null);
      setError(null);
    }
  };

  if (loading) {
    return (
      <Box
        display="flex"
        alignItems="center"
        justifyContent="center"
        minHeight="50vh"
      >
        <CircularProgress />
      </Box>
    );
  }

  const isDirty = flags !== initialFlags;

  return (
    <Stack spacing={3} sx={{ mt: 2 }}>
      <Typography variant="h5">Startup Configuration</Typography>
      <Alert severity="info">
        Changes take effect the next time you start the server.
      </Alert>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {String(error)}
        </Alert>
      )}
      {success && (
        <Alert severity="success" onClose={() => setSuccess(null)}>
          {success}
        </Alert>
      )}
      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Base Command (read-only)
        </Typography>
        <Paper
          elevation={1}
          sx={{
            p: 2,
            bgcolor: "background.default",
            fontFamily: "monospace",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          {baseCommand || "Not configured."}
        </Paper>
      </Box>
      <Box>
        <Typography variant="subtitle1" gutterBottom>
          JVM Flags Override
        </Typography>
        {!allowCustomFlags ? (
          <Alert severity="info">
            This server type manages its own startup parameters. Custom flags
            are disabled.
          </Alert>
        ) : (
          <TextField
            value={flags}
            onChange={(event) => setFlags(event.target.value)}
            placeholder="-Dkey=value -XX:+UseG1GC"
            fullWidth
            multiline
            minRows={2}
            maxRows={4}
            disabled={saving}
            helperText="Flags are inserted before -jar in the Java command."
          />
        )}
      </Box>
      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Effective Command
        </Typography>
        <Paper
          elevation={1}
          sx={{
            p: 2,
            bgcolor: "background.default",
            fontFamily: "monospace",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          {effectiveCommand || "Not configured."}
        </Paper>
      </Box>
      <Stack direction="row" spacing={2}>
        {isDirty && allowCustomFlags && (
          <>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <CircularProgress size={20} color="inherit" />
              ) : (
                "Save"
              )}
            </Button>
            <Button
              variant="outlined"
              onClick={handleReset}
              disabled={saving}
            >
              Reset
            </Button>
          </>
        )}
        <Button variant="outlined" onClick={fetchStartupConfig} disabled={saving}>
          Refresh
        </Button>
      </Stack>
    </Stack>
  );
};

export default ServerStartup;
