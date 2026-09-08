'use strict';
// Local patch derived from LibreChat upstream web-search tool module (MIT).
// This overlay trims search artifacts/snippets/highlights before model handoff.

var zod = require('zod');
var tools = require('@langchain/core/tools');
var schema = require('./schema.cjs');
var search = require('./search.cjs');
var serperScraper = require('./serper-scraper.cjs');
var firecrawl = require('./firecrawl.cjs');
var highlights = require('./highlights.cjs');
var format = require('./format.cjs');
var utils = require('./utils.cjs');
var rerankers = require('./rerankers.cjs');
var _enum = require('../../common/enum.cjs');

const DEFAULT_MAX_SOURCES = Math.max(1, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_MAX_SOURCES ?? '3', 10) || 3);
const DEFAULT_RESULT_ITEM_LIMIT = Math.max(1, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_RESULT_COUNT ?? '4', 10) || 4);
const DEFAULT_HIGHLIGHT_COUNT = Math.max(1, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_HIGHLIGHT_COUNT ?? '3', 10) || 3);
const MAX_SNIPPET_CHARS = Math.max(100, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_SNIPPET_CHAR_LIMIT ?? '400', 10) || 400);
const MAX_HIGHLIGHT_CHARS = Math.max(100, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_HIGHLIGHT_CHAR_LIMIT ?? '500', 10) || 500);
// Direct-fetch (`url` param) content budget. Reading a page the user linked
// needs the actual text — reranked highlights alone lose lists/tables (e.g. a
// GitHub org's repo list sat past the truncation point and never reached the
// model, which then hallucinated).
const FETCH_CONTENT_CHARS = Math.max(2000, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_FETCH_CHAR_LIMIT ?? '16000', 10) || 16000);

// Small models re-search near-identical queries within one run, re-scraping
// the same top-ranked pages (the dominant latency: up to 4 Firecrawl scrapes
// per call). Cache raw scrape responses per tool instance (= per agent run)
// so a repeated URL skips the Firecrawl round-trip while all downstream,
// per-query work (cleanText, truncation budgets, reranked highlights) still
// runs against the current query. Only successful scrapes stay cached; the
// promise is stored immediately so concurrent same-URL scrapes dedupe too.
const SCRAPE_CACHE_MAX_ENTRIES = 40;
function withScrapeCache(scraper) {
    const cache = new Map();
    const wrapped = Object.create(scraper);
    wrapped.scrapeUrl = function (url, options) {
        if (cache.has(url)) {
            return cache.get(url);
        }
        const promise = scraper.scrapeUrl(url, options).then((result) => {
            const response = result?.[1];
            if (!(response && response.success && response.data)) {
                cache.delete(url);
            }
            return result;
        }, (error) => {
            cache.delete(url);
            throw error;
        });
        if (cache.size < SCRAPE_CACHE_MAX_ENTRIES) {
            cache.set(url, promise);
        }
        return promise;
    };
    return wrapped;
}

function truncateText(text, maxChars) {
    if (typeof text !== 'string' || text.length <= maxChars) {
        return text;
    }
    const slice = text.slice(0, maxChars);
    const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const cutoff = lastBreak > Math.floor(maxChars * 0.6) ? lastBreak : maxChars;
    return `${slice.slice(0, cutoff).trim()}...`;
}

function compactHighlight(highlight) {
    if (!highlight) {
        return highlight;
    }
    return {
        ...highlight,
        text: truncateText(highlight.text, MAX_HIGHLIGHT_CHARS),
        references: Array.isArray(highlight.references) ? highlight.references.slice(0, 6) : highlight.references,
    };
}

function compactSource(source) {
    if (!source) {
        return source;
    }
    const compact = {
        ...source,
        snippet: truncateText(source.snippet, MAX_SNIPPET_CHARS),
        highlights: Array.isArray(source.highlights)
            ? source.highlights.slice(0, DEFAULT_HIGHLIGHT_COUNT).map(compactHighlight)
            : source.highlights,
    };
    delete compact.content;
    delete compact.references;
    return compact;
}

