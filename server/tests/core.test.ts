import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js/index-native.js";
import { loadConfig } from "../config.ts";
import { PanelDatabase } from "../db/db.ts";
import {
  getTaskStatus,
  startUnzipTask,
  startZipTask,
} from "../utils/archiveManager.ts";
import { resolveSafePath, validateLeafName } from "../utils/pathSafety.ts";
import { newServerLayout } from "../utils/serverLayout.ts";
import { classifyPublicAddress } from "../utils/deployment.ts";
import {
  commitStagedDistribution,
  reconcileServerDeletionTombstones,
  validateCreateBody,
} from "../routes/serverManagementRoutes.ts";
import type { AppConfig } from "../types.ts";
import {
  composeStartupArgv,
  ensureValidStartupFlags,
  parseCommandLine,
} from "../utils/terminal.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "panel-bun-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("configuration", () => {
  test("loads generated TOML configuration from the default panel-data directory", async () => {
    const home = await temporaryDirectory();
    const dataDir = path.join(home, "panel-data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "config.toml"),
      Bun.TOML.stringify({
        root_username: "admin",
        root_password_hash: "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri",
        jwt_secret: "0123456789abcdef0123456789abcdef",
        port: 4321,
        secure_cookie: false,
        environment: "development",
      })!,
    );

    const config = loadConfig({}, home);
    expect(config.dataDir).toBe(dataDir);
    expect(config.databasePath).toBe(path.join(dataDir, "database", "panel.sqlite3"));
    expect(config.serversPath).toBe(path.join(dataDir, "servers"));
    expect(config.port).toBe(4321);
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.corsOrigin).toBeNull();
  });

  test("validates and resolves external data paths", async () => {
    const cwd = await temporaryDirectory();
    const config = loadConfig(
      {
        ROOT_USERNAME: "admin",
        ROOT_PASSWORD_HASH: "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri",
        JWT_SECRET: "0123456789abcdef0123456789abcdef",
        PORT: "3001",
        CORSORIGIN: "http://localhost:5173",
        SECURE_STATUS: "false",
        NODE_ENV: "development",
        PANEL_DATA_DIR: "data",
      },
      cwd,
    );
    expect(config.dataDir).toBe(path.join(cwd, "data"));
    expect(config.databasePath).toBe(path.join(cwd, "data", "database", "panel.sqlite3"));
    expect(config.uploadMaxBytes).toBe(2_147_483_648);
  });

  test("rejects short JWT secrets and insecure production cookies", async () => {
    const cwd = await temporaryDirectory();
    const base = {
      ROOT_USERNAME: "admin",
      ROOT_PASSWORD_HASH: "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri",
      JWT_SECRET: "short",
      CORSORIGIN: "https://panel.example",
      SECURE_STATUS: "false",
      NODE_ENV: "production",
    };
    expect(() => loadConfig(base, cwd)).toThrow();
  });

  test("requires an explicit opt-in for direct HTTP production", async () => {
    const cwd = await temporaryDirectory();
    const base = {
      ROOT_USERNAME: "admin",
      ROOT_PASSWORD_HASH: "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
      SECURE_STATUS: "false",
      NODE_ENV: "production",
      PANEL_DEPLOYMENT_MODE: "direct-http",
      PANEL_PUBLIC_ADDRESS: "203.0.113.10",
      PANEL_HOST: "0.0.0.0",
    };
    expect(() => loadConfig(base, cwd)).toThrow("ALLOW_INSECURE_HTTP=true");

    const config = loadConfig({ ...base, ALLOW_INSECURE_HTTP: "true" }, cwd);
    expect(config.production).toBe(true);
    expect(config.secureCookie).toBe(false);
    expect(config.allowInsecureHttp).toBe(true);
    expect(config.deploymentMode).toBe("direct-http");
  });

  test("classifies DNS names for HTTPS and IP addresses for direct HTTP", () => {
    expect(classifyPublicAddress("Panel.Example.com")).toEqual({
      value: "panel.example.com",
      kind: "domain",
      deploymentMode: "https",
      listenHost: "127.0.0.1",
    });
    expect(classifyPublicAddress("203.0.113.10")).toEqual({
      value: "203.0.113.10",
      kind: "ipv4",
      deploymentMode: "direct-http",
      listenHost: "0.0.0.0",
    });
    expect(classifyPublicAddress("2001:db8::10").listenHost).toBe("::");
    expect(() => classifyPublicAddress("https://panel.example.com/path")).toThrow(
      "without a scheme",
    );
    expect(() => classifyPublicAddress("not-a-public-hostname")).toThrow();
  });
});

