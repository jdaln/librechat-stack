ARG SEARXNG_IMAGE=searxng/searxng:latest@sha256:3547509b419cd6a67333d6d68bd1ffad8d46d3669d82e7a7bd538f7b45827432
FROM ${SEARXNG_IMAGE}

COPY optional/local-search/searxng/settings.yml /etc/searxng/settings.yml
COPY optional/local-search/searxng/limiter.toml /etc/searxng/limiter.toml
# NOTE: the DDG header-order patch (searxng#6596 workaround) was removed
# 2026-09-08: upstream merged the curl_cffi migration (searxng#6620) on
# 2026-09-04, which gives engine requests browser-grade TLS/HTTP fingerprints
# and supersedes the header reorder. See git history for the old patch.
