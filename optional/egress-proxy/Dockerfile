ARG EGRESS_PROXY_IMAGE=ubuntu/squid:latest

FROM ${EGRESS_PROXY_IMAGE}

ARG EGRESS_PROXY_IMAGE

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dnsmasq-base \
  && rm -rf /var/lib/apt/lists/*

COPY optional/egress-proxy/entrypoint.sh /usr/local/bin/librechat-egress-entrypoint.sh
RUN chmod 0755 /usr/local/bin/librechat-egress-entrypoint.sh

LABEL org.opencontainers.image.base.name="${EGRESS_PROXY_IMAGE}"

ENTRYPOINT ["librechat-egress-entrypoint.sh"]
