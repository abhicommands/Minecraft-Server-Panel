import React, { useState, useEffect } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { Typography, Card, Box } from "@mui/material";
import { styled } from "@mui/system";
import { API_URL } from "../config";

const HomeContainer = styled(Box)`
  padding: 24px;
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
`;

const ServersList = styled(Box)`
  display: flex;
  flex-direction: column;
  gap: 24px;
  width: 100%;
`;

const ServerCard = styled(Card)`
  padding: 28px 36px;
  cursor: pointer;
  transition: box-shadow 0.3s ease, transform 0.2s ease;
  width: calc(100% - 12px);
  box-sizing: border-box;
  min-height: 120px;
  border-radius: 12px;
  background: #2e2e2e;
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  }
`;

function Home() {
  const [servers, setServers] = useState([]);
  const [username, setUsername] = useState(null);
  const navigate = useNavigate();

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

  const handleServerClick = (serverId) => {
    navigate(`/server/${serverId}`);
  };

  return (
    <HomeContainer>
      <Typography variant="h4" gutterBottom>
        Welcome {username}
      </Typography>
      {servers.length > 0 && (
        <ServersList>
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              elevation={6}
              onClick={() => handleServerClick(server.id)}
            >
              <Typography variant="h5" gutterBottom>
                {server.name}
              </Typography>
              <Typography variant="body1">
                <strong>Port:</strong> {server.port}
              </Typography>
              <Typography variant="body1">
                <strong>Version:</strong> {server.version}
              </Typography>
            </ServerCard>
          ))}
        </ServersList>
      )}
    </HomeContainer>
  );
}

export default Home;
