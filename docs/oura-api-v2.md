# Oura API v2 and developer portal

Checked against Oura's primary sources on 2026-10-15.

Start at **[developer.ouraring.com](https://developer.ouraring.com/)** to sign in
and create or manage an Oura API application. This is the current developer
portal, not the consumer dashboard. It requires an Oura sign-in.

Oura's [current API support guidance](https://ouraringhelp.zendesk.com/hc/en-us/articles/4415266939155-The-Oura-API)
names this as its newest developer portal. It distinguishes the older portal,
which remains available for editing existing applications.

## Addresses and their purposes

| Purpose | Address |
| --- | --- |
| Register and manage applications | **[developer.ouraring.com](https://developer.ouraring.com/)** |
| API v2 reference | [cloud.ouraring.com/v2/docs](https://cloud.ouraring.com/v2/docs) |
| API server | `https://api.ouraring.com` |
| Read a v2 collection | `https://api.ouraring.com/v2/usercollection/{collection}` |
| Documented OAuth authorization endpoint | `https://cloud.ouraring.com/oauth/authorize` |
| Documented OAuth token and refresh endpoint | `https://api.ouraring.com/oauth/token` |
| Documented alternative authorization URL for new OAuth clients | `https://developer.ouraring.com/authorize` |

The portal, API server and OAuth endpoints use different hostnames. Do not replace
API or OAuth addresses just to make them match the portal hostname. Oura documents
the alternative authorization URL as supporting an Oura-app consent experience
on compatible mobile devices; that is not a reason to change a working deployment
without testing the complete authorization flow.

The v2 reference currently loads
[openapi-1.42.json](https://cloud.ouraring.com/v2/static/json/openapi-1.42.json).
Its declared API version is `2.0`; `1.42` is the published document filename,
not an instruction to use API v1. Follow the specification linked by the current
v2 reference when Oura updates it. The older `cloud.ouraring.com/docs/` overview
identifies itself as v1 documentation and is not this project's setup entry point.

## What an owner needs to supply

1. Sign into **[developer.ouraring.com](https://developer.ouraring.com/)** with
   the intended Oura account and create an API application.
2. Keep that application's client ID and client secret in the installation's
   private configuration. The client secret belongs to the developer application;
   it is not a personal access token and does not by itself authorize health data.
3. Register the exact Oura redirect URI provided by the installation. In the
   published baseline it is `https://YOUR-HOST/oauth/oura/callback`. This is the
   container's Oura callback, separate from an agent platform's MCP OAuth callback.
4. Configure the required data permissions and complete the Oura authorization
   code flow. The user must consent to the requested categories. Use the current
   portal and v2 reference to verify permissions; portal display labels are not
   guaranteed to be literal OAuth scope strings.
5. Confirm the returned Oura account is the intended owner before using its data.
   The proposed owner pin and new setup interface are future work; follow the
   [README](../README.md#fresh-installation) for the current baseline.

The v2 reference says personal access tokens were deprecated in December 2025 and
are no longer available. New installation instructions must use a developer
application and OAuth2, not tell users to generate a personal API key.

API applications have a default limit of ten Oura users before Oura approval is
required. That is an application quota, not the number of containers or agent
connections. ChatGPT, Claude and Grok Bot querying one owner's grant still refer
to that one Oura account. The quota does not provide isolation between users.
Publishing this repository is not Oura approval of a shared developer application.

Oura's current member guidance says Gen3 and later users need an active Oura
Membership for API access. Users should keep the Oura app updated and sync their
ring. Successful OAuth does not guarantee that every collection has fresh records.

## Verification boundaries for the new design

- The v2 reference links Oura's [OAuth instructions](https://cloud.ouraring.com/docs/authentication).
  Those instructions document authorization code, S256 PKCE, exact redirect
  matching and single-use refresh tokens. The project will use server-side OAuth.
- The older OAuth page's scope table, current OpenAPI scope declarations and
  portal permission labels differ. Do not freeze an eight-scope list into setup
  instructions or infer full access from a missing scope field. Verify actual
  token responses and permission-denied behavior in the upstream experiment.
- The current v2 `personal_info` response requires a string `id`. That schema alone
  does not prove lifetime stability across reauthorization; the owner-binding
  implementation must establish that before relying on it.
- Oura recommends webhooks for ongoing ingestion and documents rate-limit response
  headers. This product's chosen workflow remains on-demand, bounded MCP queries
  without a health-data cache. Handle rate limits and delayed sync explicitly;
  do not silently add background ingestion as part of onboarding.

## Primary references

- [Current developer portal](https://developer.ouraring.com/)
- [Oura member guidance: newest and previous portals, membership and v2 reference](https://ouraringhelp.zendesk.com/hc/en-us/articles/4415266939155-The-Oura-API)
- [Oura enterprise guidance, updated October 5, 2026](https://partnersupport.ouraring.com/hc/en-us/articles/20949682312211-Using-the-Oura-API)
- [API v2 reference](https://cloud.ouraring.com/v2/docs)
- [OpenAPI document loaded by that reference when checked](https://cloud.ouraring.com/v2/static/json/openapi-1.42.json)
- [OAuth instructions linked by the v2 reference](https://cloud.ouraring.com/docs/authentication)
