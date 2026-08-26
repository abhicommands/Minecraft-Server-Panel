import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./http.ts";

export function normalizeRelativePath(value = ""): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function decodePath(raw = ""): string {
  return raw
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new HttpError(400, "Invalid path");
      }
    })
    .join("/");
}

function contained(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingParent(target: string): Promise<string> {
  let candidate = target;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export async function resolveSafePath(
  basePath: string,
  relativePath = "",
): Promise<string> {
  const base = path.resolve(basePath);
  await mkdir(base, { recursive: true });
  const normalized = normalizeRelativePath(relativePath);
  const target = path.resolve(base, normalized || ".");
  if (!contained(base, target)) throw new HttpError(400, "Invalid path");

  const baseReal = await realpath(base);
  const existingParent = await nearestExistingParent(target);
  const existingReal = await realpath(existingParent);
  if (!contained(baseReal, existingReal)) throw new HttpError(400, "Invalid path");
  return target;
}

export function validateLeafName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Invalid name");
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/\0\r\n]/.test(name)) {
    throw new HttpError(400, "Invalid name");
  }
  return name;
}

export async function assertRegularFile(filePath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch {
    throw new HttpError(400, "Invalid file path");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new HttpError(400, "Invalid file path");
  }
}
