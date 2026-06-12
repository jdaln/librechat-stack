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

  # Supervise both processes: if either squid or dnsmasq dies, exit so Docker
  # restarts the container. A fire-and-forget dnsmasq would silently take down
  # DNS for every container pointing at it while squid keeps looking healthy.
  dnsmasq "${dnsmasq_args[@]}" &
  dnsmasq_pid=$!

  /usr/local/bin/entrypoint.sh "$@" &
  squid_pid=$!

  forward_term() {
    kill -TERM "${squid_pid}" "${dnsmasq_pid}" 2>/dev/null || true
  }
  trap forward_term TERM INT

  set +e
  wait -n "${dnsmasq_pid}" "${squid_pid}"
  rc=$?
  set -e
  forward_term
  wait || true
  exit "${rc}"
fi

exec /usr/local/bin/entrypoint.sh "$@"
