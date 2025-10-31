import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { useDropzone } from "react-dropzone";
import {
  Box,
  Button,
  Card,
  Checkbox,
  CircularProgress,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  TextField,
  Typography,
  Breadcrumbs,
  Link,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  useMediaQuery,
  Backdrop,
} from "@mui/material";
import {
  Folder as FolderIcon,
  InsertDriveFile as FileIcon,
  Upload as UploadIcon,
  Download as DownloadIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Unarchive as UnarchiveIcon,
  ArrowForward as ArrowForwardIcon,
  CreateNewFolder as CreateNewFolderIcon,
} from "@mui/icons-material";
import { styled, useTheme } from "@mui/system";
import { API_URL } from "../config";

const FileManagerContainer = styled(Box)`
  padding: 24px;
  min-height: 100vh;
`;

function FileManager() {
  const params = useParams();
  const { id } = params;
  const rawPathParam = params["*"] || "";
  const currentPath = useMemo(() => {
    if (!rawPathParam) return "";
    const segments = rawPathParam.split("/").filter(Boolean);
    try {
      return segments.map((segment) => decodeURIComponent(segment)).join("/");
    } catch (error) {
      console.error("Failed to decode path segment:", error);
      return "";
    }
  }, [rawPathParam]);
  const [files, setFiles] = useState([]);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [destinationPath, setDestinationPath] = useState("");
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0); // Add this state
  const [loading, setLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [archiveTask, setArchiveTask] = useState(null);
  const [unarchiveTask, setUnarchiveTask] = useState(null);
  const [operationError, setOperationError] = useState(null);
  const archivePollRef = useRef(null);
  const unarchivePollRef = useRef(null);
  const navigate = useNavigate();
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const buildRelativePath = useCallback((base, name) => {
    if (!base) return name;
    return `${base.replace(/\/+$/, "")}/${name}`;
  }, []);

  const normalizedPath = currentPath;

  useEffect(() => {
    setSelectedFiles([]);
    setDestinationPath("");
  }, [normalizedPath]);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    const encodedPath = normalizedPath
      ? normalizedPath
          .split("/")
          .filter(Boolean)
          .map((segment) => encodeURIComponent(segment))
          .join("/")
      : "";
    const endpoint = encodedPath
      ? `${API_URL}/servers/${id}/files/${encodedPath}`
      : `${API_URL}/servers/${id}/files`;
    try {
      const response = await axios.get(endpoint, {
        withCredentials: true,
      });
      setFiles(response.data);
    } catch (error) {
      console.error("Error fetching files:", error);
    }
    setLoading(false);
  }, [id, normalizedPath]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const onDrop = async (acceptedFiles) => {
    const formData = new FormData();
    acceptedFiles.forEach((file) => {
      formData.append("files", file);
    });
    setUploadProgress(0);
    setOperationError(null);
    setIsUploading(true);
    try {
      await axios.post(`${API_URL}/servers/${id}/upload`, formData, {
        params: { path: normalizedPath },
        headers: { "Content-Type": "multipart/form-data" },
        withCredentials: true,
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setUploadProgress(percentCompleted); // Update progress
        },
      });
      fetchFiles();
    } catch (error) {
      console.error("Error uploading files:", error);
      setOperationError("Failed to upload files");
    }
    setIsUploading(false);
    setUploadProgress(0);
  };

  const { getRootProps, getInputProps, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
  });

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    setLoading(true);
    try {
      await axios.post(
        `${API_URL}/servers/${id}/folders`,
        { name: newFolderName },
        {
          params: { path: normalizedPath },
          withCredentials: true,
        }
      );
      setNewFolderName("");
      setShowNewFolderDialog(false);
      fetchFiles();
    } catch (error) {
      console.error("Error creating folder:", error);
    }
    setLoading(false);
  };

  const buildNavigatePath = useCallback(
    (nextPath) => {
      const sanitized = nextPath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      return sanitized
        ? `/server/${id}/files/${sanitized}`
        : `/server/${id}/files`;
    },
    [id]
  );

  const handleFolderChange = (newPath) => {
    navigate(buildNavigatePath(newPath));
  };

  const clearArchivePolling = useCallback(() => {
    if (archivePollRef.current) {
      clearInterval(archivePollRef.current);
      archivePollRef.current = null;
    }
  }, []);

  const clearUnarchivePolling = useCallback(() => {
    if (unarchivePollRef.current) {
      clearInterval(unarchivePollRef.current);
      unarchivePollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearArchivePolling();
      clearUnarchivePolling();
    };
  }, [clearArchivePolling, clearUnarchivePolling]);

  const triggerArchiveDownload = (taskId, fileName) => {
    const link = document.createElement("a");
    link.href = `${API_URL}/servers/${id}/files/archive/download/${taskId}`;
    if (fileName) {
      link.setAttribute("download", fileName);
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadFiles = async () => {
    if (selectedFiles.length === 0) return;
    clearArchivePolling();
    try {
      setOperationError(null);
      const response = await axios.post(
        `${API_URL}/servers/${id}/files/archive`,
        { files: selectedFiles },
        {
          withCredentials: true,
        }
      );
      const { taskId, fileName, status } = response.data;
      setArchiveTask({ taskId, fileName, status, progress: 0 });

      const pollStatus = async () => {
        try {
          const { data } = await axios.get(
            `${API_URL}/servers/${id}/files/archive/status/${taskId}`,
            {
              withCredentials: true,
            }
          );
          const percent = Math.round((data.progress || 0) * 100);
          setArchiveTask({
            taskId,
            fileName: data.fileName || fileName,
            status: data.status,
            progress: percent,
            message: data.message,
          });
          if (data.status === "completed") {
            clearArchivePolling();
            triggerArchiveDownload(taskId, data.fileName || fileName);
            setArchiveTask(null);
            setSelectedFiles([]);
            fetchFiles();
          } else if (data.status === "error") {
            clearArchivePolling();
            setArchiveTask(null);
            setOperationError(data.message || "Failed to archive files");
          }
        } catch (error) {
          console.error("Failed to poll archive status:", error);
          clearArchivePolling();
          setArchiveTask(null);
          setOperationError("Failed to retrieve archive status");
        }
      };

      await pollStatus();
      archivePollRef.current = setInterval(pollStatus, 1500);
    } catch (error) {
      console.error("Error starting archive:", error);
      setOperationError("Failed to start archive");
    }
  };

  const deleteFiles = async () => {
    if (selectedFiles.length === 0) return;
    setOperationError(null);
    setIsDeleting(true);
    try {
      await axios.post(
        `${API_URL}/servers/${id}/files/delete/`,
        { files: selectedFiles },
        {
          withCredentials: true,
        }
      );
      setSelectedFiles([]);
      await fetchFiles();
    } catch (error) {
      console.error("Error deleting files:", error);
      setOperationError("Failed to delete files");
    }
    setIsDeleting(false);
  };

  const moveFiles = async () => {
    if (selectedFiles.length === 0 || !destinationPath.trim()) return;
    setLoading(true);
    try {
      await axios.post(
        `${API_URL}/servers/${id}/files/move`,
        {
          files: selectedFiles,
          destination: destinationPath,
        },
        {
          withCredentials: true,
        }
      );
      fetchFiles();
      setDestinationPath("");
      setSelectedFiles([]);
    } catch (error) {
      console.error("Error moving files:", error);
    }
    setLoading(false);
  };

  const unarchiveFile = async (filePath) => {
    clearUnarchivePolling();
    try {
      setOperationError(null);
      const response = await axios.post(
        `${API_URL}/servers/${id}/files/unarchive`,
        { filePath },
        {
          withCredentials: true,
        }
      );
      const { taskId, status } = response.data;
      setUnarchiveTask({ taskId, filePath, status, progress: 0 });

      const pollStatus = async () => {
        try {
          const { data } = await axios.get(
            `${API_URL}/servers/${id}/files/unarchive/status/${taskId}`,
            {
              withCredentials: true,
            }
          );
          const percent = Math.round((data.progress || 0) * 100);
          setUnarchiveTask({
            taskId,
            filePath,
            status: data.status,
            progress: percent,
            message: data.message,
          });
          if (data.status === "completed") {
            clearUnarchivePolling();
            setUnarchiveTask(null);
            fetchFiles();
          } else if (data.status === "error") {
            clearUnarchivePolling();
            setUnarchiveTask(null);
            setOperationError(data.message || "Failed to unarchive");
          }
        } catch (error) {
          console.error("Failed to poll unarchive status:", error);
          clearUnarchivePolling();
          setUnarchiveTask(null);
          setOperationError("Failed to retrieve unarchive status");
        }
      };

      await pollStatus();
      unarchivePollRef.current = setInterval(pollStatus, 1500);
    } catch (error) {
      console.error("Error starting unarchive:", error);
      setOperationError("Failed to start unarchive");
    }
  };

  const toggleFileSelection = (fileName) => {
    setSelectedFiles((prevSelectedFiles) =>
      prevSelectedFiles.includes(fileName)
        ? prevSelectedFiles.filter((file) => file !== fileName)
        : [...prevSelectedFiles, fileName]
    );
  };

  const editableExtensions = [".txt", ".json", ".properties", ".log"];

  const isEditable = (fileName) => {
    return editableExtensions.some((ext) => fileName.endsWith(ext));
  };

  const openFileEditor = (filePath) => {
    const encodedPath = encodeURIComponent(filePath);
    navigate(`/server/${id}/files/edit/${encodedPath}`);
  };

  const renderBreadcrumbs = () => {
    const pathSegments = normalizedPath.split("/").filter(Boolean);
    const breadcrumbs = pathSegments.map((segment, index) => {
      const breadcrumbPath = pathSegments.slice(0, index + 1).join("/");
      const isActive = normalizedPath === breadcrumbPath;
      return (
        <Link
          key={breadcrumbPath}
          onClick={() => navigate(buildNavigatePath(breadcrumbPath))}
          sx={{
            cursor: isActive ? "default" : "pointer",
            color: isActive ? "text.disabled" : "primary.main",
            textDecoration: isActive ? "none" : "underline",
          }}
        >
          {segment}
        </Link>
      );
    });

    return (
      <Breadcrumbs aria-label="breadcrumb" sx={{ marginBottom: "16px" }}>
        <Link
          onClick={() =>
            normalizedPath !== "" && navigate(buildNavigatePath(""))
          }
          sx={{
            cursor: normalizedPath === "" ? "default" : "pointer",
            color: normalizedPath === "" ? "text.disabled" : "primary.main",
            textDecoration: normalizedPath === "" ? "none" : "underline",
          }}
        >
          root
        </Link>
        {breadcrumbs}
      </Breadcrumbs>
    );
  };

  const showOverlay =
    isUploading || Boolean(archiveTask) || Boolean(unarchiveTask) || isDeleting;

  const overlayHasProgress =
    !isDeleting && (isUploading || Boolean(archiveTask) || Boolean(unarchiveTask));

  const overlayProgress = overlayHasProgress
    ? Math.min(
        Math.max(
          isUploading
            ? uploadProgress
            : archiveTask
            ? archiveTask.progress ?? 0
            : unarchiveTask
            ? unarchiveTask.progress ?? 0
            : 0,
          0
        ),
        100
      )
    : undefined;

  const overlayMessage = isUploading
    ? `Uploading... ${uploadProgress}%`
    : archiveTask
    ? `Preparing archive... ${archiveTask.progress ?? 0}%`
    : unarchiveTask
    ? `Extracting archive... ${unarchiveTask.progress ?? 0}%`
    : isDeleting
    ? "Deleting files..."
    : "";

  return (
    <FileManagerContainer {...getRootProps()}>
      <input {...getInputProps()} />
      <Card sx={{ padding: "24px", boxShadow: 3 }}>
        <Typography variant="h5">File Manager</Typography>
        {renderBreadcrumbs()}
        {operationError && (
          <Typography color="error" variant="body2" sx={{ mb: 1 }}>
            {operationError}
          </Typography>
        )}
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Box sx={{ display: "flex", gap: 2 }}>
            <Button
              startIcon={<UploadIcon />}
              onClick={() => open()}
              disabled={
                isUploading ||
                Boolean(archiveTask) ||
                Boolean(unarchiveTask) ||
                isDeleting
              }
            >
              {isSmallScreen ? "" : "Upload"}
            </Button>
            <Button
              startIcon={<CreateNewFolderIcon />}
              onClick={() => setShowNewFolderDialog(true)}
            >
              {isSmallScreen ? "" : "Create New Directory"}
            </Button>
          </Box>
          {/* Upload progress handled by backdrop only */}
          {selectedFiles.length > 0 && (
            <Box sx={{ display: "flex", gap: 2 }}>
              <Button
                startIcon={<DownloadIcon />}
                onClick={downloadFiles}
                disabled={
                  isUploading ||
                  Boolean(archiveTask) ||
                  Boolean(unarchiveTask) ||
                  isDeleting
                }
              >
                {isSmallScreen ? "" : "Download Selected"}
              </Button>
              <Button
                startIcon={<DeleteIcon />}
                onClick={deleteFiles}
                disabled={
                  isUploading ||
                  Boolean(archiveTask) ||
                  Boolean(unarchiveTask) ||
                  isDeleting
                }
              >
                {isSmallScreen ? "" : "Delete Selected"}
              </Button>
              <TextField
                value={destinationPath}
                onChange={(e) => setDestinationPath(e.target.value)}
                placeholder="Move to path"
                InputProps={{
                  endAdornment: (
                    <IconButton
                      onClick={moveFiles}
                      disabled={
                        isUploading ||
                        Boolean(archiveTask) ||
                        Boolean(unarchiveTask) ||
                        isDeleting
                      }
                    >
                      <ArrowForwardIcon />
                    </IconButton>
                  ),
                }}
              />
            </Box>
          )}
        </Box>
        <List>
          {files.map((file) => {
            const relativePath = buildRelativePath(normalizedPath, file.name);
            return (
              <ListItem
                key={file.name}
                secondaryAction={
                  <Checkbox
                    edge="end"
                    checked={selectedFiles.includes(relativePath)}
                    onChange={() => toggleFileSelection(relativePath)}
                  />
                }
              >
                <ListItemIcon>
                  {file.type === "directory" ? <FolderIcon /> : <FileIcon />}
                </ListItemIcon>
                <ListItemText
                  primary={
                    file.type === "directory" ? (
                      <Link
                        onClick={() => handleFolderChange(relativePath)}
                        sx={{
                          cursor: "pointer",
                          color: "primary.main",
                          textDecoration: "underline",
                        }}
                      >
                        {file.name}
                      </Link>
                    ) : (
                      file.name
                    )
                  }
                />
                {file.type !== "directory" && isEditable(file.name) && (
                  <IconButton onClick={() => openFileEditor(relativePath)}>
                    <EditIcon />
                  </IconButton>
                )}
              {file.name.endsWith(".zip") && (
                <IconButton
                  onClick={() => unarchiveFile(relativePath)}
                  disabled={
                    isUploading ||
                    Boolean(archiveTask) ||
                    Boolean(unarchiveTask) ||
                    isDeleting
                  }
                >
                  <UnarchiveIcon />
                </IconButton>
              )}
              </ListItem>
            );
          })}
        </List>
        {loading && (
          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              marginTop: 2,
            }}
          >
            <CircularProgress size={40} />
          </Box>
        )}
        <Typography variant="body2" color="textSecondary">
          Drag 'n' drop files here, or click to select files
        </Typography>
      </Card>
      <Dialog
        open={showNewFolderDialog}
        onClose={() => setShowNewFolderDialog(false)}
      >
        <DialogTitle>Create New Directory</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="New Folder Name"
            fullWidth
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === "Enter") {
                createFolder();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowNewFolderDialog(false)}>Cancel</Button>
          <Button onClick={createFolder}>Create</Button>
        </DialogActions>
      </Dialog>
      <Backdrop
        open={showOverlay}
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, color: "#fff" }}
      >
        <Box display="flex" flexDirection="column" alignItems="center" gap={2}>
          <CircularProgress
            variant={overlayHasProgress ? "determinate" : "indeterminate"}
            value={overlayHasProgress ? overlayProgress : undefined}
            size={80}
            thickness={4}
          />
          {overlayMessage && (
            <Typography variant="body1">{overlayMessage}</Typography>
          )}
        </Box>
      </Backdrop>
    </FileManagerContainer>
  );
}

export default FileManager;
