import path from "node:path";

const repositoryRoot = path.join(import.meta.dir, "..");
const applications = [
  {
    name: "backend",
    directory: path.join(repositoryRoot, "server"),
    configFile: path.join(repositoryRoot, "server", "panel-data", "config.toml"),
    url: "http://localhost:3001",
    command: ["--watch", "server.ts"],
  },
  {
    name: "frontend",
    directory: path.join(repositoryRoot, "client"),
    configFile: null,
    url: "http://localhost:5173",
    command: ["node_modules/vite/bin/vite.js"],
  },
] as const;

for (const application of applications) {
  if (
    application.configFile &&
    !(await Bun.file(application.configFile).exists())
  ) {
    console.error(
      "Missing backend configuration. Run 'bun run init' (or first-time 'bun run setup') first.",
    );
    process.exit(1);
  }
}

console.log("Starting Minecraft Server Panel development services:");
console.log("  mode     source-only (no binaries are built)");
for (const application of applications) {
  console.log(`  ${application.name.padEnd(8)} ${application.url}`);
}
console.log("Press Ctrl-C once to stop both services gracefully.\n");

const childEnvironment = { ...process.env, FORCE_COLOR: "1" };
delete childEnvironment.NO_COLOR;

const children = applications.map((application) => ({
  name: application.name,
  process: Bun.spawn([process.execPath, ...application.command], {
    cwd: application.directory,
    detached: true,
    env: childEnvironment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
}));

let stopping = false;
async function stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill(signal);
  }
  await Promise.all(children.map((child) => child.process.exited.catch(() => 1)));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop(signal).finally(() => process.exit(0));
  });
}

const exited = await Promise.race(
  children.map(async (child) => ({ name: child.name, code: await child.process.exited })),
);
if (!stopping) {
  console.error(`${exited.name} exited unexpectedly with code ${exited.code}; stopping the other service.`);
  await stop();
  process.exit(exited.code || 1);
}
