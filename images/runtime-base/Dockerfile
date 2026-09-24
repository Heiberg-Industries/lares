# Shared slim runtime for every Lares agent image. The overlay's Dockerfile does
#   FROM ghcr.io/heiberg-industries/lares-runtime-base:<tag>  +  COPY --from=build /app /app
# Nothing here installs dependencies or builds; that happens in the role BUILDER image.
#
# Verbatim copy of the runtime stage shared by lares's services/eve-{saga,marcel,calliope}/
# Dockerfile (FROM node:24-bookworm-slim AS runtime, through WORKDIR /app, i.e. everything
# BEFORE each file's own `COPY --from=deps /app /app`) — verified byte-identical across all
# three roles' FROM/ENV/RUN/WORKDIR instructions; only their inline comments differed
# role-to-role. Everything AFTER the app COPY in those files — mkdir/chown of .eve, USER,
# WORKDIR, CMD — is per-agent and stays out of this shared base; Task 9's overlay
# Dockerfiles carry each agent's own tail (the three CMDs differ: gateway-key vs
# marcel-eve-gateway-key vs calliope-gateway-key).
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    HOME=/tmp
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
    && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 eve && useradd -u 10001 -g 10001 -m -s /usr/sbin/nologin eve

# Copy the WHOLE workspace tree, preserving its layout — the same reasoning every role's own
# Dockerfile documents (lares@HEAD services/eve-{saga,marcel,calliope}/Dockerfile, immediately
# after this same groupadd/useradd RUN — each also names agent-runtime's Dockerfile and, for
# marcel/calliope, the prior role(s)' Dockerfiles as doing the same thing). pnpm does not put
# real packages under services/<role>/node_modules; it puts RELATIVE symlinks that escape that
# directory and land in the workspace-root store, e.g.
#   services/<role>/node_modules/eve -> ../../../node_modules/.pnpm/eve@0.32.0_.../node_modules/eve
# and the .bin/eve shim execs "$basedir/../eve/bin/eve.js" through exactly that symlink.
# Copying services/<role> alone to /app would copy those symlinks verbatim, so every one of
# them resolves ABOVE /app to nothing — eve would not even load, and the container would
# crash-loop on boot. (Each role's own COPY --from=build /app /app in the overlay Dockerfile —
# Task 9 — carries this same risk if it ever copied a narrower path instead.)
WORKDIR /app
