# `/.well-known/` for DOX402

DOX402 is a destination REST API (Cloudflare Worker) that sells document
inference for USDC on Base via x402, with auth via SIWE/SIWX/Bearer token.
This directory holds the agent-discovery documents we publish, and this
README records the deliberate decisions about ones we do not.

## What we publish

- **`agent.json`** — A2A agent card describing identity, transport, and
  the high-level skill DOX402 offers.
- **`agents.json`** — Multi-step agent flows (login, infer, balance, etc.)
  pointing back at the OpenAPI spec.

Related agent-readable documents live one directory up:

- `/openapi.json` — OpenAPI 3.1 description of every REST endpoint.
- `/SKILL.md` — Human/agent-readable usage guide.

## What we deliberately do NOT publish

### `/.well-known/http-message-signatures-directory`

Per [draft-meunier-http-message-signatures-directory-00][bot-auth], this
JWKS lists public keys a **bot** uses to sign its outgoing requests so
destination servers can verify them. It is published by crawlers and other
outbound-signing clients — not by destination services.

DOX402 is the destination. It does not crawl other sites and does not sign
outgoing requests. Publishing an empty or stub directory here would
misrepresent us as a signing client.

### `/.well-known/mcp/server-card.json`

[SEP-1649][mcp-card] describes an MCP server's identity, transport, and
capabilities. DOX402 does not expose an MCP server endpoint — it is a REST
API documented via `openapi.json`. A future MCP wrapper around the REST
surface is possible, but until that endpoint actually exists, publishing a
server card would lie about a capability we do not have.

### `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`

DOX402 authenticates via SIWE/SIWX wallet signatures (see `/auth/nonce` and
`/auth/login`), not OAuth 2.0 / OIDC. Publishing OAuth/OIDC discovery
metadata would advertise endpoints and flows we do not implement, and
would mislead agents into attempting a handshake that cannot succeed.

## Notes for future maintainers

These decisions are tracked in [issue #90][issue-90]. If DOX402's
architecture changes (e.g. an MCP endpoint is added, or the service starts
making signed outbound requests), revisit the corresponding section above
before adding the file — do not add it as a stub.

[bot-auth]: https://www.ietf.org/archive/id/draft-meunier-http-message-signatures-directory-00.html
[mcp-card]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127
[issue-90]: https://github.com/iglesiasbrandon/dox402/issues/90
