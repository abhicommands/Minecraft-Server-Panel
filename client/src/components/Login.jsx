import React, { useState } from "react";
import {
  Button,
  TextField,
  Box,
  Container,
  Typography,
  IconButton,
  InputAdornment,
} from "@mui/material";
import { styled } from "@mui/system";
import axios from "axios";
import { Visibility, VisibilityOff } from "@mui/icons-material";
import { API_URL } from "../config";

const LoginContainer = styled(Container)`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
`;

const LoginBox = styled(Box)`
  padding: 2rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
`;

const Login = ({ onLoginSuccess }) => {
  const [showPassword, setShowPassword] = useState(false);

  const handleTogglePasswordVisibility = () => {
    setShowPassword(!showPassword);
  };

  const onFinish = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = data.get("username");
    const password = data.get("password");

    try {
      await axios.post(
        `${API_URL}/login`,
        { username, password },
        { withCredentials: true }
      );
      onLoginSuccess(true);
    } catch (error) {
      onLoginSuccess(false);
      alert("Login failed: " + error.message);
    }
  };

  return (
    <LoginContainer maxWidth="sm">
      <LoginBox>
        <Typography variant="h5" gutterBottom>
          Login
        </Typography>
        <Box component="form" onSubmit={onFinish} noValidate>
          <TextField
            label="Username"
            name="username"
            variant="outlined"
            fullWidth
            required
            margin="normal"
          />
          <TextField
            label="Password"
            name="password"
            type={showPassword ? "text" : "password"}
            variant="outlined"
            fullWidth
            required
            margin="normal"
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="toggle password visibility"
                    onClick={handleTogglePasswordVisibility}
                    edge="end"
                  >
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
          <Button type="submit" variant="contained" color="primary" fullWidth>
            Submit
          </Button>
        </Box>
      </LoginBox>
    </LoginContainer>
  );
};

export default Login;
