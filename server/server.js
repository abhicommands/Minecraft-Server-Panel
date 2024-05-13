require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { router: authRoutes } = require("./routes/auth");
const serverRoutes = require("./routes/serverManagement");
const fileRoutes = require("./routes/fileRoutes");
const config = require("./config/config");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(cookieParser());

app.use(authRoutes);
app.use(serverRoutes);
app.use(fileRoutes);

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
