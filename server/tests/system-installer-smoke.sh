#!/usr/bin/env bash

set -Eeuo pipefail

readonly SERVICE_NAME="minecraft-server-panel"
readonly SERVICE_USER="minecraft-panel"
readonly SYSTEM_INSTALL_DIR="/opt/minecraft-server-panel"

fail() {
  printf 'Installer smoke test failed: %s\n' "$*" >&2
  exit 1
}

[[ "${GITHUB_ACTIONS:-}" == "true" && "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]] ||
  fail "This destructive system-install smoke test may run only on a disposable GitHub-hosted runner."
[[ "$(uname -s):$(uname -m)" == "Linux:x86_64" ]] ||
  fail "The production installer smoke test requires Linux x86_64."
(( $# == 1 )) || fail "Usage: bash tests/system-installer-smoke.sh dist/minecraft-server-panel-linux-x64"

source_binary="$(realpath "$1")"
[[ -f "$source_binary" ]] || fail "Compiled Linux executable not found: $source_binary"
[[ ! -e "$SYSTEM_INSTALL_DIR" ]] || fail "$SYSTEM_INSTALL_DIR unexpectedly exists on the clean runner."
if id "$SERVICE_USER" >/dev/null 2>&1; then
  fail "Service account $SERVICE_USER unexpectedly exists on the clean runner."
fi

release_fixture="$(mktemp -d /tmp/minecraft-panel-installer-smoke.XXXXXX)"
headers_file=""
cookie_file=""
cleanup() {
  sudo systemctl stop "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  sudo systemctl disable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  sudo rm -f -- "/etc/systemd/system/${SERVICE_NAME}.service"
  sudo systemctl daemon-reload >/dev/null 2>&1 || true
  sudo userdel "$SERVICE_USER" >/dev/null 2>&1 || true
  sudo rm -rf -- "$SYSTEM_INSTALL_DIR"
  rm -f -- "$headers_file" "$cookie_file"
  rm -rf -- "$release_fixture"
}
trap cleanup EXIT

mkdir -p "$release_fixture/install"
cp "$source_binary" "$release_fixture/minecraft-server-panel"
cp release/install.sh "$release_fixture/install.sh"
cp release/README.md "$release_fixture/install/README.md"
cp release/Caddyfile.example "$release_fixture/install/Caddyfile.example"
cp release/minecraft-server-panel.service "$release_fixture/install/minecraft-server-panel.service"
printf 'linux-x64\n' >"$release_fixture/TARGET"
chmod 0755 "$release_fixture/minecraft-server-panel" "$release_fixture/install.sh"
(
  cd "$release_fixture"
  sha256sum \
    minecraft-server-panel \
    TARGET \
    install.sh \
    install/README.md \
    install/Caddyfile.example \
    install/minecraft-server-panel.service \
    >SHA256SUMS
)

INSTALLER_PATH="$release_fixture/install.sh" expect <<'EOF'
set timeout 90
spawn -noecho sudo -- $env(INSTALLER_PATH) --address 127.0.0.1
expect -exact {Administrator username [admin]: }
send -- "ciadmin\r"
expect -exact {Password: }
send -- "ci-test-password\r"
expect -exact {Confirm password: }
send -- "ci-test-password\r"
expect -exact {Expose the panel at http://127.0.0.1:3001 anyway? [y/N]: }
send -- "yes\r"
expect -exact {Production panel installed successfully.}
expect eof
catch wait result
set code [lindex $result 3]
if {$code eq ""} { set code 0 }
exit $code
EOF

sudo systemctl is-active --quiet "${SERVICE_NAME}.service" || fail "Installed service is not active."
[[ "$(sudo sed -n 's/^deployment_mode = "\([^"]*\)"$/\1/p' "${SYSTEM_INSTALL_DIR}/panel-data/config.toml")" == "direct-http" ]] ||
  fail "Installer did not persist direct-http mode."
[[ "$(sudo sed -n 's/^listen_host = "\([^"]*\)"$/\1/p' "${SYSTEM_INSTALL_DIR}/panel-data/config.toml")" == "0.0.0.0" ]] ||
  fail "Installer did not persist the public IPv4 bind."

health="$(curl --fail --silent --show-error --noproxy '*' http://127.0.0.1:3001/api/health)"
[[ "$health" == '{"status":"ok"}' ]] || fail "Unexpected health response: $health"
headers_file="$(mktemp /tmp/minecraft-panel-login-headers.XXXXXX)"
cookie_file="$(mktemp /tmp/minecraft-panel-login-cookie.XXXXXX)"
login_response="$(curl --fail --silent --show-error --noproxy '*' \
  --dump-header "$headers_file" \
  --cookie-jar "$cookie_file" \
  --header 'content-type: application/json' \
  --data '{"username":"ciadmin","password":"ci-test-password"}' \
  http://127.0.0.1:3001/api/login)"
[[ "$login_response" == '{"message":"Login successful"}' ]] || fail "Unexpected login response."
grep -qi '^set-cookie: token=' "$headers_file" || fail "Login did not set a token cookie."
if grep -qi '^set-cookie:.*;[[:space:]]*secure' "$headers_file"; then
  fail "Direct HTTP mode incorrectly emitted a Secure cookie."
fi
session_response="$(curl --fail --silent --show-error --noproxy '*' \
  --cookie "$cookie_file" http://127.0.0.1:3001/api/validate-session)"
[[ "$session_response" == '{"message":"Valid session"}' ]] || fail "Session validation failed."
rm -f -- "$headers_file" "$cookie_file"

printf 'Production installer smoke test passed.\n'
