import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { io as createSocket, type Socket } from "socket.io-client";
import { loadConfig } from "../config.ts";
import { startApplication, type RunningApplication } from "../server.ts";
import { newServerLayout } from "../utils/serverLayout.ts";

let application: RunningApplication | null = null;
let directory: string | null = null;
let socket: Socket | null = null;

afterEach(async () => {
  socket?.disconnect();
  socket = null;
  await application?.shutdown();
  application = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

async function startTestApplication(
  options: { frontend?: boolean } = {},
): Promise<{ baseUrl: string; cookie: string }> {
  directory = await mkdtemp(path.join(tmpdir(), "panel-bun-server-test-"));
  const config = loadConfig(
    {
      ROOT_USERNAME: "admin",
      ROOT_PASSWORD_HASH: "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
      PORT: "3001",
      CORSORIGIN: "http://localhost:5173",
      SECURE_STATUS: "false",
      NODE_ENV: "development",
      PANEL_DATA_DIR: directory,
    },
    directory,
  );
  config.port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not allocate a test port"));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  if (options.frontend) {
    await mkdir(path.join(config.publicDir, "assets"), { recursive: true });
    await Promise.all([
      writeFile(path.join(config.publicDir, "index.html"), '<div id="root"></div>'),
      writeFile(path.join(config.publicDir, "assets", "app-hash.js"), "console.log('fixture')"),
    ]);
  }
  application = startApplication(config);
  const baseUrl = `http://127.0.0.1:${application.server.port}`;
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Login did not set a cookie");
  return { baseUrl, cookie };
}

function authenticatedRequest(
  baseUrl: string,
  cookie: string,
  endpoint: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://localhost:5173");
  return fetch(`${baseUrl}${endpoint}`, { ...init, headers });
}

async function waitForTaskRoute(
  baseUrl: string,
  cookie: string,
  endpoint: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await authenticatedRequest(baseUrl, cookie, endpoint);
    expect(response.status).toBe(200);
    const task = (await response.json()) as Record<string, unknown>;
    if (task.status === "completed" || task.status === "error") return task;
    await Bun.sleep(10);
  }
  throw new Error(`Task route timed out: ${endpoint}`);
}

async function insertFixtureServer(): Promise<{
  uuid: string;
  serverRoot: string;
  backupPath: string;
}> {
  const uuid = crypto.randomUUID();
  const layout = newServerLayout(application!.config.serversPath, uuid);
  const serverRoot = layout.files;
  const backupPath = layout.backups;
  await Promise.all([
    mkdir(serverRoot, { recursive: true }),
    mkdir(backupPath, { recursive: true }),
    mkdir(layout.logs, { recursive: true }),
    mkdir(layout.runtime, { recursive: true }),
    mkdir(layout.temporary, { recursive: true }),
  ]);
  application!.database.insertServer({
    uuid,
    name: "Contract fixture",
    startupCommand: "java -Xmx1G -Xms1G -jar server.jar nogui",
    startupFlags: "",
    version: "1.21.1",
    port: 25565,
    serverType: "vanilla",
  });
  return { uuid, serverRoot, backupPath };
}

