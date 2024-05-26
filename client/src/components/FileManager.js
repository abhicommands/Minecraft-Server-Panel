import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { useDropzone } from "react-dropzone";
import EditFile from "./EditFile"; // Assuming you create a new component for editing files

function FileManager() {
  const { id } = useParams();
  const [files, setFiles] = useState([]);
  const [path, setPath] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [editingFile, setEditingFile] = useState(null);
  const [destinationPath, setDestinationPath] = useState("");
  const navigate = useNavigate();
  const API_URL = process.env.REACT_APP_API_URL;

  const fetchFiles = async () => {
    try {
      const response = await axios.get(`${API_URL}/servers/${id}/files`, {
        params: { path },
        withCredentials: true,
      });
      setFiles(response.data);
    } catch (error) {
      console.error("Error fetching files:", error);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [path, id]);

  const onDrop = async (acceptedFiles) => {
    const formData = new FormData();
    acceptedFiles.forEach((file) => {
      formData.append("files", file);
    });
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
  };

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
  });

  const createFolder = async () => {
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
      fetchFiles();
    } catch (error) {
      console.error("Error creating folder:", error);
    }
  };

  const handleFolderChange = (newPath) => {
    setPath(newPath);
  };

  const downloadFiles = async () => {
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
    } catch (error) {
      console.error("Error downloading files:", error);
    }
  };

  const deleteFiles = async () => {
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
  };
  const moveFiles = async () => {
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
      fetchFiles(); // Refresh files after moving
      setDestinationPath(""); // Clear destination path input
      setSelectedFiles([]); // Clear selection
    } catch (error) {
      console.error("Error moving files:", error);
    }
  };

  const unarchiveFile = async (filePath) => {
    try {
      await axios.get(`${API_URL}/servers/${id}/unarchive`, {
        params: { filePath },
        withCredentials: true,
      });
      fetchFiles();
    } catch (error) {
      console.error("Error unarchiving file:", error);
    }
  };

  const toggleFileSelection = (fileName) => {
    setSelectedFiles((prevSelectedFiles) =>
      prevSelectedFiles.includes(fileName)
        ? prevSelectedFiles.filter((file) => file !== fileName)
        : [...prevSelectedFiles, fileName]
    );
  };

  const editableExtensions = [".txt", ".json", ".properties", ".log"]; // Add other extensions as needed

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
        <span
          key={breadcrumbPath}
          onClick={() => setPath(breadcrumbPath)}
          style={{ cursor: "pointer", color: "blue" }}
        >
          {segment}
        </span>
      );
    });

    return (
      <div>
        <span
          onClick={() => setPath("")}
          style={{ cursor: "pointer", color: "blue" }}
        >
          root
        </span>
        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={index}>
            {" / "}
            {crumb}
          </React.Fragment>
        ))}
      </div>
    );
  };

  return (
    <div
      {...getRootProps()}
      style={{
        border: "2px dashed gray",
        padding: "20px",
        width: "100%",
        minHeight: "300px",
      }}
    >
      <input {...getInputProps()} />
      <h2>File Manager</h2>
      {renderBreadcrumbs()}
      <div>
        <input
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          placeholder="New Folder Name"
        />
        <button onClick={createFolder}>Create Folder</button>
      </div>
      {selectedFiles.length > 0 && (
        <div>
          <button onClick={downloadFiles}>Download Selected</button>
          <button onClick={deleteFiles}>Delete Selected</button>
          <input
            value={destinationPath}
            onChange={(e) => setDestinationPath(e.target.value)}
            placeholder="Move to path"
          />
          <button onClick={moveFiles}>Move Selected</button>
        </div>
      )}
      <ul>
        {files.map((file) => (
          <li key={file.name}>
            {file.type === "directory" ? (
              <span style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={selectedFiles.includes(`${path}/${file.name}`)}
                  onChange={() => toggleFileSelection(`${path}/${file.name}`)}
                />
                <span
                  onClick={() => handleFolderChange(`${path}/${file.name}`)}
                  style={{ color: "blue" }}
                >
                  [Folder] {file.name}
                </span>
              </span>
            ) : (
              <span>
                <input
                  type="checkbox"
                  checked={selectedFiles.includes(`${path}/${file.name}`)}
                  onChange={() => toggleFileSelection(`${path}/${file.name}`)}
                />
                {file.name}
                {file.name.endsWith(".zip") && (
                  <button onClick={() => unarchiveFile(`${path}/${file.name}`)}>
                    Unarchive
                  </button>
                )}
                {isEditable(file.name) && (
                  <button
                    onClick={() => openFileEditor(`${path}/${file.name}`)}
                  >
                    Edit
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p>Drag 'n' drop files here, or click to select files</p>
      {editingFile && (
        <EditFile file={editingFile} onClose={() => setEditingFile(null)} />
      )}
    </div>
  );
}

export default FileManager;
