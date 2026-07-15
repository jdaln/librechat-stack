'use strict';
// Local patch derived from LibreChat upstream search tool module (MIT).
// This overlay adds conservative source-content truncation to control prompt context growth.

var axios = require('axios');
var textsplitters = require('@langchain/textsplitters');
var utils = require('./utils.cjs');

const DEFAULT_SEARCH_RESULT_COUNT = Math.max(1, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_RESULT_COUNT ?? '4', 10) || 4);
const DEFAULT_HIGHLIGHT_COUNT = Math.max(1, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_HIGHLIGHT_COUNT ?? '3', 10) || 3);
const MAX_SOURCE_CONTENT_CHARS = Math.max(1000, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_SOURCE_CHAR_LIMIT ?? '12000', 10) || 12000);
// Upstream's 150-char chunks turn one page into ~80 rerank documents, which
// takes >10s per source on the CPU cross-encoder. Bigger chunks cut rerank
// volume ~4x and carry more context per highlight.
const HIGHLIGHT_CHUNK_SIZE = Math.max(100, Number.parseInt(process.env.LIBRECHAT_WEB_SEARCH_CHUNK_SIZE ?? '500', 10) || 500);

function truncateText(text, maxChars) {
    if (typeof text !== 'string' || text.length <= maxChars) {
        return text;
    }
    const slice = text.slice(0, maxChars);
    const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const cutoff = lastBreak > Math.floor(maxChars * 0.6) ? lastBreak : maxChars;
    return `${slice.slice(0, cutoff).trim()}...`;
}

// Scrape targets are logged as hostname only: full URLs (paths, query
// strings) can reveal what users searched for and must stay out of logs.
function redactUrl(url) {
    try {
        return new URL(url).hostname;
    }
    catch {
        return '[unparseable-url]';
    }
}

