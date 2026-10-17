# Changelog

## Unreleased

- The `oura-mcp` host skips the bearer only in tunnel mode; before, it did so in every mode.
- `SETUP_KEY` must be at least 32 characters; shorter keys stop startup.
- A rejected Oura callback returns 400 and no longer cancels the pending authorization.
  Pending authorization lives in memory, so a restart needs a new link.
- A token refresh that finishes after a new authorization keeps the new grant.
- Query bounds reject impossible dates and incomplete timestamps before calling Oura.
- Overlapping main-branch workflow runs cancel the older run, so it cannot republish `latest`.

## Baseline

- One Oura OAuth grant per deployment; raw API v2 queries with provenance.
- Published image, isolated persistent grant volume and configurable HTTPS host.
- Optional private OpenAI tunnel in the same container.
- Auth and lifecycle tests; companion plugin catalogs for supported clients.
- Universal cloud onboarding remains in development; see the support matrix.
