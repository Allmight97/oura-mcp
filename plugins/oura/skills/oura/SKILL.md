---
name: oura
description: Query one Oura account's live API v2 data through the oura-mcp tools, read-only and unsummarized.
disable-model-invocation: true
---

# Oura

The `oura` MCP server exposes two read-only tools over the owner's Oura
account. It returns Oura's native JSON with provenance and never summarizes.

- `oura_catalog`: every mapped collection with its query shape, whether Oura
  is authorized, and the granted scopes. Call it first when unsure of a
  collection name or its bounds.
- `oura_query`: one collection at a time. Date-range collections take `start`
  and `end` as `YYYY-MM-DD`; datetime collections take RFC 3339 with a
  timezone, or `latest: true` instead of bounds. Pass `cursor` from
  `next_cursor` to page. A collection that rejects bounds or `latest` says so.

If `oura_authorized` is false, the owner completes the one-time Oura
authorization on the host (plugin README); nothing here can do it. Present
what Oura returned; interpretation is the owner's.
