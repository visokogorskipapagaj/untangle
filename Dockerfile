# The UI is a folder of components per element — an .html template, an .scss sheet and a .ts
# class each — so there is a build now, and it happens here rather than being something
# somebody has to remember before `docker build`.
#
# Two stages, because the toolchain is build-time only: the runtime image gets the compiled
# game and the server, and none of the ~35 packages it took to produce it.
FROM node:22-alpine AS build

WORKDIR /app

# The lockfile first and on its own, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build


FROM node:22-alpine

WORKDIR /app
COPY package.json ./

# The built game, which is the only thing the server serves — see PUBLIC_DIR in
# server/index.js. The sources it was built from are deliberately not here.
COPY --from=build /app/dist ./dist

# The server, and the game modules it shares with the client: the pool's own arithmetic —
# what a plausible time is, how pars are pooled — lives in src/ and both sides read it, which
# is what stops the server and the browser disagreeing about what a par is.
COPY server ./server
COPY src ./src

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

# `serve` rather than `start`, which would rebuild — the build already happened upstairs, and
# the toolchain that did it is not in this image.
#
# Exec form on purpose. In shell form /bin/sh would be PID 1 and swallow SIGTERM, so
# `docker stop` would kill the process without the shutdown flush ever running — and that
# flush is the only thing that gets the last couple of seconds of submitted times onto disk.
# Exec form makes node PID 1, so it receives the signal itself.
CMD ["node", "server/index.js"]