describe("startup command safety", () => {
  test("parses quoted flags and inserts them before -jar", () => {
    expect(parseCommandLine('-XX:MaxGCPauseMillis=200 "-Dpanel.name=My Server"')).toEqual([
      "-XX:MaxGCPauseMillis=200",
      "-Dpanel.name=My Server",
    ]);
    expect(
      composeStartupArgv(
        "java -Xmx4G -Xms4G -jar server.jar nogui",
        '-XX:+UseG1GC "-Dpanel.name=My Server"',
      ),
    ).toEqual([
      "java",
      "-Xmx4G",
      "-Xms4G",
      "-XX:+UseG1GC",
      "-Dpanel.name=My Server",
      "-jar",
      "server.jar",
      "nogui",
    ]);
  });

  test("rejects shell, memory, jar, and malformed quote overrides", () => {
    for (const flags of ["-Xmx99G", "-jar evil.jar", "foo; reboot", '"unterminated']) {
      expect(() => ensureValidStartupFlags(flags)).toThrow();
    }
  });
});

describe("server creation validation", () => {
  test("accepts HTML number-input strings and normalizes them to integers", () => {
    expect(
      validateCreateBody({
        name: "Test server",
        memory: "1",
        port: "25565",
        version: "1.21.1",
        serverType: "vanilla",
        renderDistance: "10",
        startupFlags: "",
      }),
    ).toEqual({
      name: "Test server",
      memory: 1,
      port: 25565,
      version: "1.21.1",
      serverType: "vanilla",
      renderDistance: 10,
      startupFlags: "",
    });
  });

  test("rejects fractional and malformed numeric fields", () => {
    const valid = {
      name: "Test server",
      memory: 1,
      port: 25565,
      version: "1.21.1",
      serverType: "vanilla",
      renderDistance: 10,
      startupFlags: "",
    };
    expect(() => validateCreateBody({ ...valid, port: "25565.5" })).toThrow(
      "port must be an integer",
    );
    expect(() => validateCreateBody({ ...valid, memory: "1GB" })).toThrow(
      "memory must be an integer",
    );
    expect(() => validateCreateBody({ ...valid, renderDistance: "" })).toThrow(
      "renderDistance must be an integer",
    );
  });
});

describe("server installation crash consistency", () => {
  test("restores live files when update metadata cannot be committed", async () => {
    const root = await temporaryDirectory();
    const serverRoot = path.join(root, "server", "files");
    const stagingRoot = path.join(root, "server", "temporary", "distribution-test");
    await Promise.all([
      mkdir(serverRoot, { recursive: true }),
      mkdir(stagingRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(serverRoot, "server.jar"), "old"),
      writeFile(path.join(stagingRoot, "server.jar"), "new"),
    ]);

    await expect(
      commitStagedDistribution(stagingRoot, serverRoot, () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");
    expect(await readFile(path.join(serverRoot, "server.jar"), "utf8")).toBe("old");
  });

  test("restores or purges interrupted deletion tombstones from database truth", async () => {
    const serversPath = await temporaryDirectory();
    const retainedId = crypto.randomUUID();
    const deletedId = crypto.randomUUID();
    const retainedTombstone = path.join(serversPath, `.delete-${retainedId}-${crypto.randomUUID()}`);
    const deletedTombstone = path.join(serversPath, `.delete-${deletedId}-${crypto.randomUUID()}`);
    await Promise.all([
      mkdir(retainedTombstone, { recursive: true }),
      mkdir(deletedTombstone, { recursive: true }),
    ]);
    reconcileServerDeletionTombstones(
      { serversPath } as AppConfig,
      { listServers: () => [{ uuid: retainedId }] } as unknown as PanelDatabase,
    );

    expect((await stat(path.join(serversPath, retainedId))).isDirectory()).toBe(true);
    expect(await Bun.file(retainedTombstone).exists()).toBe(false);
    expect(await Bun.file(deletedTombstone).exists()).toBe(false);
  });
});

describe("path safety", () => {
  test("contains normal paths and rejects traversal and unsafe leaves", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "world"));
    expect(await resolveSafePath(root, "world/level.dat")).toBe(path.join(root, "world", "level.dat"));
    await expect(resolveSafePath(root, "../outside")).rejects.toThrow("Invalid path");
    expect(() => validateLeafName("../evil")).toThrow();
  });
});

