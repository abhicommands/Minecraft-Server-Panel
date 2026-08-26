#!/usr/bin/env bash

set -Eeuo pipefail

readonly SERVICE_NAME="minecraft-server-panel"
readonly SERVICE_USER="minecraft-panel"
readonly SYSTEM_INSTALL_DIR="/opt/minecraft-server-panel"
readonly SYSTEM_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
readonly SYSTEM_SERVICE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly CADDY_CONFIG_DIR="/etc/caddy"
readonly CADDY_MAIN_CONFIG="${CADDY_CONFIG_DIR}/Caddyfile"
readonly CADDY_PANEL_CONFIG="${CADDY_CONFIG_DIR}/conf.d/minecraft-server-panel.caddy"

archive_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_binary="${archive_dir}/minecraft-server-panel"
checksum_file="${archive_dir}/SHA256SUMS"
service_asset="${archive_dir}/install/minecraft-server-panel.service"
caddy_asset="${archive_dir}/install/Caddyfile.example"
target_file="${archive_dir}/TARGET"
mode="system"
address=""

usage() {
  cat <<'EOF'
Minecraft Server Panel release installer

Production system install (Linux x64 with systemd):
  sudo ./install.sh

Local binary test (macOS Apple Silicon or Linux x64):
  ./install.sh --local

Options:
  --system          Install or upgrade /opt/minecraft-server-panel (default).
  --local           Install for the current user without creating a service.
  --address VALUE   Preselect a DNS name or IP; credentials remain interactive.
  --domain NAME     Backward-compatible alias for --address.
  -h, --help        Show this help.

With a DNS name, the installer configures Caddy and automatic HTTPS. With an IP,
the panel listens directly over HTTP after an explicit security confirmation.
The installer never changes DNS records or firewall rules.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' was not found."
}

