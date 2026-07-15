'use strict';
// Minimal MCP stdio server exposing a single `open_url` tool that fetches a
// web page through the stack's Firecrawl scraper (so egress policy, proxy
// audit, and SSRF protections all apply). Runs inside the LibreChat api
// container; no dependencies beyond Node's stdlib.
//
// Why this exists: small models reliably ignore the `url` parameter on the
// web_search tool, but they do call a distinctly-named fetch tool. Attached
// to agents via librechat.yaml's mcpServers.

const FIRECRAWL_API_URL = (process.env.FIRECRAWL_API_URL || 'http://firecrawl-api:3002').replace(/\/$/, '');
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const DEFAULT_CHARS = Math.max(2000, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_FETCH_CHAR_LIMIT ?? '16000', 10) || 16000);
// Per-call ceiling for max_chars (~15k tokens). Keeps a single fetch from
// flooding the context while letting the model deliberately go deep.
const HARD_MAX_CHARS = 60000;

const TOOL = {
  name: 'open_url',
  description:
    'Open an exact web page (http/https) and return its content as markdown. ' +
    'Use this whenever the user provides a link or you know the precise page address ' +
    '(repository pages, listings, documentation, articles). One call per page. ' +
    'If the result says it was truncated, call again with `start` set to the indicated ' +
    'offset to continue reading, or with a larger `max_chars`.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The exact http(s) address of the page to open.' },
      max_chars: {
        type: 'integer',
        description: `Optional content budget for this call (default ${DEFAULT_CHARS}, max ${HARD_MAX_CHARS}). Raise it when the default truncates information you need.`,
      },
      start: {
        type: 'integer',
        description: 'Optional character offset to continue reading a previously truncated page from (use the offset given in the truncation notice).',
      },
    },
    required: ['url'],
  },
};

// Densify scraped markdown: replace images with their alt text (alt often
// carries the information, e.g. star ratings), drop empty-text links (icon/
// graph decorations), remove GitHub's static no-JS session/error templates,
// and collapse the leftover blank runs. Applied before slicing so the char
// budget is spent on content.
function cleanMarkdown(md) {
  return md
    .replace(/!\[([^\]]*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '$1')
    .replace(/\[\s*\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
    .replace(/You (?:signed (?:in|out) with|switched accounts on) another tab or window\.?\s*\[Reload\]\([^)]*\)\s*to refresh your session\.?/g, '')
    .replace(/#{0,4}\s*Uh oh!\s*(\[?There was an error while loading\.?\]?(\([^)]*\))?\s*)?(\[?Please reload this page\]?(\([^)]*\))?\s*)?\.?/g, '')
    .replace(/\[Skip to content\]\([^)]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function openUrl(rawUrl, maxChars, start) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be opened');
  }
  const response = await fetch(`${FIRECRAWL_API_URL}/v2/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      url: parsed.href,
      formats: ['markdown'],
      onlyMainContent: true,
      blockAds: true,
      removeBase64Images: true,
      timeout: 30000,
    }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.data) {
    // Hostname only — full URLs stay out of anything that may be logged.
    throw new Error(`Could not fetch ${parsed.hostname} (HTTP ${response.status}${data.error ? ': ' + String(data.error).slice(0, 120) : ''})`);
  }
  const markdown = cleanMarkdown(data.data.markdown ?? '');
  const title = data.data.metadata?.title ?? parsed.hostname;
  const budget = Math.min(Math.max(2000, maxChars || DEFAULT_CHARS), HARD_MAX_CHARS);
  const offset = Math.max(0, Math.min(start || 0, markdown.length));
  const end = Math.min(offset + budget, markdown.length);
  const slice = markdown.slice(offset, end).trim();
  const rangeNote = offset > 0 || end < markdown.length
    ? `\n[Showing characters ${offset}–${end} of ${markdown.length}]`
    : '';
  const continuation = end < markdown.length
    ? `\n\n[... truncated — ${markdown.length - end} characters remain. Call open_url again with start=${end} to continue, or raise max_chars (limit ${HARD_MAX_CHARS}).]`
    : '';
  return `# ${title}\nURL: ${parsed.href}${rangeNote}\n\n${slice}${continuation}`;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'browser', version: '1.0.0' },
    });
  } else if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
    // notifications get no response
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: [TOOL] });
  } else if (method === 'tools/call') {
    if (params?.name !== TOOL.name) {
      replyError(id, -32602, `Unknown tool: ${params?.name}`);
      return;
    }
    try {
      const args = params?.arguments ?? {};
      const text = await openUrl(args.url ?? '', Number(args.max_chars) || 0, Number(args.start) || 0);
      reply(id, { content: [{ type: 'text', text }], isError: false });
    } catch (error) {
      reply(id, {
        content: [{ type: 'text', text: `open_url failed: ${error.message}` }],
        isError: true,
      });
    }
  } else if (id !== undefined) {
    replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
let pending = 0;
let stdinEnded = false;
function maybeExit() {
  if (stdinEnded && pending === 0) {
    process.exit(0);
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) {
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    pending += 1;
    handle(msg)
      .catch((error) => {
        if (msg.id !== undefined) {
          replyError(msg.id, -32603, error.message);
        }
      })
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  }
});
// Drain in-flight requests before exiting on EOF.
process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
