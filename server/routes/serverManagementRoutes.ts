import { totalmem } from "node:os";
import {
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppConfig, BunRouteRequest, RouteHandler, RouteTable, ServerRecord } from "../types.ts";
import { PanelDatabase } from "../db/db.ts";
import { AuthService } from "./auth.ts";
import { HttpError, jsonResponse, readJson, route, textResponse } from "../utils/http.ts";
import { ServerProvisioner } from "../utils/serverProvisioner.ts";
import { runTrackedForgeInstaller } from "../utils/provisionProcess.ts";
import {
  composeStartupCommand,
  ensureValidStartupFlags,
  sanitizeStartupFlags,
  TerminalManager,
} from "../utils/terminal.ts";
import { newServerLayout } from "../utils/serverLayout.ts";

const VANILLA_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest.json";
const PAPER_PROJECTS_API = "https://api.papermc.io/v2/projects";
const FABRIC_LOADER_ENDPOINT = "https://meta.fabricmc.net/v2/versions/loader";
const FABRIC_INSTALLER_ENDPOINT = "https://meta.fabricmc.net/v2/versions/installer";
const FORGE_PROMOTIONS_URL = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN_BASE = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const MINECRAFT_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;
const DELETION_TOMBSTONE_PATTERN =
  /^\.delete-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-[0-9a-f-]+$/i;
const SERVER_TYPE_LABELS = {
  vanilla: "Vanilla",
  paper: "Paper",
  fabric: "Fabric",
  forge: "Forge",
  bungeecord: "BungeeCord",
} as const;

type ServerType = keyof typeof SERVER_TYPE_LABELS;

export function reconcileServerDeletionTombstones(
  config: AppConfig,
  database: PanelDatabase,
): void {
  if (!existsSync(config.serversPath)) return;
  const knownServers = new Set(database.listServers().map((record) => record.uuid));
  for (const entry of readdirSync(config.serversPath, { withFileTypes: true })) {
    const match = DELETION_TOMBSTONE_PATTERN.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const serverId = match[1]!;
    const tombstone = path.join(config.serversPath, entry.name);
    const instance = path.join(config.serversPath, serverId);
    if (!knownServers.has(serverId)) {
      rmSync(tombstone, { recursive: true, force: true });
      continue;
    }
    if (!existsSync(instance)) {
      renameSync(tombstone, instance);
      console.warn(`Recovered interrupted deletion for server ${serverId}.`);
    } else {
      console.warn(
        `Preserving ambiguous deletion tombstone ${entry.name}; the live server directory also exists.`,
      );
    }
  }
}

interface CreateServerBody {
  name?: unknown;
  memory?: unknown;
  port?: unknown;
  version?: unknown;
  serverType?: unknown;
  renderDistance?: unknown;
  startupFlags?: unknown;
}

function normalizeServerType(value: unknown): ServerType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(normalized in SERVER_TYPE_LABELS)) throw new HttpError(400, "Unsupported server type requested");
  return normalized as ServerType;
}

function validateVersion(value: unknown): string {
  if (typeof value !== "string" || !MINECRAFT_VERSION_PATTERN.test(value.trim())) {
    throw new HttpError(400, "version must look like '1.21' or '1.20.1'.");
  }
  return value.trim();
}

