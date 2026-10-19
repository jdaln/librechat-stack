'use strict';
// Minimal MCP stdio server exposing a single `open_url` tool that fetches a
// web page through the stack's Firecrawl scraper (so egress policy, proxy
// audit, and SSRF protections all apply). Runs inside the LibreChat api
// container; no dependencies beyond Node's stdlib.
//
// Why this exists: small models reliably ignore the `url` parameter on the
// web_search tool, but they do call a distinctly-named fetch tool. Attached
// to agents via librechat.yaml's mcpServers.

// Outbound HTTP(S) goes through the stack's egress proxy. LibreChat starts MCP
// children with the env from librechat.yaml only (no NODE_OPTIONS preload), so
// the proxy agent is set up here from HTTPS_PROXY/HTTP_PROXY/NO_PROXY. Silent:
// stdout is the MCP channel.
try {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
} catch (error) {
  process.stderr.write(`[open-url] proxy setup failed: ${error.message}\n`);
}

const FIRECRAWL_API_URL = (process.env.FIRECRAWL_API_URL || 'http://firecrawl-api:3002').replace(/\/$/, '');
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const SEARXNG_URL = (process.env.SEARXNG_INSTANCE_URL || 'http://searxng-auth:8080').replace(/\/$/, '');
const SEARXNG_API_KEY = process.env.SEARXNG_API_KEY || '';
// Two MCP servers from one file: `node open-url.cjs` serves open_url (attached to
// the default model specs), `node open-url.cjs social` serves social_search only
// (a separate server the user enables per conversation).
const MODE = process.argv.slice(1).includes('social') ? 'social' : 'browser';
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
    'Links to X/Twitter, Bluesky, Instagram and TikTok, and pages that answer with a login or JavaScript wall, are read ' +
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

// Keyword search across social networks: one `site:` query per network through
// the stack's SearXNG (DuckDuckGo indexes these sites), Social Searcher through
// the headless browser as fallback. Networks follow the usual OSINT set.
const SOCIAL_SITES = {
  x: 'x.com',
  bluesky: 'bsky.app',
  reddit: 'reddit.com',
  instagram: 'instagram.com',
  tiktok: 'tiktok.com',
  youtube: 'youtube.com',
  linkedin: 'linkedin.com',
  threads: 'threads.com',
  facebook: 'facebook.com',
  telegram: 't.me',
  truthsocial: 'truthsocial.com',
};
const SOCIAL_DEFAULT = ['x', 'bluesky', 'reddit', 'instagram', 'tiktok', 'youtube'];

const SOCIAL_TOOL = {
  name: 'social_search',
  description:
    'Search recent public posts and profiles on social networks by keyword, name or handle. ' +
    `Networks: ${Object.keys(SOCIAL_SITES).join(', ')} (default: ${SOCIAL_DEFAULT.join(', ')}). ` +
    'Returns links with titles and snippets per network (engine ranking decides how many each network gets); open a link with open_url to read the post or profile. ' +
    'Use this instead of web_search when the user asks what people say or post about something on social media. ' +
    'One call covers all requested networks. If a network comes back "rate-limited", retry at most once later in the answer; otherwise report it as unavailable.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, a name, or a handle (with or without @).' },
      networks: {
        type: 'array',
        items: { type: 'string', enum: Object.keys(SOCIAL_SITES) },
        description: 'Networks to search; omit for the default set.',
      },
      limit: { type: 'integer', description: 'Results per network (default 5, max 10).' },
    },
    required: ['query'],
  },
};

