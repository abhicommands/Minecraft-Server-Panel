import { Server as BunEngine } from "@socket.io/bun-engine";
import { Server as SocketIOServer } from "socket.io";
import path from "node:path";
import { applicationHome, loadConfig } from "./config.ts";
import { PanelDatabase } from "./db/db.ts";
import { AuthService } from "./routes/auth.ts";
import { createFileRoutes } from "./routes/fileRoutes.ts";
import {
  createServerManagementRoutes,
  reconcileServerDeletionTombstones,
} from "./routes/serverManagementRoutes.ts";
import type { AppConfig, RouteTable, ServerRecord } from "./types.ts";
import { HttpError, jsonResponse, preflight, route, textResponse } from "./utils/http.ts";
import { initializeConfiguration } from "./utils/initializeConfiguration.ts";
import { reconcileProvisioningProcesses } from "./utils/provisionProcess.ts";
import { ServerProvisioner } from "./utils/serverProvisioner.ts";
import { embeddedFrontendReady, serveStaticFrontend } from "./utils/staticFiles.ts";
import { TerminalManager } from "./utils/terminal.ts";

export interface RunningApplication {
  config: AppConfig;
  database: PanelDatabase;
  io: SocketIOServer;
  terminals: TerminalManager;
  provisioner: ServerProvisioner;
  server: Bun.Server<unknown>;
  shutdown(): Promise<void>;
}

function withPreflight(routes: RouteTable, config: AppConfig): RouteTable {
  for (const [path, value] of Object.entries(routes)) {
    if (value instanceof Response || typeof value === "function") continue;
    value.OPTIONS ||= (request) => preflight(request, config);
    routes[path] = value;
  }
  return routes;
}

function prefixedRoutes(routes: RouteTable, prefix: string): RouteTable {
  return Object.fromEntries(
    Object.entries(routes).map(([path, value]) => [
      `${prefix}${path}`,
      value instanceof Response || typeof value === "function" ? value : { ...value },
    ]),
  );
}

