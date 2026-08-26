import path from "node:path";

const repositoryRoot = path.join(import.meta.dir, "..");
const projects = ["server", "client"] as const;

for (const project of projects) {
  console.log(`Installing locked ${project} dependencies with Bun...`);
  const install = Bun.spawn([process.execPath, "ci"], {
    cwd: path.join(repositoryRoot, project),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await install.exited) !== 0) {
    throw new Error(`Dependency installation failed in ${project}`);
  }
}

const backendHome = path.join(repositoryRoot, "server");
const generatedConfig = path.join(backendHome, "panel-data", "config.toml");
const environmentConfig = path.join(backendHome, ".env");
if (
  !(await Bun.file(generatedConfig).exists()) &&
  !(await Bun.file(environmentConfig).exists())
) {
  console.log("\nNo backend configuration exists yet; starting secure development setup.");
  const initialize = Bun.spawn([process.execPath, "server.ts", "init", "--development"], {
    cwd: backendHome,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await initialize.exited) !== 0) {
    throw new Error("Backend configuration initialization failed");
  }
} else {
  console.log("Backend configuration already exists; leaving it unchanged.");
}

console.log("\nSetup complete. Run 'bun run dev' from the repository root.");