describe("fresh SQLite schema", () => {
  test("persists metadata while deriving portable server paths from the UUID", async () => {
    const dataDir = await temporaryDirectory();
    const config = loadConfig(
      {
        ROOT_USERNAME: "admin",
        ROOT_PASSWORD_HASH: "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri",
        JWT_SECRET: "0123456789abcdef0123456789abcdef",
        CORSORIGIN: "http://localhost:5173",
        SECURE_STATUS: "false",
        PANEL_DATA_DIR: dataDir,
      },
      dataDir,
    );
    const database = new PanelDatabase(config);
    const uuid = crypto.randomUUID();
    database.insertServer({
      uuid,
      name: "Test",
      startupCommand: "java -Xmx2G -Xms2G -jar server.jar nogui",
      startupFlags: "-XX:+UseG1GC",
      version: "1.21.1",
      port: 25565,
      serverType: "vanilla",
    });
    expect(database.getServer(uuid)?.startupFlags).toBe("-XX:+UseG1GC");
    const queryPlan = database.sqlite
      .query("EXPLAIN QUERY PLAN SELECT * FROM servers WHERE uuid = ?")
      .all(uuid) as Array<{ detail: string }>;
    expect(queryPlan.some((step) => step.detail.includes("SEARCH servers"))).toBe(true);
    expect(queryPlan.some((step) => step.detail.includes("uuid"))).toBe(true);
    const columns = database.sqlite
      .query("PRAGMA table_info(servers)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("path");
    expect(columns.map((column) => column.name)).not.toContain("backupPath");
    database.close();

    const reopened = new PanelDatabase(config);
    expect(reopened.listServers()).toHaveLength(1);
    expect(reopened.getServer(uuid)?.name).toBe("Test");
    expect(newServerLayout(config.serversPath, uuid)).toEqual({
      instance: path.join(dataDir, "servers", uuid),
      files: path.join(dataDir, "servers", uuid, "files"),
      backups: path.join(dataDir, "servers", uuid, "backups"),
      logs: path.join(dataDir, "servers", uuid, "logs"),
      runtime: path.join(dataDir, "servers", uuid, "runtime"),
      temporary: path.join(dataDir, "servers", uuid, "temporary"),
    });
    reopened.close();
  });
});

async function waitForTask(taskId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = getTaskStatus(taskId);
    if (task?.status === "completed" || task?.status === "error") return task;
    await Bun.sleep(10);
  }
  throw new Error("Archive task timed out");
}

describe("ZIP streaming", () => {
  test("creates and extracts a compatible archive", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    const output = path.join(root, "archives");
    const extracted = path.join(root, "extracted");
    await mkdir(path.join(source, "world"), { recursive: true });
    await writeFile(path.join(source, "world", "level.dat"), "minecraft-data");

    const zip = startZipTask({
      entries: [{ sourcePath: path.join(source, "world"), destName: "world" }],
      outputDir: output,
      fileName: "backup.zip",
      cleanup: false,
    });
    expect((await waitForTask(zip.taskId)).status).toBe("completed");

    const unzip = startUnzipTask({ archivePath: zip.outputPath, destination: extracted });
    expect((await waitForTask(unzip.taskId)).status).toBe("completed");
    expect(await readFile(path.join(extracted, "world", "level.dat"), "utf8")).toBe("minecraft-data");
  });

  test("rejects absolute archive entry paths", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "absolute.zip");
    const writer = new ZipWriter(new BlobWriter("application/zip"), { zip64: true });
    await writer.add("/absolute.txt", new TextReader("must-not-extract"));
    const blob = await writer.close();
    await writeFile(archivePath, new Uint8Array(await blob.arrayBuffer()));

    const unzip = startUnzipTask({
      archivePath,
      destination: path.join(root, "destination"),
    });
    const status = await waitForTask(unzip.taskId);
    expect(status.status).toBe("error");
    expect(String(status.message)).toContain("absolute path");
  });
});
