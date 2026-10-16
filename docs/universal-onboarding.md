# Universal onboarding proposal

Status: design proposal, checked against primary documentation on 2026-10-15.
The published baseline and live installations still use their existing auth.
No OAuth server, passkey login, or universal client compatibility is implemented
by this document. Personal Grok Bot interoperability remains unproven.

## Intended outcome

One person deploys one container and authorizes their Oura account. They then
connect ChatGPT, Claude.ai, and personal Grok Bot independently. Each connection
gets its own revocable permission to query that container. Another person uses
another deployment, with a different issuer, resource URL, grant, and storage.

Use O for ownership, C for credential custody, L for lifecycle, and D for delivery.
These names describe outcomes to test, not additional services to deploy.

## How agents consume the data

Suppose an owner asks Claude, "Compare my sleep over the last seven nights."

1. Claude's MCP client discovers the tool schemas from the owner's public HTTPS
   MCP URL. It has previously obtained an OAuth grant from that installation.
2. Claude calls `oura_catalog` when needed, then `oura_query` with a collection
   and date bounds. Its backend sends an installation-issued access token.
3. The container validates the token, its intended resource, owner, scope, and
   current grant status before reading anything from Oura.
4. The container calls the Oura API with its private Oura access token. It alone
   renews that token when necessary, persisting the replacement refresh token.
5. The container returns native Oura JSON and provenance. Claude receives those
   records and interprets them in the conversation.

ChatGPT and Grok Bot follow the same proposed contract. Their own clients decide
when to call a tool; a companion skill can guide use but cannot create access.
There is no background upload of the owner's entire account in this design.
Oura must already have received the ring's synced data for the API to return it.

Two independent permissions are involved:

| Permission | Issuer and recipient | What it permits |
| --- | --- | --- |
| Oura grant | Oura issues it to the container | Read the approved Oura account and categories |
| MCP grant | This installation issues it to an agent platform's client | Call approved read-only tools on this installation |

Oura passwords stay in Oura's sign-in flow. Oura client secrets and Oura tokens
stay on the owner's server. Agent platform backends keep their MCP credentials;
the model should receive tool schemas and requested records, never credentials.
Providers can retain returned data under their account policies. Revoking access
cannot erase records already returned or copied into a conversation.

## Starting from zero

Recommended first product path: user-controlled hosting and a single owner.

1. Choose a host with persistent private storage and a stable public HTTPS URL.
   A NAS needs correctly configured ingress; a cloud deployment can obtain HTTPS
   through the hosting platform. A container image alone supplies neither.
2. Deploy the image in a locked, unclaimed state. Obtain a short-lived, single-use
   owner-claim code through the host's authenticated administration channel.
   The first public visitor must not be able to claim the installation.
3. Redeem the claim in the browser and register an owner passkey. Bind login to
   the configured HTTPS origin. Disable public signup and consume the claim
   atomically. Keep recovery under host-owner control, with no public reset path.
4. Register an Oura developer application and enter its credentials through the
   owner's authenticated setup screen. Supply the exact callback URL shown by
   the installation. Never place a shared project's client secret in the image.
5. Choose Oura categories, sign in at Oura, and consent. The server uses state
   and S256 PKCE, retrieves the account identifier, and asks the authenticated
   owner to confirm the intended account. Pin that identifier; verify its stable
   semantics before implementation. A later different-owner grant must fail
   without replacing the stored credential. Reauthorization itself may affect
   older upstream tokens; measure that behavior before promising preservation
   of usable access. Identity-check permissions must be explained separately
   from optional health-data permissions. Do not use the deprecated callback
   `scope` parameter as authority: record token-response scope when supplied,
   and report unknown scope rather than assuming full access when it is omitted.
6. In each supported platform, add the installation's MCP URL and choose sign-in.
   The platform discovers OAuth, opens the installation's owner login and consent
   page, and receives its own MCP grant after approval. Repeat for each platform.
7. Verify a small query, inspect active grants, and test revocation. The setup
   screen must distinguish connected, authorization expired, upstream unavailable,
   missing scope, and data not yet synced.

