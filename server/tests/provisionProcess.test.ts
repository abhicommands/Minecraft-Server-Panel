import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTrackedForgeInstaller } from "../utils/provisionProcess.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

describe("tracked provisioning process", () => {
  test("aborts the Forge installer process group and removes its marker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "panel-forge-process-test-"));
    temporaryDirectories.push(directory);
    const instance = path.join(directory, crypto.randomUUID());
    const files = path.join(instance, "files");
    const runtime = path.join(instance, "runtime");
    const bin = path.join(directory, "bin");
    await Promise.all([
      mkdir(files, { recursive: true }),
      mkdir(runtime, { recursive: true }),
      mkdir(bin, { recursive: true }),
    ]);
    const java = path.join(bin, "java");
    await writeFile(
      java,
      "#!/bin/sh\nset -eu\necho \"$$\" > java.pid\nsleep 300 &\necho \"$!\" > child.pid\nwait $!\n",
      "utf8",
    );
    await chmod(java, 0o700);
    const installer = path.join(files, "forge-installer.jar");
    await writeFile(installer, "fixture", "utf8");
    const marker = path.join(runtime, "forge-installer.json");
    const controller = new AbortController();
    const operation = runTrackedForgeInstaller(
      installer,
      files,
      marker,
      controller.signal,
      30_000,
      { ...process.env, PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}` },
    );
    const javaPidPath = path.join(files, "java.pid");
    const childPidPath = path.join(files, "child.pid");
    await waitFor(
      async () => (await Bun.file(javaPidPath).exists()) && (await Bun.file(childPidPath).exists()),
      "Fake Forge installer did not publish process IDs",
    );
    const javaPid = Number((await readFile(javaPidPath, "utf8")).trim());
    const childPid = Number((await readFile(childPidPath, "utf8")).trim());

    controller.abort(new Error("panel shutdown"));
    await expect(operation).rejects.toThrow("panel shutdown");
    await waitFor(
      () => !processExists(javaPid) && !processExists(childPid),
      "Forge installer process group survived cancellation",
    );
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
