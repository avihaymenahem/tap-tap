# Tap-Tap — local container image.
#
# **This is for running the game on your own machine or tailnet, not for
# deploying it.** The ingest pipeline drives yt-dlp against YouTube, which
# breaks their ToS the moment it is publicly reachable, and /media serves whole
# copyrighted tracks to anyone who can reach the port. See PLAN.md §8.
#
# Serves the *production* build from a single port, which is the same thing
# `npm run serve:public` does — and is the only mode where the service worker
# and offline play exist at all.

# --- build ------------------------------------------------------------------
# Debian slim, not Alpine. ffmpeg-static and youtube-dl-exec download glibc
# binaries; on musl they install fine and then fail to exec at runtime.
FROM node:22-slim AS build

# `youtube-dl-exec` runs a preinstall check that aborts the install unless it
# finds a binary named exactly `python` — `python3` alone is not enough, and
# Debian does not provide the unsuffixed name. Needed here as well as at
# runtime, or `npm ci` fails before a single file is built.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Lockfile first, so a source-only edit does not re-run the install layer —
# which downloads ffmpeg and yt-dlp and is by far the slowest step.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/

RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY shared shared/
COPY server server/
COPY web web/

# App bundle, then the service worker as its own pass. See vite.sw.config.ts:
# the worker cannot be content-hashed or emitted as an ES module.
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime

# yt-dlp ships as a Python zipapp, so the interpreter is a real runtime
# dependency even though nothing in this project is written in Python. Without
# it ingest fails only when a download is attempted, long after the image looks
# healthy. ca-certificates is needed for the HTTPS fetch to YouTube.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python-is-python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Everything persistent lives under one directory already — audio, thumbnails,
# beatmap.json, analysis.json, waveform.json and themes.json — so a single
# volume covers the lot. `MEDIA_DIR` is read at module load in storage.ts.
ENV MEDIA_DIR=/data

WORKDIR /app

# node_modules is copied rather than reinstalled: it was built for this same
# base image, and reinstalling would re-download ffmpeg and yt-dlp for no gain.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
# Only the built frontend. `index.ts` resolves WEB_DIST as ../../web/dist
# relative to itself, so this path is not free to change.
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/web/package.json ./web/package.json

# Created so the container still starts when no volume is attached — it will
# simply have nowhere durable to put songs.
RUN mkdir -p /data

EXPOSE 8787

# Run as the image's non-root user, and give it the volume. Root inside a
# container that downloads arbitrary media from the internet is not a risk worth
# taking for zero benefit.
RUN chown -R node:node /data /app
USER node

# tsx rather than compiled output, because that is how the server actually runs
# (`npm start`) and it keeps one execution path instead of two.
CMD ["npx", "tsx", "server/src/index.ts"]
