import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const TOKEN_ARGUMENT = "-Dminecraft.panel.provisionToken=";
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProvisionProcessMarker {
  kind: "forge-installer";
  pid: number;
  processToken: string;
  command: string[];
  cwd: string;
  processGroup: true;
  phase: "starting" | "running";
  startedAt: string;
}

function durableWriteMarker(markerPath: string, marker: ProvisionProcessMarker): void {
  const temporary = `${markerPath}.part`;
  const file = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(file, JSON.stringify(marker), "utf8");
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, markerPath);
  const directory = openSync(path.dirname(markerPath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function removeMarker(markerPath: string): void {
  rmSync(markerPath, { force: true });
  rmSync(`${markerPath}.part`, { force: true });
}

function processTable(): string | undefined {
  try {
    const result = Bun.spawnSync(
      ["ps", "-e", "-ww", "-o", "pid=", "-o", "pgid=", "-o", "command="],
      { stdout: "pipe", stderr: "ignore" },
    );
    return result.success ? result.stdout.toString("utf8") : undefined;
  } catch {
    return undefined;
  }
}

function matchingProcesses(
  marker: ProvisionProcessMarker,
  output: string,
): Array<{ pid: number; processGroupId: number }> {
  const identity = `${TOKEN_ARGUMENT}${marker.processToken}`;
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const processGroupId = Number(match[2]);
    const command = match[3] || "";
    return pid > 1 && processGroupId === pid && /(?:^|\/)java(?:\s|$)/.test(command) && command.includes(identity)
      ? [{ pid, processGroupId }]
      : [];
  });
}

function markerIsSafe(marker: ProvisionProcessMarker, instancePath: string): boolean {
  if (
    !marker ||
    typeof marker !== "object" ||
    typeof marker.cwd !== "string" ||
    typeof marker.processToken !== "string" ||
    !Array.isArray(marker.command) ||
    marker.command.some((part) => typeof part !== "string")
  ) {
    return false;
  }
  const relativeCwd = path.relative(instancePath, marker.cwd);
  const installerPath = marker.command[3] || "";
  const relativeInstaller = path.relative(marker.cwd, installerPath);
  return (
    marker.kind === "forge-installer" &&
    marker.processGroup === true &&
    TOKEN_PATTERN.test(marker.processToken) &&
    (marker.phase === "starting" || marker.phase === "running") &&
    marker.command.length === 5 &&
    marker.command[0] === "java" &&
    marker.command[1] === `${TOKEN_ARGUMENT}${marker.processToken}` &&
    marker.command[2] === "-jar" &&
    path.isAbsolute(installerPath) &&
    relativeInstaller !== "" &&
    !relativeInstaller.startsWith("..") &&
    !path.isAbsolute(relativeInstaller) &&
    marker.command[4] === "--installServer" &&
    relativeCwd !== "" &&
    !relativeCwd.startsWith("..") &&
    !path.isAbsolute(relativeCwd)
  );
}

function processGroupHasMembers(processGroupId: number): boolean | undefined {
  const output = processTable();
  if (output === undefined) return undefined;
  return output.split("\n").some((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+/);
    return Boolean(match && Number(match[1]) > 0 && Number(match[2]) === processGroupId);
  });
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroup(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupHasMembers(processGroupId) !== false) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

function waitForProcessGroupSync(processGroupId: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (processGroupHasMembers(processGroupId) !== false) {
    if (Date.now() >= deadline) return false;
    Bun.sleepSync(25);
  }
  return true;
}

export function reconcileProvisioningProcesses(serversPath: string): void {
  if (!existsSync(serversPath)) return;
  for (const entry of readdirSync(serversPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const instancePath = path.join(serversPath, entry.name);
    const markerPath = path.join(instancePath, "runtime", "forge-installer.json");
    if (!existsSync(markerPath)) {
      rmSync(`${markerPath}.part`, { force: true });
      continue;
    }
    let marker: ProvisionProcessMarker;
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8")) as ProvisionProcessMarker;
    } catch {
      throw new Error(`Unreadable Forge installer marker at ${markerPath}; refusing to start`);
    }
    if (!markerIsSafe(marker, instancePath)) {
      throw new Error(`Unsafe Forge installer marker at ${markerPath}; refusing to start`);
    }
    const table = processTable();
    if (table === undefined) {
      throw new Error("Could not inspect processes while recovering a Forge installer");
    }
    const matches = matchingProcesses(marker, table);
    const verified = marker.pid > 1
      ? matches.filter((match) => match.pid === marker.pid)
      : matches;
    if (verified.length > 1) {
      throw new Error(`Ambiguous Forge installer state at ${markerPath}; refusing to start`);
    }
    const process = verified[0];
    if (process) {
      signalProcessGroup(process.processGroupId, "SIGKILL");
      if (!waitForProcessGroupSync(process.processGroupId, 10_000)) {
        throw new Error(`Forge installer ${process.pid} survived recovery SIGKILL`);
      }
    } else if (
      marker.pid > 1 &&
      table.split("\n").some((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+/);
        return Boolean(match && Number(match[1]) > 0 && Number(match[2]) === marker.pid);
      })
    ) {
      throw new Error(`Forge installer PID ${marker.pid} could not be verified safely`);
    }
    removeMarker(markerPath);
  }
}

export async function runTrackedForgeInstaller(
  installerPath: string,
  serverRoot: string,
  markerPath: string,
  signal: AbortSignal,
  timeoutMs = 30 * 60_000,
  childEnvironment: Record<string, string | undefined> = process.env,
): Promise<void> {
  signal.throwIfAborted();
  const processToken = crypto.randomUUID();
  const command = [
    "java",
    `${TOKEN_ARGUMENT}${processToken}`,
    "-jar",
    installerPath,
    "--installServer",
  ];
  const marker: ProvisionProcessMarker = {
    kind: "forge-installer",
    pid: 0,
    processToken,
    command,
    cwd: serverRoot,
    processGroup: true,
    phase: "starting",
    startedAt: new Date().toISOString(),
  };
  durableWriteMarker(markerPath, marker);

  let child: Bun.Subprocess | undefined;
  let cleanupFailure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  try {
    child = Bun.spawn(command, {
      cwd: serverRoot,
      env: childEnvironment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
    marker.pid = child.pid;
    marker.phase = "running";
    durableWriteMarker(markerPath, marker);

    const interrupted = new Promise<"abort" | "timeout">((resolve) => {
      onAbort = () => resolve("abort");
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
      if (signal.aborted) onAbort();
    });
    const outcome = await Promise.race([
      child.exited.then((code) => ({ kind: "exit" as const, code })),
      interrupted.then((kind) => ({ kind })),
    ]);
    if (outcome.kind !== "exit") {
      signalProcessGroup(child.pid, "SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      if (!exited && processGroupHasMembers(child.pid) !== false) {
        signalProcessGroup(child.pid, "SIGKILL");
      }
      await child.exited;
      if (outcome.kind === "abort") signal.throwIfAborted();
      throw new Error(`Forge installer exceeded its ${Math.round(timeoutMs / 60_000)} minute limit`);
    }
    signal.throwIfAborted();
    if (outcome.code !== 0) throw new Error(`Forge installer exited with code ${outcome.code}`);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (child && processGroupHasMembers(child.pid) !== false) {
      try {
        signalProcessGroup(child.pid, "SIGKILL");
        if (!(await waitForProcessGroup(child.pid, 10_000))) {
          throw new Error("Forge installer process group could not be cleaned up");
        }
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (!child || processGroupHasMembers(child.pid) === false) removeMarker(markerPath);
    if (cleanupFailure) throw cleanupFailure;
  }
}
