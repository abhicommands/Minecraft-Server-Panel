const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs-extra");

const DB_PATH = path.join(__dirname, "/myServers.db");
fs.ensureFileSync(DB_PATH);
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("Error opening database", err.message);
  else {
    console.log("Database connected.");
    db.run(
      `
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT,
        path TEXT,
        backupPath TEXT
      )
    `,
      (err) => {
        if (err) console.error("Error creating table", err.message);
      }
    );
  }
});

//find servers middleware function
const findServer = (req, res, next) => {
  const serverId = req.params.id;
  db.get("SELECT * FROM servers WHERE id = ?", serverId, (err, row) => {
    if (err) {
      res.status(500).send("Failed to retrieve server");
    } else if (!row) {
      res.status(404).send("Server not found");
    } else {
      req.server = row;
      next();
    }
  });
};

module.exports = { db , findServer};
