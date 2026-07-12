ARG SEARXNG_IMAGE=searxng/searxng:2026.6.15-cf1410af8@sha256:37a8cc7769c4721b8f252ba935de8f01b7918e58d26b1be18dc87b5330fda65b
FROM ${SEARXNG_IMAGE}

COPY optional/local-search/searxng/settings.yml /etc/searxng/settings.yml
COPY optional/local-search/searxng/limiter.toml /etc/searxng/limiter.toml

# Demote the limiter's per-request "PASS ... matched PASSLIST" line from
# WARNING (searxng's prod log level, so it prints for every search with a
# client IP + timestamp) to debug — minimal-logging policy. The grep guard
# fails the build loudly if upstream reshapes the line.
RUN grep -q 'logger.warning("PASS %s: matched PASSLIST - %s", network.compressed, msg)' /usr/local/searxng/searx/limiter.py \
 && sed -i 's/logger.warning("PASS %s: matched PASSLIST - %s", network.compressed, msg)/logger.debug("PASS %s: matched PASSLIST - %s", network.compressed, msg)/' /usr/local/searxng/searx/limiter.py \
 && python3 -m compileall -q /usr/local/searxng/searx/limiter.py
