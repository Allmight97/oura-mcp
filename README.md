# Oura MCP

Self-hosted, read-only access to **your own Oura account** from an agent.
Run one container per person. The image includes no account credentials, health
records, configured personal endpoint, or hosted service.

This is the published working baseline. Universal cloud onboarding is the next
deliverable: installing a companion plugin does not start a container or connect
an MCP server. See [design and support boundaries](docs/design.md).

## What works

| Consumer | Baseline connection | Companion package |
| --- | --- | --- |
| ChatGPT | Private OpenAI Secure MCP Tunnel; requires your own Platform tunnel and permissions | Repo marketplace for supported desktop/Codex surfaces; cloud installation is separate |
| Claude.ai / Claude app | Public HTTPS MCP with a fixed bearer request header, when your account has that feature | Plugin availability depends on the Claude surface and plan |
| Claude Code | Remote HTTP MCP configured with your own URL and bearer credential | `oura@oura` from the Claude marketplace |
| Codex / Cursor / Grok Build | Configure an authenticated MCP connection using that client's supported mechanism | Companion skill catalog; installing it supplies no MCP credentials |
| Grok Bot | Secure personal remote-connector onboarding remains unfinished | Grok Build's marketplace is not proof of Grok Bot installation |

The two tools are `oura_catalog` and `oura_query`. They return native Oura API v2
JSON, pagination and provenance. The service does not maintain a health-data cache
or produce summaries. Agent providers receive the requested data and may retain
it under their own settings.

## Fresh installation

The baseline image is **Linux amd64**. An ARM host needs amd64 emulation. The
bundled optional OpenAI tunnel binary is pinned to that architecture.

You need Docker Compose, an always-on host and a publicly reachable HTTPS address
for cloud clients. A reverse proxy or managed ingress must terminate TLS and
preserve the public hostname. The container publishes HTTP only on host loopback;
it does not configure your DNS, router, certificate, or firewall.

1. Clone this repository and create private configuration:

   ```bash
   git clone https://github.com/Allmight97/oura-mcp.git
   cd oura-mcp
   chmod 700 .
   cp .env.example .env
   chmod 600 .env
   ```

   On a NAS, also remove inherited share ACLs that let other service accounts
   read or replace this directory. A mode of 0600 alone may not override them.

