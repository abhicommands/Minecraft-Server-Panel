# Release installation

Each release archive contains one self-contained backend executable with the
production frontend embedded. Java remains an external runtime requirement for
Minecraft servers. Bun, Node, npm, and `node_modules` are not needed on the
deployment machine. The archive also includes the project's MIT `LICENSE` and
covers it with the internal checksum manifest.

## Production Linux install

Requirements: glibc Linux x86_64, systemd, Java, root access, and either a
public DNS name or an IP address. DNS deployments also require outbound package
and ACME access plus inbound ports 80/443. Automatic Caddy installation supports
apt-based Debian/Ubuntu systems and dnf-based Fedora/RHEL-family systems; an
already installed Caddy also works on other systemd distributions.

Before extraction, compare the archive with the adjacent checksum published by
the GitHub Release (use `sha256sum -c <archive>.sha256` on Linux or
`shasum -a 256 -c <archive>.sha256` on macOS). The installer then verifies the
individual extracted files against the archive's `SHA256SUMS`.

From the extracted release directory:

```sh
sudo ./install.sh
```

On a fresh install, the executable asks for the administrator username (default
`admin`), asks for the login password twice, and asks for a DNS name or IP
address. It stores only the password's bcrypt hash and generates the JWT secret
itself. An upgrade preserves the existing `panel-data` directory and does not
reset credentials.
The executable reads application configuration only from the generated TOML;
shell and service environment values cannot silently replace its credentials.
Upgrades verify the data owner instead of recursively rewriting ownership across
large server trees.

The installer verifies every file against `SHA256SUMS`, creates a locked service
account, installs the executable in `/opt/minecraft-server-panel`, installs and
starts `minecraft-server-panel.service`, and writes:

```text
/opt/minecraft-server-panel/
├── minecraft-server-panel
└── panel-data/
    ├── config.toml
    ├── database/panel.sqlite3
    └── servers/
```

The service reads its validated deployment mode from `config.toml`; the unit
does not override it. Its systemd sandbox grants writes only to `panel-data`.

## DNS name: automatic HTTPS

When the supplied address is a DNS name, Bun binds only to `127.0.0.1:3001` and
uses secure session cookies. The installer:

- installs Caddy from its official package source when apt or dnf is available;
- writes `/etc/caddy/conf.d/minecraft-server-panel.caddy`;
- adds one managed import to `/etc/caddy/Caddyfile` only when an equivalent
  import is not already present;
- validates the complete Caddyfile and restores the prior files on failure; and
- enables and starts/reloads `caddy.service` only after validation succeeds.

If the main Caddyfile is changed successfully, its timestamped backup is kept in
`/etc/caddy/`. Existing non-panel sites are not replaced. Point the domain's
A/AAAA records at this host and make ports 80 and 443 reachable before expecting
certificate issuance. Caddy automatically obtains and renews the certificate.
The installer cannot change DNS-provider or upstream-router settings.

The package commands follow Caddy's [official installation
guide](https://caddyserver.com/docs/install), and certificate behavior follows
its [automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https).

## IP address: direct HTTP

When the supplied address is IPv4 or IPv6, the installer explains that HTTP does
not encrypt login credentials, cookies, or panel traffic and requires an
explicit confirmation. It then binds Bun to all matching interfaces on port
3001 and does not install Caddy. Open `http://IP:3001` (use brackets around an
IPv6 address).

This is a functional domain-free production option, but it is not confidential.
Prefer restricting port 3001 to a trusted LAN/VPN or adding TLS later. The
installer deliberately does not make firewall changes because host firewall and
cloud security-group policies are deployment-specific.

Useful service commands:

```sh
sudo systemctl status minecraft-server-panel
sudo journalctl -u minecraft-server-panel -f
sudo systemctl restart minecraft-server-panel
```

## Local binary test

For a non-service test on macOS Apple Silicon or Linux x64:

```sh
./install.sh --local
```

Local mode installs into the current user's application-data directory and
prints one start command:

```sh
./minecraft-server-panel --test
```

The first run asks for a username/password and creates `panel-test-data` on
loopback. It does not touch production `panel-data`, use sudo/systemd, or install
a reverse proxy. Running `./minecraft-server-panel` without the flag is the
production first-run wizard and production server.

The macOS executable is currently unsigned and unnotarized. Review and verify the
download before making any explicit Gatekeeper exception; the installer never
removes quarantine attributes for you.
