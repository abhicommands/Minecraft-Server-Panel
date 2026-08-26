# Maintainer and release guide

This guide covers repository settings that cannot be committed as files, the
pull-request checks, release preparation, and the exact tag-driven publication
flow.

## One-time GitHub repository settings

Choose the repository's default branch (`main` is recommended; the workflows
also support the existing `master` branch). In **Settings → Rules → Rulesets**,
create an active branch ruleset targeting the default branch with:

- pull requests required before merge;
- at least one approval and dismissal of stale approvals;
- all review conversations resolved;
- force pushes and branch deletion blocked;
- linear history required if merge commits are not desired; and
- these required status checks:
  - `Frontend quality and static build`
  - `Backend darwin-arm64 native executable`
  - `Backend linux-x64 native executable`

Do not require the manual archive benchmark or tagged-release jobs for ordinary
pull requests. Enable private vulnerability reporting under **Settings →
Security → Code security** so `SECURITY.md` points to a working confidential
channel. Keep GitHub Actions' default token permissions restricted; the release
job requests its write and attestation permissions explicitly.

Useful repository metadata:

- description: `Self-hosted Minecraft server panel with a React UI and a standalone Bun backend.`
- website: the project documentation or deployment demo, when one exists;
- topics: `minecraft`, `minecraft-server`, `bun`, `react`, `sqlite`, `socket-io`, `self-hosted`.

## Pull-request lifecycle

Every pull request runs `.github/workflows/ci.yml`. The frontend is installed,
linted, audited, and built once without environment-specific URLs. The verified
static artifact is then embedded independently on macOS ARM64 and Linux x64;
each backend job typechecks, tests, audits, rejects native Node addons, builds
its native executable, verifies its checksum, and executes the standalone smoke
test. The Linux job additionally drives the interactive production installer on
the disposable hosted runner, checks its systemd service and direct-IP
configuration, and performs an authenticated HTTP session before cleanup.

Temporary Actions artifacts are evidence for that workflow run. They are not a
GitHub Release and are retained only briefly. Branch rules are what prevent a
failed check from being merged; committing a workflow file alone does not
enforce review policy.

Dependabot checks Bun dependencies in `server/` and `client/` and SHA-pinned
GitHub Actions weekly. Review and run CI on those pull requests like any other
change; dependency updates are not auto-merged.

## Prepare a release

1. Merge the intended changes through pull requests and confirm the default
   branch is green.
2. Move noteworthy entries from `Unreleased` in `CHANGELOG.md` into a versioned
   section with the release date.
3. Set the same semantic version without a leading `v` in `package.json`,
   `server/package.json`, and `client/package.json`.
4. Run the full local checks, dependency audits, and licenses:

   ```sh
   bun run check
   cd server
   bun audit
   bun pm licenses
   cd ../client
   bun audit
   bun pm licenses
   cd ..
   ```

5. For archive-sensitive changes, run `bun run benchmark:archive` locally and
   the manual **Archive benchmark** workflow. Keep comparable JSON reports.
6. Merge the release-preparation commit into the default branch.

Use pull-request labels consistently because `.github/release.yml` groups the
generated notes: `breaking-change`, `feature`/`enhancement`, `bug`/`fix`,
`dependencies`/`maintenance`, and `skip-changelog`.

## Publish from a tag

Create an annotated tag on the green default-branch commit:

```sh
git switch main
git pull --ff-only
git tag -a v3.0.0 -m "Minecraft Server Panel v3.0.0"
git push origin v3.0.0
```

Use the current default branch name if it has not been renamed to `main`.
Stable tags must be `vMAJOR.MINOR.PATCH`; prereleases may use a suffix such as
`v1.1.0-rc.1`.

`.github/workflows/release.yml` then:

1. validates the tag syntax, all three package versions, and that the tagged
   commit belongs to the default release branch;
2. builds and audits the frontend once;
3. tests and compiles macOS ARM64 and Linux x64 independently;
4. smoke-tests each standalone executable;
5. assembles self-contained installer archives and SHA-256 files;
6. creates signed GitHub artifact attestations for the archives; and
7. creates a draft GitHub Release, uploads assets, generates categorized notes,
   and publishes it only after every prior job succeeds.

The release contains two full application archives. There is no separate
frontend download because the production Vite build is embedded in each
backend executable. The workflow refuses to overwrite an existing release.

Verify a downloaded archive before installing:

```sh
shasum -a 256 -c minecraft-server-panel-v3.0.0-darwin-arm64.tar.gz.sha256
gh attestation verify minecraft-server-panel-v3.0.0-darwin-arm64.tar.gz \
  --repo abhicommands/Minecraft-Server-Panel
```

After publication, edit the generated notes when users need migration warnings,
known limitations, or a clearer overview. Do not silently replace an immutable
release asset. Fix the problem and publish a new patch version; use a prerelease
tag when the build still needs public testing.

## Platform expansion

Adding Windows, Intel macOS, Linux ARM64, or musl is more than adding a compiler
target. Add a native CI runner, compiled PTY/SQLite/Socket.IO/archive smoke test,
installer behavior, checksums/attestation, and documented support before
including a target in a release matrix.
