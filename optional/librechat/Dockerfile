ARG LIBRECHAT_IMAGE=ghcr.io/danny-avila/librechat:v0.8.6@sha256:208e0f63eefd0143191768b22675d126250eb893defae2469598adb09b17e85d
FROM ${LIBRECHAT_IMAGE}

COPY optional/librechat/registerSW.noop.js /app/client/dist/registerSW.js
COPY optional/local-search/librechat-patches/search.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/search/search.cjs
COPY optional/local-search/librechat-patches/tool.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/search/tool.cjs
COPY optional/local-search/mcp/open-url.cjs /app/mcp/open-url.cjs
COPY optional/code-interpreter/librechat-patches/BashExecutor.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/BashExecutor.cjs
COPY optional/code-interpreter/librechat-patches/CodeExecutor.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/CodeExecutor.cjs

# LibreChat runs as uid=1000 (node). The upstream image doesn't pre-create
# /app/uploads, so the lbc_api_uploads named volume mounts root-owned on
# first creation and the first user-upload attempt EACCES on
# `/app/uploads/temp/<userId>/`. Create + chown the mount point here so
# Docker seeds the volume with 1000:1000 ownership on first creation.
# (Existing volumes need a one-shot chown — see README.)
RUN mkdir -p /app/uploads && chown -R 1000:1000 /app/uploads
