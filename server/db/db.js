const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs-extra");
const { validate } = require("uuid");

const DB_PATH = path.join(__dirname, "myServers.db");
fs.ensureFileSync(DB_PATH);

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Error opening database", err.message);
  } else {
    console.log("Database connected.");
    db.serialize(() => {
      db.run(
        `CREATE TABLE IF NOT EXISTS servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT,
          name TEXT,
          path TEXT,
          backupPath TEXT,
          startupCommand TEXT,
          version TEXT,
          port INTEGER UNIQUE,
          serverType TEXT,
          mshConfig BOOLEAN
        );`,
        (err) => {
          if (err) console.error("Error creating table", err.message);
        }
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_uuid ON servers (uuid);",
        (err) => {
          if (err) console.error("Error creating UUID index", err.message);
        }
      );
    });
  }
});

// Middleware to find servers by UUID
const findServer = (req, res, next) => {
  const uuid = req.params.id;
  if (!validate(uuid)) {
    res.status(400).send("Invalid UUID");
    return;
  }
  db.get("SELECT * FROM servers WHERE uuid = ?", uuid, (err, row) => {
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

module.exports = { db, findServer };
