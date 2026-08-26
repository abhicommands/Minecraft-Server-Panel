import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const EMBEDDED_PREFIX = ".release-public/";
let embeddedFrontend: Map<string, Blob> | null = null;

interface NamedBlob extends Blob {
  readonly name: string;
}

function contained(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function embeddedFiles(): Map<string, Blob> {
  if (embeddedFrontend) return embeddedFrontend;
  embeddedFrontend = new Map(
    (Bun.embeddedFiles as readonly NamedBlob[])
      .filter((file) => file.name.startsWith(EMBEDDED_PREFIX))
      .map((file) => [file.name.slice(EMBEDDED_PREFIX.length), file]),
  );
  return embeddedFrontend;
}

export function embeddedFrontendReady(): boolean {
  return Bun.isStandaloneExecutable && embeddedFiles().has("index.html");
}

async function regularFile(publicDir: string, candidate: string): Promise<Bun.BunFile | null> {
  try {
    const [realPublicDir, realCandidate] = await Promise.all([
      realpath(publicDir),
      realpath(candidate),
    ]);
    if (!contained(realPublicDir, realCandidate)) return null;
    return (await stat(realCandidate)).isFile() ? Bun.file(realCandidate) : null;
  } catch {
    return null;
  }
}

function fileResponse(file: Blob, logicalPath: string, request: Request): Response {
  const headers = new Headers({
    "cache-control": logicalPath.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "content-type": file.type || "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  return new Response(request.method === "HEAD" ? null : file, { headers });
}

async function frontendFile(
  publicDir: string,
  logicalPath: string,
): Promise<Blob | null> {
  if (Bun.isStandaloneExecutable) return embeddedFiles().get(logicalPath) || null;
  return regularFile(publicDir, path.resolve(publicDir, logicalPath));
}

export async function serveStaticFrontend(
  request: Request,
  publicDir: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  if (
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/socket.io" ||
    url.pathname.startsWith("/socket.io/")
  ) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  if (decodedPath.includes("\0")) return new Response("Invalid path", { status: 400 });

  const relativePath = decodedPath.replace(/^\/+/, "");
  const candidate = path.resolve(publicDir, relativePath || "index.html");
  if (!contained(publicDir, candidate)) return new Response("Not found", { status: 404 });
  const logicalPath = path.relative(publicDir, candidate).split(path.sep).join("/");

  const existingFile = await frontendFile(publicDir, logicalPath);
  if (existingFile) return fileResponse(existingFile, logicalPath, request);

  if (!request.headers.get("accept")?.includes("text/html")) return null;
  const indexFile = await frontendFile(publicDir, "index.html");
  return indexFile ? fileResponse(indexFile, "index.html", request) : null;
}
