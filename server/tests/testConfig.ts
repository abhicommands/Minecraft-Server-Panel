import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import type { AppConfig } from "../types.ts";

export const TEST_PASSWORD_HASH =
  "$2b$10$VKuqhD4RPv0X5seKqhXDXOpzgwmUpJCpu3g50MgIKCluUx2nX/Wri";

export async function writeTestConfig(
  home: string,
  overrides: Record<string, unknown> = {},
  dataDirectoryName = "panel-data",
): Promise<void> {
  const dataDir = path.resolve(home, dataDirectoryName);
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "config.toml"),
    Bun.TOML.stringify({
      root_username: "admin",
      root_password_hash: TEST_PASSWORD_HASH,
      jwt_secret: "0123456789abcdef0123456789abcdef",
      public_address: "127.0.0.1",
      deployment_mode: "test",
      listen_host: "127.0.0.1",
      port: 3001,
      secure_cookie: false,
      allow_insecure_http: false,
      environment: "test",
      upload_max_bytes: 2_147_483_648,
      ...overrides,
    })!,
  );
}

export async function createTestConfig(
  home: string,
  overrides: Record<string, unknown> = {},
  dataDirectoryName = "panel-data",
): Promise<AppConfig> {
  await writeTestConfig(home, overrides, dataDirectoryName);
  return loadConfig({ home, dataDirectoryName });
}
