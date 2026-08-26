import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server as SocketIOServer } from "socket.io";
import type { ServerRecord } from "../types.ts";
import { newServerLayout } from "../utils/serverLayout.ts";
import { TerminalManager } from "../utils/terminal.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminalFixture(script: string): Promise<{
  directory: string;
  layout: ReturnType<typeof newServerLayout>;
  manager: TerminalManager;
  record: ServerRecord;
  disconnected: () => boolean;
  restartManager: () => TerminalManager;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "panel-terminal-manager-test-"));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const serversDirectory = path.join(directory, "servers");
  const record: ServerRecord = {
    id: 1,
    uuid: crypto.randomUUID(),
    name: "Lifecycle fixture",
    startupCommand: "java -Xmx1G -Xms1G -jar server.jar nogui",
    startupFlags: "",
    version: "fixture",
    port: 25565,
    serverType: "vanilla",
  };
  const layout = newServerLayout(serversDirectory, record.uuid);
  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    mkdir(layout.files, { recursive: true }),
  ]);
  const javaPath = path.join(binDirectory, "java");
  await writeFile(javaPath, `#!/bin/sh\nset -eu\n${script}\n`, "utf8");
  await chmod(javaPath, 0o700);
  let wasDisconnected = false;
  const io = {
    to: () => ({ emit: () => {} }),
    in: () => ({
      disconnectSockets: () => {
        wasDisconnected = true;
      },
    }),
  } as unknown as SocketIOServer;
  const childEnvironment = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH || "/usr/bin:/bin"}`,
  };
  const restartManager = (): TerminalManager =>
    new TerminalManager(io, serversDirectory, childEnvironment);
  const manager = restartManager();
  return {
    directory,
    layout,
    manager,
    record,
    disconnected: () => wasDisconnected,
    restartManager,
  };
}

describe("Bun.Terminal", () => {
  test("streams process input, output, and exit without node-pty", async () => {
    let output = "";
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data: (_terminal, bytes) => {
        output += decoder.decode(bytes, { stream: true });
      },
    });
    const subprocess = Bun.spawn(
      ["/bin/sh", "-c", "printf 'pty-ready\\n'; IFS= read -r line; printf 'received:%s\\n' \"$line\""],
      { terminal },
    );

    const waitForOutput = async (expected: string): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (output.includes(expected)) return;
        await Bun.sleep(5);
      }
      throw new Error(`Timed out waiting for PTY output: ${expected}`);
    };
    await waitForOutput("pty-ready");
    terminal.write("hello-from-terminal\n");
    expect(await subprocess.exited).toBe(0);
    await waitForOutput("received:hello-from-terminal");
    output += decoder.decode();
    if (!terminal.closed) terminal.close();

    expect(output).toContain("pty-ready");
    expect(output).toContain("received:hello-from-terminal");
  });
});

describe("TerminalManager lifecycle", () => {
  test("serializes stopped-only installation work against Java startup", async () => {
    const fixture = await terminalFixture(`
sleep 300 &
wait $!`);
    let releaseInstallation = (): void => {};
    let markEntered = (): void => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const installationGate = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    const installation = fixture.manager.withStopped(fixture.record, async () => {
      markEntered();
      await installationGate;
    });
    await entered;

    let startSettled = false;
    const start = fixture.manager.start(fixture.record).finally(() => {
      startSettled = true;
    });
    await Bun.sleep(50);
    expect(startSettled).toBe(false);

    releaseInstallation();
    await Promise.all([installation, start]);
    expect(await fixture.manager.isRunning(fixture.record)).toBe(true);
    await fixture.manager.kill(fixture.record);
  });

  test("kills the complete process group before deleting files and disconnects the server room", async () => {
    const fixture = await terminalFixture(`
echo "$$" > java.pid
sleep 300 &
child_pid=$!
echo "$child_pid" > child.pid
echo "fake-java-ready"
wait "$child_pid"`);
    await fixture.manager.start(fixture.record);
    const javaPidPath = path.join(fixture.layout.files, "java.pid");
    const childPidPath = path.join(fixture.layout.files, "child.pid");
    await waitFor(
      async () => {
        const [javaReady, childReady] = await Promise.all([
          Bun.file(javaPidPath).exists(),
          Bun.file(childPidPath).exists(),
        ]);
        return javaReady && childReady;
      },
      "Fake Java process did not publish its PIDs",
    );
    const javaPid = Number((await readFile(javaPidPath, "utf8")).trim());
    const childPid = Number((await readFile(childPidPath, "utf8")).trim());

    await fixture.manager.remove(fixture.record, () =>
      rm(fixture.layout.instance, { recursive: true, force: true }),
    );
    await waitFor(
      () => !processExists(javaPid) && !processExists(childPid),
      "The Java process group survived server deletion",
    );
    await Bun.sleep(50);

    expect(fixture.disconnected()).toBe(true);
    expect(await Bun.file(fixture.layout.instance).exists()).toBe(false);
    await expect(fixture.manager.start(fixture.record)).rejects.toThrow("Server no longer exists");
  });

  test("cleans unexpected exits, recreates missing logs, and permits a clean restart", async () => {
    const fixture = await terminalFixture(`
echo "fake-java-ready"
if [ -f exit-now ]; then
  sleep 0.1
  exit 7
