import type { AppConfig, BunRouteRequest, BunServer, RouteHandler } from "../types.ts";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export async function readJson<T>(
  request: Request,
  maximumBytes = 102_400,
): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maximumBytes) {
    throw new HttpError(413, "Request body is too large");
  }
  if (!request.body) throw new HttpError(400, "Request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(value);
  }

  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function query(request: Request, name: string): string {
  return new URL(request.url).searchParams.get(name) || "";
}

function addCors(response: Response, request: Request, config: AppConfig): Response {
  if (!config.corsOrigin) return response;
  const origin = request.headers.get("origin");
  if (origin !== config.corsOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", config.corsOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflight(request: Request, config: AppConfig): Response {
  const response = new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "Content-Type, server-id",
      "access-control-max-age": "600",
    },
  });
  return addCors(response, request, config);
}

export function route(config: AppConfig, handler: RouteHandler): RouteHandler {
  return async (request: BunRouteRequest, server: BunServer) => {
    try {
      return addCors(await handler(request, server), request, config);
    } catch (error) {
      if (error instanceof HttpError) {
        return addCors(textResponse(error.message, error.status), request, config);
      }
      console.error("Unhandled request error:", error);
      return addCors(textResponse("Internal server error", 500), request, config);
    }
  };
}

export function attachmentHeaders(fileName: string, contentType: string): Headers {
  const safeName = fileName.replace(/["\r\n\\/]/g, "_");
  return new Headers({
    "content-type": contentType,
    "content-disposition": `attachment; filename="${safeName}"`,
  });
}
