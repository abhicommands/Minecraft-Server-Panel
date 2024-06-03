import React, { useState, useEffect } from "react";
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

const FileManagerContainer = styled(Box)`
  padding: 24px;
  min-height: 100vh;
`;

function FileManager() {
  const { id } = useParams();
  const [files, setFiles] = useState([]);
  const [path, setPath] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [destinationPath, setDestinationPath] = useState("");
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const API_URL = process.env.REACT_APP_API_URL;
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/servers/${id}/files`, {
        params: { path },
        withCredentials: true,
      });
      setFiles(response.data);
    } catch (error) {
      console.error("Error fetching files:", error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchFiles();
  }, [path, id]);

  const onDrop = async (acceptedFiles) => {
    const formData = new FormData();
    acceptedFiles.forEach((file) => {
      formData.append("files", file);
    });
    setLoading(true);
    try {
      await axios.post(`${API_URL}/servers/${id}/upload`, formData, {
        params: { path },
        headers: { "Content-Type": "multipart/form-data" },
        withCredentials: true,
      });
      fetchFiles();
    } catch (error) {
      console.error("Error uploading files:", error);
    }
    setLoading(false);
  };

  const { getRootProps, getInputProps } = useDropzone({
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
          params: { path },
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

  const handleFolderChange = (newPath) => {
    setPath(newPath);
  };

  const downloadFiles = async () => {
    if (selectedFiles.length === 0) return;
    setLoading(true);
    try {
      const response = await axios.post(
        `${API_URL}/servers/${id}/files/download`,
        { files: selectedFiles },
        {
          responseType: "blob",
          withCredentials: true,
        }
      );
      const fileName =
        selectedFiles.length === 1 ? selectedFiles[0] : "files.zip";
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", fileName);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      setSelectedFiles([]);
    } catch (error) {
      console.error("Error downloading files:", error);
    }
    setLoading(false);
  };

  const deleteFiles = async () => {
    if (selectedFiles.length === 0) return;
    setLoading(true);
    try {
      await axios.post(
        `${API_URL}/servers/${id}/files/delete/`,
        { files: selectedFiles },
        {
          withCredentials: true,
        }
      );
      setSelectedFiles([]);
      fetchFiles();
    } catch (error) {
      console.error("Error deleting files:", error);
    }
    setLoading(false);
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
    setLoading(true);
    try {
      await axios.get(`${API_URL}/servers/${id}/unarchive`, {
        params: { filePath },
        withCredentials: true,
      });
      fetchFiles();
    } catch (error) {
      console.error("Error unarchiving file:", error);
    }
    setLoading(false);
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
    const pathSegments = path.split("/").filter(Boolean);
    const breadcrumbs = pathSegments.map((segment, index) => {
      const breadcrumbPath = pathSegments.slice(0, index + 1).join("/");
      return (
        <Link
          key={breadcrumbPath}
          onClick={() => setPath(breadcrumbPath)}
          sx={{
            cursor: path === breadcrumbPath ? "default" : "pointer",
            color: path === breadcrumbPath ? "text.disabled" : "primary.main",
            textDecoration: path === breadcrumbPath ? "none" : "underline",
          }}
        >
          {segment}
        </Link>
      );
    });

    return (
      <Breadcrumbs aria-label="breadcrumb" sx={{ marginBottom: "16px" }}>
        <Link
          onClick={() => path !== "" && setPath("")}
          sx={{
            cursor: path === "" ? "default" : "pointer",
            color: path === "" ? "text.disabled" : "primary.main",
            textDecoration: path === "" ? "none" : "underline",
          }}
        >
          root
        </Link>
        {breadcrumbs}
      </Breadcrumbs>
    );
  };

  return (
    <FileManagerContainer {...getRootProps()}>
      <input {...getInputProps()} />
      <Card sx={{ padding: "24px", boxShadow: 3 }}>
        <Typography variant="h5">File Manager</Typography>
        {renderBreadcrumbs()}
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Box sx={{ display: "flex", gap: 2 }}>
            <Button
              startIcon={<UploadIcon />}
              onClick={() =>
                document.querySelector('input[type="file"]').click()
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
          {selectedFiles.length > 0 && (
            <Box sx={{ display: "flex", gap: 2 }}>
              <Button startIcon={<DownloadIcon />} onClick={downloadFiles}>
                {isSmallScreen ? "" : "Download Selected"}
              </Button>
              <Button startIcon={<DeleteIcon />} onClick={deleteFiles}>
                {isSmallScreen ? "" : "Delete Selected"}
              </Button>
              <TextField
                value={destinationPath}
                onChange={(e) => setDestinationPath(e.target.value)}
                placeholder="Move to path"
                InputProps={{
                  endAdornment: (
                    <IconButton onClick={moveFiles}>
                      <ArrowForwardIcon />
                    </IconButton>
                  ),
                }}
              />
            </Box>
          )}
        </Box>
        <List>
          {files.map((file) => (
            <ListItem
              key={file.name}
              secondaryAction={
                <Checkbox
                  edge="end"
                  checked={selectedFiles.includes(`${path}/${file.name}`)}
                  onChange={() => toggleFileSelection(`${path}/${file.name}`)}
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
                      onClick={() => handleFolderChange(`${path}/${file.name}`)}
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
                <IconButton
                  onClick={() => openFileEditor(`${path}/${file.name}`)}
                >
                  <EditIcon />
                </IconButton>
              )}
              {file.name.endsWith(".zip") && (
                <IconButton
                  onClick={() => unarchiveFile(`${path}/${file.name}`)}
                >
                  <UnarchiveIcon />
                </IconButton>
              )}
            </ListItem>
          ))}
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
    </FileManagerContainer>
  );
}

export default FileManager;
