ARG LIBRECHAT_IMAGE=registry.librechat.ai/danny-avila/librechat-dev-api:latest@sha256:d71f74c750d5ea8f42310444ebe88d855c3d00ea57e30f5e4c759e92658b4920
FROM ${LIBRECHAT_IMAGE}

COPY optional/librechat/registerSW.noop.js /app/client/dist/registerSW.js
COPY optional/local-search/librechat-patches/search.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/search/search.cjs
COPY optional/local-search/librechat-patches/tool.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/search/tool.cjs
COPY optional/code-interpreter/librechat-patches/BashExecutor.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/BashExecutor.cjs
COPY optional/code-interpreter/librechat-patches/CodeExecutor.cjs /app/node_modules/@librechat/agents/dist/cjs/tools/CodeExecutor.cjs
