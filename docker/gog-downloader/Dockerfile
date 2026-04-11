# ===========================================
# StardropHost | docker/gog-downloader/Dockerfile
# ===========================================
# Builds the GOG game downloader container.
# Build context must be the parent of StardropHost/ so the
# GogDownloader-main PHP source (in GOG/) is reachable.
#
# In docker-compose.yml:
#   build:
#     context: ..
#     dockerfile: StardropHost/docker/gog-downloader/Dockerfile
# ===========================================

FROM composer:2 AS vendor
WORKDIR /app
COPY GOG/GogDownloader-main/composer.json GOG/GogDownloader-main/composer.lock ./
RUN composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader

FROM php:8.4-alpine

ENV CONFIG_DIRECTORY=/Configs
ENV DOWNLOAD_DIRECTORY=/Downloads

RUN apk add --no-cache libxml2-dev sqlite-dev nodejs \
    && docker-php-ext-install simplexml pcntl pdo_sqlite \
    && echo 'memory_limit = -1' > /usr/local/etc/php/conf.d/docker-php-memory-limit.ini

WORKDIR /app
COPY GOG/GogDownloader-main/ /app/
COPY --from=vendor /app/vendor /app/vendor

RUN mkdir -p "$CONFIG_DIRECTORY" "$DOWNLOAD_DIRECTORY" \
    && chmod 0777 "$CONFIG_DIRECTORY" "$DOWNLOAD_DIRECTORY"

COPY StardropHost/docker/gog-downloader/server.js /server.js

ENTRYPOINT ["node", "/server.js"]
