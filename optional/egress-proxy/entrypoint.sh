#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EGRESS_DNS_ENABLE:-0}" == "1" ]]; then
  listen_address="${EGRESS_DNS_LISTEN_ADDRESS:-0.0.0.0}"
  upstreams="${EGRESS_DNS_UPSTREAMS:-1.1.1.1,1.0.0.1}"

  dnsmasq_args=(
    --keep-in-foreground
    --no-daemon
    --no-hosts
    --no-resolv
    --bind-interfaces
    --pid-file=
    --cache-size="${EGRESS_DNS_CACHE_SIZE:-1000}"
    --listen-address="${listen_address}"
  )

  IFS=',' read -r -a upstream_array <<< "${upstreams}"
  for upstream in "${upstream_array[@]}"; do
    [[ -n "${upstream}" ]] && dnsmasq_args+=(--server="${upstream}")
  done

  dnsmasq "${dnsmasq_args[@]}" &
fi

exec /usr/local/bin/entrypoint.sh "$@"
