import React, { useState, useEffect } from "react";
import axios from "axios";
import { Link } from "react-router-dom";

function Home() {
  const [servers, setServers] = useState([]);
  const [username, setUsername] = useState(null);
  const API_URL = process.env.REACT_APP_API_URL;

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    try {
      const response = await axios.get(`${API_URL}/servers`, {
        withCredentials: true,
      });
      setServers(response.data.servers);
      setUsername(response.data.username);
    } catch (error) {
      console.error("Failed to fetch servers:", error);
    }
  };
  return (
    <div>
      <h1>Welcome {username}</h1>
      <Link to="/create-server">
        <button>Create New Server</button>
      </Link>
      {servers.length > 0 && (
        <ul>
          {servers.map((server) => (
            <li key={server.id}>
              <Link to={`/server/${server.id}/`}>{server.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default Home;
