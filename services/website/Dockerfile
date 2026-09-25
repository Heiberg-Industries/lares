FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/ui/package.json packages/ui/package.json
COPY services/website/package.json services/website/package.json
RUN pnpm --filter @lares/website... install --frozen-lockfile
COPY packages/ui/src packages/ui/src
COPY services/website services/website
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_BOOKING_ENABLED=false
ARG NEXT_PUBLIC_SITE_INDEXABLE=false
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_BOOKING_ENABLED=$NEXT_PUBLIC_BOOKING_ENABLED
ENV NEXT_PUBLIC_SITE_INDEXABLE=$NEXT_PUBLIC_SITE_INDEXABLE
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @lares/website build

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY services/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/services/website/out /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
