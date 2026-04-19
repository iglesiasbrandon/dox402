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

### `/.well-known/ucp`

The [Universal Commerce Protocol][ucp] (UCP, Google + Shopify, announced
January 2026) standardizes the **retail shopping lifecycle** for AI
agents: product discovery, cart, checkout, order tracking, fulfillment,
post-purchase support. A UCP manifest declares a merchant's catalog
endpoints, checkout session URLs, payment handlers (Google Pay, PayPal,
tokenized card PSPs), and webhook public keys — it is built around
[`POST /ucp/checkout`][ucp-guide] and friends against a product inventory.

DOX402 has no product catalog. It is a pay-per-call inference API priced
in USDC at the HTTP layer via x402. There is no cart, no line items, no
checkout session, no fulfillment lifecycle, and the payment rail is crypto
rather than the card-PSP stack UCP handlers expect. Publishing a UCP
manifest would require stub endpoints that do not exist; real UCP-aware
agents (Google Shopping, Gemini surfaces) would then attempt a checkout
handshake that cannot complete.

The protocol comparisons agree x402 is the correct primitive for
per-call API monetization and UCP is the wrong layer
(["mostly useless if your agent is paying for APIs, data feeds, or other
agent services"][protocols-compared]). The x402 payment details that UCP
would otherwise cover are already advertised in `agent.json` under
`x-payment` and programmatically at `/payment-info`.

### `/.well-known/acp.json`

The [Agentic Commerce Protocol][acp] (ACP, OpenAI + Stripe) is a
**merchant checkout protocol** for in-chat purchases — the plumbing behind
"Buy it in ChatGPT." It defines product feeds, a delegated-payment
Shared Payment Token flow through Stripe (and other compatible PSPs), and
a conversational checkout state machine. As of the 2026-04-17 spec, there
is no standardized `/.well-known/acp.json` discovery document; the ACP
maintainers note discovery mechanisms are still being designed.

DOX402's model does not fit ACP either: no SKUs, no Shared Payment Token,
no Stripe/PSP integration, and the transaction shape (streamed inference
per HTTP request, settled in on-chain USDC) is not what ACP's checkout
state machine describes. Even if a discovery format existed, the required
fields would be inapplicable.

If ACP later ships a discovery format that covers API-style services or
crypto payment rails, revisit this decision.

## Notes for future maintainers

These decisions are tracked in [issue #90][issue-90]. If DOX402's
architecture changes (e.g. an MCP endpoint is added, the service starts
making signed outbound requests, or a retail-style product surface is
introduced), revisit the corresponding section above before adding the
file — do not add it as a stub.

[bot-auth]: https://www.ietf.org/archive/id/draft-meunier-http-message-signatures-directory-00.html
[mcp-card]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127
[ucp]: https://ucp.dev/
[ucp-guide]: https://developers.google.com/merchant/ucp
[acp]: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
[protocols-compared]: https://atxp.ai/blog/agent-payment-protocols-compared/
[issue-90]: https://github.com/iglesiasbrandon/dox402/issues/90
