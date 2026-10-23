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

for name in OURA_CLIENT_ID OURA_CLIENT_SECRET MCP_PUBLIC_HOSTNAME OPENAI_TUNNEL_ID CONTROL_PLANE_API_KEY; do
  if [[ ${!name:-} == *[[:space:]]* ]]; then
    echo "$name must not contain spaces or line breaks." >&2
    exit 2
  fi
done
redirect=${MCP_PUBLIC_HOSTNAME:+https://$MCP_PUBLIC_HOSTNAME/oauth/oura/callback}

umask 077
mkdir -p "$target"
cp "$root/compose.yaml" "$root/compose.openai.yaml" "$target/"
cat >"$target/.env" <<ENV
COMPOSE_PROJECT_NAME=$project
HOST_PORT=$port
OURA_CLIENT_ID=${OURA_CLIENT_ID:-}
OURA_CLIENT_SECRET=${OURA_CLIENT_SECRET:-}
OURA_REDIRECT_URI=$redirect
SETUP_KEY=$(openssl rand -hex 32)
MCP_PUBLIC_HOSTNAME=${MCP_PUBLIC_HOSTNAME:-}
MCP_ACCESS_TOKEN=$(openssl rand -hex 32)
OPENAI_TUNNEL_ID=${OPENAI_TUNNEL_ID:-}
CONTROL_PLANE_API_KEY=${CONTROL_PLANE_API_KEY:-}
ENV

echo "Created $target as Compose project $project on 127.0.0.1:$port."
