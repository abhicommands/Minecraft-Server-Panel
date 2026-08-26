import type { Server as SocketIOServer } from "socket.io";

export interface AppConfig {
  rootUsername: string;
  rootPasswordHash: string;
  jwtSecret: Uint8Array;
  port: number;
  hostname: string;
  corsOrigin: string | null;
  secureCookie: boolean;
  allowInsecureHttp: boolean;
  deploymentMode: "https" | "direct-http" | "test";
  publicAddress: string | null;
  production: boolean;
  dataDir: string;
  databasePath: string;
  serversPath: string;
  publicDir: string;
  uploadMaxBytes: number;
}

export interface ServerRecord {
  id: number;
  uuid: string;
  name: string;
  startupCommand: string;
  startupFlags: string;
  version: string;
  port: number;
  serverType: string;
}

export interface SessionUser {
  username: string;
}

export type BunRouteRequest = Bun.BunRequest<string>;
export type BunServer = Bun.Server<unknown>;
export type RouteHandler = (
  request: BunRouteRequest,
  server: BunServer,
) => Response | Promise<Response>;

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS";
export type RouteTable = Record<
  string,
  Partial<Record<HttpMethod, RouteHandler>> | RouteHandler | Response
>;

export interface AppContext {
  config: AppConfig;
  io: SocketIOServer;
}
