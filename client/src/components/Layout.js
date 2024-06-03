import React from "react";
import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Avatar,
  Box,
  Link as MuiLink,
} from "@mui/material";
import { Link, useNavigate } from "react-router-dom";

const AppLayout = ({ children, isAuthenticated, handleLogout }) => {
  const navigate = useNavigate();

  return (
    <Box sx={{ flexGrow: 1 }}>
      <AppBar position="static">
        <Toolbar>
          <Typography
            variant="h6"
            sx={{ flexGrow: 1, cursor: "pointer", textDecoration: "none" }}
            onClick={() => navigate("/")}
            component="div"
          >
            My App
          </Typography>
          {isAuthenticated && (
            <>
              <Button color="inherit" component={Link} to="/create-server">
                Create New Server
              </Button>
              <Button color="inherit" onClick={handleLogout}>
                Logout
              </Button>
              <Avatar sx={{ ml: 2 }} />
            </>
          )}
        </Toolbar>
      </AppBar>
      <Box sx={{ p: 3 }}>{children}</Box>
    </Box>
  );
};

export default AppLayout;
