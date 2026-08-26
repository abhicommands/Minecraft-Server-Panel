import path from "node:path";
import type { ServerRecord } from "../types.ts";

export interface ServerLayout {
  instance: string;
  files: string;
  backups: string;
  logs: string;
  runtime: string;
  temporary: string;
}

export function newServerLayout(serversDirectory: string, serverId: string): ServerLayout {
  return layoutFromInstance(path.join(serversDirectory, serverId));
}

export function serverLayout(
  serversDirectory: string,
  record: Pick<ServerRecord, "uuid">,
): ServerLayout {
  return newServerLayout(serversDirectory, record.uuid);
}

function layoutFromInstance(instance: string): ServerLayout {
  return {
    instance,
    files: path.join(instance, "files"),
    backups: path.join(instance, "backups"),
    logs: path.join(instance, "logs"),
    runtime: path.join(instance, "runtime"),
    temporary: path.join(instance, "temporary"),
  };
}