validate_domain() {
  local candidate="$1"
  local label
  local -a labels

  [[ ${#candidate} -le 253 ]] || return 1
  [[ "$candidate" != .* && "$candidate" != *. && "$candidate" == *.* ]] || return 1
  [[ "$candidate" =~ ^[a-z0-9.-]+$ ]] || return 1
  IFS='.' read -r -a labels <<<"$candidate"
  (( ${#labels[@]} >= 2 )) || return 1
  for label in "${labels[@]}"; do
    (( ${#label} >= 1 && ${#label} <= 63 )) || return 1
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
  label="${labels[${#labels[@]} - 1]}"
  (( ${#label} >= 2 )) && [[ "$label" =~ [a-z] ]] || return 1
  return 0
}

config_value() {
  local key="$1"
  local config_file="${SYSTEM_INSTALL_DIR}/panel-data/config.toml"
  sed -n "s/^${key} = \"\([^\"]*\)\"$/\1/p" "$config_file" | head -n 1
}

install_caddy_package() {
  local key_file list_file

  if command -v caddy >/dev/null 2>&1; then
    if systemctl cat caddy.service >/dev/null 2>&1; then
      return
    fi
    fail "A caddy command exists but caddy.service does not. Install Caddy as an official systemd package before rerunning."
  fi

  printf '\nCaddy is required for the selected DNS name; installing its official package.\n'
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      apt-transport-https ca-certificates curl debian-archive-keyring debian-keyring gnupg
    key_file="$(mktemp /tmp/minecraft-panel-caddy-key.XXXXXX)"
    list_file="$(mktemp /tmp/minecraft-panel-caddy-list.XXXXXX)"
    trap 'rm -f -- "${key_file:-}" "${list_file:-}"' EXIT
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output "$key_file" https://dl.cloudsmith.io/public/caddy/stable/gpg.key
    gpg --batch --yes --dearmor \
      --output /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$key_file"
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output "$list_file" https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt
    install -o root -g root -m 0644 "$list_file" /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
      /etc/apt/sources.list.d/caddy-stable.list
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
    rm -f -- "$key_file" "$list_file"
    trap - EXIT
  elif command -v dnf >/dev/null 2>&1; then
    dnf -y install dnf-plugins-core
    dnf -y copr enable @caddy/caddy
    dnf -y install caddy
  else
    fail "Automatic Caddy installation supports apt and dnf. Install Caddy from https://caddyserver.com/docs/install and rerun this installer."
  fi

  command -v caddy >/dev/null 2>&1 || fail "Caddy installation completed without providing the caddy command."
}

restore_caddy_files() {
  local panel_backup="$1"
  local main_backup="$2"
  local main_was_created="$3"

  if [[ -n "$panel_backup" ]]; then
    install -o root -g root -m 0644 "$panel_backup" "$CADDY_PANEL_CONFIG"
  else
    rm -f -- "$CADDY_PANEL_CONFIG"
  fi
  if [[ -n "$main_backup" ]]; then
    install -o root -g root -m 0644 "$main_backup" "$CADDY_MAIN_CONFIG"
  elif [[ "$main_was_created" == "true" ]]; then
    rm -f -- "$CADDY_MAIN_CONFIG"
  fi
}

configure_caddy() {
  local domain="$1"
  local rendered_config main_backup="" panel_backup="" main_was_created="false"
  local caddy_was_active="false"
  local caddy_was_enabled="false"

  install_caddy_package
  for command_name in caddy grep systemctl; do
    require_command "$command_name"
  done
  install -d -o root -g root -m 0755 "$CADDY_CONFIG_DIR" "${CADDY_CONFIG_DIR}/conf.d"
  rendered_config="$(mktemp "${CADDY_CONFIG_DIR}/conf.d/.minecraft-panel.XXXXXX")"
  trap 'rm -f -- "${rendered_config:-}"' EXIT
  sed "s/__PANEL_DOMAIN__/${domain}/g" "$caddy_asset" >"$rendered_config"

  if [[ -f "$CADDY_PANEL_CONFIG" ]]; then
    panel_backup="$(mktemp "${CADDY_CONFIG_DIR}/conf.d/.minecraft-panel-backup.XXXXXX")"
    install -o root -g root -m 0644 "$CADDY_PANEL_CONFIG" "$panel_backup"
  fi
  install -o root -g root -m 0644 "$rendered_config" "$CADDY_PANEL_CONFIG"
  rm -f -- "$rendered_config"

  if [[ ! -f "$CADDY_MAIN_CONFIG" ]]; then
    printf '# Managed Caddy configuration\nimport %s\n' "$CADDY_PANEL_CONFIG" >"$CADDY_MAIN_CONFIG"
    chmod 0644 "$CADDY_MAIN_CONFIG"
    main_was_created="true"
  elif ! grep -Eq '^[[:space:]]*import[[:space:]]+(/etc/caddy/)?conf\.d/(\*\.caddy|minecraft-server-panel\.caddy)[[:space:]]*$' "$CADDY_MAIN_CONFIG"; then
    main_backup="$(mktemp "${CADDY_CONFIG_DIR}/.Caddyfile.minecraft-panel-backup.XXXXXX")"
    install -o root -g root -m 0644 "$CADDY_MAIN_CONFIG" "$main_backup"
    printf '\n# BEGIN Minecraft Server Panel managed import\nimport %s\n# END Minecraft Server Panel managed import\n' \
      "$CADDY_PANEL_CONFIG" >>"$CADDY_MAIN_CONFIG"
  fi

  if ! caddy validate --config "$CADDY_MAIN_CONFIG" --adapter caddyfile; then
    restore_caddy_files "$panel_backup" "$main_backup" "$main_was_created"
    rm -f -- "$panel_backup" "$main_backup"
    fail "Caddy validation failed; the previous configuration was restored."
  fi

  if systemctl is-active --quiet caddy.service; then
    caddy_was_active="true"
  fi
  if systemctl is-enabled --quiet caddy.service; then
    caddy_was_enabled="true"
  fi
  systemctl enable caddy.service
  if [[ "$caddy_was_active" == "true" ]]; then
    if ! systemctl reload caddy.service; then
      restore_caddy_files "$panel_backup" "$main_backup" "$main_was_created"
      caddy validate --config "$CADDY_MAIN_CONFIG" --adapter caddyfile || true
      systemctl reload caddy.service || true
      if [[ "$caddy_was_enabled" != "true" ]]; then
        systemctl disable caddy.service || true
      fi
      rm -f -- "$panel_backup" "$main_backup"
      fail "Caddy reload failed; the previous configuration was restored."
    fi
  else
    if ! systemctl start caddy.service; then
      restore_caddy_files "$panel_backup" "$main_backup" "$main_was_created"
      if [[ "$caddy_was_enabled" != "true" ]]; then
        systemctl disable caddy.service || true
      fi
      rm -f -- "$panel_backup" "$main_backup"
      fail "Caddy could not start; the previous configuration was restored."
    fi
  fi
  systemctl is-active --quiet caddy.service || fail "Caddy did not become active."
  rm -f -- "$panel_backup"
  if [[ -n "$main_backup" ]]; then
    printf 'Previous Caddyfile backup retained at %s\n' "$main_backup"
  fi
  trap - EXIT
}

verify_release_files() {
  [[ -f "$source_binary" && ! -L "$source_binary" ]] ||
    fail "The canonical binary must be adjacent to install.sh as 'minecraft-server-panel'."
  [[ -f "$checksum_file" && ! -L "$checksum_file" ]] ||
    fail "SHA256SUMS is missing from the extracted release."
  [[ -f "$service_asset" && ! -L "$service_asset" ]] ||
    fail "The bundled systemd service asset is missing."
  [[ -f "$caddy_asset" && ! -L "$caddy_asset" ]] ||
    fail "The bundled Caddy asset is missing."
  [[ -f "$target_file" && ! -L "$target_file" ]] ||
    fail "The release target marker is missing."

  if command -v sha256sum >/dev/null 2>&1; then
    (cd -- "$archive_dir" && sha256sum --check SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    (cd -- "$archive_dir" && shasum -a 256 --check SHA256SUMS)
  else
    fail "Install sha256sum (Linux) or shasum (macOS) to verify this release."
  fi
}

verify_platform() {
  local system architecture detected_target release_target
  system="$(uname -s)"
  architecture="$(uname -m)"

  case "${system}:${architecture}" in
    Linux:x86_64) detected_target="linux-x64" ;;
    Darwin:arm64) detected_target="darwin-arm64" ;;
    *) fail "This release supports Linux x86_64 and macOS arm64; detected ${system} ${architecture}." ;;
  esac

  IFS= read -r release_target <"$target_file" ||
    fail "Could not read the release target marker."
  [[ "$release_target" == "$detected_target" ]] ||
    fail "This is the ${release_target} archive, but this machine requires ${detected_target}."

  if [[ "$mode" == "system" && "$detected_target" != "linux-x64" ]]; then
    fail "The systemd production installer requires Linux x86_64. Use --local to test the macOS binary."
  fi
}

install_binary_atomically() {
  local destination_dir="$1"
  local destination="${destination_dir}/minecraft-server-panel"
  local staged="${destination_dir}/.minecraft-server-panel.new"
  local quarantine_value=""

  install -m 0755 "$source_binary" "$staged"
  if [[ "$(uname -s)" == "Darwin" ]] && command -v xattr >/dev/null 2>&1; then
    if quarantine_value="$(xattr -p com.apple.quarantine "$source_binary" 2>/dev/null)"; then
      xattr -w com.apple.quarantine "$quarantine_value" "$staged"
    fi
  fi
  mv -f -- "$staged" "$destination"
}

install_local() {
  local local_install_dir
  local system
  system="$(uname -s)"

  [[ -z "$address" ]] || fail "--address is only used by the production --system install."
  if [[ "$system" == "Darwin" ]]; then
    local_install_dir="${HOME:?HOME is not set}/Library/Application Support/MinecraftServerPanel"
  else
    local_install_dir="${XDG_DATA_HOME:-${HOME:?HOME is not set}/.local/share}/minecraft-server-panel"
  fi

  [[ ! -L "$local_install_dir" ]] || fail "Refusing to install through symlink: $local_install_dir"
  [[ ! -e "${local_install_dir}/.env" && ! -L "${local_install_dir}/.env" ]] ||
    fail "Move the legacy ${local_install_dir}/.env aside before using the TOML installer."
  require_command install
  require_command java
  require_command mv
  mkdir -p -- "$local_install_dir"
  install_binary_atomically "$local_install_dir"

  printf '\nLocal binary test installed. No service, production data, or reverse proxy was changed.\n'
  printf 'Run it with:\n  cd %q && ./minecraft-server-panel --test\n' "$local_install_dir"
  printf 'The first run asks for a username and password, creates panel-test-data, and opens only on http://127.0.0.1:3001/.\n'
}

create_service_identity() {
  local existing_home existing_shell nologin_shell

  if id "$SERVICE_USER" >/dev/null 2>&1; then
    existing_home="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
    existing_shell="$(getent passwd "$SERVICE_USER" | cut -d: -f7)"
    [[ "$existing_home" == "$SYSTEM_INSTALL_DIR" ]] ||
      fail "Existing user '$SERVICE_USER' has unexpected home '$existing_home'."
    [[ "$(id -gn "$SERVICE_USER")" == "$SERVICE_USER" ]] ||
      fail "Existing user '$SERVICE_USER' must use the '$SERVICE_USER' primary group."
    [[ "$existing_shell" == */nologin || "$existing_shell" == /bin/false ]] ||
      fail "Existing user '$SERVICE_USER' must be a non-login service account."
    return
  fi

  if [[ -x /usr/sbin/nologin ]]; then
    nologin_shell="/usr/sbin/nologin"
  elif [[ -x /sbin/nologin ]]; then
    nologin_shell="/sbin/nologin"
  else
    nologin_shell="/bin/false"
  fi

  if getent group "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SERVICE_USER" --home-dir "$SYSTEM_INSTALL_DIR" \
      --shell "$nologin_shell" "$SERVICE_USER"
  else
    useradd --system --user-group --home-dir "$SYSTEM_INSTALL_DIR" \
      --shell "$nologin_shell" "$SERVICE_USER"
  fi
}

install_system() {
  local service_group
  local service_was_active="false"
  local health_response=""
  local healthy="false"
  local created_configuration="false"
  local data_owner=""
  local config_owner=""
  local deployment_mode=""
  local public_address=""
  local listen_host=""
  local health_host="127.0.0.1"
  local public_url=""

  (( EUID == 0 )) || fail "The production system install must run as root (use sudo)."

  for command_name in chmod chown curl cut getent head id install java mkdir mktemp mv runuser sed sleep stat systemctl systemd-analyze useradd; do
    require_command "$command_name"
  done
  PATH="$SYSTEM_SERVICE_PATH" command -v java >/dev/null 2>&1 ||
    fail "Java must be installed in the system service PATH: $SYSTEM_SERVICE_PATH"
  [[ -d /run/systemd/system ]] || fail "systemd is not running on this machine."
  [[ ! -L "$SYSTEM_INSTALL_DIR" ]] || fail "Refusing to install through symlink: $SYSTEM_INSTALL_DIR"
  [[ ! -e "${SYSTEM_INSTALL_DIR}/.env" && ! -L "${SYSTEM_INSTALL_DIR}/.env" ]] ||
    fail "Move the legacy ${SYSTEM_INSTALL_DIR}/.env aside before using the TOML installer."
  [[ ! -L "${SYSTEM_INSTALL_DIR}/panel-data" ]] ||
    fail "Refusing to use symlinked data directory: ${SYSTEM_INSTALL_DIR}/panel-data"
  [[ ! -L "${SYSTEM_INSTALL_DIR}/panel-data/config.toml" ]] ||
    fail "Refusing to use symlinked configuration: ${SYSTEM_INSTALL_DIR}/panel-data/config.toml"
  [[ ! -L "$SYSTEM_UNIT_PATH" ]] || fail "Refusing to replace symlink: $SYSTEM_UNIT_PATH"

  install -d -o root -g root -m 0755 "$SYSTEM_INSTALL_DIR"

  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    service_was_active="true"
  fi

  install_binary_atomically "$SYSTEM_INSTALL_DIR"
  if [[ ! -f "${SYSTEM_INSTALL_DIR}/panel-data/config.toml" ]]; then
    [[ -t 0 && -t 1 ]] || fail "First-time production setup requires an interactive terminal."
    if [[ -n "$address" ]]; then
      (cd -- "$SYSTEM_INSTALL_DIR" && PANEL_SETUP_ADDRESS="$address" ./minecraft-server-panel init)
    else
      (cd -- "$SYSTEM_INSTALL_DIR" && ./minecraft-server-panel init)
    fi
    created_configuration="true"
  else
    printf 'Preserving existing configuration and data in %s/panel-data.\n' "$SYSTEM_INSTALL_DIR"
  fi

  deployment_mode="$(config_value deployment_mode)"
  public_address="$(config_value public_address)"
  listen_host="$(config_value listen_host)"
  [[ "$deployment_mode" == "https" || "$deployment_mode" == "direct-http" ]] ||
    fail "The installed config must declare deployment_mode as https or direct-http."
  [[ -n "$public_address" ]] || fail "The installed config does not contain public_address."
  if [[ -n "$address" && "$address" != "$public_address" ]]; then
    fail "--address does not rewrite an existing deployment. Update config.toml deliberately or omit the option."
  fi
  if [[ "$deployment_mode" == "https" ]]; then
    validate_domain "$public_address" || fail "The configured HTTPS address is not a valid public DNS name."
    [[ "$listen_host" == "127.0.0.1" ]] || fail "HTTPS mode must bind the Bun application to 127.0.0.1."
    public_url="https://${public_address}"
  else
    [[ "$listen_host" == "0.0.0.0" || "$listen_host" == "::" ]] ||
      fail "Direct HTTP mode must bind to 0.0.0.0 or ::."
    if [[ "$listen_host" == "::" ]]; then
      health_host="[::1]"
      public_url="http://[${public_address}]:3001"
    else
      public_url="http://${public_address}:3001"
    fi
  fi

  create_service_identity
  service_group="$(id -gn "$SERVICE_USER")"
  if [[ "$created_configuration" == "true" ]]; then
    chown -R --no-dereference "${SERVICE_USER}:${service_group}" "${SYSTEM_INSTALL_DIR}/panel-data"
  else
    data_owner="$(stat -c '%U:%G' "${SYSTEM_INSTALL_DIR}/panel-data")"
    config_owner="$(stat -c '%U:%G' "${SYSTEM_INSTALL_DIR}/panel-data/config.toml")"
    [[ "$data_owner" == "${SERVICE_USER}:${service_group}" &&
      "$config_owner" == "${SERVICE_USER}:${service_group}" ]] ||
      fail "Existing panel-data must be owned by ${SERVICE_USER}:${service_group}; refusing a recursive ownership rewrite."
  fi
  chmod 0700 "${SYSTEM_INSTALL_DIR}/panel-data"
  chmod 0600 "${SYSTEM_INSTALL_DIR}/panel-data/config.toml"
  (cd -- "$SYSTEM_INSTALL_DIR" && runuser -u "$SERVICE_USER" -- ./minecraft-server-panel doctor)

  install -o root -g root -m 0644 "$service_asset" "$SYSTEM_UNIT_PATH"
  systemd-analyze verify "$SYSTEM_UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service"
  if [[ "$service_was_active" == "true" ]]; then
    systemctl restart "${SERVICE_NAME}.service"
  else
    systemctl start "${SERVICE_NAME}.service"
  fi
  if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
    fail "The service did not become active."
  fi
  for _ in {1..30}; do
    if health_response="$(curl --fail --silent --show-error --max-time 2 \
      --noproxy '*' "http://${health_host}:3001/api/health" 2>/dev/null)" &&
      [[ "$health_response" == '{"status":"ok"}' ]]; then
      healthy="true"
      break
    fi
    sleep 1
  done
  if [[ "$healthy" != "true" ]]; then
    systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
    fail "The service did not pass GET /api/health within 30 seconds."
  fi

  if [[ "$deployment_mode" == "https" ]]; then
    configure_caddy "$public_address"
  fi

  printf '\nProduction panel installed successfully.\n'
  printf 'Mutable state: %s/panel-data\n' "$SYSTEM_INSTALL_DIR"
  printf 'Open: %s\n' "$public_url"
  if [[ "$deployment_mode" == "https" ]]; then
    printf 'Caddy is active with automatic HTTPS. DNS must point here and ports 80/443 must be reachable.\n'
  else
    printf 'Caddy was not installed because this IP deployment uses direct HTTP on port 3001.\n'
    printf 'WARNING: traffic is unencrypted. Restrict port 3001 with your firewall or a VPN whenever possible.\n'
  fi

  if [[ "$service_was_active" == "true" ]]; then
    printf 'The existing service was restarted with the new executable.\n'
  fi
}

while (( $# > 0 )); do
  case "$1" in
    --system) mode="system" ;;
    --local) mode="local" ;;
    --address|--domain)
      (( $# >= 2 )) || fail "$1 requires a value."
      address="${2,,}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "Unknown argument '$1'. Run ./install.sh --help." ;;
  esac
  shift
done

verify_release_files
verify_platform

if [[ "$mode" == "local" ]]; then
  install_local
else
  install_system
fi
