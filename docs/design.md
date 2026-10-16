# Design and support boundaries

The first public deliverable is a working single-owner server image and companion
package. Uniform ChatGPT, Claude.ai and Grok Bot cloud onboarding is deferred.
The [onboarding proposal](universal-onboarding.md) develops that next deliverable;
its owner login and MCP OAuth flow are not implemented in the baseline.
The source and image contain no installation credentials, personal endpoints or
health responses. A clean installation must supply its own hosting and consent.

One deployment owns one Oura grant. More agent connections use that same owner's
data. Another person gets another deployment with separate storage, authorization
and routing. An upstream application's user quota does not determine this boundary.

The container calls Oura over HTTPS. A private OpenAI tunnel is a transport from
OpenAI to the container; it is not a tunnel into Oura. Public cloud clients need
a reachable HTTPS address plus authentication. DNS names alone provide neither.

## Established baseline

- Read-only raw API v2 tools with validation, provenance and pagination.
- A private persistent token file and no health-data cache.
- Public hostname and fixed-bearer checks; unknown hosts and origins fail closed.
- Single-process non-root default; optional combined OpenAI tunnel mode.
- Lifecycle tests for process failure, startup ordering and token persistence
  during graceful shutdown. Natural live token expiry is not automated proof.
- The companion package supplies instructions only. Client configuration and
  private credential entry remain separate from marketplace discovery.

## Next decisions and proof

Use **O — ownership**, **C — custody**, **L — lifecycle**, and **D — delivery** to
assess the next implementation. Keep provider facts, proposals and unverified
claims distinct. Prefer raw protocol exchanges and real client settings over
model agreement or a schema's apparent support for a feature.

1. Verify each target cloud client's actual secure sign-in mechanism. A fixed
   header works in eligible Claude accounts; that is not a universal flow.
   Evaluate standards-based MCP OAuth and maintained implementations before
   adding an authorization server. Keep MCP and Oura grants distinct.
2. Add separately revocable agent grants and test that revoking one stops its
   new reads without affecting the others. Test client disconnect separately.
3. Bind setup to the intended Oura owner, reject a later wrong-owner grant and
   test secure first pairing. The current setup key is an administrative gate,
   not an owner pin.
4. Move fixed secrets to private mounts, assess process compromise boundaries
   and test that the tunnel cannot read the Oura grant or other credentials.
   Encryption with an adjacent key cannot hide data from the serving process.
5. Exercise concurrent refresh, forced process death and persistence failure.
   Single-use upstream refresh tokens can leave an unrecoverable crash window;
   recovery must ask for authorization, never substitute another owner's grant.
6. Verify a fresh installation by a second owner, including rejected wrong-token,
   wrong-host and cross-instance calls. Compare raw tool results with upstream
   responses, and assess agent prose separately. Inventory logs and backups.

Container boundaries protect only the tested threat model. Host administrators
can read credentials and plaintext responses. Authorized agent providers receive
queried records, and revocation cannot erase data already copied into a chat.

The public package and image are not claims of public-directory approval. A
future hosted service would introduce a separate custody and tenant decision.

## Primary references

- [Oura authorization](https://cloud.ouraring.com/docs/authentication)
- [Oura developer portal](https://developer.ouraring.com/)
- [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- [MCP security practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices)
- [OpenAI packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI submission authentication limits](https://developers.openai.com/plugins/deploy/submission)
- [Claude custom connectors](https://claude.com/docs/connectors/custom/add-unlisted)
- [Grok Bot apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Grok Bot OAuth support correction](https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877/8)
