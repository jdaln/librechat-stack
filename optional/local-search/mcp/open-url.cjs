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
    '(repository pages, listings, documentation, articles, social media posts and profiles). One call per page. ' +
    'Links to X/Twitter, Bluesky and Instagram, and pages that answer with a login or JavaScript wall, are read ' +
    'through alternative front-ends or archive snapshots automatically; the result states which source answered. ' +
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

// ---------------------------------------------------------------------------
// Sources. Social networks and some sites no longer serve their content to a
// headless browser (login walls, JavaScript-only shells, bot challenges). For
// those, read through an alternative front-end or an archive snapshot, in a
// fixed order, and say which source answered. Verified 2026-10-18.
// ---------------------------------------------------------------------------

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com']);
const X_RESERVED = new Set(['home', 'explore', 'search', 'i', 'settings', 'login', 'signup', 'notifications', 'messages', 'compose', 'hashtag', 'intent', 'share']);
const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const BSKY_HOSTS = new Set(['bsky.app', 'www.bsky.app', 'fxbsky.app']);
const BSKY_API = 'https://public.api.bsky.app/xrpc';
// Text patterns of pages that did load but hold no content for a reader.
const WALL_PATTERNS = /just a moment|enable javascript|javascript is (?:required|disabled)|log ?in to (?:continue|see|view)|sign up to see|verify you are (?:a )?human|access denied|you have been blocked|checking your browser|something went wrong\.? try (?:again|reloading)|please wait while|attention required/i;
const WALL_MIN_CHARS = 400;

function archiveTodayUrl(href) {
  return `https://archive.ph/newest/${href}`;
}
function waybackUrl(href) {
  return `https://web.archive.org/web/2/${href}`;
}

