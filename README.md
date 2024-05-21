# Fabric Minecraft Server Panel

This is a nodejs Minecraft server panel, created in the front end using react, and the backend is using nodejs.

## How to run the program locally and develop.

### Frontend (React)

In the `client` directory, you can run:

#### `npm start`

Runs the React app in development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.\
The page will reload when you make changes. You may also see any lint errors in the console.

## Environment Variables

### Frontend

Create a `.env` file inside the `client` directory with the following content (example for development if the backend is running on port 3001):

```plaintext
REACT_APP_API_URL=http://localhost:3001
REACT_APP_SOCKET_URL=http://localhost:3001
REACT_APP_SOCKET_PATH=/socket.io
```

### Backend

Create a `.env` file inside the `server` directory with the following content (example for development):

```plaintext
ROOT_USERNAME=sample_username
ROOT_PASSWORD_HASH="hashed password"
JWT_SECRET=your_jwt_secret
PORT=3001
CORSORIGIN=http://localhost:3000
SECURE_STATUS=true
```

The username hash can be generated using the following command:
const bcrypt = require("bcryptjs");

```plaintext
async function generateHash() {
  const password = "sample_password"; // Replace with your actual password
  const saltRounds = 10; //used in my backend
  const hash = await bcrypt.hash(password, saltRounds);
  console.log("Hashed password:", hash);
}
generateHash();
```

you have to run node hash.js to generate the hash, and put that hash in the .env variable.