fi
sleep 300 &
wait $!`);
    await writeFile(path.join(fixture.layout.files, "exit-now"), "1");
    await fixture.manager.start(fixture.record);
    await waitFor(
      async () => !(await fixture.manager.isRunning(fixture.record)),
      "Unexpected Java exit was not finalized",
    );
    expect(await readFile(path.join(fixture.layout.logs, "console.log"), "utf8")).toContain(
      "Server process exited with code 7",
    );

    await Promise.all([
      rm(path.join(fixture.layout.files, "exit-now"), { force: true }),
      rm(fixture.layout.logs, { recursive: true, force: true }),
    ]);
    await fixture.manager.start(fixture.record);
    expect(await fixture.manager.isRunning(fixture.record)).toBe(true);
    await fixture.manager.kill(fixture.record);
    expect(await fixture.manager.isRunning(fixture.record)).toBe(false);
    expect(await Bun.file(path.join(fixture.layout.logs, "console.log")).exists()).toBe(true);
  });

  test("kills Java without recreating an instance removed outside the panel", async () => {
    const fixture = await terminalFixture(`
echo "$$" > java.pid
while true; do
  echo "fake-java-output"
  sleep 0.05
done`);
    await fixture.manager.start(fixture.record);
    const javaPidPath = path.join(fixture.layout.files, "java.pid");
    await waitFor(
      () => Bun.file(javaPidPath).exists(),
      "Fake Java process did not publish its PID",
    );
    const javaPid = Number((await readFile(javaPidPath, "utf8")).trim());

    await rm(fixture.layout.instance, { recursive: true, force: true });
    await waitFor(
      () => !processExists(javaPid),
      "Java survived external removal of its instance directory",
    );
    await Bun.sleep(100);

    expect(await Bun.file(fixture.layout.instance).exists()).toBe(false);
    await fixture.manager.shutdown(100);
  });

  test("reattaches a uniquely identified orphan even when stored startup flags changed", async () => {
    const fixture = await terminalFixture(`
echo "$$" > java.pid
sleep 300 &
wait $!`);
    await fixture.manager.start(fixture.record);
    const javaPidPath = path.join(fixture.layout.files, "java.pid");
    await waitFor(
      () => Bun.file(javaPidPath).exists(),
      "Fake Java process did not publish its PID",
    );
    const javaPid = Number((await readFile(javaPidPath, "utf8")).trim());
    const restartedManager = fixture.restartManager();
    const updatedRecord = { ...fixture.record, startupFlags: "-Dpanel.test.changed=true" };

    await restartedManager.initialize(updatedRecord);
    expect(await restartedManager.isRunning(updatedRecord)).toBe(true);
    await restartedManager.kill(updatedRecord);
    await waitFor(() => !processExists(javaPid), "Verified orphan survived force kill");
    expect(await restartedManager.isRunning(updatedRecord)).toBe(false);
    await fixture.manager.shutdown(100);
  });

  test("recovers a process spawned before its durable PID marker was committed", async () => {
    const fixture = await terminalFixture(`
echo "$$" > java.pid
sleep 300 &
wait $!`);
    await fixture.manager.start(fixture.record);
    const markerPath = path.join(fixture.layout.runtime, "process.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    const javaPidPath = path.join(fixture.layout.files, "java.pid");
    await waitFor(() => Bun.file(javaPidPath).exists(), "Fake Java process did not publish its PID");
    const javaPid = Number((await readFile(javaPidPath, "utf8")).trim());
    await writeFile(markerPath, JSON.stringify({ ...marker, pid: 0, phase: "starting" }), "utf8");

    const restartedManager = fixture.restartManager();
    await restartedManager.initialize(fixture.record);
    expect(await restartedManager.isRunning(fixture.record)).toBe(true);
    await restartedManager.kill(fixture.record);
    await waitFor(() => !processExists(javaPid), "Recovered launch survived force kill");
    expect(await restartedManager.isRunning(fixture.record)).toBe(false);
    await fixture.manager.shutdown(100);
  });

  test("quarantines a live PID when its marker lacks a verifiable process identity", async () => {
    const fixture = await terminalFixture("exit 0");
    await mkdir(fixture.layout.runtime, { recursive: true });
    await writeFile(
      path.join(fixture.layout.runtime, "process.json"),
      JSON.stringify({
        pid: process.pid,
        serverId: fixture.record.uuid,
        command: ["java", "-Xmx1G", "-Xms1G", "-jar", "server.jar", "nogui"],
        startedAt: new Date().toISOString(),
        processGroup: true,
      }),
      "utf8",
    );
    let finalized = false;

    await expect(fixture.manager.initialize(fixture.record)).rejects.toThrow(
      "cannot be verified safely",
    );
    await expect(
      fixture.manager.remove(fixture.record, () => {
        finalized = true;
      }),
    ).rejects.toThrow("cannot be verified safely");

    expect(finalized).toBe(false);
    expect(processExists(process.pid)).toBe(true);
  });

  test("kills a spawned process when durable marker creation fails", async () => {
    const fixture = await terminalFixture(`
sleep 300 &
wait $!`);
    await fixture.manager.initialize(fixture.record);
    await chmod(fixture.layout.runtime, 0o500);
    try {
      await expect(fixture.manager.start(fixture.record)).rejects.toThrow();
    } finally {
      await chmod(fixture.layout.runtime, 0o700);
    }
    expect(await fixture.manager.isRunning(fixture.record)).toBe(false);
    await fixture.manager.start(fixture.record);
    expect(await fixture.manager.isRunning(fixture.record)).toBe(true);
    await fixture.manager.kill(fixture.record);
    expect(await fixture.manager.isRunning(fixture.record)).toBe(false);
  }, 15_000);
});