An OAuth client identifies an application, not necessarily the signed-in person's
ChatGPT/Claude/Grok account. Connecting requires checking the intended platform
account in that platform. Do not claim our server has verified a remote account's
email or identity unless that client supplies a separately validated assertion.
With Grok Bot, connection availability is account-wide, not isolated to one Bot.

### Recovery and retirement

- Lost owner passkey: use the authenticated host administration channel to issue
  a short-lived, single-use recovery code. Replace the lost passkey and invalidate
  owner browser sessions. Preserve the pinned owner, Oura grant and existing MCP
  grants. If compromise is suspected, explicitly revoke affected grants too.
- Expired Oura authorization: authenticate the owner and reauthorize at Oura;
  re-check the pinned identifier before accepting the replacement. Show failures
  explicitly. Do not revoke a rejected candidate token until Oura's revocation
  semantics are known; it might invalidate the still-needed upstream grant.
- Revoked platform grant: reconnect from that platform and approve a fresh grant.
  The revoked grant and its refresh family must never reactivate automatically.
- Restore: before making a restored installation publicly reachable, invalidate
  all restored MCP grants and refresh families, invalidate owner browser sessions,
  preserve the owner pin, and validate the recovered Oura credential. If its
  refresh token is spent, request Oura authorization. Reconnect platforms afresh.
- Retirement: revoke MCP grants, then explicitly disconnect Oura using verified
  upstream controls. Explain that volumes and backups can contain credentials.
  Data deletion is a separate owner-authorized action, not a recovery step.

## Choices and recommendation

### Owner authentication

| Choice | Concrete experience | Tradeoff and proof needed |
| --- | --- | --- |
| Local owner passkey and consent | Owner signs into their installation to approve Claude; the existing Oura grant is unchanged | Recommended. Requires secure first claim, passkey recovery, session protection and a maintained WebAuthn implementation |
| Fresh Oura authorization for every platform connection | Connecting ChatGPT opens Oura again; the returned account identifier must match the installation owner | Avoid selecting this until Oura's repeated-authorization and refresh-token invalidation behavior is measured. Oura OAuth is not an OIDC identity assertion |
| External identity/authorization provider | Owner also configures or signs into another identity service before approving the agent | Can provide established identity controls, but adds another account, dependency and consent/metadata custody. No need established for the initial single-owner product |

Prefer an embedded, maintained OAuth authorization server plus local owner
authentication. The image can still contain one application process, a setup and
consent UI, an authorization server, an MCP resource server, and persistent state.
These are responsibilities, not a requirement for separate containers.

The target is direct public OAuth for ChatGPT as well as the other clients.
After real-client proof and an explicit cutover, retire the private OpenAI tunnel
option, root launcher, bundled tunnel binaries and control-plane credential.
That leaves the application running as one non-root process. Host or platform
ingress still supplies HTTPS; it never bypasses the application's authorization.

Candidate implementations to evaluate are Better Auth with its OAuth Provider,
CIMD, MCP and passkey components (1.7.10 observed), and `oidc-provider` (9.12.2
observed) with a maintained owner-auth implementation. Better Auth documents
integrated components and a Node metadata transport with DNS pinning;
`oidc-provider` documents OpenID certification and experimental CIMD support.
Neither establishes our configuration's safety. Select and pin the implementation
after the protocol and persistence tests below, not from feature names alone.

### Hosting and Oura application registration

| Choice | Starting workflow | Custody boundary |
| --- | --- | --- |
| User-controlled NAS or cloud account | Deploy own container, supply own Oura app, connect each agent | Recommended initial path. Host administrators and hosting provider remain trusted |
| Managed deployment operated by this project | Visit a project service, sign into Oura, then approve agent access | Separate product decision. Operator can access grants and serving processes; needs a hosting, recovery and incident model plus Oura app approval/secret custody |

A cloud deployment template can remove router administration for users while
keeping the container in their hosting account. Choose a provider only after
testing persistent storage, HTTPS, idle behavior, IPv4 reachability, backup,
region and cost. No provider-specific template is selected by this proposal.

