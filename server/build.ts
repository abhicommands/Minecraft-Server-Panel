import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const availableBuilds = [
  {
    name: "darwin-arm64",
    target: "bun-darwin-arm64" as const,
    outfile: "minecraft-server-panel-darwin-arm64",
  },
  {
    name: "linux-x64",
    target: "bun-linux-x64" as const,
    outfile: "minecraft-server-panel-linux-x64",
  },
];

const requestedTarget = process.env.PANEL_BUILD_TARGET?.trim();
const builds = requestedTarget
  ? availableBuilds.filter(
      (build) => build.name === requestedTarget || build.target === requestedTarget,
    )
  : availableBuilds;
if (!builds.length) {
  throw new Error(
    `Unknown PANEL_BUILD_TARGET '${requestedTarget}'. Use darwin-arm64 or linux-x64.`,
  );
}

const outputDirectory = path.join(import.meta.dir, "dist");
const frontendDirectory = path.join(import.meta.dir, "..", "client");
const frontendOutput = path.join(frontendDirectory, "dist");
const stagedFrontend = path.join(import.meta.dir, ".release-public");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await rm(stagedFrontend, { recursive: true, force: true });

if (process.env.PANEL_USE_EXISTING_FRONTEND_DIST !== "true") {
  console.log("Building configuration-free frontend...");
  const frontendEnvironment: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "production",
  };
  for (const name of Object.keys(frontendEnvironment)) {
    if (name.startsWith("VITE_")) delete frontendEnvironment[name];
  }
  const frontendBuild = Bun.spawn([process.execPath, "run", "build"], {
    cwd: frontendDirectory,
    env: frontendEnvironment,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await frontendBuild.exited) !== 0) {
    throw new Error("Frontend build failed. Run 'bun ci' in client/ before building a release.");
  }
} else {
  console.log("Using the verified frontend build supplied by CI...");
}
if (!(await Bun.file(path.join(frontendOutput, "index.html")).exists())) {
  throw new Error("Frontend build did not create client/dist/index.html");
}
await cp(frontendOutput, stagedFrontend, { recursive: true });

try {
  for (const build of builds) {
    console.log(`Building ${build.target}...`);
    const result = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "server.ts")],
      compile: {
        target: build.target,
        outfile: path.join(outputDirectory, build.outfile),
        assets: ["./.release-public"],
        // Deployment configuration is external TOML; never discover or embed a
        // build-machine .env file in a standalone executable.
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadPackageJson: false,
        autoloadTsconfig: false,
      },
      minify: true,
      sourcemap: "inline",
      bytecode: true,
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Failed to build ${build.target}`);
    }
    const executablePath = path.join(outputDirectory, build.outfile);
    const hasher = new Bun.CryptoHasher("sha256");
    const reader = Bun.file(executablePath).stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
    await writeFile(
      `${executablePath}.sha256`,
      `${hasher.digest("hex")}  ${build.outfile}\n`,
      "utf8",
    );
    console.log(`Created dist/${build.outfile}`);
  }
} finally {
  await rm(stagedFrontend, { recursive: true, force: true });
}

// Bun embeds compiled-executable source maps; discard its non-runtime sidecar so releases stay standalone.
await rm(path.join(outputDirectory, "server.js.map"), { force: true });
for (const fileName of await readdir(import.meta.dir)) {
  if (/^\.[a-f0-9]+-\d+\.bun-build$/.test(fileName)) {
    await rm(path.join(import.meta.dir, fileName), { force: true });
  }
}
