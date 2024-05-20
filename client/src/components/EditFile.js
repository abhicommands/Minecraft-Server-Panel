import React, { useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";

function EditFile({ file, onClose }) {
  const { id } = useParams();
  const [content, setContent] = useState(file.content);
  const API_URL = process.env.REACT_APP_API_URL;

  const saveFile = async () => {
    try {
      await axios.post(
        `${API_URL}/servers/${id}/files/save`,
        { path: file.path, content },
        {
          withCredentials: true,
        }
      );
      onClose();
    } catch (error) {
      console.error("Error saving file:", error);
    }
  };

  return (
    <div style={{ padding: "20px", border: "1px solid gray" }}>
      <h3>Editing {file.path}</h3>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        style={{ width: "100%", height: "300px" }}
      />
      <button onClick={saveFile}>Save</button>
      <button onClick={onClose}>Close</button>
    </div>
  );
}

export default EditFile;
