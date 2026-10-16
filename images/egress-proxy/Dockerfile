# Built only in CI. The installation pins this artifact's digest.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
# Distributor-managed Squid includes the HTTP framing fix from 7.6. Never mix
# unstable Debian packages into the proxy or build third-party code on a host.
RUN apk upgrade --no-cache && apk add --no-cache squid=7.6-r0 ca-certificates
CMD ["squid", "-N", "-f", "/config/squid.conf"]
