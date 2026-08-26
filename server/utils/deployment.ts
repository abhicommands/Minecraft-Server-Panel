import { isIP } from "node:net";

export type DeploymentMode = "https" | "direct-http" | "test";

export interface PublicAddress {
  value: string;
  kind: "domain" | "ipv4" | "ipv6";
  deploymentMode: "https" | "direct-http";
  listenHost: string;
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function classifyPublicAddress(raw: string): PublicAddress {
  const value = raw.trim().toLowerCase();
  if (!value) throw new Error("A public DNS name or IP address is required");
  if (value.includes("://") || /[/?#@]/.test(value)) {
    throw new Error("Enter only a DNS name or IP address, without a scheme, port, or path");
  }

  const ipVersion = isIP(value);
  if (ipVersion === 4) {
    return { value, kind: "ipv4", deploymentMode: "direct-http", listenHost: "0.0.0.0" };
  }
  if (ipVersion === 6) {
    return { value, kind: "ipv6", deploymentMode: "direct-http", listenHost: "::" };
  }

  if (value.length > 253 || value.startsWith(".") || value.endsWith(".")) {
    throw new Error("Invalid DNS name");
  }
  const labels = value.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => label.length > 63 || !DOMAIN_LABEL.test(label)) ||
    labels.at(-1)!.length < 2 ||
    !/[a-z]/.test(labels.at(-1)!)
  ) {
    throw new Error("Enter a valid public DNS name such as panel.example.com, or an IP address");
  }
  return { value, kind: "domain", deploymentMode: "https", listenHost: "127.0.0.1" };
}

export function displayHttpAddress(address: PublicAddress, port: number): string {
  return address.kind === "ipv6" ? `[${address.value}]:${port}` : `${address.value}:${port}`;
}
