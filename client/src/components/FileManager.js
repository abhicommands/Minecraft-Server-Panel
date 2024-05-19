import React, { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { useDropzone } from "react-dropzone";

function FileManager() {
  const { id } = useParams();
  const [files, setFiles] = useState([]);
  const [path, setPath] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const API_URL = process.env.REACT_APP_API_URL;

  const fetchFiles = async () => {
    try {
      const response = await axios.get(`${API_URL}/servers/${id}/files`, {
        params: { path }, // Using params object to properly include query parameters
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
        params: { path }, // Including path as a query parameter
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
          params: { path }, // Passing the path as a query parameter
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

  const downloadFile = async (filePath) => {
    try {
      const response = await axios.get(`${API_URL}/servers/${id}/download`, {
        params: { filePath }, // Correct usage of params to send query parameters
        responseType: "blob",
        withCredentials: true,
      });
      const contentType = response.headers["content-type"];
      let fileName = filePath.split("/").pop();
      if (
        contentType.includes("application/zip") &&
        !fileName.endsWith(".zip")
      ) {
        fileName += ".zip";
      }
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", fileName);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
    } catch (error) {
      console.error("Error downloading file:", error);
    }
  };

  const deleteFile = async (filePath) => {
    try {
      await axios.delete(`${API_URL}/servers/${id}/files`, {
        params: { filePath },
        withCredentials: true,
      });
      fetchFiles();
    } catch (error) {
      console.error("Error deleting file:", error);
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
      {path && (
        <button onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>
          Go Back
        </button>
      )}
      <div>
        <input
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          placeholder="New Folder Name"
        />
        <button onClick={createFolder}>Create Folder</button>
      </div>
      <ul>
        {files.map((file) => (
          <li key={file.name}>
            {file.type === "directory" ? (
              <span style={{ cursor: "pointer" }}>
                <span
                  onClick={() => handleFolderChange(`${path}/${file.name}`)}
                  style={{ color: "blue" }}
                >
                  [Folder] {file.name}
                </span>
                <button onClick={() => downloadFile(`${path}/${file.name}`)}>
                  Download
                </button>
                <button onClick={() => deleteFile(`${path}/${file.name}`)}>
                  Delete
                </button>
              </span>
            ) : (
              <span>
                {file.name}
                <button onClick={() => downloadFile(`${path}/${file.name}`)}>
                  Download
                </button>
                <button onClick={() => deleteFile(`${path}/${file.name}`)}>
                  Delete
                </button>
                {file.name.endsWith(".zip") && (
                  <button onClick={() => unarchiveFile(`${path}/${file.name}`)}>
                    Unarchive
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p>Drag 'n' drop files here, or click to select files</p>
    </div>
  );
}

export default FileManager;
