#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 NEW_PROJECT_DIRECTORY HOST_PORT" >&2
  exit 2
fi
target=$1
port=$2
if ! [[ $port =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  echo "HOST_PORT must be a number from 1024 to 65535." >&2
  exit 2
fi
if [ -e "$target" ]; then
  echo "$target already exists. Choose a new directory; this script never overwrites an owner." >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
project=oura-$(basename "$target" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')

umask 077
mkdir -p "$target"
cp "$root/compose.yaml" "$root/compose.openai.yaml" "$target/"
{
  echo "COMPOSE_PROJECT_NAME=$project"
  echo "HOST_PORT=$port"
  sed -E \
    -e "s/^SETUP_KEY=.*/SETUP_KEY=$(openssl rand -hex 32)/" \
    -e "s/^MCP_ACCESS_TOKEN=.*/MCP_ACCESS_TOKEN=$(openssl rand -hex 32)/" \
    -e "s/^(OURA_REDIRECT_URI|MCP_PUBLIC_HOSTNAME)=.*/\1=/" \
    "$root/.env.example"
} >"$target/.env"

echo "Created $target as Compose project $project on 127.0.0.1:$port."
echo "Fill in OURA_CLIENT_ID, OURA_CLIENT_SECRET, OURA_REDIRECT_URI and MCP_PUBLIC_HOSTNAME in $target/.env."
echo "For ChatGPT, also fill in this owner's own OPENAI_TUNNEL_ID and CONTROL_PLANE_API_KEY."
