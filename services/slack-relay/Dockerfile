# services/slack-relay/Dockerfile
#
# The ADR-0011 relay: public Slack webhooks terminate on ops-1 and exactly one path is
# forwarded over the tailnet to eve-saga on agent-1 (172.18.0.24 behind tailscale serve).
#
# Build context = the REPO ROOT, matching the sibling services Coolify already builds:
#   docker build -f services/slack-relay/Dockerfile .
#
# There is no application here on purpose. The relay must stay a dumb pipe — no
# verification, no rewriting, nothing that could drift from what eve expects.

FROM nginx:1.27-alpine

# nginx's own config is replaced wholesale; the stock default.conf would otherwise serve a
# welcome page on / and quietly widen the public surface.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY services/slack-relay/nginx.conf /usr/share/lares/relay.conf.example
COPY --chmod=755 services/slack-relay/start.sh /usr/local/bin/lares-relay

# One writable directory for pid + proxy temp files, owned by the runtime user.
RUN mkdir -p /var/lib/nginx-relay && chown nginx:nginx /var/lib/nginx-relay

# Run as the image's existing unprivileged user. Port 8080 (not 80) so no capability to
# bind a privileged port is needed — and it matches the sibling services' Coolify port.
USER nginx
EXPOSE 8080

# Validate the config, and do it AS the runtime user so any file the check leaves behind is
# owned by the account that has to rewrite it at boot. Running this as root is what broke
# the first build of this image: `nginx -t` dropped a root-owned pid file into sticky /tmp,
# which the nginx user then could not replace.
RUN nginx -t -c /usr/share/lares/relay.conf.example

ENTRYPOINT ["/usr/local/bin/lares-relay"]
