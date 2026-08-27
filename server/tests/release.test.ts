import { describe, expect, test } from "bun:test";
import path from "node:path";

const releaseDirectory = path.join(import.meta.dir, "..", "release");

describe("release operator assets", () => {
  test("installer is valid Bash and documents the automatic deployment choices", async () => {
    const installer = path.join(releaseDirectory, "install.sh");
    const systemSmoke = path.join(import.meta.dir, "system-installer-smoke.sh");
    for (const script of [installer, systemSmoke]) {
      const syntax = Bun.spawn(["bash", "-n", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [syntaxError, syntaxExit] = await Promise.all([
        new Response(syntax.stderr).text(),
        syntax.exited,
      ]);
      expect(syntaxExit, `${script}: ${syntaxError}`).toBe(0);
    }

    const help = Bun.spawn(["bash", installer, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [helpOutput, helpError, helpExit] = await Promise.all([
      new Response(help.stdout).text(),
      new Response(help.stderr).text(),
      help.exited,
    ]);
    expect(helpExit, helpError).toBe(0);
    expect(helpOutput).toContain("sudo ./install.sh");
    expect(helpOutput).toContain("DNS name");
    expect(helpOutput).toContain("IP");
    expect(helpOutput).toContain("automatic HTTPS");

    const installerSource = await Bun.file(installer).text();
    expect(installerSource).toContain('init --address "$address"');
    expect(installerSource).not.toContain("PANEL_SETUP_ADDRESS");
  });

  test("systemd leaves deployment mode to validated config and starts the default binary", async () => {
    const service = await Bun.file(
      path.join(releaseDirectory, "minecraft-server-panel.service"),
    ).text();
    expect(service).toContain("ExecStart=/opt/minecraft-server-panel/minecraft-server-panel\n");
    expect(service).not.toContain("Environment=PANEL_HOST");
    expect(service).not.toContain("Environment=SECURE_STATUS");
    expect(service).not.toContain("Environment=NODE_ENV");
  });

  test("Caddy template proxies the full same-origin application", async () => {
    const caddyfile = await Bun.file(path.join(releaseDirectory, "Caddyfile.example")).text();
    expect(caddyfile).toContain("__PANEL_DOMAIN__");
    expect(caddyfile).toContain("reverse_proxy 127.0.0.1:3001");
    expect(caddyfile).not.toContain("handle_path /api");
  });

  test("release archives include the project license and use supported ARM64 macOS runners", async () => {
    const repositoryRoot = path.join(import.meta.dir, "..", "..");
    const releaseWorkflow = await Bun.file(
      path.join(repositoryRoot, ".github", "workflows", "release.yml"),
    ).text();
    const continuousIntegration = await Bun.file(
      path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    ).text();
    const buildSource = await Bun.file(path.join(repositoryRoot, "server", "build.ts")).text();

    expect(releaseWorkflow).toContain("os: macos-15");
    expect(continuousIntegration).toContain("os: macos-15");
    expect(releaseWorkflow).not.toContain("macos-14");
    expect(continuousIntegration).not.toContain("macos-14");
    expect(buildSource).toContain("autoloadDotenv: false");
    expect(releaseWorkflow).toContain('cp ../LICENSE "$release_root/LICENSE"');
    expect(releaseWorkflow).toContain('grep -F -x -q "${release_name}/LICENSE"');
  });
});
