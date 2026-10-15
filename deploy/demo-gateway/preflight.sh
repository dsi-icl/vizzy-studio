#!/usr/bin/env bash
# Run from a client network before changing DNS. This verifies the real TLS
# certificate and that the Vizzy gateway denies anonymous demo requests.
set -euo pipefail

vizzy_ip="${1:-146.169.9.69}"
demo_host='vizzy-studio-demos.dsi.ic.ac.uk'

for demo_path in '/bitcoin/' '/bitcoin/assets/no-session.js' '/api/no-session'; do
    if ! result="$(curl --silent --show-error --noproxy '*' \
        --connect-timeout 3 --max-time 10 \
        --resolve "${demo_host}:443:${vizzy_ip}" \
        --output /dev/null --write-out '%{http_code} %{remote_ip}' \
        "https://${demo_host}${demo_path}")"; then
        printf 'FAIL: HTTPS or certificate validation failed for %s\n' "$demo_path" >&2
        exit 1
    fi

    read -r http_code remote_ip <<< "$result"
    printf '%s: HTTP %s from %s\n' "$demo_path" "$http_code" "$remote_ip"
    if [[ "$http_code" != '401' || "$remote_ip" != "$vizzy_ip" ]]; then
        printf 'FAIL: expected HTTP 401 from Vizzy VM %s\n' "$vizzy_ip" >&2
        exit 1
    fi
done

printf 'PASS: TLS and anonymous gateway checks passed. Authorized browser flows still need testing.\n'
