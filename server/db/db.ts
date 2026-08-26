import { Database } from "bun:sqlite";
import type { AppConfig, ServerRecord } from "../types.ts";
import { HttpError } from "../utils/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export class PanelDatabase {
  readonly sqlite: Database;
  private closed = false;

  constructor(config: AppConfig) {
    this.sqlite = new Database(config.databasePath, { create: true, strict: true });
    try {
      this.assertFreshSchemaCompatible();
      this.sqlite.exec("PRAGMA journal_mode = WAL;");
      this.sqlite.exec("PRAGMA busy_timeout = 5000;");
      this.sqlite.exec("PRAGMA foreign_keys = ON;");
      this.initializeSchema();
      // Ask SQLite to gather bounded planner statistics when they are useful.
      // The UUID UNIQUE constraint already supplies the lookup index.
      this.sqlite.exec("PRAGMA optimize=0x10002;");
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  private assertFreshSchemaCompatible(): void {
    const table = this.sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'servers'")
      .get() as { name: string } | null;
    if (!table) return;
    const columns = this.sqlite
      .query("PRAGMA table_info(servers)")
      .all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "path" || column.name === "backupPath")) {
      throw new Error(
        "This Bun data directory contains the pre-reset schema. Use a fresh panel-data directory; the legacy server/ database is not modified automatically.",
      );
    }
  }

  private initializeSchema(): void {
    this.sqlite.transaction(() => {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS servers (
          id INTEGER PRIMARY KEY,
          uuid TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          startupCommand TEXT NOT NULL,
          startupFlags TEXT NOT NULL DEFAULT '',
          version TEXT NOT NULL,
          port INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1 AND 65535),
          serverType TEXT NOT NULL
        );
      `);
      this.sqlite.exec("PRAGMA user_version = 1;");
    })();
  }

  listServers(): ServerRecord[] {
    return this.sqlite.query("SELECT * FROM servers ORDER BY id").all() as ServerRecord[];
  }

  getServer(uuid: string): ServerRecord | null {
    if (!isUuid(uuid)) throw new HttpError(400, "Invalid UUID");
    const row = this.sqlite
      .query("SELECT * FROM servers WHERE uuid = ?")
      .get(uuid) as ServerRecord | null;
    if (!row) throw new HttpError(404, "Server not found");
    return { ...row, startupFlags: row.startupFlags || "" };
  }

  insertServer(record: Omit<ServerRecord, "id">): void {
    this.sqlite
      .query(`
        INSERT INTO servers
          (uuid, name, startupCommand, startupFlags, version, port, serverType)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.uuid,
        record.name,
        record.startupCommand,
        record.startupFlags,
        record.version,
        record.port,
        record.serverType,
      );
  }

  updateVersion(uuid: string, version: string): void {
    this.sqlite.query("UPDATE servers SET version = ? WHERE uuid = ?").run(version, uuid);
  }

  updateServerType(uuid: string, serverType: string): void {
    this.sqlite
      .query("UPDATE servers SET serverType = ? WHERE uuid = ?")
      .run(serverType, uuid);
  }

  updateDistribution(uuid: string, version: string, serverType: string): void {
    this.sqlite
      .query("UPDATE servers SET version = ?, serverType = ? WHERE uuid = ?")
      .run(version, serverType, uuid);
  }

  updateStartupFlags(uuid: string, flags: string): void {
    this.sqlite
      .query("UPDATE servers SET startupFlags = ? WHERE uuid = ?")
      .run(flags, uuid);
  }

  deleteServer(uuid: string): void {
    if (!isUuid(uuid)) throw new HttpError(400, "Invalid UUID");
    this.sqlite.query("DELETE FROM servers WHERE uuid = ?").run(uuid);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sqlite.exec("PRAGMA optimize;");
    } catch (error) {
      console.warn(
        `SQLite planner optimization during shutdown was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.sqlite.close();
    }
  }
}