Oura documents a default ten-user quota per developer application and review for
wider use. That quota does not impose multi-owner containers. Self-hosted owners
using their own developer applications and a project-operated shared application
are different distribution models. Do not present the quota as approval of a
particular public product or of distributing its client secret.

## Authorization contract to implement

- One configured canonical HTTPS issuer and exact MCP resource URL, including
  `/mcp`. Do not derive either from untrusted Host or forwarded headers.
- OAuth protected-resource metadata, authorization-server discovery, code flow
  with S256 PKCE, issuer identification, and resource/audience validation.
  Reject a missing or unknown resource; do not silently select the local one.
- Prefer validated Client ID Metadata Documents (CIMD). Add bounded dynamic
  client registration only where observed clients need it. Registration alone
  grants no data access; client-supplied names are not verified branding.
- Validate exact redirect URIs. Apply narrowly defined native loopback exceptions
  only to clients whose current behavior requires them. Never accept arbitrary
  redirects or disable PKCE to accommodate a failing client.
- Separate grant records for each authorization, including multiple connections
  using the same platform client ID. A global platform client ID is not a grant.
- Short-lived MCP access tokens and rotating refresh-token families, persisted
  transactionally. Check current grant status on every protected call, so a
  signature-valid token cannot bypass revocation. Test refresh replay handling.
- A read-only MCP scope, mapped to the owner's approved Oura categories. Do not
  advertise machine grants, write scopes, or unrelated OIDC profile claims.
- Owner login sessions cannot authorize MCP requests directly. MCP credentials
  cannot open administration routes, relink Oura, create owners or approve grants.
- Remove hostname-based authentication exemptions from the universal design.
  Internal and public MCP requests require a valid grant. A tunnel is transport,
  not a substitute for per-owner authorization.
- Public ingress must expose required discovery, authorization, token, callback
  and MCP routes. The current MCP-only ingress cannot support the new flow
  unchanged. Recovery/claim administration remains separately protected.
- Store grant state in a private transactional persistent database using the
  chosen library's supported storage. Protect fixed secrets with private mounts.
  Preserve the existing live Oura grant during an explicit upgrade; do not reset
  a volume, restore a spent refresh token, or silently change owners.
- Bound OAuth registration and metadata fetching. Fetch HTTPS client metadata
  with verified TLS, public-address enforcement at connection time, DNS pinning,
  redirect refusal, size/time/concurrency limits, and bounded caches. A DNS check
  followed by an ordinary re-resolving fetch is insufficient on a NAS network.
- Protect login/consent with secure HttpOnly cookies, CSRF protections, bounded
  sessions, fresh owner authentication for new grants or sensitive changes, and
  rate limits. Do not load
  remote client logos or trust client-provided HTML on consent screens.
- Log outcome codes and request identifiers, not tokens, codes, state values,
  secret headers, full callback queries or health responses. Treat backups as
  credentials. Encryption with a key beside the data does not protect against
  serving-process or host-administrator compromise.
- A restored auth snapshot can resurrect revoked grants. Require an explicit
  restore procedure that invalidates prior MCP grants before serving traffic,
  while retaining the pinned Oura owner and protecting the live upstream grant.
  A counter restored in that same snapshot cannot reliably detect rollback.
  Never claim automatic rollback detection without an independent trust anchor.

## Client evidence as of 2026-10-15

| Client | Established by primary sources | Still requires live proof |
| --- | --- | --- |
| ChatGPT | MCP OAuth with S256, resource metadata, CIMD/DCR/static client options; exact callback depends on issuer identification and management settings | Own public OAuth connection, refresh and revocation without the private OpenAI tunnel |
| Claude.ai | Remote OAuth; CIMD needs both its support flag and public-client `none`; discovery resource must exactly match the entered URL | Owner authentication, tool result, refresh and revocation through this implementation |
| Personal Grok Bot | Primary support guidance says OAuth for custom remote connectors; official docs say installed connections are account-wide | Current registration fields, redirect URI, PKCE, resource handling, refresh, revocation and actual tool calls. September callback bug status is not established |

