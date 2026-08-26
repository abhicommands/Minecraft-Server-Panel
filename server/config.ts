import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.ts";
import { classifyPublicAddress } from "./utils/deployment.ts";
import { validatePanelUsername } from "./utils/password.ts";

const encoder = new TextEncoder();

interface PanelConfigFile {
  root_username?: unknown;
  root_password_hash?: unknown;
  jwt_secret?: unknown;
  listen_host?: unknown;
  port?: unknown;
  cors_origin?: unknown;
  secure_cookie?: unknown;
  allow_insecure_http?: unknown;
  deployment_mode?: unknown;
  public_address?: unknown;
  environment?: unknown;
  upload_max_bytes?: unknown;
}

export function applicationHome(cwd = process.cwd()): string {
  return Bun.isStandaloneExecutable ? path.dirname(process.execPath) : path.resolve(cwd);
}

function readConfigFile(dataDir: string): PanelConfigFile {
  const configPath = path.join(dataDir, "config.toml");
  if (!existsSync(configPath)) return {};
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a TOML table`);
  }
  return parsed as PanelConfigFile;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required configuration value ${name}`);
  }
  return value.trim();
}

function environmentString(
  env: NodeJS.ProcessEnv,
  name: string,
  fileValue: unknown,
): unknown {
  return env[name] === undefined ? fileValue : env[name];
}

