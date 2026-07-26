ARG SEARXNG_IMAGE=searxng/searxng:2026.6.15-cf1410af8@sha256:37a8cc7769c4721b8f252ba935de8f01b7918e58d26b1be18dc87b5330fda65b
FROM ${SEARXNG_IMAGE}

COPY optional/local-search/searxng/settings.yml /etc/searxng/settings.yml
COPY optional/local-search/searxng/limiter.toml /etc/searxng/limiter.toml
