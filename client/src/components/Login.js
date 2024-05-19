import React, { useState } from "react";
import axios from "axios";

function Login({ onLoginSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const API_URL = process.env.REACT_APP_API_URL;

  const handleLogin = async (event) => {
    event.preventDefault();
    try {
      await axios.post(
        `${API_URL}/login`,
        { username, password },
        { withCredentials: true }
      );
      onLoginSuccess();
    } catch (error) {
      alert("Login failed: " + error.message);
    }
  };

  return (
    <form onSubmit={handleLogin}>
      <label>
        Username:
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label>
        Password:
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button type="submit">Login</button>
    </form>
  );
}

export default Login;
