ARG SEARXNG_IMAGE=searxng/searxng:latest@sha256:8bdd9aa136b2dc3b9332cf24714fa34a375b8a1949a1201ec900c24d7378596e
FROM ${SEARXNG_IMAGE}

# The upstream image declares /etc/searxng as a VOLUME: Docker fills that
# anonymous volume from the image on the first container create only, and
# compose keeps it across recreates, so files copied there never update a
# running deployment. The config SearXNG reads therefore lives outside that
# path (SEARXNG_SETTINGS_PATH in optional/local-search/compose.yml; a folder, so
# limiter.toml is found next to settings.yml). The copy into /etc/searxng only
# seeds the volume: the entrypoint exits when it finds no settings.yml there,
# and it cannot create one itself on this host (its shell utilities do not run
# under the rootless legacy builder, see compose.local-search.rootless.yml).
COPY optional/local-search/searxng/settings.yml /usr/local/searxng/etc/settings.yml
COPY optional/local-search/searxng/limiter.toml /usr/local/searxng/etc/limiter.toml
COPY optional/local-search/searxng/settings.yml /etc/searxng/settings.yml
COPY optional/local-search/searxng/limiter.toml /etc/searxng/limiter.toml

# Consistent client profile for engine requests (Safari on iPadOS 26: TLS side
# via curl_cffi, header side via useragents.json) and small per-engine request
# adjustments; see patch_engines.py. Exec form with python3, no shell: under the
# rootless legacy builder /bin/sh in this image cannot load its shared libraries
# (see compose.local-search.rootless.yml).
COPY optional/local-search/searxng/useragents.json /usr/local/searxng/searx/data/useragents.json
COPY optional/local-search/searxng/patch_engines.py /tmp/patch_engines.py
# The image's own interpreter, so the recompiled bytecode matches its version.
RUN ["/usr/local/searxng/.venv/bin/python", "/tmp/patch_engines.py"]
# NOTE: the DDG header-order patch (searxng#6596 workaround) was removed
# 2026-09-08: upstream merged the curl_cffi migration (searxng#6620) on
# 2026-09-04, which gives engine requests browser-grade TLS/HTTP fingerprints
# and supersedes the header reorder. See git history for the old patch.
