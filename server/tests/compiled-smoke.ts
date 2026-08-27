import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { io as createSocket, type Socket } from "socket.io-client";
import { loadConfig } from "../config.ts";
import { PanelDatabase } from "../db/db.ts";

const PASSWORD_HASH = "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri";
const JWT_SECRET = "0123456789abcdef0123456789abcdef";

function executableName(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "minecraft-server-panel-darwin-arm64";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "minecraft-server-panel-linux-x64";
  }
  throw new Error(`Compiled smoke tests do not support ${process.platform}-${process.arch}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not allocate a smoke-test port"));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok && (await response.json()).status === "ok") return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Compiled server did not become ready: ${String(lastError || "timeout")}`);
}

function waitForSocketEvent<T>(
  socket: Socket,
  event: string,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for Socket.IO event ${event}`));
    }, timeoutMs);
    const handler = (value: T): void => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "panel-compiled-smoke-"));
const dataDirectory = path.join(temporaryDirectory, "panel-data");
const binDirectory = path.join(temporaryDirectory, "bin");
const serverId = crypto.randomUUID();
const serverInstance = path.join(dataDirectory, "servers", serverId);
const serverRoot = path.join(serverInstance, "files");
const backupPath = path.join(serverInstance, "backups");
const port = await availablePort();
const builtExecutable = path.join(import.meta.dir, "..", "dist", executableName());
const executable = path.join(temporaryDirectory, executableName());
let backend: Bun.Subprocess | undefined;
let socket: Socket | undefined;

try {
  await Promise.all([
    mkdir(path.join(dataDirectory, "database"), { recursive: true }),
    mkdir(serverRoot, { recursive: true }),
    mkdir(backupPath, { recursive: true }),
    mkdir(path.join(serverInstance, "logs"), { recursive: true }),
    mkdir(path.join(serverInstance, "runtime"), { recursive: true }),
    mkdir(path.join(serverInstance, "temporary"), { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
  ]);
  await copyFile(builtExecutable, executable);
  await chmod(executable, 0o755);
  await writeFile(path.join(serverRoot, "server.jar"), "fixture");
  const fakeJava = path.join(binDirectory, "java");
  await writeFile(
    fakeJava,
    [
      "#!/bin/sh",
      "printf 'fake-java-ready\\n'",
      "while IFS= read -r line; do",
      "  printf 'command:%s\\n' \"$line\"",
      "  if [ \"$line\" = stop ]; then",
      "    printf 'fake-java-stopped\\n'",
      "    exit 0",
      "  fi",
      "done",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(fakeJava, 0o755);

  await writeFile(
    path.join(dataDirectory, "config.toml"),
    Bun.TOML.stringify({
      root_username: "admin",
      root_password_hash: PASSWORD_HASH,
      jwt_secret: JWT_SECRET,
      port,
      secure_cookie: false,
      environment: "development",
      upload_max_bytes: 2_147_483_648,
    })!,
    { mode: 0o600 },
  );

  const config = loadConfig({ home: temporaryDirectory });
  const database = new PanelDatabase(config);
  database.insertServer({
    uuid: serverId,
    name: "Compiled PTY fixture",
    startupCommand: "java -Xmx1G -Xms1G -jar server.jar nogui",
    startupFlags: "-Dfixture=true",
    version: "fixture",
    port: 25565,
    serverType: "vanilla",
  });
  database.close();

  const childEnvironment = {
    ...process.env,
    PATH: `${binDirectory}:/usr/bin:/bin`,
  };
  const doctor = Bun.spawn([executable, "doctor"], {
    cwd: temporaryDirectory,
    env: childEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [doctorOutput, doctorError, doctorExit] = await Promise.all([
    new Response(doctor.stdout).text(),
    new Response(doctor.stderr).text(),
    doctor.exited,
  ]);
  if (doctorExit !== 0) throw new Error(`Compiled doctor failed: ${doctorError}`);
  console.log(doctorOutput.trim());

  backend = Bun.spawn([executable], {
    cwd: temporaryDirectory,
    env: childEnvironment,
    stdout: "inherit",
    stderr: "inherit",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(baseUrl);

  const frontend = await fetch(baseUrl, { headers: { accept: "text/html" } });
  if (!frontend.ok || !(await frontend.text()).includes('<div id="root"></div>')) {
    throw new Error("Compiled executable did not serve the embedded Vite frontend");
  }

  const spaFallback = await fetch(`${baseUrl}/server/fixture`, {
    headers: { accept: "text/html" },
  });
  if (!spaFallback.ok || !(await spaFallback.text()).includes('<div id="root"></div>')) {
    throw new Error("Compiled executable did not serve the React Router fallback");
  }

  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  if (!login.ok) throw new Error(`Compiled login failed with HTTP ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Compiled login did not set the token cookie");

  socket = createSocket(baseUrl, {
    path: "/socket.io",
    transports: ["websocket"],
    extraHeaders: { cookie, "server-id": serverId },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Compiled Socket.IO connection timed out")), 10_000);
    socket!.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket!.once("connect_error", reject);
  });

  const becameRunning = waitForSocketEvent<boolean>(socket, "serverStatus", (value) => value === true);
  const producedOutput = waitForSocketEvent<string>(socket, "output", (value) => value.includes("fake-java-ready"));
  socket.emit("startServer");
  await Promise.all([becameRunning, producedOutput]);

  const receivedCommand = waitForSocketEvent<string>(socket, "output", (value) => value.includes("command:ping"));
  socket.emit("command", "ping");
  await receivedCommand;

  const becameStopped = waitForSocketEvent<boolean>(socket, "serverStatus", (value) => value === false);
  socket.emit("stopServer");
  await becameStopped;
  socket.disconnect();
  socket = undefined;

  backend.kill("SIGTERM");
  const exitCode = await Promise.race([
    backend.exited,
    Bun.sleep(10_000).then(() => {
      throw new Error("Compiled backend did not shut down after SIGTERM");
    }),
  ]);
  if (exitCode !== 0) throw new Error(`Compiled backend exited with code ${exitCode}`);
  backend = undefined;
  console.log(`Compiled standalone smoke test passed for ${process.platform}-${process.arch}.`);
} finally {
  socket?.disconnect();
  if (backend) {
    backend.kill("SIGKILL");
    await backend.exited.catch(() => {});
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