async function searxng(query, engines) {
  const u = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json${engines ? '&engines=' + encodeURIComponent(engines) : ''}`;
  const response = await fetch(u, { headers: { 'X-API-Key': SEARXNG_API_KEY }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`search backend HTTP ${response.status}`);
  const data = await response.json().catch(() => ({}));
  return {
    results: Array.isArray(data.results) ? data.results : [],
    unresponsive: Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines.map((e) => (Array.isArray(e) ? e[0] : e)).filter(Boolean) : [],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostToNetwork(url, wanted) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile|old)\./, '');
  } catch {
    return null;
  }
  return wanted.find((n) => host === SOCIAL_SITES[n] || host.endsWith('.' + SOCIAL_SITES[n])) || null;
}

async function socialSearch(query, networks, limit) {
  const wanted = (Array.isArray(networks) && networks.length ? networks : SOCIAL_DEFAULT).filter((n) => SOCIAL_SITES[n]);
  if (!wanted.length) throw new Error('no known network requested');
  const per = Math.min(Math.max(1, limit || 5), 10);
  const q = String(query || '').trim().replace(/^@/, '');
  if (!q) throw new Error('query is required');

  // One query for all networks (the engines accept `site:a OR site:b`), then
  // at most one follow-up for the networks the first page missed. Two paced
  // requests instead of one per network: bursts get the engines suspended.
  const grouped = Object.fromEntries(wanted.map((n) => [n, []]));
  const seen = new Set();
  const unresponsive = new Set();
  const run = async (nets) => {
    // DDG only: the other engines index none of these sites for site: queries.
    const r = await searxng(`${q} (${nets.map((n) => 'site:' + SOCIAL_SITES[n]).join(' OR ')})`, 'duckduckgo');
    r.unresponsive.forEach((e) => unresponsive.add(e));
    for (const res of r.results) {
      const n = hostToNetwork(res.url, wanted);
      if (!n || seen.has(res.url) || grouped[n].length >= per) continue;
      seen.add(res.url);
      grouped[n].push(res);
    }
  };
  let failure = '';
  try {
    await run(wanted);
    const missing = wanted.filter((n) => !grouped[n].length);
    if (missing.length && missing.length < wanted.length) {
      await sleep(2000 + Math.floor(Math.random() * 1500));
      await run(missing);
    }
  } catch (error) {
    failure = ` (search failed: ${error.message})`;
  }

  const sections = [];
  for (const n of wanted) {
    const results = grouped[n];
    let note = failure;
    if (!results.length && !failure && unresponsive.size) note = ` (engine rate-limited: ${[...unresponsive].join(', ')}; retry in a minute)`;
    const lines = [`## ${n} (${SOCIAL_SITES[n]})${note}`];
    if (!results.length) lines.push('no results');
    for (const r of results) {
      const snippet = (r.content || '').replace(/\s+/g, ' ').trim();
      lines.push(`- [${(r.title || r.url || '').trim()}](${r.url})${r.publishedDate ? ' · ' + String(r.publishedDate).slice(0, 10) : ''}${snippet ? '\n  ' + snippet.slice(0, 240) : ''}`);
    }
    sections.push(lines.join('\n'));
  }
  return `# Social search: ${q}\n\n${sections.join('\n\n')}`;
}

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
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const BSKY_API = 'https://public.api.bsky.app/xrpc';
// Pages that did load but hold no content for a reader. Strong phrases mark a
// wall whatever the page length (front-ends pad them with boilerplate); weak
// ones only on short pages, where they cannot be part of an article.
const WALL_STRONG = /verify (?:that )?you(?:'re| are) (?:not a (?:ro)?bot|(?:a )?human)|checking (?:that )?(?:that's )?you(?:'re| are)? ?(?:a )?human|just a moment|attention required|enable javascript|javascript is (?:required|disabled)|checking your browser|you have been blocked|please wait while|complete the (?:captcha|security check)|not a robot/i;
const WALL_WEAK = /log ?in to (?:continue|see|view)|sign up to see|access denied|something went wrong\.? try (?:again|reloading)/i;
const WALL_MIN_CHARS = 1500;
function looksLikeWall(text) {
  return WALL_STRONG.test(text) || (text.length < WALL_MIN_CHARS && WALL_WEAK.test(text));
}
// archive.today answers an unknown URL with its search page, not an error.
function looksLikeArchiveMiss(url, text) {
  return /archive\.(?:ph|today)/.test(url) && /webpage capture/i.test(text) && /No results/.test(text);
}

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
    const isPost = ['p', 'reel', 'reels', 'tv'].includes((segs[0] || '').toLowerCase()) && segs[1];
    if (isPost) {
      return [
        { label: 'instagram.com embed page', kind: 'ig-embed', url: `https://www.instagram.com/p/${encodeURIComponent(segs[1])}/embed/captioned/` },
        { label: 'original page', kind: 'scrape', url: original },
        { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
      ];
    }
    if (segs.length === 1 && segs[0] && !['explore', 'accounts', 'directory'].includes(segs[0].toLowerCase())) {
      const user = segs[0].replace(/^@/, '');
      return [
        { label: 'instagram.com embed page', kind: 'ig-embed', url: `https://www.instagram.com/${encodeURIComponent(user)}/embed/` },
        { label: 'dumpor.io (alternative front-end for instagram.com)', kind: 'scrape', url: `https://dumpor.io/v/${encodeURIComponent(user)}` },
        { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
      ];
    }
    return [
      { label: 'original page', kind: 'scrape', url: original },
      { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
    ];
  }

  if (TIKTOK_HOSTS.has(host) && segs[0] && segs[0].startsWith('@')) {
    const user = segs[0].slice(1);
    if (segs[1] === 'video' && /^\d+$/.test(segs[2] || '')) {
      return [
        { label: 'tikvib.com (alternative front-end for tiktok.com)', kind: 'scrape', url: `https://www.tikvib.com/media/${segs[2]}` },
        { label: 'original page', kind: 'scrape', url: original },
      ];
    }
    if (segs.length === 1) {
      return [
        { label: 'tikvib.com (alternative front-end for tiktok.com)', kind: 'scrape', url: `https://www.tikvib.com/profile/${encodeURIComponent(user)}` },
        { label: 'original page', kind: 'scrape', url: original },
      ];
    }
  }

  return [
    { label: 'original page', kind: 'scrape', url: original },
    { label: 'archive.today snapshot', kind: 'scrape', url: archiveTodayUrl(original) },
    { label: 'Wayback Machine snapshot', kind: 'scrape', url: waybackUrl(original) },
  ];
}

async function firecrawl(url, formats) {
  const response = await fetch(`${FIRECRAWL_API_URL}/v2/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      url,
      formats,
      onlyMainContent: formats.includes('markdown'),
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
  return data.data;
}

async function scrape(url) {
  const data = { data: await firecrawl(url, ['markdown']) };
  const markdown = cleanMarkdown(data.data.markdown ?? '');
  const title = data.data.metadata?.title ?? new URL(url).hostname;
  if (looksLikeWall(`${title}\n${markdown}`)) {
    throw new Error('page served a bot check, login or JavaScript wall instead of content');
  }
  if (looksLikeArchiveMiss(url, markdown)) {
    throw new Error('no snapshot of this page');
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

// Instagram embed pages (/<user>/embed/, /p/<code>/embed/captioned/) are
// served without login and carry their data as an escaped JSON string in a
// "contextJSON" attribute. Fetched as raw HTML through Firecrawl (so the
// egress policy still applies), parsed here.
function extractJsonStringValue(text, key) {
  const marker = `"${key}":"`;
  const i = text.indexOf(marker);
  if (i < 0) return null;
  let j = i + marker.length;
  let out = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      out += c + (text[j + 1] ?? '');
      j += 2;
      continue;
    }
    if (c === '"') break;
    out += c;
    j += 1;
  }
  try {
    return JSON.parse(JSON.parse(`"${out}"`));
  } catch {
    return null;
  }
}

function* walk(o) {
  if (Array.isArray(o)) {
    for (const x of o) yield* walk(x);
  } else if (o && typeof o === 'object') {
    yield o;
    for (const v of Object.values(o)) yield* walk(v);
  }
}

function igCaption(node) {
  return node?.edge_media_to_caption?.edges?.[0]?.node?.text || '';
}

function igPostToMarkdown(node, owner) {
  const user = node.owner?.username || owner?.username || '?';
  const when = node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString().slice(0, 10) : '';
  const lines = [`**@${user}**${when ? ' · ' + when : ''}${node.is_video ? ' · video' : ''}`, '', igCaption(node)];
  const stats = [
    node.edge_liked_by?.count != null ? `${fmtCount(node.edge_liked_by.count)} likes` : (node.edge_media_preview_like?.count != null ? `${fmtCount(node.edge_media_preview_like.count)} likes` : ''),
    node.edge_media_to_comment?.count != null ? `${fmtCount(node.edge_media_to_comment.count)} comments` : '',
    node.video_view_count != null ? `${fmtCount(node.video_view_count)} views` : '',
  ].filter(Boolean);
  if (stats.length) lines.push('', stats.join(' · '));
  if (node.location?.name) lines.push('', `location: ${node.location.name}`);
  if (node.shortcode) lines.push('', `https://www.instagram.com/p/${node.shortcode}/`);
  return lines.join('\n');
}

async function fetchInstagramEmbed(url) {
  const data = await firecrawl(url, ['rawHtml']);
  const html = data.rawHtml || data.html || '';
  const ctx = extractJsonStringValue(html, 'contextJSON');
  if (!ctx || url.includes('/p/')) {
    // Post embeds render the caption as HTML (class "Caption"), no usable JSON.
    const cap = html.match(/class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments/);
    const user = html.match(/class="UsernameText"[^>]*>([^<]+)</);
    if (cap) {
      const strip = (h) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
      let text = strip(cap[1]);
      if (user && text.startsWith(user[1])) text = text.slice(user[1].length).trim();
      const code = (url.match(/\/p\/([^/]+)\//) || [])[1];
      const lines = [`**@${user ? user[1] : '?'}**`, '', text, ''];
      if (code) lines.push(`https://www.instagram.com/p/${code}/`);
      return { title: `Instagram post by @${user ? user[1] : '?'}`, markdown: lines.join('\n') };
    }
    if (looksLikeWall(html.slice(0, 20000))) throw new Error('page served a bot check, login or JavaScript wall instead of content');
    throw new Error('embed data not found');
  }
  const objects = [...walk(ctx)];
  const owner = objects.find((o) => o.username && o.edge_followed_by) || objects.find((o) => o.username) || null;
  const single = objects.find((o) => o.shortcode && o.edge_media_to_caption && o.__typename && !objects.some((p) => p.edges && p.edges.some((e) => e.node === o)));
  const timeline = objects.find((o) => o.edge_owner_to_timeline_media?.edges)?.edge_owner_to_timeline_media?.edges?.map((e) => e.node) || [];
  if (url.includes('/p/')) {
    const node = single || timeline[0];
    if (!node) throw new Error('post not found in embed data');
    return { title: `Instagram post by @${node.owner?.username || owner?.username || '?'}`, markdown: igPostToMarkdown(node, owner) };
  }
  if (!owner) throw new Error('profile not found in embed data');
  const lines = [`**@${owner.username}**${owner.full_name ? ' · ' + owner.full_name : ''}${owner.is_verified ? ' · verified' : ''}`, ''];
  if (owner.biography) lines.push(owner.biography, '');
  lines.push([
    owner.edge_followed_by?.count != null ? `${fmtCount(owner.edge_followed_by.count)} followers` : '',
    owner.edge_owner_to_timeline_media?.count != null ? `${fmtCount(owner.edge_owner_to_timeline_media.count)} posts` : '',
    owner.is_private ? 'private account' : '',
  ].filter(Boolean).join(' · '));
  const posts = timeline.length ? timeline : objects.filter((o) => o.shortcode && o.edge_media_to_caption);
  if (posts.length) {
    lines.push('', `## Latest posts (${posts.length})`);
    for (const n of posts) lines.push('', '---', '', igPostToMarkdown(n, owner));
  }
  lines.push('', `https://www.instagram.com/${owner.username}/`);
  return { title: `@${owner.username} on Instagram`, markdown: lines.join('\n') };
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
        : attempt.kind === 'ig-embed' ? await fetchInstagramEmbed(attempt.url)
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
      serverInfo: { name: MODE, version: '1.2.0' },
    });
  } else if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
    // notifications get no response
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: MODE === 'social' ? [SOCIAL_TOOL] : [TOOL] });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const served = MODE === 'social' ? SOCIAL_TOOL.name : TOOL.name;
    if (name !== served) {
      replyError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    try {
      const args = params?.arguments ?? {};
      const text = name === SOCIAL_TOOL.name
        ? await socialSearch(args.query, args.networks, Number(args.limit) || 0)
        : await openUrl(args.url ?? '', Number(args.max_chars) || 0, Number(args.start) || 0);
      reply(id, { content: [{ type: 'text', text }], isError: false });
    } catch (error) {
      reply(id, {
        content: [{ type: 'text', text: `${name} failed: ${error.message}` }],
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
