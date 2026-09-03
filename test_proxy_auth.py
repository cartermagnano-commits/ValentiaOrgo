"""
test_proxy_auth.py — proxy trust-boundary suite.

Run before committing changes to proxy_auth.py:

    python test_proxy_auth.py

Plain Python (matching test_prediction.py): one PASS/FAIL line per case,
non-zero exit on any failure. Imports only proxy_auth.py.

Two rules, one secret. Splitting the frontend onto Vercel broke the old
"trust X-Forwarded-For only from a loopback peer" rule — from Vercel the peer
is never loopback, so every user collapsed into ONE rate-limit bucket. The
shared secret restores the boundary: it proves the request came from our
proxy, which is exactly when the forwarded IP can be believed.
"""

import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from proxy_auth import (
    EXEMPT_PATHS, LOOPBACK_IPS, PROXY_SECRET_HEADER,
    proxy_authorized, resolve_client_ip, secret_matches,
)

failures: list[str] = []
passes = 0


def check(name: str, ok: bool, detail: str = ""):
    global passes
    if ok:
        passes += 1
        print(f"  PASS  {name}")
    else:
        failures.append(name)
        print(f"  FAIL  {name}  {detail}")


print("\nsecret_matches — did this request carry a valid secret?\n")

# The narrow question. Never true without a configured secret, so an unset
# ORGO_PROXY_SECRET can never be read as "trust this caller's forwarded IP".
check("a matching header matches",
      secret_matches("s3cret", "s3cret") is True)

check("a wrong header does not match",
      secret_matches("wrong", "s3cret") is False)

check("a missing header does not match",
      secret_matches(None, "s3cret") is False)

check("nothing matches when no secret is configured",
      secret_matches("anything", None) is False)

check("nothing matches when the configured secret is empty",
      secret_matches("anything", "") is False)

print("\nproxy_authorized — access control\n")

check("the right secret is authorized",
      proxy_authorized("s3cret", "s3cret", "/react") is True)

check("the wrong secret is rejected",
      proxy_authorized("wrong", "s3cret", "/react") is False)

check("a missing header is rejected when a secret is configured",
      proxy_authorized(None, "s3cret", "/react") is False)

check("an empty header is rejected when a secret is configured",
      proxy_authorized("", "s3cret", "/react") is False)

# Unset secret = feature off. This preserves the keyless local workflow
# CLAUDE.md documents; the backend must not lock itself out by default.
check("no configured secret authorizes everything (local dev)",
      proxy_authorized(None, None, "/react") is True)

check("an empty configured secret also counts as unset",
      proxy_authorized(None, "", "/react") is True)

print("\nproxy_authorized — /health exemption\n")

# Railway's healthcheck probes the backend DIRECTLY and carries no proxy
# header. Requiring the secret on /health would fail every deploy.
check("/health is exempt with no header",
      proxy_authorized(None, "s3cret", "/health") is True)

check("/health is exempt with a wrong header",
      proxy_authorized("wrong", "s3cret", "/health") is True)

check("/health is in the exempt set",
      "/health" in EXEMPT_PATHS)

check("a non-exempt path is still gated",
      proxy_authorized(None, "s3cret", "/analyze") is False)

check("the header name is the one the middleware will send",
      PROXY_SECRET_HEADER == "x-orgo-proxy-secret", PROXY_SECRET_HEADER)

print("\nresolve_client_ip — rate-limit bucketing\n")

# The bug this fixes: from Vercel the peer is an egress IP, never loopback,
# so without trust every user shares one bucket.
check("a trusted proxy's forwarded IP is used",
      resolve_client_ip("52.9.1.1", "203.0.113.7", trusted=True) == "203.0.113.7")

check("two different forwarded IPs give two different buckets",
      resolve_client_ip("52.9.1.1", "203.0.113.7", trusted=True)
      != resolve_client_ip("52.9.1.1", "203.0.113.8", trusted=True))

check("the FIRST hop is taken from a multi-hop forwarded chain",
      resolve_client_ip("52.9.1.1", "203.0.113.7, 70.0.0.1", trusted=True) == "203.0.113.7")

check("surrounding whitespace in the chain is stripped",
      resolve_client_ip("52.9.1.1", "  203.0.113.7 , 70.0.0.1", trusted=True) == "203.0.113.7")

# Without trust, an untrusted caller must not be able to spoof its way into
# a fresh bucket — this is why the secret gates the trust flag.
check("an untrusted caller's forwarded header is ignored",
      resolve_client_ip("198.51.100.5", "203.0.113.7", trusted=False) == "198.51.100.5")

check("a trusted peer with no forwarded header falls back to the peer",
      resolve_client_ip("52.9.1.1", None, trusted=True) == "52.9.1.1")

check("a trusted peer with an empty forwarded header falls back to the peer",
      resolve_client_ip("52.9.1.1", "", trusted=True) == "52.9.1.1")

check("a forwarded header of only commas falls back to the peer",
      resolve_client_ip("52.9.1.1", " , ", trusted=True) == "52.9.1.1")

check("an unknown peer stays 'unknown'",
      resolve_client_ip("unknown", None, trusted=False) == "unknown")

check("loopback is still recognized for the local-dev path",
      "127.0.0.1" in LOOPBACK_IPS and "::1" in LOOPBACK_IPS)

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
