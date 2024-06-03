import React, { useState, useEffect } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { Typography, Card, Grid, Box } from "@mui/material";
import { styled } from "@mui/system";

const HomeContainer = styled(Box)`
  padding: 20px;
`;

const ServerCard = styled(Card)`
  padding: 20px;
  margin-bottom: 20px;
  cursor: pointer;
  transition: background-color 0.3s, box-shadow 0.3s;
  &:hover {
    background-color: #a9a9a9;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
  }
`;

function Home() {
  const [servers, setServers] = useState([]);
  const [username, setUsername] = useState(null);
  const API_URL = process.env.REACT_APP_API_URL;
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
    navigate(`/server/${serverId}/`);
  };

  return (
    <HomeContainer>
      <Typography variant="h4" gutterBottom>
        Welcome {username}
      </Typography>
      {servers.length > 0 && (
        <Grid container spacing={3}>
          {servers.map((server) => (
            <Grid item key={server.id} xs={12}>
              <ServerCard onClick={() => handleServerClick(server.id)}>
                <Typography variant="h6">{server.name}</Typography>
                <Typography variant="body2">
                  <strong>Port:</strong> {server.port}
                </Typography>
                <Typography variant="body2">
                  <strong>Version:</strong> {server.version}
                </Typography>
              </ServerCard>
            </Grid>
          ))}
        </Grid>
      )}
    </HomeContainer>
  );
}

export default Home;
