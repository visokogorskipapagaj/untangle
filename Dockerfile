FROM node:22-alpine

# No install step and no build: the game has no dependencies, so copying the source is the
# entire image. Only what the server actually serves is copied — the static allowlist in
# server/index.js covers index.html, styles.css and src/, and nothing else needs to exist.
WORKDIR /app
COPY package.json ./
COPY index.html styles.css ./
COPY src ./src
COPY server ./server

# The pool lives outside the source tree so that redeploying the image cannot carry it away
# with it. Mount a volume here or the times last exactly as long as the container does.
ENV UNTANGLE_DATA=/data/pool.json \
    PORT=8000

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8000

# Costs one request every 30s against its own rate-limit bucket: it arrives on the loopback
# with no X-Forwarded-For, so it is never counted against a real player's allowance.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/pars').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form on purpose. In shell form /bin/sh would be PID 1 and swallow SIGTERM, so
# `docker stop` would kill the process without the shutdown flush ever running — and that
# flush is the only thing that gets the last couple of seconds of submitted times onto
# disk. Exec form makes node PID 1, so it receives the signal itself.
CMD ["node", "server/index.js"]
