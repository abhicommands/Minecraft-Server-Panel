const path = require("path");

const SERVERS_BASE_PATH = path.join(__dirname, "../server-directory");

module.exports = {
  port: process.env.PORT,
  SERVERS_BASE_PATH,
  JWT_SECRET: process.env.JWT_SECRET,
  ROOT_PASSWORD_HASH: process.env.ROOT_PASSWORD_HASH,
  corsOrigin: process.env.CORS_ORIGIN,
};