export function startApplication(config = loadConfig()): RunningApplication {
  const database = new PanelDatabase(config);
  try {
    reconcileServerDeletionTombstones(config, database);
    reconcileProvisioningProcesses(config.serversPath);
  } catch (error) {
    database.close();
    throw error;
  }
  const io = new SocketIOServer();
  const engine = new BunEngine({
    path: "/socket.io/",
    maxHttpBufferSize: 1_000_000,
    ...(config.corsOrigin
      ? {
          cors: {
            origin: [config.corsOrigin],
            credentials: true,
            methods: ["GET", "POST"],
            allowedHeaders: ["content-type", "server-id"],
          },
        }
      : {}),
  });
  io.bind(engine);

  const auth = new AuthService(config);
  const terminals = new TerminalManager(io, config.serversPath);
  const provisioner = new ServerProvisioner();
  const terminalInitialization = terminals.initializeAll(database.listServers()).catch((error) => {
    console.error("Failed to initialize one or more Minecraft process states:", error);
  });
  const legacyRoutes = {
    ...auth.createRoutes(),
    ...createFileRoutes(config, auth, database, terminals),
    ...createServerManagementRoutes(config, auth, database, terminals, provisioner),
  };
  const routes = withPreflight(
    {
      ...legacyRoutes,
      ...prefixedRoutes(legacyRoutes, "/api"),
      "/api/health": { GET: route(config, () => jsonResponse({ status: "ok" })) },
    },
    config,
  );

  io.use(async (socket, next) => {
    try {
      const cookies = new Bun.CookieMap(socket.handshake.headers.cookie || "");
      const token = cookies.get("token");
      const rawServerId = socket.handshake.headers["server-id"];
      const serverId = Array.isArray(rawServerId) ? rawServerId[0] : rawServerId;
      if (!token) throw new Error("Authentication error");
      if (!serverId) throw new Error("Server ID not found");
      const user = await auth.verifyToken(token);
      const record = database.getServer(serverId);
      if (!record) throw new Error("Server ID not found");
      await terminals.initialize(record);
      socket.data.user = user;
      socket.data.serverId = serverId;
      next();
    } catch (error) {
      next(new Error(error instanceof HttpError && error.status !== 401 ? "Server ID not found" : "Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const serverId = socket.data.serverId as string;
    socket.join(serverId);
    const withServer = (
      fallback: string,
      operation: (record: ServerRecord) => void | Promise<void>,
    ): void => {
      void (async () => {
        try {
          const record = database.getServer(serverId);
          if (!record) throw new HttpError(404, "Server not found");
          await operation(record);
        } catch (error) {
          socket.emit("output", `Error: ${error instanceof Error ? error.message : fallback}`);
          if (error instanceof HttpError && error.status === 404) socket.disconnect(true);
        }
      })();
    };

    withServer("Server not found", async (record) => {
      socket.emit("output", await terminals.history(record));
      if (await terminals.isRunning(record)) {
        socket.emit("serverStatus", true);
      }
    });

    socket.on("command", (data) => {
      withServer("Terminal not found", (record) => terminals.command(record, data));
    });
    socket.on("startServer", () => {
      withServer("Server could not be started", (record) => terminals.start(record));
    });
    socket.on("stopServer", () => {
      withServer("Server is not running", (record) => terminals.stop(record));
    });
    socket.on("killServer", () => {
      withServer("Server is not running", (record) => terminals.kill(record));
    });
  });

  const engineHandlers = engine.handler();
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    idleTimeout: 30,
    maxRequestBodySize: config.uploadMaxBytes + 1024 * 1024,
    routes: routes as Bun.Serve.Routes<unknown, string>,
    async fetch(request, bunServer) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/socket.io/" || pathname.startsWith("/socket.io/")) {
        return engine.handleRequest(request, bunServer);
      }
      if (request.method === "OPTIONS") return preflight(request, config);
      const staticResponse = await serveStaticFrontend(request, config.publicDir);
      if (staticResponse) return staticResponse;
      return route(config, async () => textResponse("Not found", 404))(
        request as Bun.BunRequest<string>,
        bunServer,
      );
    },
    websocket: engineHandlers.websocket,
  });

  let shuttingDown: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shuttingDown ||= (async () => {
      const failures: unknown[] = [];
      const provisionerShutdown = provisioner.shutdown();
      try {
        io.disconnectSockets(true);
      } catch (error) {
        failures.push(error);
      }
      try {
        await server.stop(true);
      } catch (error) {
        failures.push(error);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out while closing Socket.IO transports")),
            10_000,
          );
          timer.unref?.();
          io.close(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        engine.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await provisionerShutdown;
      } catch (error) {
        failures.push(error);
      }
      await terminalInitialization;
      try {
        await terminals.shutdown();
      } catch (error) {
        failures.push(error);
      }
      try {
        database.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, "Application shutdown was incomplete");
    })();
    return shuttingDown;
  };

  return { config, database, io, terminals, provisioner, server, shutdown };
}

