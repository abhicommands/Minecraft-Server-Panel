import { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import axios from "axios";
import Home from "./components/Home";
import ServerDetails from "./components/ServerDetails";
import CreateServer from "./components/CreateServer";
import AppLayout from "./components/Layout";
import Login from "./components/Login";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { API_URL, ensureEnv } from "./config";

const theme = createTheme({
  palette: {
    mode: "dark",
  },
});

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    ensureEnv();
    const fetchUserData = async () => {
      try {
        await axios.get(`${API_URL}/validate-session`, {
          withCredentials: true,
        });
        setIsAuthenticated(true);
      } catch {
        setIsAuthenticated(false);
      }
    };
    fetchUserData();
  }, []);

  const handleLogout = async () => {
    try {
      await axios.post(
        `${API_URL}/logout`,
        {},
        { withCredentials: true }
      );
      setIsAuthenticated(false);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  return (
    <ThemeProvider theme={theme}>
      <Router>
        {isAuthenticated ? (
          <AppLayout
            isAuthenticated={isAuthenticated}
            handleLogout={handleLogout}
          >
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/server/:id/*" element={<ServerDetails />} />
              <Route path="/create-server" element={<CreateServer />} />
              <Route path="*" element={<h1>Page Doesn't exist</h1>} />
            </Routes>
          </AppLayout>
        ) : (
          <Login onLoginSuccess={setIsAuthenticated} />
        )}
      </Router>
    </ThemeProvider>
  );
}

export default App;
