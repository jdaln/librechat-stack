ARG SEARXNG_IMAGE=searxng/searxng:latest
FROM ${SEARXNG_IMAGE}

COPY optional/local-search/searxng/settings.yml /etc/searxng/settings.yml
COPY optional/local-search/searxng/limiter.toml /etc/searxng/limiter.toml
