// src/App.js
import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import axios from "axios";
import Home from "./components/Home";
import ServerDetails from "./components/ServerDetails";
import CreateServer from "./components/CreateServer";
import Layout from "./components/Layout";
import Login from "./components/Login";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const API_URL = process.env.REACT_APP_API_URL;

  const fetchUserData = async () => {
    try {
      await axios.get(`${API_URL}/validate-session`, {
        withCredentials: true,
      });
      setIsAuthenticated(true);
    } catch (error) {
      setIsAuthenticated(false);
    }
  };
  useEffect(() => {
    fetchUserData();
  }, []);

  const handleLogout = async () => {
    try {
      await axios.post(`${API_URL}/logout`, {}, { withCredentials: true });
      setIsAuthenticated(false);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };
  const setLoginStatus = (status) => {
    setIsAuthenticated(status);
  };
  return (
    <Router>
      {isAuthenticated ? (
        <Layout isAuthenticated={isAuthenticated} handleLogout={handleLogout}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/server/:id/*" element={<ServerDetails />} />
            <Route path="/create-server" element={<CreateServer />} />
            <Route path="*" element={<h1>Page Doesn't exist</h1>} />
          </Routes>
        </Layout>
      ) : (
        <Login onLoginSuccess={setLoginStatus} />
      )}
    </Router>
  );
}

export default App;
