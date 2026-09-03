"""
test_byok.py — BYOK key-routing suite.

Run before committing changes to byok.py:

    python test_byok.py

Plain Python (matching test_prediction.py): one PASS/FAIL line per case,
non-zero exit on any failure. Imports only byok.py — no FastAPI, no cv2.

The rule under test is load-bearing: a Parley gateway key sent to
api.anthropic.com is rejected, and a real Anthropic key sent to the Parley
gateway is equally rejected. Routing by prefix is what lets one BYOK field
accept both.
"""

import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from byok import ANTHROPIC_BASE_URL, PARLEY_BASE_URL, anthropic_base_url

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


print("\nBYOK key routing\n")

check("a Parley key routes to the Parley gateway",
      anthropic_base_url("sk-parley-v1-abc123") == PARLEY_BASE_URL,
      anthropic_base_url("sk-parley-v1-abc123"))

check("a real Anthropic key routes to api.anthropic.com",
      anthropic_base_url("sk-ant-api03-abc123") == ANTHROPIC_BASE_URL,
      anthropic_base_url("sk-ant-api03-abc123"))

check("an unrecognized key shape defaults to api.anthropic.com",
      anthropic_base_url("some-other-key") == ANTHROPIC_BASE_URL,
      anthropic_base_url("some-other-key"))

# A BYOK key must NOT inherit the server's gateway base URL: a real Anthropic
# key sent to Parley is rejected, which is the whole reason for prefix routing.
check("a BYOK key ignores the server's configured base URL",
      anthropic_base_url("sk-ant-api03-abc", server_base_url=PARLEY_BASE_URL) == ANTHROPIC_BASE_URL,
      anthropic_base_url("sk-ant-api03-abc", server_base_url=PARLEY_BASE_URL))

check("a Parley BYOK key still routes to Parley when the server points elsewhere",
      anthropic_base_url("sk-parley-v1-abc", server_base_url=ANTHROPIC_BASE_URL) == PARLEY_BASE_URL,
      anthropic_base_url("sk-parley-v1-abc", server_base_url=ANTHROPIC_BASE_URL))

print("\nServer-key fallback (no BYOK key)\n")

check("no key falls back to the server's configured base URL",
      anthropic_base_url(None, server_base_url="https://gateway.example") == "https://gateway.example",
      anthropic_base_url(None, server_base_url="https://gateway.example"))

check("no key and no server base URL defaults to api.anthropic.com",
      anthropic_base_url(None) == ANTHROPIC_BASE_URL,
      anthropic_base_url(None))

check("an empty key is treated as absent, not as an unrecognized key",
      anthropic_base_url("", server_base_url="https://gateway.example") == "https://gateway.example",
      anthropic_base_url("", server_base_url="https://gateway.example"))

check("a trailing slash on the server base URL is stripped",
      anthropic_base_url(None, server_base_url="https://gateway.example/") == "https://gateway.example",
      anthropic_base_url(None, server_base_url="https://gateway.example/"))

print()
print(f"{passes} passed, {len(failures)} failed")
if failures:
    for f in failures:
        print(f"  FAILED: {f}")
    sys.exit(1)
