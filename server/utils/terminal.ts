import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Server as SocketIOServer } from "socket.io";
import type { ServerRecord } from "../types.ts";
import { HttpError } from "./http.ts";
import { serverLayout } from "./serverLayout.ts";

const MAX_STARTUP_FLAGS_LENGTH = 600;
const DISALLOWED_FLAGS_PATTERN = /[;&|<>`$\0\r\n]/;
const LOG_LINE_LIMIT = 1_000;
const LOG_COMPACT_AT = 1_200;
const FORCE_EXIT_TIMEOUT_MS = 10_000;
const PROCESS_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESS_TOKEN_ARGUMENT = "-Dminecraft.panel.processToken=";
const SERVER_ID_ARGUMENT = "-Dminecraft.panel.serverId=";

interface ProcessMarker {
  pid: number;
  serverId: string;
  command: string[];
  startedAt: string;
  processGroup?: boolean;
  processToken?: string;
  phase?: "starting" | "running";
}

interface ManagedServer {
  record: ServerRecord;
  process: Bun.Subprocess | undefined;
  terminal: Bun.Terminal | undefined;
  running: boolean;
  orphanPid: number | undefined;
  orphanProcessGroup: boolean;
  orphanVerified: boolean;
  orphanMarker: ProcessMarker | undefined;
  history: string[];
  partialLine: string;
  historyLoaded: boolean;
  decoder: TextDecoder;
  logQueue: Promise<void>;
  generation: number;
  exitCleanup: Promise<void> | undefined;
  removing: boolean;
  disposed: boolean;
}

type RemovalFinalizer = () => void | Promise<void>;

export function sanitizeStartupFlags(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function ensureValidStartupFlags(value: unknown): string {
  const flags = sanitizeStartupFlags(value);
  if (!flags) return "";
  if (flags.length > MAX_STARTUP_FLAGS_LENGTH) throw new HttpError(400, "Flags are too long");
  if (DISALLOWED_FLAGS_PATTERN.test(flags)) {
    throw new HttpError(400, "Flags contain unsupported characters like shell separators");
  }
  if (/-jar\b/i.test(flags) || /\bserver\.jar\b/i.test(flags)) {
    throw new HttpError(400, "Flags cannot modify the server jar configuration");
  }
  const parsed = parseCommandLine(flags);
  if (parsed.some((argument) => /^-X(?:mx|ms)/i.test(argument))) {
    throw new HttpError(400, "Flags cannot change the allocated memory");
  }
  if (parsed.some((argument) => /^(?:.*[\\/])?java(?:\.exe)?$/i.test(argument))) {
    throw new HttpError(400, "Flags cannot override the java executable");
  }
  return flags;
}

export function parseCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let hasToken = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      hasToken = true;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      hasToken = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (hasToken) {
        result.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += character;
    hasToken = true;
  }

  if (escaping || quote) throw new HttpError(400, "Flags contain unmatched quoting");
  if (hasToken) result.push(current);
  return result;
}

export function composeStartupCommand(baseCommand = "", flags = ""): string {
  const base = String(baseCommand || "").trim();
  const cleanFlags = sanitizeStartupFlags(flags);
  if (!cleanFlags) return base;
  const jarMatch = base.match(/\s-jar\b/i);
  if (!jarMatch || jarMatch.index === undefined) return `${base} ${cleanFlags}`.trim();
  return `${base.slice(0, jarMatch.index).trimEnd()} ${cleanFlags} ${base
    .slice(jarMatch.index)
    .trimStart()}`;
}

export function composeStartupArgv(baseCommand: string, flags: string): string[] {
  if (DISALLOWED_FLAGS_PATTERN.test(baseCommand)) {
    throw new HttpError(400, "Startup command contains unsupported characters");
  }
  const base = parseCommandLine(baseCommand.trim());
  if (base[0] !== "java") throw new HttpError(400, "Startup command must use java directly");
  const maximumMemoryOptions = base.filter((argument) => /^-Xmx/i.test(argument));
  if (maximumMemoryOptions.length !== 1 || !/^-Xmx\d+[GMK]$/i.test(maximumMemoryOptions[0] || "")) {
    throw new HttpError(400, "Startup command is missing -Xmx memory configuration");
  }
  const initialMemoryOptions = base.filter((argument) => /^-Xms/i.test(argument));
  if (initialMemoryOptions.length !== 1 || !/^-Xms\d+[GMK]$/i.test(initialMemoryOptions[0] || "")) {
    throw new HttpError(400, "Startup command is missing -Xms memory configuration");
  }
  const jarIndexes = base.flatMap((argument, index) => (argument === "-jar" ? [index] : []));
  if (jarIndexes.length !== 1) throw new HttpError(400, "Startup command must contain one -jar option");
  const jarIndex = jarIndexes[0];
  if (jarIndex === undefined || base[jarIndex + 1] !== "server.jar") {
    throw new HttpError(400, "Startup command must use -jar server.jar");
  }
  const parsedFlags = parseCommandLine(ensureValidStartupFlags(flags));
  return [...base.slice(0, jarIndex), ...parsedFlags, ...base.slice(jarIndex)];
}

function addProcessIdentity(command: string[], serverId: string, processToken: string): string[] {
  const jarIndex = command.indexOf("-jar");
  if (jarIndex < 0) throw new HttpError(400, "Startup command must contain one -jar option");
  return [
    ...command.slice(0, jarIndex),
    `${SERVER_ID_ARGUMENT}${serverId}`,
    `${PROCESS_TOKEN_ARGUMENT}${processToken}`,
    ...command.slice(jarIndex),
  ];
}

async function readLastLines(filePath: string, maximumLines = LOG_LINE_LIMIT): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    const chunks: Buffer[] = [];
    let position = stats.size;
    let newlines = 0;
    while (position > 0 && newlines <= maximumLines) {
      const size = Math.min(64 * 1024, position);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      await handle.read(chunk, 0, size, position);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 10) newlines += 1;
    }
    return Buffer.concat(chunks).toString("utf8").split("\n").slice(-maximumLines).join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  } finally {
    await handle?.close();
  }
}

export class TerminalManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly lifecycleLocks = new Map<string, Promise<void>>();
  private readonly removedServers = new Set<string>();
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly io: SocketIOServer,
    private readonly serversDirectory: string,
    private readonly childEnvironment: Record<string, string | undefined> = process.env,
  ) {}

  private layout(record: ServerRecord) {
    return serverLayout(this.serversDirectory, record);
  }

  private markerPath(record: ServerRecord): string {
    return path.join(this.layout(record).runtime, "process.json");
  }

  private logPath(record: ServerRecord): string {
    return path.join(this.layout(record).logs, "console.log");
  }

  private state(record: ServerRecord): ManagedServer {
    const existing = this.servers.get(record.uuid);
    if (existing) {
      existing.record = record;
      return existing;
    }
    const created: ManagedServer = {
      record,
      process: undefined,
      terminal: undefined,
      running: false,
      orphanPid: undefined,
      orphanProcessGroup: false,
      orphanVerified: false,
      orphanMarker: undefined,
      history: [],
      partialLine: "",
      historyLoaded: false,
      decoder: new TextDecoder(),
      logQueue: Promise.resolve(),
      generation: 0,
      exitCleanup: undefined,
      removing: false,
      disposed: false,
    };
    this.servers.set(record.uuid, created);
    return created;
  }

  private assertAvailable(record: ServerRecord): void {
    if (this.closing) throw new HttpError(503, "The panel is shutting down");
    if (this.removedServers.has(record.uuid)) throw new HttpError(404, "Server no longer exists");
  }

  private async withLifecycleLock<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleLocks.get(serverId) || Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.lifecycleLocks.set(serverId, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleLocks.get(serverId) === tail) this.lifecycleLocks.delete(serverId);
    }
  }

  private async initializeState(state: ManagedServer): Promise<void> {
    if (state.disposed) throw new HttpError(404, "Server no longer exists");
    if (!state.running && state.process && state.exitCleanup) {
      await state.exitCleanup.catch(() => {});
    }
    await Promise.all([
      mkdir(path.dirname(this.logPath(state.record)), { recursive: true }),
      mkdir(path.dirname(this.markerPath(state.record)), { recursive: true }),
    ]);
    if (!state.historyLoaded) {
      const history = await readLastLines(this.logPath(state.record));
      state.history = history ? history.split("\n").slice(-LOG_LINE_LIMIT) : [];
      state.historyLoaded = true;
    }
    if (state.orphanPid) await this.refreshOrphan(state);
    else if (!state.process) await this.detectOrphan(state);
  }

  async initialize(record: ServerRecord): Promise<void> {
    await this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      await this.initializeState(this.state(record));
    });
  }

  async initializeAll(records: ServerRecord[]): Promise<void> {
    await Promise.all(records.map((record) => this.initialize(record)));
  }

  async registerPrepared(
    record: ServerRecord,
    publish: () => void | Promise<void>,
  ): Promise<void> {
    await this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      if (this.servers.has(record.uuid)) {
        throw new HttpError(409, "Server lifecycle state already exists");
      }
      const state = this.state(record);
      try {
        await this.initializeState(state);
        await publish();
      } catch (error) {
        state.disposed = true;
        this.servers.delete(record.uuid);
        throw error;
      }
    });
  }

  async withStopped<T>(record: ServerRecord, operation: () => Promise<T>): Promise<T> {
    return this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      await this.initializeState(state);
      if (state.running || state.process || state.orphanPid) {
        throw new HttpError(409, "Stop the server before changing its installation");
      }
      return operation();
    });
  }

  async history(record: ServerRecord): Promise<string> {
    return this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      await this.initializeState(state);
      return state.history.join("\n");
    });
  }

  async isRunning(record: ServerRecord): Promise<boolean> {
    return this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      await this.initializeState(state);
      return state.running;
    });
  }

  private appendOutput(state: ManagedServer, rawOutput: string): void {
    if (!rawOutput || state.disposed) return;
    this.io.to(state.record.uuid).emit("output", rawOutput);
    const combined = state.partialLine + rawOutput;
    const lines = combined.split("\n");
    state.partialLine = lines.pop() || "";
    state.history.push(...lines);
    const shouldCompact = state.history.length > LOG_COMPACT_AT;
    if (shouldCompact) {
      state.history = state.history.slice(-LOG_LINE_LIMIT);
    }
    const compacted = shouldCompact
      ? [...state.history, state.partialLine].join("\n")
      : null;
    const logPath = this.logPath(state.record);
    state.logQueue = state.logQueue
      .then(async () => {
        if (state.disposed) return;
        try {
          // The normal initializer creates the instance tree. Only recreate a
          // missing logs directory here; never resurrect an instance that was
          // removed outside the panel while its process was still producing output.
          await mkdir(path.dirname(logPath));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            if (state.process?.exitCode === null) this.signalManagedProcess(state, "SIGKILL");
            return;
          }
          if (code !== "EEXIST") throw error;
        }
        await appendFile(logPath, rawOutput, "utf8");
        if (compacted !== null) {
          await writeFile(logPath, compacted, "utf8");
        }
      })
      .catch((error) => console.error("Failed to write server log:", error));
  }

  private createMarker(
    record: ServerRecord,
    command: string[],
    processToken: string,
    pid: number,
    phase: "starting" | "running",
  ): ProcessMarker {
    return {
      pid,
      serverId: record.uuid,
      command,
      startedAt: new Date().toISOString(),
      processGroup: true,
      processToken,
      phase,
    };
  }

  private async writeMarker(record: ServerRecord, marker: ProcessMarker): Promise<void> {
    const destination = this.markerPath(record);
    const temporary = `${destination}.part`;
    await mkdir(path.dirname(destination), { recursive: true });
    let markerHandle;
    try {
      markerHandle = await open(temporary, "w", 0o600);
      await markerHandle.writeFile(JSON.stringify(marker), "utf8");
      await markerHandle.sync();
    } finally {
      await markerHandle?.close();
    }
    await rename(temporary, destination);
    let directoryHandle;
    try {
      directoryHandle = await open(path.dirname(destination), "r");
      await directoryHandle.sync();
    } finally {
      await directoryHandle?.close();
    }
  }

  private async removeMarker(record: ServerRecord): Promise<void> {
    const destination = this.markerPath(record);
    await Promise.all(
      [destination, `${destination}.part`].map((markerPath) =>
        unlink(markerPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }),
      ),
    );
  }

  private markerHasSafeIdentity(marker: ProcessMarker, record: ServerRecord): boolean {
    if (
      marker.serverId !== record.uuid ||
      marker.processGroup !== true ||
      typeof marker.processToken !== "string" ||
      !PROCESS_TOKEN_PATTERN.test(marker.processToken) ||
      !Array.isArray(marker.command) ||
      marker.command.length < 6 ||
      marker.command.length > 128 ||
      marker.command.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length > 2_048 ||
          /[\0\r\n]/.test(argument),
      ) ||
      marker.command[0] !== "java"
    ) {
      return false;
    }
    const jarIndexes = marker.command.flatMap((argument, index) =>
      argument === "-jar" ? [index] : [],
    );
    const jarIndex = jarIndexes[0];
    return (
      jarIndexes.length === 1 &&
      jarIndex !== undefined &&
      marker.command[jarIndex + 1] === "server.jar" &&
      marker.command.filter((argument) => /^-Xmx\d+[GMK]$/i.test(argument)).length === 1 &&
      marker.command.filter((argument) => /^-Xms\d+[GMK]$/i.test(argument)).length === 1 &&
      marker.command.filter((argument) => argument === `${SERVER_ID_ARGUMENT}${record.uuid}`)
        .length === 1 &&
      marker.command.filter(
        (argument) => argument === `${PROCESS_TOKEN_ARGUMENT}${marker.processToken}`,
      ).length === 1
    );
  }

  private async processMatches(marker: ProcessMarker): Promise<boolean> {
    try {
      process.kill(marker.pid, 0);
      const [commandResult, groupResult] = await Promise.all([
        Bun.spawn(["ps", "-ww", "-p", String(marker.pid), "-o", "command="], {
          stdout: "pipe",
          stderr: "ignore",
        }),
        Bun.spawn(["ps", "-p", String(marker.pid), "-o", "pgid="], {
          stdout: "pipe",
          stderr: "ignore",
        }),
      ]);
      const [commandExit, groupExit] = await Promise.all([
        commandResult.exited,
        groupResult.exited,
      ]);
      if (commandExit !== 0 || groupExit !== 0) return false;
      const [command, group] = await Promise.all([
        new Response(commandResult.stdout).text(),
        new Response(groupResult.stdout).text(),
      ]);
      return (
        Number(group.trim()) === marker.pid &&
        /(?:^|\/)java(?:\s|$)/.test(command.trim()) &&
        command.includes(`${SERVER_ID_ARGUMENT}${marker.serverId}`) &&
        command.includes(`${PROCESS_TOKEN_ARGUMENT}${marker.processToken}`)
      );
    } catch {
      return false;
    }
  }

  private async findIdentityProcesses(
    marker: ProcessMarker,
    record: ServerRecord,
  ): Promise<Array<{ pid: number; processGroupId: number }> | undefined> {
    if (!this.markerHasSafeIdentity(marker, record)) return [];
    let output: string;
    try {
      const result = Bun.spawn(
        ["ps", "-e", "-ww", "-o", "pid=", "-o", "pgid=", "-o", "command="],
        { stdout: "pipe", stderr: "ignore" },
      );
      if ((await result.exited) !== 0) return undefined;
      output = await new Response(result.stdout).text();
    } catch {
      return undefined;
    }
    const serverIdentity = `${SERVER_ID_ARGUMENT}${record.uuid}`;
    const processIdentity = `${PROCESS_TOKEN_ARGUMENT}${marker.processToken}`;
    const matches: Array<{ pid: number; processGroupId: number }> = [];
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const processGroupId = Number(match[2]);
      const command = match[3] || "";
      if (
        pid > 1 &&
        processGroupId === pid &&
        /(?:^|\/)java(?:\s|$)/.test(command) &&
        command.includes(serverIdentity) &&
        command.includes(processIdentity)
      ) {
        matches.push({ pid, processGroupId });
      }
    }
    return matches;
  }

  private processGroupHasMembers(processGroupId: number): boolean | undefined {
    let result;
    try {
      result = Bun.spawnSync(["ps", "-e", "-o", "pid=", "-o", "pgid="], {
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      return undefined;
    }
    if (!result.success) return undefined;
    return result.stdout
      .toString("utf8")
      .split("\n")
      .some((line) => {
        const [rawPid, rawGroup] = line.trim().split(/\s+/);
        return Number(rawPid) > 0 && Number(rawGroup) === processGroupId;
      });
  }

  private processExists(pid: number, processGroup: boolean): boolean {
    try {
      process.kill(processGroup ? -pid : pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
      if (!processGroup) return true;
      return this.processGroupHasMembers(pid) ?? true;
    }
  }

  private signalProcess(pid: number, processGroup: boolean, signal: NodeJS.Signals): void {
    try {
      process.kill(processGroup ? -pid : pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (code === "EPERM" && processGroup && this.processGroupHasMembers(pid) === false) return;
      throw error;
    }
  }

  private async waitForProcessExit(
    pid: number,
    processGroup: boolean,
    timeoutMs = FORCE_EXIT_TIMEOUT_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.processExists(pid, processGroup)) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(25);
    }
    return true;
  }

  private async settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private orphanStillExists(state: ManagedServer): boolean {
    const pid = state.orphanPid;
    if (!pid) return false;
    return (
      this.processExists(pid, false) ||
      (state.orphanMarker?.processGroup === true && this.processExists(pid, true))
    );
  }

  private clearOrphanState(state: ManagedServer): void {
    state.orphanPid = undefined;
    state.orphanProcessGroup = false;
    state.orphanVerified = false;
    state.orphanMarker = undefined;
    state.running = false;
  }

  private async refreshOrphan(state: ManagedServer): Promise<void> {
    if (!state.orphanPid) return;
    if (!this.orphanStillExists(state)) {
      this.clearOrphanState(state);
      await this.removeMarker(state.record);
      this.io.to(state.record.uuid).emit("serverStatus", false);
      return;
    }
    const marker = state.orphanMarker;
    if (
      state.orphanVerified &&
      marker &&
      this.markerHasSafeIdentity(marker, state.record) &&
      (await this.processMatches(marker))
    ) {
      return;
    }
    state.orphanVerified = false;
    state.orphanProcessGroup = false;
    state.running = true;
  }

  private async detectOrphan(state: ManagedServer): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.markerPath(state.record), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await unlink(`${this.markerPath(state.record)}.part`).catch(
          (partError: NodeJS.ErrnoException) => {
            if (partError.code !== "ENOENT") throw partError;
          },
        );
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw new HttpError(
        409,
        "The server process marker is unreadable; inspect it before starting another process",
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new HttpError(
        409,
        "The server process marker is invalid; inspect it before starting another process",
      );
    }
    const marker = parsed as ProcessMarker;
    if (!this.markerHasSafeIdentity(marker, state.record)) {
      throw new HttpError(
        409,
        "The server process marker cannot be verified safely; inspect it before starting another process",
      );
    }
    if (marker.phase === "starting" && marker.pid === 0) {
      const matches = await this.findIdentityProcesses(marker, state.record);
      if (matches === undefined || matches.length > 1) {
        throw new HttpError(
          409,
          "The interrupted server launch cannot be resolved safely; inspect its Java process before retrying",
        );
      }
      const recovered = matches[0];
      if (!recovered) {
        await this.removeMarker(state.record);
        return;
      }
      marker.pid = recovered.pid;
      marker.phase = "running";
      await this.writeMarker(state.record, marker);
    } else if (!Number.isSafeInteger(marker.pid) || marker.pid <= 1) {
      throw new HttpError(
        409,
        "The server process marker contains an invalid PID; inspect it before starting another process",
      );
    }
    const directExists = this.processExists(marker.pid, false);
    const groupExists = marker.processGroup === true && this.processExists(marker.pid, true);
    if (!directExists && !groupExists) {
      await this.removeMarker(state.record);
      return;
    }

    state.orphanPid = marker.pid;
    state.orphanMarker = marker;
    state.running = true;
    if (
      directExists &&
      this.markerHasSafeIdentity(marker, state.record) &&
      (await this.processMatches(marker))
    ) {
      state.orphanVerified = true;
      state.orphanProcessGroup = true;
      return;
    }
    state.orphanVerified = false;
    state.orphanProcessGroup = false;
    console.warn(
      `Server ${state.record.uuid} has a live process marker that cannot be verified; start and automatic kill are blocked.`,
    );
  }

  private async watchProcessExit(
    state: ManagedServer,
    generation: number,
    subprocess: Bun.Subprocess,
    terminal: Bun.Terminal,
    marker: ProcessMarker,
  ): Promise<void> {
    let exitCode: number | null = null;
    let waitError: unknown;
    try {
      exitCode = await subprocess.exited;
    } catch (error) {
      waitError = error;
    }

    if (state.generation !== generation) return;
    state.running = false;
    let residualProcessGroup = false;
    try {
      const trailing = state.decoder.decode();
      if (trailing) this.appendOutput(state, trailing);
      if (waitError) {
        this.appendOutput(
          state,
          `\nProcess error: ${waitError instanceof Error ? waitError.message : "unknown error"}\n`,
        );
      } else if (exitCode !== 0) {
        this.appendOutput(
          state,
          `\nServer process exited with code ${exitCode ?? "unknown"}${subprocess.signalCode ? ` (${subprocess.signalCode})` : ""}.\n`,
        );
      }
      // A detached Java process leads its own process group. If a plugin or
      // wrapper spawned descendants, the group can survive after Java exits.
      if (this.processExists(subprocess.pid, true)) {
        this.signalProcess(subprocess.pid, true, "SIGKILL");
      }
      if (!(await this.waitForProcessExit(subprocess.pid, true))) {
        residualProcessGroup = true;
        throw new Error("The Java process group still has live descendants after SIGKILL");
      }
      if (!terminal.closed) terminal.close();
      await this.removeMarker(state.record).catch((error) => {
        console.error("Failed to remove server process marker:", error);
      });
      this.io.to(state.record.uuid).emit("serverStatus", false);
      await state.logQueue;
    } catch (error) {
      residualProcessGroup ||= this.processExists(subprocess.pid, true);
      if (residualProcessGroup) {
        state.orphanPid = subprocess.pid;
        state.orphanProcessGroup = true;
        state.orphanVerified = true;
        state.orphanMarker = marker;
        state.running = true;
        this.io.to(state.record.uuid).emit("serverStatus", true);
      }
      console.error("Failed to finalize server process exit:", error);
      throw error;
    } finally {
      if (!terminal.closed) terminal.close();
      if (state.generation === generation) {
        state.process = undefined;
        state.terminal = undefined;
        if (!residualProcessGroup) this.clearOrphanState(state);
      }
    }
  }

  private signalManagedProcess(state: ManagedServer, signal: NodeJS.Signals): void {
    const subprocess = state.process;
    if (!subprocess) return;
    try {
      this.signalProcess(subprocess.pid, true, signal);
    } catch (error) {
      if (subprocess.exitCode === null) subprocess.kill(signal);
      else if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private async forceManagedExit(state: ManagedServer): Promise<void> {
    const subprocess = state.process;
    if (!subprocess) return;
    if (subprocess.exitCode === null) this.signalManagedProcess(state, "SIGKILL");
    const cleanup = state.exitCleanup || subprocess.exited.then(() => undefined);
    if (!(await this.settlesWithin(cleanup, FORCE_EXIT_TIMEOUT_MS))) {
      throw new HttpError(500, "The server process did not exit after SIGKILL");
    }
  }

  private async forceOrphanExit(state: ManagedServer): Promise<void> {
    const pid = state.orphanPid;
    if (!pid) return;
    if (!this.orphanStillExists(state)) {
      this.clearOrphanState(state);
      await this.removeMarker(state.record);
      this.io.to(state.record.uuid).emit("serverStatus", false);
      return;
    }
    const marker = state.orphanMarker;
    if (!state.orphanVerified || !marker || !this.markerHasSafeIdentity(marker, state.record)) {
      throw new HttpError(
        409,
        "A live process marker cannot be verified safely; stop that process manually before retrying",
      );
    }
    const leaderExists = this.processExists(pid, false);
    if (leaderExists && !(await this.processMatches(marker))) {
      state.orphanVerified = false;
      state.orphanProcessGroup = false;
      throw new HttpError(
        409,
        "The marked process identity changed; automatic kill was refused",
      );
    }
    this.signalProcess(pid, true, "SIGKILL");
    if (!(await this.waitForProcessExit(pid, true))) {
      throw new HttpError(500, "The orphaned server process group did not exit after SIGKILL");
    }
    this.clearOrphanState(state);
    await this.removeMarker(state.record);
    this.io.to(state.record.uuid).emit("serverStatus", false);
  }

  async start(record: ServerRecord): Promise<void> {
    await this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      await this.initializeState(state);
      if (state.running || state.process || state.orphanPid) {
        throw new HttpError(409, "Server is already running");
      }
      const processToken = crypto.randomUUID();
      const command = addProcessIdentity(
        composeStartupArgv(record.startupCommand, record.startupFlags || ""),
        record.uuid,
        processToken,
      );
      state.decoder = new TextDecoder();
      const generation = ++state.generation;
      const terminal = new Bun.Terminal({
        cols: 120,
        rows: 40,
        name: "xterm-256color",
        data: (_terminal, data) => {
          this.appendOutput(state, state.decoder.decode(data, { stream: true }));
        },
      });
      state.terminal = terminal;

      let subprocess: Bun.Subprocess | undefined;
      let processStopped = false;
      try {
        const reservation = this.createMarker(record, command, processToken, 0, "starting");
        await this.writeMarker(record, reservation);
        subprocess = Bun.spawn(command, {
          cwd: this.layout(record).files,
          env: { ...this.childEnvironment, TERM: "xterm-256color" },
          terminal,
          detached: true,
        });
        state.process = subprocess;
        state.running = true;
        const marker = this.createMarker(
          record,
          command,
          processToken,
          subprocess.pid,
          "running",
        );
        const cleanup = this.watchProcessExit(state, generation, subprocess, terminal, marker);
        state.exitCleanup = cleanup;
        const clearCleanup = (): void => {
          if (state.exitCleanup === cleanup) state.exitCleanup = undefined;
        };
        void cleanup.then(clearCleanup, clearCleanup);
        await this.writeMarker(record, marker);
        if (!state.running || subprocess.exitCode !== null) {
          await cleanup;
          throw new HttpError(500, "The server process exited during startup");
        }
        this.io.to(record.uuid).emit("serverStatus", true);
      } catch (error) {
        state.running = false;
        if (subprocess && state.process === subprocess) {
          try {
            await this.forceManagedExit(state);
            processStopped = !this.processExists(subprocess.pid, true);
          } catch (cleanupError) {
            console.error("Failed to clean up a partially started server process:", cleanupError);
          }
        } else {
          if (!terminal.closed) terminal.close();
          state.terminal = undefined;
          processStopped = true;
        }
        if (processStopped && !state.orphanPid) await this.removeMarker(record).catch(() => {});
        throw error;
      }
    });
  }

  async command(record: ServerRecord, command: unknown): Promise<void> {
    await this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      await this.initializeState(state);
      if (!state.process || !state.terminal || !state.running) {
        if (state.orphanPid) throw new HttpError(409, "The server process is running but its console cannot be reattached");
        throw new HttpError(409, "Terminal not found");
      }
      if (typeof command !== "string" || command.length > 4_096 || /[\0\r\n]/.test(command)) {
        throw new HttpError(400, "Invalid command");
      }
      state.terminal.write(`${command}\n`);
    });
  }

  async stop(record: ServerRecord): Promise<void> {
    await this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      await this.initializeState(state);
      if (!state.process || !state.terminal || !state.running) {
        if (state.orphanPid) throw new HttpError(409, "The orphaned server process cannot receive console input; use kill");
        throw new HttpError(409, "Server is not running");
      }
      state.terminal.write("stop\n");
    });
  }

  async kill(record: ServerRecord): Promise<void> {
    await this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      await this.initializeState(state);
      if (state.process) await this.forceManagedExit(state);
      else if (state.orphanPid) await this.forceOrphanExit(state);
      else throw new HttpError(409, "Server is not running");
    });
  }

  async remove(record: ServerRecord, finalize: RemovalFinalizer = () => {}): Promise<void> {
    await this.withLifecycleLock(record.uuid, async () => {
      this.assertAvailable(record);
      const state = this.state(record);
      this.removedServers.add(record.uuid);
      state.removing = true;
      this.io.in(record.uuid).disconnectSockets(true);
      try {
        await this.initializeState(state);
        if (state.process) await this.forceManagedExit(state);
        if (state.orphanPid) await this.forceOrphanExit(state);
        await state.logQueue;
        if (!state.terminal?.closed) state.terminal?.close();
        await finalize();
        state.disposed = true;
        state.terminal = undefined;
        this.servers.delete(record.uuid);
      } catch (error) {
        this.removedServers.delete(record.uuid);
        state.removing = false;
        throw error;
      }
    });
  }

  async shutdown(timeoutMs = 60_000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = (async () => {
      const states = [...this.servers.values()];
      const failures: unknown[] = [];
      const knownProcessGroups = new Set<number>();
      for (const state of states) {
        if (state.process) knownProcessGroups.add(state.process.pid);
        if (state.orphanPid && state.orphanVerified && state.orphanProcessGroup) {
          knownProcessGroups.add(state.orphanPid);
        }
      }
      await Promise.all(
        states.map((state) =>
          this.withLifecycleLock(state.record.uuid, async () => {
            if (state.disposed) return;
            try {
              if (state.process && state.running) state.terminal?.write("stop\n");
              if (state.orphanPid) await this.forceOrphanExit(state);
            } catch (error) {
              failures.push(error);
            }
          }),
        ),
      );

      const cleanupPromises = [
        ...new Set(states.flatMap((state) => (state.exitCleanup ? [state.exitCleanup] : []))),
      ];
      const settledCleanups = Promise.allSettled(cleanupPromises);
      const graceful = await this.settlesWithin(settledCleanups, timeoutMs);
      if (!graceful) {
        for (const processGroupId of knownProcessGroups) {
          try {
            if (this.processExists(processGroupId, true)) {
              this.signalProcess(processGroupId, true, "SIGKILL");
            }
          } catch (error) {
            failures.push(error);
          }
        }
      }

      if (!(await this.settlesWithin(settledCleanups, FORCE_EXIT_TIMEOUT_MS))) {
        failures.push(new Error("One or more Minecraft exit handlers did not settle"));
      } else {
        for (const result of await settledCleanups) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      }

      for (const processGroupId of knownProcessGroups) {
        if (!this.processExists(processGroupId, true)) continue;
        try {
          this.signalProcess(processGroupId, true, "SIGKILL");
          if (!(await this.waitForProcessExit(processGroupId, true))) {
            failures.push(
              new Error(`Minecraft process group ${processGroupId} could not be terminated`),
            );
          }
        } catch (error) {
          failures.push(error);
        }
      }

      const logResults = await Promise.allSettled(states.map((state) => state.logQueue));
      for (const result of logResults) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      for (const state of states) {
        if (!state.terminal?.closed) state.terminal?.close();
        state.terminal = undefined;
        const managedProcessLives = state.process
          ? this.processExists(state.process.pid, true)
          : false;
        if (!managedProcessLives && !this.orphanStillExists(state)) {
          state.disposed = true;
          this.servers.delete(state.record.uuid);
        }
      }
      this.lifecycleLocks.clear();
      if (failures.length) {
        throw new AggregateError(failures, "Terminal shutdown was incomplete");
      }
    })();
    return this.shutdownPromise;
  }
}