const chunker = {
    cleanText: (text) => {
        if (!text)
            return '';
        // Densify scraped markdown before chunking/truncation: images become
        // their alt text (often the actual information, e.g. ratings), empty
        // decorative links and GitHub's static no-JS templates are dropped.
        const denoised = text
            .replace(/!\[([^\]]*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '$1')
            .replace(/\[\s*\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
            .replace(/You (?:signed (?:in|out) with|switched accounts on) another tab or window\.?\s*\[Reload\]\([^)]*\)\s*to refresh your session\.?/g, '')
            .replace(/#{0,4}\s*Uh oh!\s*(\[?There was an error while loading\.?\]?(\([^)]*\))?\s*)?(\[?Please reload this page\]?(\([^)]*\))?\s*)?\.?/g, '')
            .replace(/\[Skip to content\]\([^)]*\)/g, '');
        /** Normalized all line endings to '\n' */
        const normalizedText = denoised.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        /** Handle multiple backslashes followed by newlines
         * This replaces patterns like '\\\\\\n' with a single newline */
        const fixedBackslashes = normalizedText.replace(/\\+\n/g, '\n');
        /** Cleaned up consecutive newlines, tabs, and spaces around newlines */
        const cleanedNewlines = fixedBackslashes.replace(/[\t ]*\n[\t \n]*/g, '\n');
        /** Cleaned up excessive spaces and tabs */
        const cleanedSpaces = cleanedNewlines.replace(/[ \t]+/g, ' ');
        return cleanedSpaces.trim();
    },
    splitText: async (text, options) => {
        const chunkSize = options?.chunkSize ?? 150;
        const chunkOverlap = options?.chunkOverlap ?? 50;
        const separators = options?.separators || ['\n\n', '\n'];
        const splitter = new textsplitters.RecursiveCharacterTextSplitter({
            separators,
            chunkSize,
            chunkOverlap,
        });
        return await splitter.splitText(text);
    },
    splitTexts: async (texts, options, logger) => {
        // Split multiple texts
        const logger_ = logger || utils.createDefaultLogger();
        const promises = texts.map((text) => chunker.splitText(text, options).catch((error) => {
            logger_.error('Error splitting text:', error);
            return [text];
        }));
        return Promise.all(promises);
    },
};
function createSourceUpdateCallback(sourceMap) {
    return (link, update) => {
        const source = sourceMap.get(link);
        if (source) {
            sourceMap.set(link, {
                ...source,
                ...update,
            });
        }
    };
}
const getHighlights = async ({ query, content, reranker, topResults = DEFAULT_HIGHLIGHT_COUNT, logger, }) => {
    const logger_ = logger || utils.createDefaultLogger();
    if (!content) {
        logger_.warn('No content provided for highlights');
        return;
    }
    if (!reranker) {
        logger_.warn('No reranker provided for highlights');
        return;
    }
    try {
        const documents = await chunker.splitText(content, {
            chunkSize: HIGHLIGHT_CHUNK_SIZE,
            chunkOverlap: 50,
        });
        if (Array.isArray(documents)) {
            return await reranker.rerank(query, documents, topResults);
        }
        else {
            logger_.error('Expected documents to be an array, got:', typeof documents);
            return;
        }
    }
    catch (error) {
        logger_.error('Error in content processing:', error);
        return;
    }
};
const createSerperAPI = (apiKey) => {
    const config = {
        apiKey: apiKey ?? process.env.SERPER_API_KEY,
        apiUrl: 'https://google.serper.dev/search',
        timeout: 10000,
    };
    if (config.apiKey == null || config.apiKey === '') {
        throw new Error('SERPER_API_KEY is required for SerperAPI');
    }
    const getSources = async ({ query, date, country, safeSearch, numResults = DEFAULT_SEARCH_RESULT_COUNT, type, }) => {
        if (!query.trim()) {
            return { success: false, error: 'Query cannot be empty' };
        }
        try {
            const safe = ['off', 'moderate', 'active'];
            const payload = {
                q: query,
                safe: safe[safeSearch ?? 1],
                num: Math.min(Math.max(1, numResults), 10),
            };
            // Set the search type if provided
            if (type) {
                payload.type = type;
            }
            if (date != null) {
                payload.tbs = `qdr:${date}`;
            }
            if (country != null && country !== '') {
                payload['gl'] = country.toLowerCase();
            }
            // Determine the API endpoint based on the search type
            let apiEndpoint = config.apiUrl;
            if (type === 'images') {
                apiEndpoint = 'https://google.serper.dev/images';
            }
            else if (type === 'videos') {
                apiEndpoint = 'https://google.serper.dev/videos';
            }
            else if (type === 'news') {
                apiEndpoint = 'https://google.serper.dev/news';
            }
            const response = await axios.post(apiEndpoint, payload, {
                headers: {
                    'X-API-KEY': config.apiKey,
                    'Content-Type': 'application/json',
                },
                timeout: config.timeout,
            });
            const data = response.data;
            const results = {
                organic: data.organic,
                images: data.images ?? [],
                answerBox: data.answerBox,
                topStories: data.topStories ?? [],
                peopleAlsoAsk: data.peopleAlsoAsk,
                knowledgeGraph: data.knowledgeGraph,
                relatedSearches: data.relatedSearches,
                videos: data.videos ?? [],
                news: data.news ?? [],
            };
            return { success: true, data: results };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `API request failed: ${errorMessage}` };
        }
    };
    return { getSources };
};
const createSearXNGAPI = (instanceUrl, apiKey) => {
    const config = {
        instanceUrl: instanceUrl ?? process.env.SEARXNG_INSTANCE_URL,
        apiKey: apiKey ?? process.env.SEARXNG_API_KEY,
        timeout: 10000,
    };
    if (config.instanceUrl == null || config.instanceUrl === '') {
        throw new Error('SEARXNG_INSTANCE_URL is required for SearXNG API');
    }
    const getSources = async ({ query, numResults = DEFAULT_SEARCH_RESULT_COUNT, safeSearch, type, }) => {
        if (!query.trim()) {
            return { success: false, error: 'Query cannot be empty' };
        }
        try {
            // Ensure the instance URL ends with /search
            if (config.instanceUrl == null || config.instanceUrl === '') {
                return { success: false, error: 'Instance URL is not defined' };
            }
            let searchUrl = config.instanceUrl;
            if (!searchUrl.endsWith('/search')) {
                searchUrl = searchUrl.replace(/\/$/, '') + '/search';
            }
            // Determine the search category based on the type
            let category = 'general';
            if (type === 'images') {
                category = 'images';
            }
            else if (type === 'videos') {
                category = 'videos';
            }
            else if (type === 'news') {
                category = 'news';
            }
            // Prepare parameters for SearXNG
            const params = {
                q: query,
                format: 'json',
                pageno: 1,
                categories: category,
                // 'auto' lets SearXNG detect the query language and pick the
                // matching engine market; upstream's 'all' returns cross-locale
                // junk (notably from Bing when queried via a datacenter/proxy IP).
                language: process.env.SEARXNG_LANGUAGE || 'auto',
                safesearch: safeSearch,
            };
            // Upstream pins engines=google,bing,duckduckgo, which collides with
            // instances that curate their engine set server-side (google is
            // removed in ours, silently leaving bing+ddg only). Only pin engines
            // when explicitly configured; otherwise settings.yml decides.
            if (process.env.SEARXNG_ENGINES) {
                params.engines = process.env.SEARXNG_ENGINES;
            }
            const headers = {
                'Content-Type': 'application/json',
            };
            if (config.apiKey != null && config.apiKey !== '') {
                headers['X-API-Key'] = config.apiKey;
            }
            const response = await axios.get(searchUrl, {
                headers,
                params,
                timeout: config.timeout,
            });
            const data = response.data;
            // Helper function to identify news results since SearXNG doesn't provide that classification by default
            const isNewsResult = (result) => {
                const url = result.url?.toLowerCase() ?? '';
                const title = result.title?.toLowerCase() ?? '';
                // News-related keywords in title/content
                const newsKeywords = [
                    'breaking news',
                    'latest news',
                    'top stories',
                    'news today',
                    'developing story',
                    'trending news',
                    'news',
                ];
                // Check if title/content contains news keywords
                const hasNewsKeywords = newsKeywords.some((keyword) => title.toLowerCase().includes(keyword) // just title probably fine, content parsing is overkill for what we need: || content.includes(keyword)
                );
                // Check if URL contains news-related paths
                const hasNewsPath = url.includes('/news/') ||
                    url.includes('/world/') ||
                    url.includes('/politics/') ||
                    url.includes('/breaking/');
                return hasNewsKeywords || hasNewsPath;
            };
            // Transform SearXNG results to match SerperAPI format
            const organicResults = (data.results ?? [])
                .slice(0, numResults)
                .map((result, index) => {
                let attribution = '';
                try {
                    attribution = new URL(result.url ?? '').hostname;
                }
                catch {
                    attribution = '';
                }
                return {
                    position: index + 1,
                    title: result.title ?? '',
                    link: result.url ?? '',
                    snippet: result.content ?? '',
                    date: result.publishedDate ?? '',
                    attribution,
                };
            });
            const imageResults = (data.results ?? [])
                .filter((result) => result.img_src)
                .slice(0, 6)
                .map((result, index) => ({
                title: result.title ?? '',
                imageUrl: result.img_src ?? '',
                position: index + 1,
                source: new URL(result.url ?? '').hostname,
                domain: new URL(result.url ?? '').hostname,
                link: result.url ?? '',
            }));
            // Extract news results from organic results
            const newsResults = (data.results ?? [])
                .filter(isNewsResult)
                .map((result, index) => {
                let attribution = '';
                try {
                    attribution = new URL(result.url ?? '').hostname;
                }
                catch {
                    attribution = '';
                }
                return {
                    title: result.title ?? '',
                    link: result.url ?? '',
                    snippet: result.content ?? '',
                    date: result.publishedDate ?? '',
                    source: attribution,
                    imageUrl: result.img_src ?? '',
                    position: index + 1,
                };
            });
            const topStories = newsResults.slice(0, DEFAULT_SEARCH_RESULT_COUNT);
            const relatedSearches = Array.isArray(data.suggestions)
                ? data.suggestions.map((suggestion) => ({ query: suggestion }))
                : [];
            const results = {
                organic: organicResults,
                images: imageResults,
                topStories: topStories, // Use first 5 extracted news as top stories
                relatedSearches,
                videos: [],
                news: newsResults,
                // Add empty arrays for other Serper fields to maintain parity
                places: [],
                shopping: [],
                peopleAlsoAsk: [],
                knowledgeGraph: undefined,
                answerBox: undefined,
            };
            return { success: true, data: results };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: `SearXNG API request failed: ${errorMessage}`,
            };
        }
    };
    return { getSources };
};
// Brave Search API provider (https://api.search.brave.com). Not an upstream
// LibreChat provider: librechat.yaml's webSearch schema only accepts
// 'serper'/'searxng', so this is selected via LIBRECHAT_SEARCH_PROVIDER_OVERRIDE
// (see createSearchAPI below) while the yaml keeps searchProvider: searxng.
const createBraveAPI = (apiKey) => {
    const config = {
        apiKey: apiKey ?? process.env.BRAVE_API_KEY,
        apiUrl: (process.env.BRAVE_API_URL || 'https://api.search.brave.com/res/v1').replace(/\/$/, ''),
        timeout: 10000,
    };
    if (config.apiKey == null || config.apiKey === '') {
        throw new Error('BRAVE_API_KEY is required for Brave Search API');
    }
    const stripHtml = (text) => (text ?? '').replace(/<[^>]+>/g, '');
    const toAttribution = (result) => {
        if (result.meta_url?.hostname) {
            return result.meta_url.hostname;
        }
        try {
            return new URL(result.url ?? '').hostname;
        }
        catch {
            return '';
        }
    };
    const getSources = async ({ query, date, safeSearch, numResults = DEFAULT_SEARCH_RESULT_COUNT, type, }) => {
        if (!query.trim()) {
            return { success: false, error: 'Query cannot be empty' };
        }
        try {
            let endpoint = `${config.apiUrl}/web/search`;
            if (type === 'images') {
                endpoint = `${config.apiUrl}/images/search`;
            }
            else if (type === 'videos') {
                endpoint = `${config.apiUrl}/videos/search`;
            }
            else if (type === 'news') {
                endpoint = `${config.apiUrl}/news/search`;
            }
            const safe = ['off', 'moderate', 'strict'];
            let safesearch = safe[safeSearch ?? 1];
            if (type === 'images' && safesearch === 'moderate') {
                // The images endpoint only accepts off|strict.
                safesearch = 'strict';
            }
            const params = {
                q: query,
                count: Math.min(Math.max(1, numResults), 20),
                safesearch,
            };
            // LibreChat date ranges follow Google qdr codes (h/d/w/m/y);
            // Brave freshness knows pd/pw/pm/py.
            const freshness = { h: 'pd', d: 'pd', w: 'pw', m: 'pm', y: 'py' }[date];
            if (freshness != null && type !== 'images') {
                params.freshness = freshness;
            }
            if (process.env.BRAVE_COUNTRY) {
                params.country = process.env.BRAVE_COUNTRY;
            }
            if (process.env.BRAVE_SEARCH_LANG) {
                params.search_lang = process.env.BRAVE_SEARCH_LANG;
            }
            // fetch, not axios: undici's global dispatcher is wired to the
            // egress proxy by undici-proxy-bootstrap.cjs (axios' own env-proxy
            // handling can't CONNECT-tunnel https through squid).
            const url = new URL(endpoint);
            for (const [key, value] of Object.entries(params)) {
                url.searchParams.set(key, String(value));
            }
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    'X-Subscription-Token': config.apiKey,
                },
                signal: AbortSignal.timeout(config.timeout),
            });
            if (!response.ok) {
                const body = (await response.text().catch(() => '')).slice(0, 300);
                throw new Error(`HTTP ${response.status}: ${body}`);
            }
            const data = await response.json();
            const mapOrganic = (results) => (results ?? []).slice(0, numResults).map((result, index) => ({
                position: index + 1,
                title: stripHtml(result.title),
                link: result.url ?? '',
                snippet: stripHtml(result.description),
                date: result.age ?? result.page_age ?? '',
                attribution: toAttribution(result),
            }));
            const mapNews = (results) => (results ?? []).map((result, index) => ({
                title: stripHtml(result.title),
                link: result.url ?? '',
                snippet: stripHtml(result.description),
                date: result.age ?? result.page_age ?? '',
                source: toAttribution(result),
                imageUrl: result.thumbnail?.src ?? '',
                position: index + 1,
            }));
            const mapVideos = (results) => (results ?? []).map((result, index) => ({
                title: stripHtml(result.title),
                link: result.url ?? '',
                snippet: stripHtml(result.description),
                date: result.age ?? result.page_age ?? '',
                imageUrl: result.thumbnail?.src ?? '',
                position: index + 1,
            }));
            const mapImages = (results) => (results ?? []).slice(0, 6).map((result, index) => ({
                title: stripHtml(result.title),
                imageUrl: result.properties?.url ?? result.thumbnail?.src ?? '',
                position: index + 1,
                source: toAttribution(result),
                domain: toAttribution(result),
                link: result.url ?? '',
            }));
            let results;
            if (type === 'images') {
                results = {
                    organic: [],
                    images: mapImages(data.results),
                    topStories: [],
                    relatedSearches: [],
                    videos: [],
                    news: [],
                };
            }
            else if (type === 'videos') {
                results = {
                    organic: [],
                    images: [],
                    topStories: [],
                    relatedSearches: [],
                    videos: mapVideos(data.results),
                    news: [],
                };
            }
            else if (type === 'news') {
                const news = mapNews(data.results);
                results = {
                    organic: [],
                    images: [],
                    topStories: news.slice(0, DEFAULT_SEARCH_RESULT_COUNT),
                    relatedSearches: [],
                    videos: [],
                    news,
                };
            }
            else {
                // /web/search returns a mixed payload: organic under data.web,
                // plus optional news/videos clusters.
                const news = mapNews(data.news?.results);
                results = {
                    organic: mapOrganic(data.web?.results),
                    images: [],
                    topStories: news.slice(0, DEFAULT_SEARCH_RESULT_COUNT),
                    relatedSearches: (data.query?.altered != null && data.query.altered !== '')
                        ? [{ query: data.query.altered }]
                        : [],
                    videos: mapVideos(data.videos?.results),
                    news,
                };
            }
            results.places = [];
            results.shopping = [];
            results.peopleAlsoAsk = [];
            results.knowledgeGraph = undefined;
            results.answerBox = undefined;
            return { success: true, data: results };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: `Brave Search API request failed: ${errorMessage}`,
            };
        }
    };
    return { getSources };
};
const createSearchAPI = (config) => {
    const { searchProvider = 'serper', serperApiKey, searxngInstanceUrl, searxngApiKey, } = config;
    // librechat.yaml only validates 'serper'/'searxng'; the env override lets
    // the stack swap the actual backend (e.g. brave) without failing config
    // validation. Scraper/reranker wiring is unaffected.
    const provider = (process.env.LIBRECHAT_SEARCH_PROVIDER_OVERRIDE || searchProvider).toLowerCase();
    if (provider === 'serper') {
        return createSerperAPI(serperApiKey);
    }
    else if (provider === 'searxng') {
        return createSearXNGAPI(searxngInstanceUrl, searxngApiKey);
    }
    else if (provider === 'brave') {
        return createBraveAPI();
    }
    else {
        throw new Error(`Invalid search provider: ${provider}. Must be 'serper', 'searxng', or 'brave'`);
    }
};
const createSourceProcessor = (config = {}, scraperInstance) => {
    if (!scraperInstance) {
        throw new Error('Scraper instance is required');
    }
    const { topResults = 5, 
    // strategies = ['no_extraction'],
    // filterContent = true,
    reranker, logger, } = config;
    const logger_ = logger || utils.createDefaultLogger();
    const scraper = scraperInstance;
    const webScraper = {
        scrapeMany: async ({ query, links, onGetHighlights, contentCharLimit, skipHighlights, }) => {
            logger_.debug(`Scraping ${links.length} links`);
            const promises = [];
            try {
                for (let i = 0; i < links.length; i++) {
                    const currentLink = links[i];
                    const promise = scraper
                        .scrapeUrl(currentLink, {})
                        .then(([url, response]) => {
                        const attribution = utils.getAttribution(url, response.data?.metadata, logger_);
                        if (response.success && response.data) {
                            const [content, references] = scraper.extractContent(response);
                            return {
                                url,
                                references,
                                attribution,
                                content: truncateText(chunker.cleanText(content), contentCharLimit ?? MAX_SOURCE_CONTENT_CHARS),
                            };
                        }
                        else {
                            logger_.error(`Error scraping ${redactUrl(url)}: ${response.error ?? 'Unknown error'}`);
                        }
                        return {
                            url,
                            attribution,
                            error: true,
                            content: '',
                        };
                    })
                        .then(async (result) => {
                        try {
                            if (result.error != null) {
                                logger_.error(`Error scraping ${redactUrl(result.url)}`);
                                return {
                                    ...result,
                                };
                            }
                            // Direct-fetch mode returns the page content itself, so
                            // reranked highlights add nothing but latency (and, on
                            // boilerplate-heavy pages, misleading low-relevance noise).
                            if (skipHighlights) {
                                if (onGetHighlights) {
                                    onGetHighlights(result.url);
                                }
                                return result;
                            }
                            const highlights = await getHighlights({
                                query,
                                reranker,
                                content: result.content,
                                logger: logger_,
                            });
                            if (onGetHighlights) {
                                onGetHighlights(result.url);
                            }
                            return {
                                ...result,
                                highlights,
                            };
                        }
                        catch (error) {
                            logger_.error('Error processing scraped content:', error);
                            return {
                                ...result,
                            };
                        }
                    })
                        .catch((error) => {
                        // error.message only — serializing the full error can embed
                        // the request URL (axios config) in the log line.
                        logger_.error(`Error scraping ${redactUrl(currentLink)}: ${error?.message ?? error}`);
                        return {
                            url: currentLink,
                            error: true,
                            content: '',
                        };
                    });
                    promises.push(promise);
                }
                return await Promise.all(promises);
            }
            catch (error) {
                logger_.error('Error in scrapeMany:', error);
                return [];
            }
        },
    };
    const fetchContents = async ({ links, query, target, onGetHighlights, onContentScraped, contentCharLimit, skipHighlights, }) => {
        const initialLinks = links.slice(0, target);
        // const remainingLinks = links.slice(target).reverse();
        const results = await webScraper.scrapeMany({
            query,
            links: initialLinks,
            onGetHighlights,
            contentCharLimit,
            skipHighlights,
        });
        for (const result of results) {
            if (result.error === true) {
                continue;
            }
            const { url, content, attribution, references, highlights } = result;
            onContentScraped?.(url, {
                content,
                attribution,
                references,
                highlights,
            });
        }
    };
    const processSources = async ({ result, numElements, query, news, proMode = true, onGetHighlights, contentCharLimit, skipHighlights, }) => {
        try {
            if (!result.data) {
                return {
                    organic: [],
                    topStories: [],
                    images: [],
                    relatedSearches: [],
                };
            }
            else if (!result.data.organic) {
                return result.data;
            }
            if (!proMode) {
                const wikiSources = result.data.organic.filter((source) => source.link.includes('wikipedia.org'));
                if (!wikiSources.length) {
                    return result.data;
                }
                const wikiSourceMap = new Map();
                wikiSourceMap.set(wikiSources[0].link, wikiSources[0]);
                const onContentScraped = createSourceUpdateCallback(wikiSourceMap);
                await fetchContents({
                    query,
                    target: 1,
                    onGetHighlights,
                    onContentScraped,
                    links: [wikiSources[0].link],
                });
                for (let i = 0; i < result.data.organic.length; i++) {
                    const source = result.data.organic[i];
                    const updatedSource = wikiSourceMap.get(source.link);
                    if (updatedSource) {
                        result.data.organic[i] = {
                            ...source,
                            ...updatedSource,
                        };
                    }
                }
                return result.data;
            }
            const sourceMap = new Map();
            const organicLinksSet = new Set();
            // Collect organic links
            const organicLinks = collectLinks(result.data.organic, sourceMap, organicLinksSet);
            // Collect top story links, excluding any that are already in organic links
            const topStories = result.data.topStories ?? [];
            const topStoryLinks = collectLinks(topStories, sourceMap, organicLinksSet);
            if (organicLinks.length === 0 && (topStoryLinks.length === 0 || !news)) {
                return result.data;
            }
            const onContentScraped = createSourceUpdateCallback(sourceMap);
            const promises = [];
            // Process organic links
            if (organicLinks.length > 0) {
                promises.push(fetchContents({
                    query,
                    onGetHighlights,
                    onContentScraped,
                    links: organicLinks,
                    target: numElements,
                    contentCharLimit,
                    skipHighlights,
                }));
            }
            // Process top story links
            if (news && topStoryLinks.length > 0) {
                promises.push(fetchContents({
                    query,
                    onGetHighlights,
                    onContentScraped,
                    links: topStoryLinks,
                    target: numElements,
                    contentCharLimit,
                }));
            }
            await Promise.all(promises);
            if (result.data.organic.length > 0) {
                updateSourcesWithContent(result.data.organic, sourceMap);
            }
            if (news && topStories.length > 0) {
                updateSourcesWithContent(topStories, sourceMap);
            }
            return result.data;
        }
        catch (error) {
            logger_.error('Error in processSources:', error);
            return {
                organic: [],
                topStories: [],
                images: [],
                relatedSearches: [],
                ...result.data,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };
    return {
        processSources,
        topResults,
    };
};
/** Helper function to collect links and update sourceMap */
function collectLinks(sources, sourceMap, existingLinksSet) {
    const links = [];
    for (const source of sources) {
        if (source.link) {
            // For topStories, only add if not already in organic links
            if (existingLinksSet && existingLinksSet.has(source.link)) {
                continue;
            }
            links.push(source.link);
            if (existingLinksSet) {
                existingLinksSet.add(source.link);
            }
            sourceMap.set(source.link, source);
        }
    }
    return links;
}
/** Helper function to update sources with scraped content */
function updateSourcesWithContent(sources, sourceMap) {
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const updatedSource = sourceMap.get(source.link);
        if (updatedSource) {
            sources[i] = {
                ...source,
                ...updatedSource,
            };
        }
    }
}

exports.createSearchAPI = createSearchAPI;
exports.createSourceProcessor = createSourceProcessor;
//# sourceMappingURL=search.cjs.map