function compactSearchResult(searchResult) {
    return {
        ...searchResult,
        organic: Array.isArray(searchResult.organic)
            ? searchResult.organic.slice(0, DEFAULT_RESULT_ITEM_LIMIT).map(compactSource)
            : searchResult.organic,
        topStories: Array.isArray(searchResult.topStories)
            ? searchResult.topStories.slice(0, DEFAULT_RESULT_ITEM_LIMIT).map(compactSource)
            : searchResult.topStories,
        relatedSearches: Array.isArray(searchResult.relatedSearches)
            ? searchResult.relatedSearches.slice(0, 5)
            : searchResult.relatedSearches,
        peopleAlsoAsk: Array.isArray(searchResult.peopleAlsoAsk)
            ? searchResult.peopleAlsoAsk.slice(0, 5).map((item) => ({
                ...item,
                question: truncateText(item.question, MAX_SNIPPET_CHARS),
                snippet: truncateText(item.snippet, MAX_SNIPPET_CHARS),
                title: truncateText(item.title, MAX_SNIPPET_CHARS),
            }))
            : searchResult.peopleAlsoAsk,
        answerBox: searchResult.answerBox == null
            ? searchResult.answerBox
            : {
                ...searchResult.answerBox,
                title: truncateText(searchResult.answerBox.title, MAX_SNIPPET_CHARS),
                snippet: truncateText(searchResult.answerBox.snippet, MAX_SNIPPET_CHARS),
            },
        knowledgeGraph: searchResult.knowledgeGraph == null
            ? searchResult.knowledgeGraph
            : {
                ...searchResult.knowledgeGraph,
                title: truncateText(searchResult.knowledgeGraph.title, MAX_SNIPPET_CHARS),
                description: truncateText(searchResult.knowledgeGraph.description, MAX_SNIPPET_CHARS),
            },
    };
}

/**
 * Executes parallel searches and merges the results
 */
