# Patched Firecrawl playwright-service: launch Chromium WITH the egress proxy.
#
# Upstream sets the scrape proxy per *context* (browser.newContext({ proxy })) but
# launches the browser with none. Chromium ignores a per-context proxy unless the
# browser was *launched* with one, so the per-context setting silently does nothing.
# Two consequences:
#   - Functionality: where the browser has NO direct internet (e.g. behind this
#     stack's Squid egress proxy), every scrape goes out directly, is blocked, and
#     returns empty — web search falls back to thin SearXNG snippets.
#   - Security: where the browser DOES have direct internet (e.g. Mac/Colima dev),
#     scrapes egress directly and BYPASS the Squid egress allowlist/logging the stack
#     relies on to constrain the scraper.
# Fixed by launching with the PROXY_SERVER the compose already provides, so the
# scraper always egresses through Squid. (Upstream fix: same one line in firecrawl
# apps/playwright-service-ts/api.ts: chromium.launch({ proxy: { server: ... } }).)
ARG FIRECRAWL_PLAYWRIGHT_IMAGE=ghcr.io/firecrawl/playwright-service:latest@sha256:9e0737bc09df28275aab29726b1c0824a7725113945434e843385d487b7f7ec6
FROM ${FIRECRAWL_PLAYWRIGHT_IMAGE}

USER root
RUN sed -i 's#headless: true,#headless: true, proxy: process.env.PROXY_SERVER ? { server: process.env.PROXY_SERVER } : undefined,#' /usr/src/app/dist/api.js \
 && grep -q 'proxy: process.env.PROXY_SERVER' /usr/src/app/dist/api.js
