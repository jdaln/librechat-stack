"""Build-time adjustments to SearXNG (run by the Dockerfile with the image's
python3 in exec form: /bin/sh in this image cannot load its libraries under the
rootless legacy builder). Each step asserts its anchor, so an upstream change
fails the build instead of silently doing nothing. Checked against searxng
2026.10.17.
"""
import importlib.util
import pathlib
import py_compile

ROOT = pathlib.Path("/usr/local/searxng/searx")
TOUCHED = set()


def patch(rel, old, new, why):
    p = ROOT / rel
    s = p.read_text()
    assert s.count(old) == 1, f"{rel}: anchor not found exactly once ({why})"
    p.write_text(s.replace(old, new))
    TOUCHED.add(p)
    print(f"patched {rel}: {why}")


def recompile():
    """The image ships precompiled bytecode in unchecked-hash mode: the
    interpreter never re-reads the source, so a patched .py alone changes
    nothing. Rebuild the cache file of every touched module."""
    for p in sorted(TOUCHED):
        cfile = importlib.util.cache_from_source(str(p))
        py_compile.compile(str(p), cfile=cfile, doraise=True, invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)
        print(f"recompiled {p.relative_to(ROOT)} -> {pathlib.Path(cfile).name}")


# Default curl_cffi client profile, consistent with data/useragents.json
# (Safari on iPadOS 26 for both the TLS side and the User-Agent header).
patch(
    "network/client.py",
    'DEFAULT_IMPERSONATE = "chrome"',
    'DEFAULT_IMPERSONATE = "safari260_ios"',
    "client profile",
)

# DDG: always send an explicit region. A bare detected language (language=auto
# -> "fr", "en", ...) resolves to "all" (wt-wt) in the engine's region table;
# derive the region from that language instead, so results still follow the
# query language. "all" itself falls back to us-en.
patch(
    "engines/duckduckgo.py",
    '        data["kl"] = "wt-wt"\n',
    '        data["kl"] = params["cookies"]["kl"] = _region_for_locale(params["searxng_locale"])\n',
    "ddg region fallback",
)
ddg = ROOT / "engines/duckduckgo.py"
TOUCHED.add(ddg)
ddg.write_text(
    ddg.read_text()
    + '''

def _region_for_locale(locale: str) -> str:
    """DDG region (kl, "<country>-<language>") for a locale that has no region of its own."""
    lang = (locale or "").replace("_", "-").split("-")[0].lower()
    if lang in ("", "all", "auto"):
        return "us-en"
    regions = set(traits.regions.values())
    for candidate in (f"{lang}-{lang}", f"us-{lang}", f"uk-{lang}"):
        if candidate in regions:
            return candidate
    for region in sorted(regions):
        if region.endswith("-" + lang):
            return region
    return "us-en"
'''
)
print("patched engines/duckduckgo.py: region helper")

# Bing: same idea. Without a resolvable region it sends no market at all and
# Bing picks one from the egress IP (German results for a French query from a
# Swiss address). Derive the market from the detected language instead.
patch(
    "engines/bing.py",
    '    engine_region = traits.get_region(params["searxng_locale"], traits.all_locale)\n',
    '    engine_region = _region_for_locale(params["searxng_locale"])\n',
    "bing region fallback",
)
bing = ROOT / "engines/bing.py"
TOUCHED.add(bing)
bing.write_text(
    bing.read_text()
    + '''

def _region_for_locale(locale: str) -> str:
    """Bing market ("<language>-<country>") for a locale; derived from the language when the locale has no region."""
    region = traits.get_region(locale, None)
    if region and region != "clear":
        return region
    lang = (locale or "").replace("_", "-").split("-")[0].lower()
    if lang in ("", "all", "auto"):
        return "en-us"
    markets = set(traits.regions.values())
    for candidate in (f"{lang}-{lang}", f"{lang}-us", f"{lang}-gb"):
        if candidate in markets:
            return candidate
    for market in sorted(markets):
        if market.startswith(lang + "-"):
            return market
    return "en-us"
'''
)
print("patched engines/bing.py: region helper")

recompile()
