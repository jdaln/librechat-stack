"""Reorder the DDG engine's HTTP headers (searxng#6596).

DuckDuckGo started fingerprinting HTTP header order (~2026-08-30) and serves
an HTTP 202 challenge to requests whose User-Agent precedes Accept-Language.
Verified empirically through the stack's own egress proxy: an otherwise
identical request answers 200 with results when User-Agent is sent after
Accept-Language, and 202 with zero results when it is sent early. TLS cipher
order (searxng's shuffle_ciphers) was tested and is NOT a factor.

Two edits are required, because httpx's Headers.update() keeps an existing
key's original wire position:

1. searx/network/client.py — drop the client-level default User-Agent after
   the AsyncClient is built. Otherwise every request-level User-Agent merely
   replaces the default's VALUE while inheriting its early POSITION, and no
   engine-level reordering can ever reach the wire. Safe globally: every
   online-engine request sets its own UA first (processors/online.py).
2. searx/engines/duckduckgo.py — re-insert User-Agent after the
   Accept-Language block so it lands last in the request dict, hence last on
   the wire. The UA value is unchanged (the vqd cache keys off the value).

Applied at image build by optional/local-search/searxng/Dockerfile. Exits
non-zero when an anchor is missing or ambiguous so the build fails loudly on
upstream drift (repo convention: no silent no-op patching). Drop this patch
once upstream ships a fix (searxng#6620 curl_cffi migration or #5476
curl-impersonate) and the SEARXNG_IMAGE pin is bumped accordingly.
"""

import sys


def patch_file(path, anchor, replacement, extra_required=None):
    src = open(path, encoding="utf-8").read()
    count = src.count(anchor)
    if count != 1 or (extra_required and extra_required not in src):
        sys.exit(
            f"DDG header-order patch: anchor found {count} time(s) in {path} "
            "(need exactly 1"
            + (f", plus {extra_required!r}" if extra_required else "")
            + ") - upstream changed, update the patch"
        )
    open(path, "w", encoding="utf-8").write(src.replace(anchor, replacement))
    print(f"DDG header-order patch applied to {path}")


ENGINE_PATH = "/usr/local/searxng/searx/engines/duckduckgo.py"
ENGINE_ANCHOR = (
    '    ui_lang = params["searxng_locale"]\n'
    '    if not headers.get("Accept-Language"):\n'
    '        headers["Accept-Language"] = f"{ui_lang},{ui_lang}-{ui_lang.upper()};q=0.7"\n'
)
ENGINE_INSERT = ENGINE_ANCHOR + (
    "\n"
    "    # DDG fingerprints HTTP header order (searxng#6596): re-insert User-Agent\n"
    "    # so it is sent after Accept-Language, matching browser ordering.\n"
    '    headers.pop("User-Agent", None)\n'
    '    headers["User-Agent"] = _HTTP_User_Agent\n'
)

CLIENT_PATH = "/usr/local/searxng/searx/network/client.py"
CLIENT_ANCHOR = (
    "    return httpx.AsyncClient(\n"
    "        transport=transport,\n"
    "        mounts=mounts,\n"
    "        max_redirects=max_redirects,\n"
    "        event_hooks=event_hooks,\n"
    "    )\n"
)
CLIENT_REPLACEMENT = (
    "    client = httpx.AsyncClient(\n"
    "        transport=transport,\n"
    "        mounts=mounts,\n"
    "        max_redirects=max_redirects,\n"
    "        event_hooks=event_hooks,\n"
    "    )\n"
    "    # httpx merges request headers into these client defaults and an existing\n"
    "    # key keeps the default's early wire position. Engines always set their\n"
    "    # own User-Agent per request (processors/online.py), and DDG requires it\n"
    "    # to be sent LAST (searxng#6596) - so drop the client-level default.\n"
    '    if "user-agent" in client.headers:\n'
    '        del client.headers["user-agent"]\n'
    "    return client\n"
)

patch_file(ENGINE_PATH, ENGINE_ANCHOR, ENGINE_INSERT, extra_required="_HTTP_User_Agent")
patch_file(CLIENT_PATH, CLIENT_ANCHOR, CLIENT_REPLACEMENT)