async function main(): Promise<void> {
  try {
    const args = Bun.argv.slice(2);
    const command = args[0];
    const home = applicationHome();
    if (command === "--help" || command === "-h") {
      console.log(`Minecraft Server Panel

Usage:
  minecraft-server-panel          Production setup on first run, then start
  minecraft-server-panel --test   Isolated localhost setup, then start
  minecraft-server-panel init [--development] [--address <DNS-or-IP>]

The test configuration and data use panel-test-data; production uses panel-data.
The compatibility diagnostics 'doctor', 'init', and 'serve' are also available.`);
      return;
    }
    if (command === "init") {
      const initArguments = args.slice(1);
      let development = false;
      let publicAddress: string | undefined;
      for (let index = 0; index < initArguments.length; index += 1) {
        const argument = initArguments[index];
        if (argument === "--development") {
          if (development) throw new Error("--development may be specified only once");
          development = true;
          continue;
        }
        if (argument === "--address") {
          if (publicAddress !== undefined) throw new Error("--address may be specified only once");
          publicAddress = initArguments[index + 1]?.trim();
          if (!publicAddress) throw new Error("--address requires a DNS name or IP address");
          index += 1;
          continue;
        }
        throw new Error(`Unknown init option '${argument}'`);
      }
      await initializeConfiguration({
        home,
        mode: development ? "test" : "production",
        ...(publicAddress ? { publicAddress } : {}),
      });
    } else if (command === "doctor") {
      const config = loadConfig();
      console.log(`Mode: ${Bun.isStandaloneExecutable ? "standalone executable" : "Bun source"}`);
      console.log(`Application home: ${home}`);
      console.log(`Data directory: ${config.dataDir}`);
      console.log(`Deployment: ${config.deploymentMode}`);
      console.log(`Listen address: ${config.hostname}:${config.port}`);
      if (config.publicAddress) console.log(`Public address: ${config.publicAddress}`);
      console.log(
        `Frontend: ${Bun.isStandaloneExecutable ? "embedded in executable" : config.publicDir}`,
      );
      console.log(`Frontend index: ${embeddedFrontendReady() ? "ready" : "external or missing"}`);
      console.log(`Embedded assets: ${Bun.embeddedFiles.length}`);
    } else {
      const testMode = command === "--test";
      if (command && command !== "serve" && !testMode) {
        throw new Error(`Unknown option '${command}'. Run with --help for usage.`);
      }
      if (args.length > 1) {
        throw new Error("Only one mode option may be used. Production is the default; use --test locally.");
      }

      let config: AppConfig;
      if (testMode) {
        const testDataName = "panel-test-data";
        const testConfigPath = path.join(home, testDataName, "config.toml");
        if (!(await Bun.file(testConfigPath).exists())) {
          await initializeConfiguration({ home, mode: "test", dataDirectoryName: testDataName });
        }
        config = loadConfig({ home, dataDirectoryName: testDataName });
      } else {
        const configPath = path.join(home, "panel-data", "config.toml");
        if (!command && !(await Bun.file(configPath).exists())) {
          await initializeConfiguration({ home, mode: "production" });
        }
        config = loadConfig();
      }
      const application = startApplication(config);
      const publicAddress = application.config.publicAddress;
      const publicUrl =
        application.config.deploymentMode === "https" && publicAddress
          ? `https://${publicAddress}`
          : publicAddress
            ? `http://${publicAddress.includes(":") ? `[${publicAddress}]` : publicAddress}:${application.config.port}`
            : `http://localhost:${application.config.port}`;
      console.log(`Server is running. Open ${publicUrl}`);
      let exitStarted = false;
      const exitCleanly = (exitCode: number, reason?: unknown): void => {
        if (exitStarted) return;
        exitStarted = true;
        if (reason) console.error("Panel is shutting down after a fatal error:", reason);
        void application.shutdown().then(
          () => process.exit(exitCode),
          (error) => {
            console.error("Panel shutdown failed:", error);
            process.exit(1);
          },
        );
      };
      const handleSignal = (): void => {
        if (exitStarted) {
          console.error("A second shutdown signal forced immediate exit.");
          process.exit(1);
        }
        exitCleanly(0);
      };
      process.on("SIGINT", handleSignal);
      process.on("SIGTERM", handleSignal);
      process.once("uncaughtException", (error) => exitCleanly(1, error));
      process.once("unhandledRejection", (error) => exitCleanly(1, error));
    }
  } catch (error) {
    console.error("Panel command failed:", error instanceof Error ? error.message : error);
    if (error instanceof Error && error.message.includes("required configuration value")) {
      console.error("Run this program without arguments once to create panel-data/config.toml securely.");
    }
    process.exit(1);
  }
}

if (import.meta.main) void main();