// Returns an ordered list of attempts: {label, kind: 'scrape'|'fx', url}.
function planAttempts(parsed) {
  const host = parsed.hostname.toLowerCase();
  const segs = parsed.pathname.split('/').filter(Boolean);
  const original = parsed.href;

  if (X_HOSTS.has(host)) {
    const user = segs[0] && !X_RESERVED.has(segs[0].toLowerCase()) ? segs[0] : null;
    if (user && segs[1] === 'status' && /^\d+$/.test(segs[2] || '')) {
      return [
        { label: 'api.fxtwitter.com (alternative front-end for x.com)', kind: 'fx', url: `https://api.fxtwitter.com/${user}/status/${segs[2]}` },
        { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
      ];
    }
    if (user && segs.length === 1) {
      return [
        { label: 'api.fxtwitter.com (alternative front-end for x.com)', kind: 'fx', url: `https://api.fxtwitter.com/${user}` },
        { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
      ];
    }
    return [
      { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
      { label: 'original page', kind: 'scrape', url: original },
    ];
  }

  if (BSKY_HOSTS.has(host) && segs[0] === 'profile' && segs[1]) {
    const handle = segs[1];
    if (segs[2] === 'post' && segs[3]) {
      return [
        { label: 'public.api.bsky.app (Bluesky public API)', kind: 'bsky-post', url: `${BSKY_API}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${handle}/app.bsky.feed.post/${segs[3]}`)}&depth=0&parentHeight=0` },
        { label: 'original page', kind: 'scrape', url: original },
      ];
    }
    if (segs.length === 2) {
      return [
        { label: 'public.api.bsky.app (Bluesky public API)', kind: 'bsky-profile', url: handle },
        { label: 'original page', kind: 'scrape', url: original },
      ];
    }
  }

  if (IG_HOSTS.has(host)) {
    const isPost = ['p', 'reel', 'reels', 'tv'].includes((segs[0] || '').toLowerCase());
    if (!isPost && segs.length === 1 && segs[0] && !['explore', 'accounts', 'directory'].includes(segs[0].toLowerCase())) {
      const user = segs[0].replace(/^@/, '');
      return [
        { label: 'dumpor.io (alternative front-end for instagram.com)', kind: 'scrape', url: `https://dumpor.io/v/${encodeURIComponent(user)}` },
        { label: 'tikvib.com (Picuki, alternative front-end for instagram.com)', kind: 'scrape', url: `https://www.tikvib.com/profile/${encodeURIComponent(user)}` },
        { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
      ];
    }
    return [
      { label: 'original page', kind: 'scrape', url: original },
      { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
    ];
  }

  return [
    { label: 'original page', kind: 'scrape', url: original },
    { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
    { label: 'Wayback Machine snapshot', kind: 'scrape', url: waybackUrl(original) },
  ];
}

async function scrape(url) {
  const response = await fetch(`${FIRECRAWL_API_URL}/v2/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      url,
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
    throw new Error(`HTTP ${response.status}${data.error ? ': ' + String(data.error).slice(0, 120) : ''}`);
  }
  const markdown = cleanMarkdown(data.data.markdown ?? '');
  const title = data.data.metadata?.title ?? new URL(url).hostname;
  if (markdown.length < WALL_MIN_CHARS && WALL_PATTERNS.test(`${title}\n${markdown}`)) {
    throw new Error('page served a login or JavaScript wall instead of content');
  }
  if (markdown.trim().length === 0) {
    throw new Error('page returned no readable content');
  }
  return { title, markdown };
}

function fmtCount(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '';
}

function tweetToMarkdown(t, depth = 0) {
  const a = t.author || {};
  const head = `**${a.name || ''}** (@${a.screen_name || '?'})${t.created_at ? ' · ' + t.created_at : ''}`;
  const lines = [head, '', t.text || ''];
  for (const m of t.media?.all || []) {
    const kind = m.type || 'media';
    lines.push('', `[${kind}${m.altText ? ': ' + m.altText : ''}](${m.url || ''})`);
  }
  if (t.poll?.choices) {
    lines.push('', 'Poll:', ...t.poll.choices.map((c) => `- ${c.label}: ${fmtCount(c.count)} (${c.percentage}%)`));
  }
  const stats = [
    t.replies != null ? `${fmtCount(t.replies)} replies` : '',
    t.retweets != null ? `${fmtCount(t.retweets)} reposts` : '',
    t.likes != null ? `${fmtCount(t.likes)} likes` : '',
    t.views != null ? `${fmtCount(t.views)} views` : '',
  ].filter(Boolean);
  if (stats.length) lines.push('', stats.join(' · '));
  if (t.quote && depth < 1) {
    lines.push('', '> Quoted post:', ...tweetToMarkdown(t.quote, depth + 1).split('\n').map((l) => '> ' + l));
  }
  if (t.url) lines.push('', t.url);
  return lines.join('\n');
}

function profileToMarkdown(u) {
  const lines = [`**${u.name || ''}** (@${u.screen_name || '?'})`, ''];
  if (u.description) lines.push(u.description, '');
  const facts = [
    u.followers != null ? `${fmtCount(u.followers)} followers` : '',
    u.following != null ? `${fmtCount(u.following)} following` : '',
    u.tweets != null ? `${fmtCount(u.tweets)} posts` : '',
    u.location ? `location: ${u.location}` : '',
    u.website?.url ? `website: ${u.website.url}` : '',
    u.joined ? `joined: ${u.joined}` : '',
  ].filter(Boolean);
  lines.push(facts.join(' · '));
  if (u.url) lines.push('', u.url);
  return lines.join('\n');
}

// FxTwitter API (JSON). Called directly: the api container's egress proxy
// allowlists api.fxtwitter.com for this purpose.
async function fetchFx(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code && data.code !== 200)) {
    throw new Error(`HTTP ${response.status}${data.message ? ': ' + String(data.message).slice(0, 120) : ''}`);
  }
  if (data.tweet) {
    return { title: `Post by @${data.tweet.author?.screen_name || '?'}`, markdown: tweetToMarkdown(data.tweet) };
  }
  if (data.user) {
    return { title: `${data.user.name || ''} (@${data.user.screen_name || '?'})`, markdown: profileToMarkdown(data.user) };
  }
  throw new Error('unexpected response');
}

// Bluesky public API (JSON, no key). The api container's egress proxy
// allowlists public.api.bsky.app for this purpose.
async function bskyGet(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(`HTTP ${response.status}${data.message ? ': ' + String(data.message).slice(0, 120) : ''}`);
  }
  return data;
}

function bskyPostToMarkdown(p) {
  const a = p.author || {};
  const r = p.record || {};
  const lines = [`**${a.displayName || ''}** (@${a.handle || '?'})${r.createdAt ? ' · ' + r.createdAt : ''}`, '', r.text || ''];
  const e = p.embed || {};
  for (const img of e.images || []) lines.push('', `[image${img.alt ? ': ' + img.alt : ''}](${img.fullsize || ''})`);
  if (e.external?.uri) lines.push('', `[link: ${e.external.title || e.external.uri}](${e.external.uri})`);
  const q = e.record?.value || e.record?.record?.value;
  const qa = e.record?.author || e.record?.record?.author;
  if (q?.text) lines.push('', `> Quoted post by @${qa?.handle || '?'}:`, ...String(q.text).split('\n').map((l) => '> ' + l));
  const stats = [
    p.replyCount != null ? `${fmtCount(p.replyCount)} replies` : '',
    p.repostCount != null ? `${fmtCount(p.repostCount)} reposts` : '',
    p.likeCount != null ? `${fmtCount(p.likeCount)} likes` : '',
  ].filter(Boolean);
  if (stats.length) lines.push('', stats.join(' · '));
  if (p.uri && a.handle) {
    lines.push('', `https://bsky.app/profile/${a.handle}/post/${p.uri.split('/').pop()}`);
  }
  return lines.join('\n');
}

async function fetchBskyPost(url) {
  const data = await bskyGet(url);
  const post = data.thread?.post;
  if (!post) throw new Error('post not found');
  return { title: `Bluesky post by @${post.author?.handle || '?'}`, markdown: bskyPostToMarkdown(post) };
}

async function fetchBskyProfile(handle) {
  const u = await bskyGet(`${BSKY_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`);
  const feed = await bskyGet(`${BSKY_API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=10&filter=posts_no_replies`).catch(() => ({ feed: [] }));
  const lines = [`**${u.displayName || ''}** (@${u.handle || handle})`, ''];
  if (u.description) lines.push(u.description, '');
  lines.push([
    u.followersCount != null ? `${fmtCount(u.followersCount)} followers` : '',
    u.followsCount != null ? `${fmtCount(u.followsCount)} following` : '',
    u.postsCount != null ? `${fmtCount(u.postsCount)} posts` : '',
    u.createdAt ? `joined: ${u.createdAt.slice(0, 10)}` : '',
  ].filter(Boolean).join(' · '));
  const posts = (feed.feed || []).map((f) => f.post).filter(Boolean);
  if (posts.length) {
    lines.push('', `## Recent posts (${posts.length})`);
    for (const p of posts) lines.push('', '---', '', bskyPostToMarkdown(p));
  }
  return { title: `${u.displayName || ''} (@${u.handle || handle}) on Bluesky`, markdown: lines.join('\n') };
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

  const attempts = planAttempts(parsed);
  const failures = [];
  let got = null;
  for (const attempt of attempts) {
    try {
      const result = attempt.kind === 'fx' ? await fetchFx(attempt.url)
        : attempt.kind === 'bsky-post' ? await fetchBskyPost(attempt.url)
        : attempt.kind === 'bsky-profile' ? await fetchBskyProfile(attempt.url)
        : await scrape(attempt.url);
      got = { ...result, attempt };
      break;
    } catch (error) {
      failures.push(`${attempt.label}: ${error.message}`);
    }
  }
  if (!got) {
    throw new Error(`Could not fetch ${parsed.hostname}. Tried: ${failures.join('; ')}`);
  }

  const { title, markdown, attempt } = got;
  const budget = Math.min(Math.max(2000, maxChars || DEFAULT_CHARS), HARD_MAX_CHARS);
  const offset = Math.max(0, Math.min(start || 0, markdown.length));
  const end = Math.min(offset + budget, markdown.length);
  const slice = markdown.slice(offset, end).trim();
  const sourceNote = attempt.label === 'original page' ? '' : `\nSource: ${attempt.label}${failures.length ? ` (after: ${failures.join('; ')})` : ''}`;
  const rangeNote = offset > 0 || end < markdown.length
    ? `\n[Showing characters ${offset}–${end} of ${markdown.length}]`
    : '';
  const continuation = end < markdown.length
    ? `\n\n[... truncated — ${markdown.length - end} characters remain. Call open_url again with start=${end} to continue, or raise max_chars (limit ${HARD_MAX_CHARS}).]`
    : '';
  return `# ${title}\nURL: ${parsed.href}${sourceNote}${rangeNote}\n\n${slice}${continuation}`;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'browser', version: '1.1.0' },
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