function parseInteger(
  raw: unknown,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw === null || raw === "") return defaultValue;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function parseBoolean(raw: unknown, name: string, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return defaultValue;
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  home = applicationHome(),
): AppConfig {
  const dataDir = path.resolve(home, env.PANEL_DATA_DIR?.trim() || "panel-data");
  const file = readConfigFile(dataDir);
  const rootUsername = required(
    environmentString(env, "ROOT_USERNAME", file.root_username),
    "root_username / ROOT_USERNAME",
  );
  validatePanelUsername(rootUsername);
  const rootPasswordHash = required(
    environmentString(env, "ROOT_PASSWORD_HASH", file.root_password_hash),
    "root_password_hash / ROOT_PASSWORD_HASH",
  );
  const jwtSecretText = required(
    environmentString(env, "JWT_SECRET", file.jwt_secret),
    "jwt_secret / JWT_SECRET",
  );
  const environment = required(
    environmentString(env, "NODE_ENV", file.environment ?? "development"),
    "environment / NODE_ENV",
  );
  if (environment !== "development" && environment !== "production" && environment !== "test") {
    throw new Error("environment / NODE_ENV must be development, production, or test");
  }
  const production = environment === "production";
  const hostname = required(
    environmentString(env, "PANEL_HOST", file.listen_host ?? "127.0.0.1"),
    "listen_host / PANEL_HOST",
  );
  if (!/^[a-zA-Z0-9.:-]+$/.test(hostname)) {
    throw new Error("listen_host / PANEL_HOST must be a hostname or IP address");
  }
  const secureCookie = parseBoolean(
    environmentString(env, "SECURE_STATUS", file.secure_cookie),
    "secure_cookie / SECURE_STATUS",
    production,
  );
  const allowInsecureHttp = parseBoolean(
    environmentString(env, "ALLOW_INSECURE_HTTP", file.allow_insecure_http),
    "allow_insecure_http / ALLOW_INSECURE_HTTP",
    false,
  );
  const deploymentModeValue = environmentString(
    env,
    "PANEL_DEPLOYMENT_MODE",
    file.deployment_mode ?? (production ? (secureCookie ? "https" : "direct-http") : "test"),
  );
  if (
    deploymentModeValue !== "https" &&
    deploymentModeValue !== "direct-http" &&
    deploymentModeValue !== "test"
  ) {
    throw new Error("deployment_mode / PANEL_DEPLOYMENT_MODE must be https, direct-http, or test");
  }
  const deploymentMode = deploymentModeValue;
  const publicAddressValue = environmentString(env, "PANEL_PUBLIC_ADDRESS", file.public_address);
  const publicAddress =
    publicAddressValue === undefined || publicAddressValue === null || publicAddressValue === ""
      ? null
      : required(publicAddressValue, "public_address / PANEL_PUBLIC_ADDRESS");
  const corsValue = environmentString(env, "CORSORIGIN", file.cors_origin);
  const corsOrigin =
    corsValue === undefined || corsValue === null || corsValue === ""
      ? null
      : required(corsValue, "cors_origin / CORSORIGIN");

  if (!/^\$2[aby]\$\d{2}\$/.test(rootPasswordHash)) {
    throw new Error("root_password_hash / ROOT_PASSWORD_HASH must be a bcrypt hash");
  }
  if (encoder.encode(jwtSecretText).byteLength < 32) {
    throw new Error("jwt_secret / JWT_SECRET must contain at least 32 UTF-8 bytes");
  }
  if (production && !secureCookie && !allowInsecureHttp) {
    throw new Error(
      "Production without secure cookies requires allow_insecure_http / ALLOW_INSECURE_HTTP=true",
    );
  }
  if (production && secureCookie && allowInsecureHttp) {
    throw new Error("secure_cookie and allow_insecure_http cannot both be true in production");
  }
  if (deploymentMode === "https" && (!production || !secureCookie || allowInsecureHttp)) {
    throw new Error("HTTPS deployment mode requires production with secure cookies");
  }
  if (deploymentMode === "https" && hostname !== "127.0.0.1") {
    throw new Error("HTTPS deployment mode must bind the Bun application to 127.0.0.1");
  }
  if (
    deploymentMode === "direct-http" &&
    (!production || secureCookie || !allowInsecureHttp)
  ) {
    throw new Error(
      "Direct HTTP deployment mode requires production, non-secure cookies, and allow_insecure_http=true",
    );
  }
  if (deploymentMode === "direct-http" && hostname !== "0.0.0.0" && hostname !== "::") {
    throw new Error("Direct HTTP deployment mode must bind to 0.0.0.0 or ::");
  }
  if (deploymentMode === "test" && production) {
    throw new Error("Test deployment mode cannot use the production environment");
  }
  if (publicAddress) {
    const classifiedAddress = classifyPublicAddress(publicAddress);
    if (deploymentMode === "https" && classifiedAddress.kind !== "domain") {
      throw new Error("HTTPS deployment mode requires a public DNS name");
    }
    if (deploymentMode === "direct-http" && classifiedAddress.kind === "domain") {
      throw new Error("Direct HTTP deployment mode requires an IPv4 or IPv6 address");
    }
  }

  if (corsOrigin) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(corsOrigin);
    } catch {
      throw new Error("cors_origin / CORSORIGIN must be an absolute HTTP(S) origin");
    }
    if (!/^https?:$/.test(parsedOrigin.protocol) || parsedOrigin.origin !== corsOrigin) {
      throw new Error("cors_origin / CORSORIGIN must be an exact HTTP(S) origin without a path");
    }
  }

  const databasePath = path.join(dataDir, "database", "panel.sqlite3");
  const serversPath = path.join(dataDir, "servers");
  const publicDir = env.PANEL_PUBLIC_DIR?.trim()
    ? path.resolve(home, env.PANEL_PUBLIC_DIR)
    : Bun.isStandaloneExecutable
      ? path.join(import.meta.dir, ".release-public")
      : path.resolve(home, "public");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  mkdirSync(serversPath, { recursive: true });

  return {
    rootUsername,
    rootPasswordHash,
    jwtSecret: encoder.encode(jwtSecretText),
    port: parseInteger(environmentString(env, "PORT", file.port), "port / PORT", 3001, 1, 65_535),
    hostname,
    corsOrigin,
    secureCookie,
    allowInsecureHttp,
    deploymentMode,
    publicAddress,
    production,
    dataDir,
    databasePath,
    serversPath,
    publicDir,
    uploadMaxBytes: parseInteger(
      environmentString(env, "UPLOAD_MAX_BYTES", file.upload_max_bytes),
      "upload_max_bytes / UPLOAD_MAX_BYTES",
      2_147_483_648,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}
