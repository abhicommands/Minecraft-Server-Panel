# Security Policy

Minecraft Server Panel controls Java processes and reads and writes server
files. Treat security reports carefully and never publish exploit details,
credentials, world data, session tokens, or private logs in an issue.

## Supported versions

Security fixes target the latest published release and the current default
branch. Pre-release builds may receive fixes before the next stable release.
The backend under `legacy-node-server/`, old releases, unofficial builds, and
modified deployments are not supported with security updates.

## Report a vulnerability

Use GitHub's private vulnerability-reporting form:

<https://github.com/abhicommands/Minecraft-Server-Panel/security/advisories/new>

If private vulnerability reporting is unavailable, use a private contact
method listed on the [maintainer's GitHub
profile](https://github.com/abhicommands). Do not open a public issue containing
vulnerability details. You may open a detail-free issue asking how to establish
private contact if no private channel is listed.

Include, when applicable:

- the affected release, commit, operating system, architecture, and deployment
  mode;
- the affected route, Socket.IO event, archive/upload flow, or process action;
- prerequisites and minimal reproduction steps;
- the security impact and who could exploit it;
- sanitized logs, proof-of-concept material, or a proposed fix; and
- whether the issue has been disclosed anywhere else.

Do not access data you do not own, disrupt other systems, run denial-of-service
tests, or retain sensitive information while researching an issue.

The maintainer will assess the report and coordinate a fix and disclosure when
appropriate. This volunteer project does not promise a response or remediation
deadline. Please avoid public disclosure until a fix is available or disclosure
has been coordinated.

## Operational concerns

Questions about installation, Caddy, Java compatibility, unsupported platforms,
or ordinary configuration belong in the support channels described in
[SUPPORT.md](SUPPORT.md). Lost passwords, exposed JWT secrets, and compromised
hosts require operator action; rotate secrets and secure the host rather than
posting them to the repository.