describe("native Bun HTTP and Socket.IO contracts", () => {
  test("exposes canonical same-origin API routes while retaining legacy aliases", async () => {
    const { baseUrl, cookie } = await startTestApplication({ frontend: true });
    const canonical = await fetch(`${baseUrl}/api/validate-session`, {
      headers: { cookie },
    });
    expect(canonical.status).toBe(200);
    expect(await canonical.json()).toEqual({ message: "Valid session" });

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const canonicalList = await authenticatedRequest(baseUrl, cookie, "/api/servers");
    expect(canonicalList.status).toBe(200);
    expect((await canonicalList.json()).servers).toEqual([]);

    const frontend = await fetch(baseUrl, { headers: { accept: "text/html" } });
    expect(frontend.status).toBe(200);
    expect(await frontend.text()).toContain('<div id="root"></div>');
    const spaFallback = await fetch(`${baseUrl}/server/fixture`, {
      headers: { accept: "text/html" },
    });
    expect(spaFallback.status).toBe(200);
    expect(await spaFallback.text()).toContain('<div id="root"></div>');

    const asset = await fetch(`${baseUrl}/assets/app-hash.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const unknownApi = await fetch(`${baseUrl}/api/not-a-route`, {
      headers: { accept: "text/html" },
    });
    expect(unknownApi.status).toBe(404);
  });

  test("authenticates REST requests and the frontend's Socket.IO 4.8.3 client", async () => {
    const { baseUrl, cookie } = await startTestApplication();
    const validate = await fetch(`${baseUrl}/validate-session`, {
      headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(validate.status).toBe(200);
    expect(validate.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(await validate.json()).toEqual({ message: "Valid session" });

    const uuid = crypto.randomUUID();
    const layout = newServerLayout(application!.config.serversPath, uuid);
    await Promise.all([
      mkdir(layout.files, { recursive: true }),
      mkdir(layout.backups, { recursive: true }),
      mkdir(layout.logs, { recursive: true }),
      mkdir(layout.runtime, { recursive: true }),
    ]);
    application!.database.insertServer({
      uuid,
      name: "Socket test",
      startupCommand: "java -Xmx1G -Xms1G -jar server.jar nogui",
      startupFlags: "",
      version: "1.21.1",
      port: 25565,
      serverType: "vanilla",
    });

    socket = createSocket(baseUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: { cookie, "server-id": uuid },
      reconnection: false,
    });
    const output = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Socket connection timed out")), 5_000);
      socket!.once("connect_error", reject);
      socket!.once("output", (value: string) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    expect(output).toBe("");
    expect(socket.connected).toBe(true);
  });

  test("disconnects a server's Socket.IO room before deleting its runtime data", async () => {
    const { baseUrl, cookie } = await startTestApplication();
    const { uuid } = await insertFixtureServer();
    const instance = newServerLayout(application!.config.serversPath, uuid).instance;
    socket = createSocket(baseUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: { cookie, "server-id": uuid },
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Socket connection timed out")), 5_000);
      socket!.once("connect_error", reject);
      socket!.once("output", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const disconnected = new Promise<string>((resolve) => socket!.once("disconnect", resolve));

    const response = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(await disconnected).toBe("io server disconnect");
    expect(socket.connected).toBe(false);
    expect(() => application!.database.getServer(uuid)).toThrow("Server not found");
    expect(await Bun.file(instance).exists()).toBe(false);
  });

  test("disconnects active sockets during idempotent application shutdown", async () => {
    const { baseUrl, cookie } = await startTestApplication();
    const { uuid } = await insertFixtureServer();
    socket = createSocket(baseUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: { cookie, "server-id": uuid },
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Socket connection timed out")), 5_000);
      socket!.once("connect_error", reject);
      socket!.once("output", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    const disconnected = new Promise<void>((resolve) => socket!.once("disconnect", () => resolve()));

    await Promise.all([application!.shutdown(), application!.shutdown()]);
    await disconnected;
    expect(socket.connected).toBe(false);
    expect(application!.io.of("/").sockets.size).toBe(0);
  });

  test("rejects invalid sessions with the legacy JSON shape", async () => {
    const { baseUrl } = await startTestApplication();
    const response = await fetch(`${baseUrl}/validate-session`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid session." });
  });

  test("warns before backing up a running server and accepts explicit confirmation", async () => {
    const { baseUrl, cookie } = await startTestApplication();
    const { uuid, serverRoot } = await insertFixtureServer();
    await mkdir(path.join(serverRoot, "world"), { recursive: true });
    await writeFile(path.join(serverRoot, "world", "level.dat"), "fixture");
    application!.terminals.isRunning = async () => true;

    const warning = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/backup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(warning.status).toBe(409);
    expect(await warning.json()).toEqual({
      code: "SERVER_RUNNING_BACKUP_WARNING",
      message:
        "The server is running. Files may change while they are being archived, so this backup might not restore to a fully consistent state. Stop the server for the safest backup, or confirm that you want to continue anyway.",
      requiresConfirmation: true,
    });

    const confirmed = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/backup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowRunning: true }),
    });
    expect(confirmed.status).toBe(202);
    const task = (await confirmed.json()) as { taskId: string };
    expect(
      (
        await waitForTaskRoute(
          baseUrl,
          cookie,
          `/servers/${uuid}/backup/status/${task.taskId}`,
        )
      ).status,
    ).toBe("completed");
  });

  test("preserves server, file, archive, backup, cookie, and CORS route contracts", async () => {
    const { baseUrl, cookie } = await startTestApplication();
    const { uuid, serverRoot, backupPath } = await insertFixtureServer();

    const preflight = await fetch(`${baseUrl}/servers`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

    const list = await authenticatedRequest(baseUrl, cookie, "/servers");
    expect(await list.json()).toEqual({
      servers: [{ id: uuid, name: "Contract fixture", version: "1.21.1", port: 25565 }],
      username: "admin",
    });
    const details = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}`);
    expect(await details.json()).toEqual({
      id: uuid,
      name: "Contract fixture",
      version: "1.21.1",
      port: 25565,
    });

    const invalidCreate = await authenticatedRequest(baseUrl, cookie, "/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(invalidCreate.status).toBe(400);
    const invalidUpdate = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "latest" }),
    });
    expect(invalidUpdate.status).toBe(400);

    const flagsUpdate = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/startup-flags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flags: "-XX:+UseG1GC" }),
    });
    expect(flagsUpdate.status).toBe(200);
    expect((await flagsUpdate.json()).effectiveCommand).toBe(
      "java -Xmx1G -Xms1G -XX:+UseG1GC -jar server.jar nogui",
    );
    const flagsRead = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/startup-flags`);
    expect((await flagsRead.json()).startupFlags).toBe("-XX:+UseG1GC");
    const flagsRejected = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/startup-flags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flags: "-Xmx8G" }),
    });
    expect(flagsRejected.status).toBe(400);

    const folder = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "world" }),
    });
    expect(await folder.text()).toBe("Folder created successfully");
    await mkdir(path.join(serverRoot, "mods"));

    const uploadForm = new FormData();
    uploadForm.append("files", new File(["uploaded-data"], "uploaded.txt"));
    const upload = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/upload?path=mods`, {
      method: "POST",
      body: uploadForm,
    });
    expect(upload.status).toBe(200);
    expect(await upload.text()).toBe("Files uploaded successfully");

    const save = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/files/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "world/server.properties", content: "motd=fixture" }),
    });
    expect(save.status).toBe(200);
    const read = await authenticatedRequest(
      baseUrl,
      cookie,
      `/servers/${uuid}/files/read?filePath=world%2Fserver.properties`,
    );
    expect(await read.text()).toBe("motd=fixture");

    const move = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/files/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: ["mods/uploaded.txt"], destination: "world" }),
    });
    expect(move.status).toBe(200);
    const nestedList = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/files/world`);
    expect((await nestedList.json()) as unknown[]).toEqual(
      expect.arrayContaining([
        { name: "server.properties", type: "file", path: "world/server.properties" },
        { name: "uploaded.txt", type: "file", path: "world/uploaded.txt" },
      ]),
    );

    const archiveStart = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/files/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: ["world"] }),
    });
    expect(archiveStart.status).toBe(202);
    const archive = (await archiveStart.json()) as { taskId: string; fileName: string };
    expect(
      (
        await waitForTaskRoute(
          baseUrl,
          cookie,
          `/servers/${uuid}/files/archive/status/${archive.taskId}`,
        )
      ).status,
    ).toBe("completed");
    const archiveDownload = await authenticatedRequest(
      baseUrl,
      cookie,
      `/servers/${uuid}/files/archive/download/${archive.taskId}`,
    );
    expect(archiveDownload.status).toBe(200);
    const archiveBytes = await archiveDownload.arrayBuffer();
    expect(archiveBytes.byteLength).toBeGreaterThan(0);

    const archiveUploadForm = new FormData();
    archiveUploadForm.append("files", new File([archiveBytes], "fixture.zip"));
    expect(
      (
        await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/upload`, {
          method: "POST",
          body: archiveUploadForm,
        })
      ).status,
    ).toBe(200);
    const unarchiveStart = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/files/unarchive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: "fixture.zip", destination: "restored" }),
    });
    expect(unarchiveStart.status).toBe(202);
    const unarchive = (await unarchiveStart.json()) as { taskId: string };
    expect(
      (
        await waitForTaskRoute(
          baseUrl,
          cookie,
          `/servers/${uuid}/files/unarchive/status/${unarchive.taskId}`,
        )
      ).status,
    ).toBe("completed");
    expect(await readFile(path.join(serverRoot, "restored", "world", "uploaded.txt"), "utf8")).toBe(
      "uploaded-data",
    );

    const deleteFiles = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/files/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: ["restored", "fixture.zip"] }),
    });
    expect(deleteFiles.status).toBe(200);
    await writeFile(path.join(serverRoot, "legacy-trailing-slash.txt"), "fixture");
    const legacyDeleteAlias = await authenticatedRequest(
      baseUrl,
      cookie,
      `/servers/${uuid}/files/delete/`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: ["legacy-trailing-slash.txt"] }),
      },
    );
    expect(legacyDeleteAlias.status).toBe(200);
    const rejectRootDelete = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/files/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [""] }),
    });
    expect(rejectRootDelete.status).toBe(400);

    await writeFile(path.join(serverRoot, "server.jar"), "jar-fixture");
    const backupStart = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/backup`, {
      method: "POST",
    });
    expect(backupStart.status).toBe(202);
    const backup = (await backupStart.json()) as { taskId: string; backupName: string };
    expect(
      (
        await waitForTaskRoute(baseUrl, cookie, `/servers/${uuid}/backup/status/${backup.taskId}`)
      ).status,
    ).toBe("completed");
    const backups = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/backups`);
    expect(((await backups.json()) as Array<{ name: string }>).some((item) => item.name === backup.backupName)).toBe(true);
    const backupDownload = await authenticatedRequest(
      baseUrl,
      cookie,
      `/servers/${uuid}/backup/download?backup=${encodeURIComponent(backup.backupName)}`,
    );
    expect((await backupDownload.arrayBuffer()).byteLength).toBeGreaterThan(0);

    await writeFile(path.join(backupPath, "corrupt.zip"), "not-a-zip");
    const corruptRestoreStart = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/backup/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backupName: "corrupt.zip" }),
    });
    expect(corruptRestoreStart.status).toBe(202);
    const corruptRestore = (await corruptRestoreStart.json()) as { taskId: string };
    expect(
      (
        await waitForTaskRoute(
          baseUrl,
          cookie,
          `/servers/${uuid}/backup/restore/status/${corruptRestore.taskId}`,
        )
      ).status,
    ).toBe("error");
    expect(await readFile(path.join(serverRoot, "world", "server.properties"), "utf8")).toBe("motd=fixture");

    const restoreStart = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/backup/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backupName: backup.backupName }),
    });
    expect(restoreStart.status).toBe(202);
    const restore = (await restoreStart.json()) as { taskId: string };
    expect(
      (
        await waitForTaskRoute(
          baseUrl,
          cookie,
          `/servers/${uuid}/backup/restore/status/${restore.taskId}`,
        )
      ).status,
    ).toBe("completed");
    expect(await readFile(path.join(serverRoot, "world", "server.properties"), "utf8")).toBe("motd=fixture");

    const backupDelete = await authenticatedRequest(
      baseUrl,
      cookie,
      `/servers/${uuid}/backup?backup=${encodeURIComponent(backup.backupName)}`,
      { method: "DELETE" },
    );
    expect(backupDelete.status).toBe(200);
    const rejectBackupRootDelete = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}/backup`, {
      method: "DELETE",
    });
    expect(rejectBackupRootDelete.status).toBe(400);

    const deleteServer = await authenticatedRequest(baseUrl, cookie, `/servers/${uuid}`, { method: "DELETE" });
    expect(deleteServer.status).toBe(204);
    const emptyList = await authenticatedRequest(baseUrl, cookie, "/servers");
    expect((await emptyList.json()).servers).toEqual([]);

    const logout = await authenticatedRequest(baseUrl, cookie, "/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("token=");
  });
});