async function executeParallelSearches({ searchAPI, query, date, country, safeSearch, images, videos, news, logger, }) {
    // Prepare all search tasks to run in parallel
    const searchTasks = [
        // Main search
        searchAPI.getSources({
            query,
            date,
            country,
            safeSearch,
        }),
    ];
    if (images) {
        searchTasks.push(searchAPI
            .getSources({
            query,
            date,
            country,
            safeSearch,
            type: 'images',
        })
            .catch((error) => {
            logger.error('Error fetching images:', error);
            return {
                success: false,
                error: `Images search failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }));
    }
    if (videos) {
        searchTasks.push(searchAPI
            .getSources({
            query,
            date,
            country,
            safeSearch,
            type: 'videos',
        })
            .catch((error) => {
            logger.error('Error fetching videos:', error);
            return {
                success: false,
                error: `Videos search failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }));
    }
    if (news) {
        searchTasks.push(searchAPI
            .getSources({
            query,
            date,
            country,
            safeSearch,
            type: 'news',
        })
            .catch((error) => {
            logger.error('Error fetching news:', error);
            return {
                success: false,
                error: `News search failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }));
    }
    // Run all searches in parallel
    const results = await Promise.all(searchTasks);
    // Get the main search result (first result)
    const mainResult = results[0];
    if (!mainResult.success) {
        throw new Error(mainResult.error ?? 'Search failed');
    }
    // Merge additional results with the main results
    const mergedResults = { ...mainResult.data };
    // Convert existing news to topStories if present
    if (mergedResults.news !== undefined && mergedResults.news.length > 0) {
        const existingNewsAsTopStories = mergedResults.news
            .filter((newsItem) => newsItem.link !== undefined && newsItem.link !== '')
            .map((newsItem) => ({
            title: newsItem.title ?? '',
            link: newsItem.link ?? '',
            source: newsItem.source ?? '',
            date: newsItem.date ?? '',
            imageUrl: newsItem.imageUrl ?? '',
            processed: false,
        }));
        mergedResults.topStories = [
            ...(mergedResults.topStories ?? []),
            ...existingNewsAsTopStories,
        ];
        delete mergedResults.news;
    }
    results.slice(1).forEach((result) => {
        if (result.success && result.data !== undefined) {
            if (result.data.images !== undefined && result.data.images.length > 0) {
                mergedResults.images = [
                    ...(mergedResults.images ?? []),
                    ...result.data.images,
                ];
            }
            if (result.data.videos !== undefined && result.data.videos.length > 0) {
                mergedResults.videos = [
                    ...(mergedResults.videos ?? []),
                    ...result.data.videos,
                ];
            }
            if (result.data.news !== undefined && result.data.news.length > 0) {
                const newsAsTopStories = result.data.news.map((newsItem) => ({
                    ...newsItem,
                    link: newsItem.link ?? '',
                }));
                mergedResults.topStories = [
                    ...(mergedResults.topStories ?? []),
                    ...newsAsTopStories,
                ];
            }
        }
    });
    return { success: true, data: mergedResults };
}
// Direct-fetch mode: wrap a user-provided link as a single organic result so
// the existing scrape → rerank → citation pipeline handles it unchanged.
function directUrlResult(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http(s) URLs can be opened directly');
    }
    return {
        success: true,
        data: {
            organic: [
                {
                    position: 1,
                    title: parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : ''),
                    link: parsed.href,
                    snippet: '',
                    date: '',
                    attribution: parsed.hostname,
                },
            ],
            topStories: [],
            images: [],
            videos: [],
            news: [],
            relatedSearches: [],
        },
    };
}
function createSearchProcessor({ searchAPI, safeSearch, sourceProcessor, onGetHighlights, logger, }) {
    return async function ({ query, url, date, country, proMode = true, maxSources = DEFAULT_MAX_SOURCES, onSearchResults, images = false, videos = false, news = false, }) {
        try {
            // A url skips engine search entirely and scrapes that page.
            const searchResult = url
                ? directUrlResult(url)
                : await executeParallelSearches({
                    searchAPI,
                    query,
                    date,
                    country,
                    safeSearch,
                    images,
                    videos,
                    news,
                    logger,
                });
            onSearchResults?.(searchResult);
            const processedSources = await sourceProcessor.processSources({
                // In direct-fetch mode the query drives highlight extraction;
                // fall back to the URL so an empty query still scrapes.
                query: query && query.trim() ? query : (url ?? query),
                news,
                result: searchResult,
                proMode,
                onGetHighlights,
                numElements: maxSources,
                // A single directly-requested page gets a larger content
                // budget than each of several search-result sources, and the
                // page text makes reranked highlights redundant.
                contentCharLimit: url ? FETCH_CONTENT_CHARS : undefined,
                skipHighlights: Boolean(url),
            });
            const expanded = highlights.expandHighlights(processedSources);
            // expandHighlights drops `content` from sources that have
            // highlights; direct-fetch mode needs it downstream (the page text
            // is appended to the model output in createTool).
            const scrapedContent = processedSources.organic?.[0]?.content;
            if (url && expanded.organic?.[0] && scrapedContent) {
                expanded.organic[0] = { ...expanded.organic[0], content: scrapedContent };
            }
            return expanded;
        }
        catch (error) {
            logger.error('Error in search:', error);
            return {
                organic: [],
                topStories: [],
                images: [],
                videos: [],
                news: [],
                relatedSearches: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };
}
function createOnSearchResults({ runnableConfig, onSearchResults, }) {
    return function (results) {
        if (!onSearchResults) {
            return;
        }
        onSearchResults(results, runnableConfig);
    };
}
function createTool({ schema, search, onSearchResults: _onSearchResults, }) {
    /** Links already shown to the model during this run — the tool instance
     *  (and this set) lives for one agent run and dies with it. */
    const seenLinks = new Set();
    return tools.tool(async (params, runnableConfig) => {
        let { query, url } = params;
        const { date, country: _c, images, videos, news } = params;
        const country = typeof _c === 'string' && _c ? _c : undefined;
        // Models often put URLs in `query` instead of `url`; searching engines
        // for a URL returns noise, so promote it to a direct fetch.
        if (!url && typeof query === 'string') {
            const embedded = query.match(/https?:\/\/\S+/);
            if (embedded) {
                url = embedded[0].replace(/[).,\]>'"]+$/, '');
                query = query.replace(embedded[0], ' ').replace(/\s+/g, ' ').trim();
            }
        }
        const searchResult = await search({
            query,
            url,
            date,
            country,
            images,
            videos,
            news,
            onSearchResults: createOnSearchResults({
                runnableConfig,
                onSearchResults: _onSearchResults,
            }),
        });
        const turn = runnableConfig.toolCall?.turn ?? 0;
        // Direct-fetch mode: hand the model the page text itself (compaction
        // drops `content` and truncates snippets, which is right for N search
        // sources but starves a deliberate single-page read).
        const fetchedContent = url ? searchResult.organic?.[0]?.content : undefined;
        const compactResult = compactSearchResult(searchResult);
        const { output, references } = format.formatResultsForLLM(turn, compactResult);
        // Zero-source searches otherwise hand the model a blank result: tell it
        // explicitly whether the search failed or genuinely found nothing, so
        // it can report that accurately instead of guessing.
        // WebSearch.tsx hides the whole entry when the tool output contains
        // the phrase "error processing" — make sure error text can't match.
        // A rate-limited backend (every tier failed) gets a firm STOP note:
        // the soft "no results" phrasing invites query reformulation, which
        // is exactly the loop that burns the run's recursion budget while
        // extending the engine bans.
        const rateLimited = typeof searchResult.error === 'string'
            && searchResult.error.startsWith('Search engines rate-limited');
        const retrySecs = /retry in ~(\d+)s/.exec(searchResult.error ?? '')?.[1];
        const emptyNote = rateLimited
            ? `[Search engines are rate-limiting requests. Do NOT retry web_search now — it will fail${retrySecs ? ` for roughly the next ${retrySecs} seconds` : ' for a while'}. Continue with other tools (e.g. open_url on pages you already know); after that you may retry web_search ONCE. If it fails again, answer with the information already gathered and tell the user that web search is temporarily degraded.]\n\n`
            : searchResult.error != null
                ? `[Search failed: ${truncateText(String(searchResult.error), 300).replace(/error processing/gi, 'error-processing')}]\n\n`
                : '[The search returned no results.]\n\n';
        const hasAnySource = (compactResult.organic?.length ?? 0) + (compactResult.topStories?.length ?? 0) > 0;
        const statusPrefix = hasAnySource ? '' : emptyNote;
        // Small models loop on near-identical searches. When a new search mostly
        // re-returns pages already shown this run, say so explicitly — results
        // are kept as-is (highlights are query-specific, citation anchors stay
        // valid); only the nudge is added. Direct-fetch (`url`) is deliberate
        // re-reading and never gets the note.
        let dupNote = '';
        const currentLinks = [
            ...(compactResult.organic ?? []),
            ...(compactResult.topStories ?? []),
        ].map((s) => s?.link).filter(Boolean);
        if (!url) {
            const dupCount = currentLinks.filter((l) => seenLinks.has(l)).length;
            if (dupCount >= 2 && dupCount / currentLinks.length >= 0.5) {
                dupNote = `[Note: ${dupCount} of ${currentLinks.length} results were already returned by an earlier search in this reply. Repeating similar queries finds nothing new — refine the query, or open a specific page with url="<link>".]\n\n`;
            }
        }
        for (const link of currentLinks) {
            seenLinks.add(link);
        }
        const finalOutput = fetchedContent
            ? `${statusPrefix}${output}\n\n## Page Content (cite as \\ue202turn${turn}search0)\n\n${truncateText(fetchedContent, FETCH_CONTENT_CHARS)}`
            // In-context nudge: weak models keyword-search for pages they
            // already know the address of; remind them at decision time.
            : `${statusPrefix}${dupNote}${output}\n\n[Reminder: to read a specific page, call this tool with url="<link>" (one call per page). Never keyword-search for a URL you already have.]`;
        // A search that ends with zero sources renders as a dead, non-expandable
        // "Searched the web" label in the client (WebSearch.tsx disables the
        // toggle when the artifact has no organic/topStories links). Inject a
        // synthetic placeholder source into the UI artifact only — never into
        // the model output or citation references — so the label stays
        // expandable and shows what was searched and why nothing came back.
        let artifactResult = compactResult;
        if (!hasAnySource) {
            const failed = compactResult.error != null;
            const failureSnippet = failed
                ? truncateText(String(compactResult.error), MAX_SNIPPET_CHARS)
                : '';
            let placeholder;
            if (url) {
                let label = url;
                try {
                    const parsed = new URL(url);
                    label = parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');
                }
                catch {
                    // keep the raw url as label
                }
                placeholder = {
                    position: 1,
                    title: `Fetch failed — ${label}`,
                    link: url,
                    snippet: failureSnippet,
                    date: '',
                    attribution: label,
                };
            }
            else {
                const q = typeof query === 'string' ? query : '';
                placeholder = {
                    position: 1,
                    title: `${rateLimited ? 'Search rate-limited' : failed ? 'Search failed' : 'No results'} — "${q}"`,
                    // Clicking the row reruns the query in the user's own browser.
                    link: `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
                    snippet: failureSnippet,
                    date: '',
                    attribution: 'duckduckgo.com',
                };
            }
            artifactResult = { ...compactResult, organic: [placeholder] };
        }
        const data = { turn, ...artifactResult, references };
        return [finalOutput, { [_enum.Constants.WEB_SEARCH]: data }];
    }, {
        name: _enum.Constants.WEB_SEARCH,
        description: `Real-time search. Results have required citation anchors.

Two modes:
1. Search: set \`query\` with keywords.
2. Open a page: set \`url\` to the exact link — the page's full content is returned. ALWAYS use this mode when the user provides a URL or you know the exact page (e.g. a GitHub org's repo listing, a repo's page); NEVER put a URL into \`query\`. Set \`query\` to what you are looking for in the page.

Note: Use ONCE per reply unless instructed otherwise. Reading several known pages is the exception: make one call per page, with \`url\` set.

Anchors:
- \\ue202turnXtypeY
- X = turn idx, type = 'search' | 'news' | 'image' | 'ref', Y = item idx

Special Markers:
- \\ue203...\\ue204 — highlight start/end of cited text (for Standalone or Group citations)
- \\ue200...\\ue201 — group block (e.g. \\ue200\\ue202turn0search1\\ue202turn0news2\\ue201)

**CITE EVERY NON-OBVIOUS FACT/QUOTE:**
Use anchor marker(s) immediately after the statement:
- Standalone: "Pure functions produce same output. \\ue202turn0search0"
- Standalone (multiple): "Today's News \\ue202turn0search0\\ue202turn0news0"
- Highlight: "\\ue203Highlight text.\\ue204\\ue202turn0news1"
- Group: "Sources. \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Group Highlight: "\\ue203Highlight for group.\\ue204 \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Image: "See photo \\ue202turn0image0."

**NEVER use markdown links, [1], or footnotes. CITE ONLY with anchors provided.**
`.trim(),
        schema: schema,
        responseFormat: _enum.Constants.CONTENT_AND_ARTIFACT,
    });
}
/**
 * Creates a search tool with a schema that dynamically includes the country field
 * only when the searchProvider is 'serper'.
 *
 * Supports multiple scraper providers:
 * - Firecrawl (default): Full-featured web scraping with multiple formats
 * - Serper: Lightweight scraping using Serper's scrape API
 *
 * @example
 * ```typescript
 * // Using Firecrawl scraper (default)
 * const searchTool = createSearchTool({
 *   searchProvider: 'serper',
 *   scraperProvider: 'firecrawl',
 *   firecrawlApiKey: 'your-firecrawl-key'
 * });
 *
 * // Using Serper scraper
 * const searchTool = createSearchTool({
 *   searchProvider: 'serper',
 *   scraperProvider: 'serper',
 *   serperApiKey: 'your-serper-key'
 * });
 * ```
 *
 * @param config - The search tool configuration
 * @returns A DynamicStructuredTool with a schema that depends on the searchProvider
 */
const createSearchTool = (config = {}) => {
    const { searchProvider = 'serper', serperApiKey, searxngInstanceUrl, searxngApiKey, rerankerType = 'cohere', topResults = 5, strategies = ['no_extraction'], filterContent = true, safeSearch = 1, scraperProvider = 'firecrawl', firecrawlApiKey, firecrawlApiUrl, firecrawlVersion, firecrawlOptions, serperScraperOptions, scraperTimeout, jinaApiKey, jinaApiUrl, cohereApiKey, onSearchResults: _onSearchResults, onGetHighlights, } = config;
    const logger = config.logger || utils.createDefaultLogger();
    // `schema.*Schema` are JSON-Schema objects used to advertise the tool to
    // models. `z.object()` only accepts ZodType values, so build a parallel zod
    // shape for runtime validation.
    const schemaObject = {
        query: zod.z.string().describe(schema.querySchema.description),
        date: zod.z
            .enum(Object.values(schema.DATE_RANGE))
            .optional()
            .describe(schema.dateSchema.description),
        images: zod.z.boolean().optional().describe(schema.imagesSchema.description),
        videos: zod.z.boolean().optional().describe(schema.videosSchema.description),
        news: zod.z.boolean().optional().describe(schema.newsSchema.description),
        url: zod.z
            .string()
            .optional()
            .describe('Exact http(s) page to open instead of searching. REQUIRED whenever the user provides a link or you already know the page address — never search for a URL. Keep `query` set to what should be extracted from the page.'),
    };
    if (searchProvider === 'serper') {
        schemaObject.country = zod.z
            .string()
            .optional()
            .describe(schema.countrySchema.description);
    }
    const toolSchema = zod.z.object(schemaObject);
    const searchAPI = search.createSearchAPI({
        searchProvider,
        serperApiKey,
        searxngInstanceUrl,
        searxngApiKey,
    });
    /** Create scraper based on scraperProvider */
    let scraperInstance;
    if (scraperProvider === 'serper') {
        scraperInstance = serperScraper.createSerperScraper({
            ...serperScraperOptions,
            apiKey: serperApiKey,
            timeout: scraperTimeout ?? serperScraperOptions?.timeout,
            logger,
        });
    }
    else {
        scraperInstance = firecrawl.createFirecrawlScraper({
            ...firecrawlOptions,
            apiKey: firecrawlApiKey ?? process.env.FIRECRAWL_API_KEY,
            apiUrl: firecrawlApiUrl,
            version: firecrawlVersion,
            timeout: scraperTimeout ?? firecrawlOptions?.timeout,
            formats: firecrawlOptions?.formats ?? ['markdown'],
            onlyMainContent: firecrawlOptions?.onlyMainContent ?? true,
            blockAds: firecrawlOptions?.blockAds ?? true,
            removeBase64Images: firecrawlOptions?.removeBase64Images ?? true,
            logger,
        });
    }
    scraperInstance = withScrapeCache(scraperInstance);
    const selectedReranker = rerankers.createReranker({
        rerankerType,
        jinaApiKey,
        jinaApiUrl,
        cohereApiKey,
        logger,
    });
    if (!selectedReranker) {
        logger.warn('No reranker selected. Using default ranking.');
    }
    const sourceProcessor = search.createSourceProcessor({
        reranker: selectedReranker,
        topResults,
        logger,
    }, scraperInstance);
    const search$1 = createSearchProcessor({
        searchAPI,
        safeSearch,
        sourceProcessor,
        onGetHighlights,
        logger,
    });
    return createTool({
        search: search$1,
        schema: toolSchema,
        onSearchResults: _onSearchResults,
    });
};

exports.createSearchTool = createSearchTool;
//# sourceMappingURL=tool.cjs.map
