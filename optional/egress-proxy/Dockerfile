# Default matches the digest-pinned compose build arg so bare `docker build`
# is reproducible too.
ARG EGRESS_PROXY_IMAGE=ubuntu/squid:latest@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029

FROM ${EGRESS_PROXY_IMAGE}

ARG EGRESS_PROXY_IMAGE

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dnsmasq-base \
  && rm -rf /var/lib/apt/lists/*

COPY optional/egress-proxy/entrypoint.sh /usr/local/bin/librechat-egress-entrypoint.sh
RUN chmod 0755 /usr/local/bin/librechat-egress-entrypoint.sh

LABEL org.opencontainers.image.base.name="${EGRESS_PROXY_IMAGE}"

ENTRYPOINT ["librechat-egress-entrypoint.sh"]
