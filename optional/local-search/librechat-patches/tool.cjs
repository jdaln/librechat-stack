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
function createSearchProcessor({ searchAPI, safeSearch, sourceProcessor, onGetHighlights, logger, }) {
    return async function ({ query, date, country, proMode = true, maxSources = DEFAULT_MAX_SOURCES, onSearchResults, images = false, videos = false, news = false, }) {
        try {
            // Execute parallel searches and merge results
            const searchResult = await executeParallelSearches({
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
                query,
                news,
                result: searchResult,
                proMode,
                onGetHighlights,
                numElements: maxSources,
            });
            return highlights.expandHighlights(processedSources);
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
    return tools.tool(async (params, runnableConfig) => {
        const { query, date, country: _c, images, videos, news } = params;
        const country = typeof _c === 'string' && _c ? _c : undefined;
        const searchResult = await search({
            query,
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
        const compactResult = compactSearchResult(searchResult);
        const { output, references } = format.formatResultsForLLM(turn, compactResult);
        const data = { turn, ...compactResult, references };
        return [output, { [_enum.Constants.WEB_SEARCH]: data }];
    }, {
        name: _enum.Constants.WEB_SEARCH,
        description: `Real-time search. Results have required citation anchors.

Note: Use ONCE per reply unless instructed otherwise.

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
