# ===========================================
# StardropHost | docker/gog-downloader/Dockerfile
# ===========================================
# Builds the GOG game downloader container.
# GogDownloader is cloned from GitHub at build time —
# no local source files required.
# Build context is the StardropHost project directory.
#
# In docker-compose.yml:
#   build:
#     context: .
#     dockerfile: docker/gog-downloader/Dockerfile
# ===========================================

FROM composer:2 AS vendor
WORKDIR /app
RUN apk add --no-cache git \
    && git clone --depth=1 https://github.com/RikudouSage/GogDownloader.git /app
RUN composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader

FROM php:8.4-alpine

ENV CONFIG_DIRECTORY=/Configs
ENV DOWNLOAD_DIRECTORY=/Downloads

RUN apk add --no-cache libxml2-dev sqlite-dev nodejs bash unzip \
    && docker-php-ext-install simplexml pcntl pdo_sqlite \
    && echo 'memory_limit = -1' > /usr/local/etc/php/conf.d/docker-php-memory-limit.ini

WORKDIR /app
COPY --from=vendor /app /app/

RUN mkdir -p "$CONFIG_DIRECTORY" "$DOWNLOAD_DIRECTORY" \
    && chmod 0777 "$CONFIG_DIRECTORY" "$DOWNLOAD_DIRECTORY"

COPY docker/gog-downloader/server.js /server.js

ENTRYPOINT ["node", "/server.js"]
