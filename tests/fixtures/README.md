# Test fixtures

## `localhost-cert.pem` / `localhost-key.pem`

A self-signed certificate for `localhost` / `127.0.0.1`, used **only** by the
local test server so HTTP/2 can be negotiated over ALPN. A plain-HTTP listener
cannot exercise HTTP/2 at all, which is why every h2 test was previously
pointed at a public origin.

The certificate is deliberately committed rather than generated at test time:
generating it per run costs a keygen and makes the subject unpredictable, and
the key is worthless outside this repository — it has no CA, no name outside
`localhost`, and an expiry 100 years out that is never reached in practice.

Tests pass the certificate to the client as a CA (`ca: LOCAL_TLS_CA`), so trust
is explicit and scoped to the process; `NODE_TLS_REJECT_UNAUTHORIZED` is never
touched.

The key is allowlisted by path in the repository's `.gitleaks.toml`, because the
`private-key` rule flags any file that is one — including this one, on purpose.
Every other rule still applies, here included: a real credential committed
alongside this fixture is still caught.