Grok chat, Grok Build, xAI API tools and Team Bots are separate consumers. Evidence
for those products does not prove personal Grok Bot compatibility. Marketplace
listing and provider directory approval remain separate from connector sign-in.
Per-owner server URLs mean custom-URL setup is the initial connection path; a
single public listing pointing at the maintainer's endpoint cannot serve them.

## Proof and implementation order

1. **Interoperability first:** make an isolated OAuth/MCP fixture with synthetic
   records and a maintained provider on a disposable public HTTPS hostname,
   separate from production ingress and the private OpenAI tunnel. Capture
   sanitized discovery, registration,
   authorize, callback and token exchanges from each real cloud client, starting
   with personal Grok Bot. Record app version/date, requested grant/PKCE/resource
   on both authorization and token requests,
   callback and result. No personal Oura credential is needed for this experiment.
   If a client is broken, keep the incompatibility explicit and do not weaken auth.
2. **Protocol choice:** compare candidate implementations using those exact
   requests. Test wrong audience, client, redirect, verifier, expired/replayed code,
   malicious metadata URL, DNS rebinding, resource mismatch and server restart.
   Prefer the candidate that satisfies the complete contract with fewer custom
   security responsibilities. Check pinned dependency advisories and licensing.
   Compare captured CIMD documents against the candidate's exact supported draft
   and MCP profile; test Claude's public-client `none` and OpenAI's callback mode.
3. **Upstream evidence gate:** with a dedicated Oura developer application and an
   explicitly authorized test owner, isolated from the live grant, measure account
   identifier stability, repeated-authorization effects on older refresh tokens,
   actual granted-scope fields and reduced-scope responses. Test PKCE exchange.
   If identity is unstable or token behavior is unsafe, block automatic relinking
   and revise that workflow before implementing it. Never guess another identity.
4. **Owner and upstream:** implement private first claim, owner login/recovery,
   Oura PKCE pairing, owner pin and preservation of the rotating upstream grant.
   Test wrong-owner relink, concurrency, refresh persistence failure and recovery.
5. **Independent grants:** issue separate grants for three clients; revoke one
   and prove its next read and refresh fail while the other two still work.
   Requests already dispatched to Oura can finish; cancellation cannot retract
   previously returned data. Repeat after container restart. Restore a snapshot
   taken before revocation using the explicit restore procedure: every old MCP
   credential must fail, and fresh connections must work after owner approval.
6. **Second owner and real data:** run two fresh instances with synthetic owners
   first. Cross-instance tokens must fail even with identical client IDs. Then,
   with each person's authorization, compare a small raw query against Oura in
   each actual platform account. Keep health records out of public test artifacts.
7. **Fresh installation and cutover:** prove setup on a clean host and document
   provider availability/plan limits. Only then prepare an upgrade of an existing
   deployment, retaining its live grant and verifying each existing agent before
   retiring the old route. No live NAS or router change is part of this proposal.

Independent evidence is the raw protocol, negative tests, upstream response
comparison, persistent revocation and real-client results. Model agreement and
library certification do not establish end-to-end correctness.

## Primary sources

- [Oura OAuth and PKCE](https://cloud.ouraring.com/docs/authentication)
- [Oura developer application quota and review](https://cloud.ouraring.com/docs/)
- [MCP authorization, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Personal Grok Bot connector custody](https://docs.x.ai/grok-bot/computer-and-apps)
- [Grok Bot support correction, September 17](https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877/8)
- [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)
- [Better Auth CIMD and secure Node transport](https://better-auth.com/docs/plugins/cimd)
- [oidc-provider implementation and certification](https://github.com/panva/node-oidc-provider)

## Review provenance

Claude Opus 5.5 was consulted through the local Claude Code CLI with high effort,
read-only repository tools and no private installation configuration. It agreed
with the single-owner, embedded OAuth, passkey and interoperability-first shape.
Its assessment of provider requirements initially used supplied primary-source
findings; that agreement is not an independent verification of those sources or
of a live client. Candidate-library and Oura PKCE details were checked separately.