function integerField(value: unknown, name: string, minimum: number, maximum: number): number {
  const normalized =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new HttpError(400, `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized;
}

export function validateCreateBody(body: CreateServerBody): {
  name: string;
  memory: number;
  port: number;
  version: string;
  serverType: ServerType;
  renderDistance: number;
  startupFlags: string;
} {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 || /[\0\r\n]/.test(body.name)) {
    throw new HttpError(400, "name is required");
  }
  const maximumMemory = Math.floor(totalmem() / 1024 / 1024 / 1024);
  const memory = integerField(body.memory, "memory", 1, maximumMemory);
  const port = integerField(body.port, "port", 1, 65_535);
  const renderDistance = integerField(body.renderDistance, "renderDistance", 2, 32);
  return {
    name: body.name.trim(),
    memory,
    port,
    version: validateVersion(body.version),
    serverType: normalizeServerType(body.serverType),
    renderDistance,
    startupFlags: ensureValidStartupFlags(body.startupFlags),
  };
}

function withTimeout(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Operation timed out", "TimeoutError")),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

function throwAbort(signal: AbortSignal, fallback: unknown): never {
  if (signal.reason instanceof Error) throw signal.reason;
  if (signal.reason !== undefined) throw new Error(String(signal.reason));
  if (fallback instanceof Error) throw fallback;
  throw new DOMException("Operation aborted", "AbortError");
}

async function fetchJson<T>(
  url: string,
  failureMessage: string,
  parentSignal: AbortSignal,
): Promise<T> {
  const timeout = withTimeout(parentSignal, 60_000);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: timeout.signal,
      headers: { "user-agent": "Minecraft-Server-Panel/3.0" },
    });
  } catch (error) {
    timeout.dispose();
    if (timeout.signal.aborted) throwAbort(timeout.signal, error);
    throw new Error(failureMessage);
  }
  try {
    if (!response.ok) {
      const error = new Error(response.status === 404 ? "not-found" : failureMessage);
      Object.assign(error, { status: response.status });
      throw error;
    }
    return (await response.json()) as T;
  } catch (error) {
    if (timeout.signal.aborted) throwAbort(timeout.signal, error);
    if ((error as { status?: number }).status) throw error;
    throw new Error(failureMessage);
  } finally {
    timeout.dispose();
  }
}

async function downloadFile(
  url: string,
  destination: string,
  parentSignal: AbortSignal,
): Promise<void> {
  const timeout = withTimeout(parentSignal, 300_000);
  const temporary = `${destination}.${crypto.randomUUID()}.part`;
  let output: ReturnType<typeof createWriteStream> | undefined;
  try {
    const response = await fetch(url, {
      signal: timeout.signal,
      redirect: "follow",
      headers: { "user-agent": "Minecraft-Server-Panel/3.0" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    await pipeline(Readable.fromWeb(response.body as never), output, {
      signal: timeout.signal,
    });
    const details = await stat(temporary);
    if (!details.isFile() || details.size === 0) throw new Error("Downloaded file was empty");
    if (timeout.signal.aborted) throwAbort(timeout.signal, undefined);
    await rename(temporary, destination);
  } catch (error) {
    output?.destroy();
    await rm(temporary, { force: true });
    if (timeout.signal.aborted) throwAbort(timeout.signal, error);
    throw error;
  } finally {
    timeout.dispose();
  }
}

async function resolveVanillaDownloadUrl(version: string, signal: AbortSignal): Promise<string> {
  const manifest = await fetchJson<{ versions?: Array<{ id: string; url: string }> }>(
    VANILLA_MANIFEST_URL,
    "Failed to retrieve vanilla version manifest",
    signal,
  );
  const entry = manifest.versions?.find((candidate) => candidate.id === version);
  if (!entry) throw new HttpError(400, `Vanilla server version '${version}' was not found`);
  const details = await fetchJson<{ downloads?: { server?: { url?: string } } }>(
    entry.url,
    "Failed to retrieve vanilla server download information",
    signal,
  );
  const url = details.downloads?.server?.url;
  if (!url) throw new Error("Failed to retrieve vanilla server download information");
  return url;
}

async function resolvePaperProjectDownloadUrl(
  project: string,
  version: string,
  label: string,
  signal: AbortSignal,
): Promise<string> {
  const projectBase = `${PAPER_PROJECTS_API}/${project}`;
  let versionMeta: { builds?: number[] };
  try {
    versionMeta = await fetchJson(
      `${projectBase}/versions/${version}`,
      `Failed to retrieve ${label} version metadata`,
      signal,
    );
  } catch (error) {
    if ((error as { status?: number }).status === 404 || (error as Error).message === "not-found") {
      throw new HttpError(400, `${label} server version '${version}' was not found`);
    }
    throw error;
  }
  const builds = versionMeta.builds || [];
  if (!builds.length) throw new HttpError(400, `${label} server version '${version}' has no builds`);
  const selectedBuild = Math.max(...builds);
  const buildMeta = await fetchJson<{ downloads?: { application?: { name?: string } } }>(
    `${projectBase}/versions/${version}/builds/${selectedBuild}`,
    `Failed to retrieve ${label} build metadata`,
    signal,
  );
  const name = buildMeta.downloads?.application?.name;
  if (!name) throw new Error(`${label} build metadata did not include a server jar`);
  return `${projectBase}/versions/${version}/builds/${selectedBuild}/downloads/${name}`;
}

async function resolveFabricDownloadUrl(version: string, signal: AbortSignal): Promise<string> {
  const loaders = await fetchJson<
    Array<{ loader?: { stable?: boolean; version?: string }; intermediary?: { stable?: boolean } }>
  >(`${FABRIC_LOADER_ENDPOINT}/${version}`, "Failed to retrieve Fabric loader versions", signal);
  if (!loaders.length) throw new HttpError(400, `Fabric loader for Minecraft '${version}' was not found`);
  const loader = loaders.find((item) => item.loader?.stable && item.intermediary?.stable) || loaders[0];
  const loaderVersion = loader?.loader?.version;
  if (!loaderVersion) throw new Error("Fabric loader metadata did not include a loader version");
  const installers = await fetchJson<Array<{ stable?: boolean; version?: string }>>(
    FABRIC_INSTALLER_ENDPOINT,
    "Failed to retrieve Fabric installer versions",
    signal,
  );
  const installerVersion = installers.find((item) => item.stable)?.version || installers[0]?.version;
  if (!installerVersion) throw new Error("No Fabric installers available for download");
  return `${FABRIC_LOADER_ENDPOINT}/${version}/${loaderVersion}/${installerVersion}/server/jar`;
}

async function installForgeServer(
  version: string,
  serverRoot: string,
  jarPath: string,
  processMarkerPath: string,
  signal: AbortSignal,
): Promise<void> {
  const promotions = await fetchJson<{ promos?: Record<string, string> }>(
    FORGE_PROMOTIONS_URL,
    "Failed to retrieve Forge promotion metadata",
    signal,
  );
  const build = promotions.promos?.[`${version}-recommended`] || promotions.promos?.[`${version}-latest`];
  if (!build) throw new HttpError(400, `Forge build for Minecraft '${version}' was not found`);
  const fullVersion = `${version}-${build}`;
  const installerPath = path.join(serverRoot, `forge-installer-${fullVersion}.jar`);
  await downloadFile(
    `${FORGE_MAVEN_BASE}/${fullVersion}/forge-${fullVersion}-installer.jar`,
    installerPath,
    signal,
  );
  try {
    await runTrackedForgeInstaller(installerPath, serverRoot, processMarkerPath, signal);
    const candidates = (await readdir(serverRoot))
      .filter((name) => name.startsWith(`forge-${fullVersion}`) && name.endsWith(".jar") && !name.includes("installer"))
      .sort((left, right) => Number(right.includes("-server.jar")) - Number(left.includes("-server.jar")) || left.length - right.length);
    const candidate = candidates[0];
    if (!candidate) throw new Error("Forge installer completed but the server jar was not found in the installation directory");
    await rename(path.join(serverRoot, candidate), jarPath);
  } finally {
    await rm(installerPath, { force: true });
  }
}

async function downloadServerJar(
  version: string,
  serverRoot: string,
  serverType: ServerType,
  processMarkerPath: string,
  signal: AbortSignal,
): Promise<void> {
  const jarPath = path.join(serverRoot, "server.jar");
  switch (serverType) {
    case "vanilla":
      await downloadFile(await resolveVanillaDownloadUrl(version, signal), jarPath, signal);
      break;
    case "paper":
      await downloadFile(
        await resolvePaperProjectDownloadUrl("paper", version, "Paper", signal),
        jarPath,
        signal,
      );
      break;
    case "fabric":
      await downloadFile(await resolveFabricDownloadUrl(version, signal), jarPath, signal);
      break;
    case "forge":
      await installForgeServer(version, serverRoot, jarPath, processMarkerPath, signal);
      break;
    case "bungeecord":
      await downloadFile(
        await resolvePaperProjectDownloadUrl("waterfall", version, "BungeeCord", signal),
        jarPath,
        signal,
      );
      break;
  }
}

interface DistributionMove {
  destination: string;
  rollback: string;
  hadOriginal: boolean;
}

export async function commitStagedDistribution(
  stagingRoot: string,
  serverRoot: string,
  commitMetadata: () => void,
): Promise<void> {
  const serverJar = await lstat(path.join(stagingRoot, "server.jar"));
  if (!serverJar.isFile() || serverJar.isSymbolicLink()) {
    throw new Error("The staged server installation did not contain a regular server.jar");
  }
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  if (!entries.length) throw new Error("The staged server installation was empty");
  const rollbackRoot = path.join(
    path.dirname(stagingRoot),
    `.distribution-rollback-${crypto.randomUUID()}`,
  );
  await mkdir(rollbackRoot, { recursive: true });
  const moves: DistributionMove[] = [];
  let committed = false;
  let rollbackComplete = false;

  try {
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error(`Unsupported staged installation entry: ${entry.name}`);
      }
      const source = path.join(stagingRoot, entry.name);
      const destination = path.join(serverRoot, entry.name);
      const rollback = path.join(rollbackRoot, entry.name);
      let hadOriginal = false;
      try {
        await rename(destination, rollback);
        hadOriginal = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      moves.push({ destination, rollback, hadOriginal });
      await rename(source, destination);
    }

    commitMetadata();
    committed = true;
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const move of [...moves].reverse()) {
      try {
        await rm(move.destination, { recursive: true, force: true });
        if (move.hadOriginal) await rename(move.rollback, move.destination);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "Server update failed and its filesystem rollback was incomplete",
      );
    }
    rollbackComplete = true;
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch((error) => {
      console.error("Failed to remove staged server distribution:", error);
    });
    if (committed || rollbackComplete) {
      await rm(rollbackRoot, { recursive: true, force: true }).catch((error) => {
        console.error("Failed to remove server distribution rollback data:", error);
      });
    }
  }
}

function serverProperties(port: number, renderDistance: number): string {
  return `#Minecraft server properties
allow-flight=false
allow-nether=true
broadcast-console-to-ops=true
broadcast-rcon-to-ops=true
difficulty=easy
enable-command-block=false
enable-jmx-monitoring=false
enable-query=false
enable-rcon=false
enable-status=true
enforce-secure-profile=true
enforce-whitelist=false
force-gamemode=false
gamemode=survival
generate-structures=true
hardcore=false
hide-online-players=false
level-name=world
level-type=minecraft:normal
max-players=20
motd=A Minecraft Server
online-mode=true
pvp=true
query.port=${port}
server-ip=
server-port=${port}
simulation-distance=${Math.min(renderDistance, 10)}
spawn-protection=16
sync-chunk-writes=true
use-native-transport=true
view-distance=${renderDistance}
white-list=false
`;
}

export function createServerManagementRoutes(
  config: AppConfig,
  auth: AuthService,
  database: PanelDatabase,
  terminals: TerminalManager,
  provisioner: ServerProvisioner,
): RouteTable {
  const protectedRoute = (
    handler: (request: BunRouteRequest, username: string) => Response | Promise<Response>,
  ): RouteHandler =>
    route(config, auth.authenticated((request, user) => handler(request, user.username)));
  const protectedServerRoute = (
    handler: (request: BunRouteRequest, record: ServerRecord) => Response | Promise<Response>,
  ): RouteHandler =>
    protectedRoute((request) => handler(request, database.getServer(request.params.id || "")!));

  return {
    "/servers": {
      POST: protectedRoute(async (request) => {
        const value = validateCreateBody(await readJson<CreateServerBody>(request));
        return provisioner.run(request.signal, async (signal) => {
          const uuid = crypto.randomUUID();
          const layout = newServerLayout(config.serversPath, uuid);
          const serverRoot = layout.files;
          const startupCommand = `java -Xmx${value.memory}G -Xms${value.memory}G -jar server.jar nogui`;
          const record: Omit<ServerRecord, "id"> = {
            uuid,
            name: value.name,
            startupCommand,
            startupFlags: value.startupFlags,
            version: value.version,
            port: value.port,
            serverType: value.serverType,
          };
          try {
            await Promise.all([
              mkdir(serverRoot, { recursive: true }),
              mkdir(layout.backups, { recursive: true }),
              mkdir(layout.logs, { recursive: true }),
              mkdir(layout.runtime, { recursive: true }),
              mkdir(layout.temporary, { recursive: true }),
            ]);
            await downloadServerJar(
              value.version,
              serverRoot,
              value.serverType,
              path.join(layout.runtime, "forge-installer.json"),
              signal,
            );
            signal.throwIfAborted();
            await writeFile(
              path.join(serverRoot, "server.properties"),
              serverProperties(value.port, value.renderDistance),
              "utf8",
            );
            await writeFile(
              path.join(serverRoot, "eula.txt"),
              "# By setting eula=true you agree to https://aka.ms/MinecraftEULA\neula=true\n",
              "utf8",
            );
            const response = jsonResponse({
              id: uuid,
              name: value.name,
              version: value.version,
              port: value.port,
              serverType: value.serverType,
            });
            await terminals.registerPrepared({ id: 0, ...record }, () => {
              signal.throwIfAborted();
              database.insertServer(record);
            });
            return response;
          } catch (error) {
            try {
              await rm(layout.instance, { recursive: true, force: true });
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                `Server creation failed and incomplete data for ${uuid} could not be removed`,
              );
            }
            throw error;
          }
        });
      }),
      GET: protectedRoute(async (_request, username) =>
        jsonResponse({
          servers: database.listServers().map((record) => ({
            id: record.uuid,
            name: record.name,
            version: record.version,
            port: record.port,
          })),
          username,
        }),
      ),
    },
    "/servers/:id/update": {
      POST: protectedServerRoute(async (request, record) => {
        const body = await readJson<{ version?: unknown }>(request);
        const version = validateVersion(body.version);
        return provisioner.run(request.signal, (signal) =>
          terminals.withStopped(record, async () => {
            const current = database.getServer(record.uuid);
            if (!current) throw new HttpError(404, "Server not found");
            const serverType = normalizeServerType(current.serverType);
            const layout = newServerLayout(config.serversPath, record.uuid);
            const stagingRoot = path.join(
              layout.temporary,
              `distribution-${crypto.randomUUID()}`,
            );
            try {
              await mkdir(stagingRoot, { recursive: true });
              await downloadServerJar(
                version,
                stagingRoot,
                serverType,
                path.join(layout.runtime, "forge-installer.json"),
                signal,
              );
              signal.throwIfAborted();
              await commitStagedDistribution(stagingRoot, layout.files, () => {
                database.updateDistribution(record.uuid, version, serverType);
              });
              return textResponse("Server updated successfully");
            } catch (error) {
              await rm(stagingRoot, { recursive: true, force: true }).catch((cleanupError) => {
                throw new AggregateError(
                  [error, cleanupError],
                  "Server update failed and its staging directory could not be removed",
                );
              });
              throw error;
            }
          }),
        );
      }),
    },
    "/servers/:id/startup-flags": {
      GET: protectedServerRoute(async (_request, record) => {
        const baseCommand = record.startupCommand.trim();
        const startupFlags = sanitizeStartupFlags(record.startupFlags);
        return jsonResponse({
          baseCommand,
          startupFlags,
          effectiveCommand: composeStartupCommand(baseCommand, startupFlags),
          allowCustomFlags: true,
          requiresRestart: true,
        });
      }),
      PUT: protectedServerRoute(async (request, record) => {
        const body = await readJson<{ flags?: unknown }>(request);
        const flags = ensureValidStartupFlags(body.flags);
        return provisioner.run(request.signal, (signal) =>
          terminals.withStopped(record, async () => {
            signal.throwIfAborted();
            const current = database.getServer(record.uuid);
            if (!current) throw new HttpError(404, "Server not found");
            database.updateStartupFlags(record.uuid, flags);
            const baseCommand = current.startupCommand.trim();
            return jsonResponse({
              baseCommand,
              startupFlags: flags,
              effectiveCommand: composeStartupCommand(baseCommand, flags),
              allowCustomFlags: true,
              requiresRestart: true,
            });
          }),
        );
      }),
    },
    "/servers/:id": {
      GET: protectedServerRoute(async (_request, record) =>
        jsonResponse({ id: record.uuid, name: record.name, version: record.version, port: record.port }),
      ),
      DELETE: protectedServerRoute(async (request, record) =>
        provisioner.run(request.signal, async (signal) => {
          signal.throwIfAborted();
          await terminals.remove(record, async () => {
            const instance = newServerLayout(config.serversPath, record.uuid).instance;
            const tombstone = path.join(
              config.serversPath,
              `.delete-${record.uuid}-${crypto.randomUUID()}`,
            );
            let moved = false;
            try {
              await rename(instance, tombstone);
              moved = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            try {
              database.deleteServer(record.uuid);
            } catch (error) {
              if (moved) {
                try {
                  await rename(tombstone, instance);
                } catch (restoreError) {
                  throw new AggregateError(
                    [error, restoreError],
                    "Database deletion failed and the server directory could not be restored",
                  );
                }
              }
              throw error;
            }
            if (moved) {
              await rm(tombstone, { recursive: true, force: true }).catch((error) => {
                console.error(`Deleted server ${record.uuid}, but its tombstone cleanup failed:`, error);
              });
            }
          });
          return new Response(null, { status: 204 });
        }),
      ),
    },
  };
}