2. Register your own application in the [Oura developer portal](https://developer.ouraring.com/).
   Register `https://YOUR-HOST/oauth/oura/callback` as its redirect URI. Enter its
   client ID and secret in `.env`, with that exact URI and your public hostname.
   Each person authorizes an individual grant; an application user quota is
   independent of how many containers hold those grants.

3. Generate two different secrets with `openssl rand -hex 32`: one for
   `SETUP_KEY` and one for `MCP_ACCESS_TOKEN`. Enter them privately in `.env`.
   These are configuration values for your installation; never commit them.

4. Configure HTTPS forwarding for `/mcp` and `/oauth/oura/callback` to
   `http://127.0.0.1:8787`, preserving the public `Host`. Keep the admin setup
   endpoint local. **Never rewrite public requests to `Host: oura-mcp`**: that
   name is trusted for the private tunnel. Do not forward a NAS administration
   interface as part of exposing this MCP.

5. Start the published image:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

   The default runs the MCP process as non-root with dropped capabilities and a
   read-only root filesystem. The named volume supplies its writable `/data`.

6. Request the authorization link locally without putting the setup secret in
   shell arguments:

   ```bash
   docker compose exec -T oura-mcp node --input-type=module <<'JS'
   const response = await fetch('http://127.0.0.1:8787/admin/oura/authorize', {
     method: 'POST', headers: { 'X-Setup-Key': process.env.SETUP_KEY }
   });
   if (!response.ok) throw new Error(`Setup failed: ${response.status}`);
   console.log((await response.json()).authorization_url);
   JS
   ```

   Open the returned link, confirm you are signed into the intended Oura account,
   and approve access. The current authorization flow requests all available
   application scopes; Oura controls which scopes you grant. Keep the link private.

7. Connect an agent below. Verify `oura_catalog` reports authorization and make
   a small date-range query. Missing authorization or data must remain visible.

## Connect an agent

### Claude.ai and the Claude app

Add a custom connector pointing at `https://YOUR-HOST/mcp`. If your account shows
Request headers, choose No sign-in and add a required `Authorization` header
whose value is `Bearer YOUR_MCP_ACCESS_TOKEN`. Enter the secret only in that
credential field. This header-auth feature has account-dependent availability;
see [Claude's current connector instructions](https://claude.com/docs/connectors/custom/add-unlisted).

### ChatGPT private tunnel

Create your own OpenAI Secure MCP Tunnel and a runtime key with its required
permissions. Set `OPENAI_TUNNEL_ID` and `CONTROL_PLANE_API_KEY` in `.env`, then run:

```bash
docker compose -f compose.yaml -f compose.openai.yaml up -d
```

This still uses one container. The launcher starts MCP before the tunnel, stops
both if either fails, and drains MCP requests on shutdown. The tunnel runs as
UID 10001 with only its OpenAI credential. MCP runs as UID 1000 in both modes.
This optional mode uses a root launcher with the listed Compose capabilities.
It trusts that launcher and the host administrator.

Connect the tunnel in your own ChatGPT developer configuration. A private tunnel
does not publish a universal directory plugin or automatically authorize other
people. Follow the [OpenAI tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

### Companion skill marketplace

The repository contains one instruction-only plugin, `oura`, and native catalogs
for the supported plugin clients. For Claude Code:

```bash
claude plugin marketplace add Allmight97/oura-mcp
claude plugin install oura@oura
```

For Codex's repo marketplace:

```bash
codex plugin marketplace add Allmight97/oura-mcp
codex plugin add oura@oura
```

Cursor can import this repository through its marketplace UI. Grok Build reads
the separate `.grok-plugin/marketplace.json`. These instructions do not establish
Grok Bot cloud compatibility. The companion is invoked as `/oura:oura` in Claude
or `$oura` in Codex after installing; it expects a separately authenticated MCP.

Public directory submission, repo marketplace installation, and connecting a
private server are distinct workflows. Adding this GitHub URL to one client is
not a claim of installation into every other account or provider.

## Credentials, isolation and updates

Fixed configuration comes from `.env` and is visible to Docker administrators.
The rotating Oura grant is `/data/oura-credential.json` on the named volume,
written with mode 0600. With the default image it is owned by UID 1000. Keep the
volume private and run only one credential writer per grant. Backups can contain
usable credentials; an older refresh token may already be spent.

For another person, use a separate Compose project, volume, secrets, hostname and
host port. For example `docker compose -p second-owner ...` separates the volume
and network, but you must also change the published host port before running it
beside the first instance. Never mount both owners' volumes into one container.
Host and Docker administrators remain trusted across these installations.

Updates use `docker compose pull` followed by `docker compose up -d` (include
`compose.openai.yaml` if that mode is enabled). Retain the volume and `.env`.
Never use `down -v` to update. Existing deployments must preserve their live
credential store and confirm ownership before adopting these fresh-install
templates; this repository does not reset or migrate personal data automatically.

The baseline uses one public bearer credential per deployment. It does not yet
offer separate per-agent revocation, MCP OAuth login, an owner pin, or managed
hosting. Disconnecting a client does not revoke a copied bearer. These are
documented next steps, not implied security properties.

## Development and image publication

```bash
npm ci
npm run check
npm test
python3 scripts/check-packaging.py
docker build --platform linux/amd64 -t oura-mcp:test .
node scripts/smoke-image.mjs oura-mcp:test
```

The image build uses an allowlisted context and production dependencies. Tests
use synthetic credentials and responses. GitHub Actions checks source and the
actual image, then publishes `ghcr.io/allmight97/oura-mcp:latest` and an immutable
commit tag. It attaches an SBOM, build provenance and a GitHub artifact attestation.
For reproducible deployment, pull the published digest rather than a moving tag.

The image and source are independent of any live installation. Nothing in this
repository grants access to the maintainer's account. This is an independent
project; review Oura's current API terms and each provider's requirements for your
intended use and distribution.
