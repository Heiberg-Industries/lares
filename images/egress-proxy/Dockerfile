# Built only in CI. The installation pins this artifact's digest.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends squid ca-certificates && rm -rf /var/lib/apt/lists/*
CMD ["squid", "-N", "-f", "/config/squid.conf"]
