ARG SEARXNG_IMAGE=searxng/searxng:2026.6.15-cf1410af8@sha256:37a8cc7769c4721b8f252ba935de8f01b7918e58d26b1be18dc87b5330fda65b
FROM ${SEARXNG_IMAGE}

COPY optional/local-search/searxng/settings.yml /etc/searxng/settings.yml
COPY optional/local-search/searxng/limiter.toml /etc/searxng/limiter.toml

# DDG serves CAPTCHA to searxng's header order since ~2026-08-30 (searxng#6596);
# upstream fix unmerged as of 2026-09-02. The script exits non-zero (failing the
# build) if the upstream code drifted from its anchor.
COPY optional/local-search/searxng/patch_ddg_header_order.py /tmp/patch_ddg_header_order.py
RUN python3 /tmp/patch_ddg_header_order.py \
 && python3 -m compileall -q /usr/local/searxng/searx/engines/duckduckgo.py /usr/local/searxng/searx/network/client.py \
 && rm /tmp/patch_ddg_header_order.py
