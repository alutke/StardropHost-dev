# ===========================================
# StardropHost | docker/manager/Dockerfile
# ===========================================
# Lightweight sidecar container with Docker
# socket access for container lifecycle
# management via the web panel.
# ===========================================

FROM docker:27-cli

RUN apk add --no-cache nodejs bash

WORKDIR /app

COPY server.js /app/server.js

EXPOSE 18700

ENTRYPOINT ["node", "/app/server.js"]