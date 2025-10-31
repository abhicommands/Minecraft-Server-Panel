const path = require("path");
const fs = require("fs-extra");
const Database = require("better-sqlite3");
const { validate } = require("uuid");

const DB_PATH = path.join(__dirname, "myServers.db");
fs.ensureFileSync(DB_PATH);

let nativeDb;
try {
  nativeDb = new Database(DB_PATH);
  console.log("Database connected.");
} catch (error) {
  console.error("Error opening database", error.message);
  throw error;
}

const runSchemaMigrations = () => {
  try {
    nativeDb.exec(
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
      );`
    );
  } catch (error) {
    console.error("Error creating servers table", error.message);
  }

  try {
    nativeDb.exec("CREATE INDEX IF NOT EXISTS idx_uuid ON servers (uuid);");
  } catch (error) {
    console.error("Error creating UUID index", error.message);
  }
};

runSchemaMigrations();

const scheduleCallback = (fn) =>
  typeof setImmediate === "function" ? setImmediate(fn) : process.nextTick(fn);

const isPlainObject = (value) =>
  Object.prototype.toString.call(value) === "[object Object]";

const normalizeValue = (value) => {
  if (value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
};

const prepareParams = (params) => {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params;
  if (isPlainObject(params)) return params;
  return [params];
};

const normalizeParams = (params) => {
  if (Array.isArray(params)) {
    return params.map((value) => normalizeValue(value));
  }
  if (isPlainObject(params)) {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, normalizeValue(value)])
    );
  }
  return normalizeValue(params);
};

const hasBoundParams = (params) => {
  if (Array.isArray(params)) return params.length > 0;
  if (isPlainObject(params)) return Object.keys(params).length > 0;
  return params !== undefined;
};

const extractParamsAndCallback = (params, callback) => {
  if (typeof params === "function") {
    return { params: [], callback: params };
  }
  return {
    params,
    callback: typeof callback === "function" ? callback : undefined,
  };
};

const db = {};

db.run = (sql, params, callback) => {
  const { params: rawParams, callback: cb } = extractParamsAndCallback(
    params,
    callback
  );
  const prepared = prepareParams(rawParams);
  const normalized = normalizeParams(prepared);
  const statement = nativeDb.prepare(sql);

  const execute = () =>
    hasBoundParams(normalized)
      ? statement.run(normalized)
      : statement.run();

  if (!cb) {
    execute();
    return db;
  }

  try {
    const info = execute();
    const context = {
      lastID: Number(info.lastInsertRowid),
      changes: info.changes,
    };
    scheduleCallback(() => cb.call(context, null));
  } catch (error) {
    scheduleCallback(() => cb(error));
  }

  return db;
};

db.get = (sql, params, callback) => {
  const { params: rawParams, callback: cb } = extractParamsAndCallback(
    params,
    callback
  );
  const prepared = prepareParams(rawParams);
  const normalized = normalizeParams(prepared);
  const statement = nativeDb.prepare(sql);

  const execute = () =>
    hasBoundParams(normalized)
      ? statement.get(normalized)
      : statement.get();

  if (!cb) {
    return execute();
  }

  try {
    const row = execute();
    scheduleCallback(() => cb(null, row));
  } catch (error) {
    scheduleCallback(() => cb(error));
  }

  return db;
};

db.all = (sql, params, callback) => {
  const { params: rawParams, callback: cb } = extractParamsAndCallback(
    params,
    callback
  );
  const prepared = prepareParams(rawParams);
  const normalized = normalizeParams(prepared);
  const statement = nativeDb.prepare(sql);

  const execute = () =>
    hasBoundParams(normalized)
      ? statement.all(normalized)
      : statement.all();

  if (!cb) {
    return execute();
  }

  try {
    const rows = execute();
    scheduleCallback(() => cb(null, rows));
  } catch (error) {
    scheduleCallback(() => cb(error));
  }

  return db;
};

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
