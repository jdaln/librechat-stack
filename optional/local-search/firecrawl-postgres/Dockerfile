ARG FIRECRAWL_POSTGRES_SCHEMA_IMAGE=ghcr.io/firecrawl/nuq-postgres:latest@sha256:f9388bd25ae2e1f1d034518236f993ce236173c1d8800ce24092ea6643a95a33
ARG FIRECRAWL_POSTGRES_BASE_IMAGE=postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641

FROM --platform=linux/amd64 ${FIRECRAWL_POSTGRES_SCHEMA_IMAGE} AS upstream

FROM ${FIRECRAWL_POSTGRES_BASE_IMAGE}

COPY --from=upstream /docker-entrypoint-initdb.d/010-nuq.sql /docker-entrypoint-initdb.d/010-nuq.sql

RUN awk '\
  /CREATE EXTENSION IF NOT EXISTS pg_cron;/ { next } \
  /SELECT cron[.]schedule/ { skipping = 1; if ($0 ~ /[$][$][)];/) skipping = 0; next } \
  skipping { if ($0 ~ /[$][$][)];/) skipping = 0; next } \
  { print }' \
  /docker-entrypoint-initdb.d/010-nuq.sql > /tmp/010-nuq.sql \
  && mv /tmp/010-nuq.sql /docker-entrypoint-initdb.d/010-nuq.sql
