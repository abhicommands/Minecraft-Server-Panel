// src/components/EditFile.js
import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { API_URL } from "../config";

function EditFile() {
  const { id, encodedPath } = useParams();
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const filePath = decodeURIComponent(encodedPath);
    const fetchFileContent = async () => {
      try {
        const response = await axios.get(
          `${API_URL}/servers/${id}/files/read`,
          {
            params: { filePath },
            withCredentials: true,
          }
        );
        setContent(response.data);
        setFileName(filePath);
      } catch (error) {
        console.error("Error reading file:", error);
      }
    };
    fetchFileContent();
  }, [id, encodedPath]);

  const saveFile = async () => {
    try {
      await axios.post(
        `${API_URL}/servers/${id}/files/save`,
        { path: fileName, content },
        {
          withCredentials: true,
        }
      );
      navigate(-1); // Go back to the previous page
    } catch (error) {
      console.error("Error saving file:", error);
    }
  };

  return (
    <div style={{ padding: "20px", border: "1px solid gray" }}>
      <h3>Editing {fileName}</h3>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        style={{ width: "100%", height: "300px" }}
      />
      <button onClick={saveFile}>Save</button>
      <button onClick={() => navigate(-1)}>Close</button>
    </div>
  );
}

export default EditFile;
