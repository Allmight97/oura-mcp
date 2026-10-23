#!/usr/bin/env bash
set -euo pipefail

if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "Run this in a terminal: it asks for secrets that must be typed by a person, not passed in by a program." >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
docker=$(command -v docker || echo /usr/local/bin/docker)
bold=$'\e[1m' dim=$'\e[2m' green=$'\e[32m' yellow=$'\e[33m' reset=$'\e[0m'

step() { printf '\n%sStep %s · %s%s\n' "$bold" "$1" "$2" "$reset"; }
say() { printf '  %s\n' "$@"; }
note() { printf '  %s%s%s\n' "$dim" "$*" "$reset"; }
warn() { printf '  %s%s%s\n' "$yellow" "$*" "$reset"; }
ok() { printf '  %s✓ %s%s\n' "$green" "$*" "$reset"; }
ask() { local reply; read -r -p "  $2${3:+ [$3]}: " reply </dev/tty; printf -v "$1" '%s' "${reply:-${3:-}}"; }
ask_secret() { local reply; read -r -s -p "  $2 (hidden): " reply </dev/tty; echo; printf -v "$1" '%s' "$reply"; }
confirm() { local reply; read -r -p "  $1 [$2]: " reply </dev/tty; [[ ${reply:-$2} =~ ^[Yy] ]]; }
env_value() { sed -n "s/^$2=//p" "$1" | tail -1; }
https_status() { curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$1/healthz" || true; }

label="" target="" port="" host="" reuse=""
"$docker" info >/dev/null 2>&1 || { echo "Docker is not reachable. Run this with sudo on the Docker host." >&2; exit 1; }

step "1/6" "What this does"
say "Creates a separate server for one person's Oura account, in its own folder," \
  "with its own storage, port and secrets. Nothing is shared with other owners" \
  "unless you choose to reuse an existing Oura app below."
note "Stored in the new folder's .env and Docker volume: the Oura app secret, the"
note "person's Oura access, and connection keys. This computer's administrators can"
note "read them. Health data goes only to Oura and to the agents the person connects."
note "Secrets you type here are hidden and never printed."
confirm "Continue?" "Y" || exit 0

step "2/6" "Where it runs"
ask label "Short name for this person (letters and digits, e.g. kb)" ""
[[ $label =~ ^[a-z0-9]+$ ]] || { warn "Use lowercase letters and digits only."; exit 2; }
ask target "Folder for the new server" "$(dirname "$root")/oura-$label"
ask port "Local port" "8788"
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  warn "Port $port is already in use. Run again with another port."; exit 1
fi
ask host "Public HTTPS hostname for this person (e.g. oura-$label.example.com)" ""
redirect="https://$host/oauth/oura/callback"
case $(https_status "$host") in
  502 | 503 | 504) ok "https://$host reaches this host and nothing answers yet, as expected." ;;
  000) warn "https://$host is not reachable. Add a reverse-proxy rule: https://$host -> http://127.0.0.1:$port"
    confirm "Continue anyway?" "N" || exit 1 ;;
  *) warn "Something already answers at https://$host. Its proxy must point to http://127.0.0.1:$port."
    confirm "Continue anyway?" "N" || exit 1 ;;
esac

step "3/6" "Oura app"
say "Oura needs an app registration (client ID and secret) for this server." \
  "Personal API keys no longer exist; the person approves access at Oura instead."
ask reuse "Reuse the Oura app of an existing install? Path to its .env, or Enter to skip" ""
if [ -n "$reuse" ]; then
  OURA_CLIENT_ID=$(env_value "$reuse" OURA_CLIENT_ID)
  OURA_CLIENT_SECRET=$(env_value "$reuse" OURA_CLIENT_SECRET)
  [ -n "$OURA_CLIENT_ID" ] && [ -n "$OURA_CLIENT_SECRET" ] || { warn "No Oura app found in $reuse."; exit 1; }
  note "This person's access will depend on that app's owner keeping the app."
  say "In that app at https://developer.ouraring.com, add this Redirect URI:" "  $redirect"
