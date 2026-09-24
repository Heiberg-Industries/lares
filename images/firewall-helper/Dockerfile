# CI-only build; installations pin the produced digest. Host network + NET_ADMIN,
# never privileged. Keeper passes only its own staged transaction to nft.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends nftables && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["nft"]
