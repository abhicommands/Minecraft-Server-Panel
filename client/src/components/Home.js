import React, { useState, useEffect } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import Login from "./Login";

function Home() {
  const [servers, setServers] = useState([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState(null);

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    try {
      const response = await axios.get("http://localhost:3001/servers", {
        withCredentials: true,
      });
      console.log(response.data.servers);
      setServers(response.data.servers);
      setUsername(response.data.username);
      setIsAuthenticated(true);
    } catch (error) {
      setIsAuthenticated(false);
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post(
        "http://localhost:3001/logout",
        {},
        {
          withCredentials: true,
        }
      );
      setIsAuthenticated(false);
      setUsername(null);
      setServers([]);
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  return (
    <div>
      {!isAuthenticated ? (
        <Login onLoginSuccess={fetchServers} />
      ) : (
        <>
          <h1>Welcome {username}</h1>
          <button onClick={handleLogout}>Logout</button>
          <Link to="/create-server">
            <button>Create New Server</button>
          </Link>
          {servers.length > 0 && (
            <ul>
              {servers.map((server) => (
                <li key={server.id}>
                  <Link to={`/server/${server.id}`}>{server.name}</Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default Home;