else
  say "1. Sign in at https://developer.ouraring.com with the person's Oura account." \
    "2. Create New. Redirect URI: $redirect" \
    "3. Tick every scope, accept the API agreement, save."
fi
confirm "Is $redirect listed on the app?" "N" || { warn "Add it, then run this again."; exit 1; }
if [ -z "$reuse" ]; then
  ask OURA_CLIENT_ID "Client ID" ""
  ask_secret OURA_CLIENT_SECRET "Client Secret"
fi

step "4/6" "ChatGPT (optional)"
if confirm "Connect ChatGPT through the person's own OpenAI Secure MCP Tunnel?" "Y"; then
  say "Create a tunnel and a runtime key in the person's OpenAI Platform account:" \
    "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels"
  ask OPENAI_TUNNEL_ID "Tunnel ID" ""
  ask_secret CONTROL_PLANE_API_KEY "Runtime key"
else
  OPENAI_TUNNEL_ID="" CONTROL_PLANE_API_KEY=""
fi

step "5/6" "Start the server"
MCP_PUBLIC_HOSTNAME=$host OURA_CLIENT_ID=$OURA_CLIENT_ID OURA_CLIENT_SECRET=$OURA_CLIENT_SECRET \
  OPENAI_TUNNEL_ID=$OPENAI_TUNNEL_ID CONTROL_PLANE_API_KEY=$CONTROL_PLANE_API_KEY \
  "$root/scripts/new-owner.sh" "$target" "$port" | sed 's/^/  /'
files=(-f compose.yaml)
[ -n "$OPENAI_TUNNEL_ID" ] && files+=(-f compose.openai.yaml)
(cd "$target" && "$docker" compose "${files[@]}" up -d --pull always 2>&1 | sed 's/^/  /')
for _ in $(seq 60); do curl -sf -m 2 "http://127.0.0.1:$port/healthz" >/dev/null && break; sleep 1; done
curl -sf -m 2 "http://127.0.0.1:$port/healthz" >/dev/null || { warn "The server did not start. See: cd $target && docker compose logs"; exit 1; }
ok "Server running on 127.0.0.1:$port."
[ "$(https_status "$host")" = 200 ] && ok "https://$host reaches it." || warn "https://$host does not reach it yet; check the reverse proxy."

step "6/6" "Connect Oura"
setup_key=$(env_value "$target/.env" SETUP_KEY)
token=$(env_value "$target/.env" MCP_ACCESS_TOKEN)
link=$(curl -sf -X POST -H @<(printf 'X-Setup-Key: %s\n' "$setup_key") "http://127.0.0.1:$port/admin/oura/authorize" |
  sed -n 's/.*"authorization_url":"\([^"]*\)".*/\1/p')
say "Open this link on the person's phone or laptop, signed in to THEIR Oura account," \
  "and tap Approve. The page that follows names the connected account; check it." "" "  $link" ""
note "Waiting for approval (up to 10 minutes; the link expires after that)..."
catalog='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oura_catalog","arguments":{}}}'
for _ in $(seq 200); do
  if curl -s -m 5 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") -d "$catalog" "http://127.0.0.1:$port/mcp" | grep -q '"oura_authorized":true'; then
    ok "Oura connected."; break
  fi
  sleep 3
done

printf '\n%sDone.%s Next, in the person'"'"'s own accounts:\n' "$bold" "$reset"
[ -n "$OPENAI_TUNNEL_ID" ] && say "ChatGPT (web): Plugins → + → Add custom MCP server → Connection: Tunnel → $OPENAI_TUNNEL_ID."
say "Claude: add a custom connector https://$host/mcp with header Authorization: Bearer <token>."
if confirm "Show the Claude bearer token now?" "N"; then say "$token"; fi
note "Folder: $target · Update later with: docker compose ${files[*]} pull && docker compose ${files[*]} up -d"
