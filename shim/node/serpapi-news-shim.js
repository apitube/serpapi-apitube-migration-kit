/*
 * SerpApi Google News -> APITube shim.
 *
 * Accepts the parameters you already send to `engine=google_news`, returns the shape you already
 * parse, and queries APITube underneath. Every conversion that loses something calls onWarning.
 *
 * Node 18+ (global fetch). No dependencies.
 *
 *   import { SerpApiNewsShim } from './serpapi-news-shim.js';
 *
 *   const client = new SerpApiNewsShim({ apiKey: process.env.APITUBE_API_KEY });
 *   const response = await client.search({ engine: 'google_news', q: 'tesla site:bbc.co.uk when:7d' });
 */

const APITUBE_BASE_URL = 'https://api.apitube.io';

const MAX_MULTI_VALUES = 3;
const MAX_PER_PAGE = 250;

// Google's search country vs APITube's ISO publisher country. Only the codes that actually differ.
const COUNTRY_FIXUPS = {
    uk: 'gb'
};

// Google's legacy language codes and the ISO 639-1 codes APITube accepts.
const LANGUAGE_FIXUPS = {
    iw: 'he',
    in: 'id',
    ji: 'yi'
};

const UNSUPPORTED_LANGUAGES = {
    ru: 'APITube has no Russian (400 ER0237). There is no substitute.',
    uk: 'APITube has no Ukrainian (400 ER0237). There is no substitute.'
};

// SerpApi parameters with no APITube counterpart, and why.
const DROPPED_PARAMS = {
    topic_token:
        'topic_token is an opaque Google identifier with no lookup table. Re-express it as category.id (IPTC) or topic.id.',
    section_token: 'section_token is a sub-section of a Google topic. Re-express it as a narrower category.id.',
    story_token:
        'story_token identifies a Google cluster. APITube articles carry story.id for grouping, but it is not a filter.',
    kgmid: 'kgmid is a Google Knowledge Graph id. Re-express it as organization.name or person.name.',
    no_cache: 'no_cache has no meaning against an index — APITube is not a scraper with a cache.',
    async: 'async has no equivalent: APITube has no asynchronous job submission.',
    zero_trace: 'zero_trace is a SerpApi enterprise feature with no APITube counterpart.',
    device: 'device changes which Google page is scraped. APITube serves one index regardless of device.'
};

const KNOWN_PARAMS = new Set([
    'engine', 'api_key', 'q', 'gl', 'hl', 'so', 'topic_token', 'section_token', 'publication_token',
    'story_token', 'kgmid', 'no_cache', 'async', 'output', 'zero_trace', 'device',
    // not SerpApi's, but people add them when they discover APITube pages
    'page', 'per_page', 'num'
]);

export class SerpApiNewsShim {
    constructor({
        apiKey,
        baseUrl = APITUBE_BASE_URL,
        fetchImpl = globalThis.fetch,
        onWarning = message => console.warn(`[serpapi-shim] ${message}`),
        strict = false
    } = {}) {
        if (!apiKey) {
            throw new SerpApiShimError('apiKey is required. Get one at https://dashboard.apitube.io');
        }

        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.fetchImpl = fetchImpl;
        this.onWarning = onWarning;
        this.strict = strict;
        this.warnings = [];
    }

    async search(params = {}) {
        this.warnings = [];

        if (params.engine && params.engine !== 'google_news') {
            throw new SerpApiShimError(
                `This shim only covers engine=google_news; got "${params.engine}". Other SerpApi engines scrape different Google surfaces and have no APITube equivalent.`
            );
        }

        const apitubeParams = this.translateParams(params);
        const payload = await this.request('/v1/news/everything', apitubeParams);

        return this.toResponse(payload, params, apitubeParams);
    }

    // SerpApi returns the count inside the search response; APITube needs a separate call.
    async count(params = {}) {
        const apitubeParams = this.translateParams(params);

        delete apitubeParams.page;
        delete apitubeParams.per_page;
        delete apitubeParams['sort.by'];
        delete apitubeParams['sort.order'];

        const payload = await this.request('/v1/news/count', apitubeParams);

        return typeof payload.count === 'number' ? payload.count : null;
    }

    translateParams(serpapi = {}) {
        const out = {};

        for (const key of Object.keys(serpapi)) {
            if (!KNOWN_PARAMS.has(key)) {
                this.warn(
                    `Unknown SerpApi parameter "${key}" was not forwarded. APITube ignores parameters it does not recognise and returns the ENTIRE index with a 200, so forwarding it would look like success.`
                );
            }
        }

        for (const [key, reason] of Object.entries(DROPPED_PARAMS)) {
            if (!isEmpty(serpapi[key])) {
                this.warn(`${key}="${serpapi[key]}" dropped: ${reason}`);
            }
        }

        if (!isEmpty(serpapi.publication_token)) {
            this.warn(
                `publication_token="${serpapi.publication_token}" dropped: it is an opaque Google identifier. Use source.domain with the publisher's actual domain instead.`
            );
        }

        if (!isEmpty(serpapi.output) && serpapi.output !== 'json') {
            this.warn(
                `output="${serpapi.output}" dropped: APITube returns JSON. For other formats use export=csv|tsv|xlsx|xml|rss|parquet|jsonl on the request.`
            );
        }

        Object.assign(out, this.translateQuery(serpapi.q));
        Object.assign(out, this.translateLanguage(serpapi));
        Object.assign(out, this.translateCountry(serpapi, out));
        Object.assign(out, this.translateSort(serpapi));
        Object.assign(out, this.translatePaging(serpapi));

        return out;
    }

    // Google packs several filters into one string; APITube wants them as separate parameters.
    translateQuery(q) {
        if (isEmpty(q)) {
            return {};
        }

        const out = {};
        let rest = String(q).trim();

        const domains = [];
        const ignoreDomains = [];

        rest = rest.replace(/(-?)site:(\S+)/gi, (_, negated, domain) => {
            (negated ? ignoreDomains : domains).push(normaliseDomain(domain));
            return ' ';
        });

        rest = rest.replace(/\bwhen:(\d+)([hdy])\b/gi, (_, amount, unit) => {
            out['published_at.start'] = `NOW-${amount}${unit.toLowerCase()}`;
            return ' ';
        });

        rest = rest.replace(/\bwhen:(\d+)m\b/gi, (match, amount) => {
            this.warn(
                `when:${amount}m dropped: APITube reads "m" in NOW-${amount}m as MONTHS, not minutes — NOW-30m returns almost the whole index. Use an absolute published_at.start timestamp for sub-hour windows.`
            );
            return ' ';
        });

        rest = rest.replace(/\bafter:(\S+)/gi, (_, date) => {
            out['published_at.start'] = toIsoBoundary(date);
            return ' ';
        });

        rest = rest.replace(/\bbefore:(\S+)/gi, (_, date) => {
            out['published_at.end'] = toIsoBoundary(date);
            return ' ';
        });

        rest = rest.replace(/\blocation:("[^"]+"|\S+)/gi, (_, place) => {
            const name = stripQuotes(place);

            out['location.name'] = name;
            this.warn(
                `location:${name} became location.name=${name}, which resolves against APITube's entity index rather than matching free text. Exact names only: "New York City" resolves, "New York" and "California" return 400 ER0218.`
            );

            return ' ';
        });

        rest = rest.replace(/\bsource:("[^"]+"|\S+)/gi, (_, name) => {
            this.warn(
                `source:${stripQuotes(name)} dropped: APITube has no source.name parameter. Sending one returns 200 and filters NOTHING — the whole index comes back. Use site:<domain> instead.`
            );
            return ' ';
        });

        // intitle:/allintitle: are free — APITube only ever searches headlines.
        rest = rest.replace(/\b(all)?intitle:/gi, ' ');

        if (domains.length) {
            out['source.domain'] = this.capMulti(domains, 'site:').join(',');
        }

        if (ignoreDomains.length) {
            out['ignore.source.domain'] = this.capMulti(ignoreDomains, '-site:').join(',');
        }

        const negated = [];

        rest = rest.replace(/(?:^|\s)-("[^"]+"|[^\s"]+)/g, (_, term) => {
            negated.push(stripQuotes(term));
            return ' ';
        });

        if (negated.length) {
            out['ignore.title'] = this.capMulti(negated, 'negation').join(',');
        }

        rest = rest.replace(/\s+/g, ' ').trim();

        if (!rest) {
            return out;
        }

        if (/[*?]/.test(rest)) {
            const message = `q="${rest}" contains a wildcard. APITube has no wildcard support, and title= accepts one without error while returning the ENTIRE index. Expand it into an OR list: query=title:(term1 OR term2).`;

            if (this.strict) {
                throw new SerpApiShimError(message);
            }

            this.warn(message);

            return out;
        }

        this.warn(
            `q="${rest}" searches HEADLINES only on APITube. Google News matches the article body too, so expect fewer results. The full body is in the response if you want to filter locally.`
        );

        Object.assign(out, this.textToParams(rest));

        return out;
    }

    textToParams(text) {
        const hasBoolean = /\b(AND|OR|NOT)\b/.test(text) || text.includes('(');

        if (!hasBoolean) {
            const phrase = text.match(/^"([^"]+)"$/);

            if (phrase) {
                return { title: `"${phrase[1]}"` };
            }

            const words = splitTerms(text);

            // Google ANDs adjacent terms, and so does APITube's comma — this one is faithful.
            return { title: words.join(',') };
        }

        return { query: qualifyExpression(text) };
    }

    translateLanguage(serpapi) {
        if (isEmpty(serpapi.hl)) {
            return {};
        }

        let code = String(serpapi.hl).trim().toLowerCase();

        if (code.includes('-') || code.includes('_')) {
            const short = code.split(/[-_]/)[0];

            this.warn(
                `hl="${serpapi.hl}" narrowed to language.code=${short}: APITube accepts two-letter codes only (400 ER0061 otherwise). Any regional distinction is lost.`
            );
            code = short;
        }

        if (LANGUAGE_FIXUPS[code]) {
            this.warn(
                `hl="${code}" mapped to language.code=${LANGUAGE_FIXUPS[code]}: APITube uses the current ISO 639-1 code, not Google's legacy one.`
            );
            code = LANGUAGE_FIXUPS[code];
        }

        if (UNSUPPORTED_LANGUAGES[code]) {
            this.warn(`hl="${code}" dropped: ${UNSUPPORTED_LANGUAGES[code]}`);

            return {};
        }

        this.warn(
            `hl="${serpapi.hl}" became language.code=${code}: on Google this is the INTERFACE language, on APITube it is the language the article is written in. Related, not identical.`
        );

        return { 'language.code': code };
    }

    translateCountry(serpapi, current) {
        if (isEmpty(serpapi.gl)) {
            return {};
        }

        let code = String(serpapi.gl).trim().toLowerCase();

        if (COUNTRY_FIXUPS[code]) {
            this.warn(
                `gl="${code}" mapped to source.country.code=${COUNTRY_FIXUPS[code]}: APITube uses the ISO code (400 ER0212 for "${code}").`
            );
            code = COUNTRY_FIXUPS[code];
        }

        if (current['source.domain']) {
            this.warn(
                `gl="${serpapi.gl}" dropped because site: is already narrowing to a publisher. Many publishers carry country_code "un" in APITube's source index, so combining source.domain with source.country.code usually returns zero — theguardian.com does.`
            );

            return {};
        }

        this.warn(
            `gl="${serpapi.gl}" became source.country.code=${code}: on Google this is the country you are searching FROM, on APITube it is where the publisher is based.`
        );

        return { 'source.country.code': code };
    }

    translateSort(serpapi) {
        if (isEmpty(serpapi.so)) {
            return {};
        }

        const so = String(serpapi.so);

        if (so === '1') {
            return { 'sort.by': 'published_at', 'sort.order': 'desc' };
        }

        if (so === '0') {
            this.warn(
                'so=0 (relevance) dropped: sort.by=relevance returns 500 ER0183 on APITube when a search term is present. Falling back to publication date. The closest quality proxy is sort.by=source.rank.opr, which ranks publishers rather than articles.'
            );

            return { 'sort.by': 'published_at', 'sort.order': 'desc' };
        }

        this.warn(`so="${so}" is not a documented SerpApi value (0 = relevance, 1 = date). Ignored.`);

        return {};
    }

    translatePaging(serpapi) {
        const out = {};

        const size = firstDefined(serpapi.per_page, serpapi.num);

        if (!isEmpty(size)) {
            let perPage = Number(size);

            if (perPage > MAX_PER_PAGE) {
                this.warn(
                    `per_page=${perPage} capped at ${MAX_PER_PAGE}: APITube returns 400 ER0171 "Limit is out of range." above that.`
                );
                perPage = MAX_PER_PAGE;
            }

            out.per_page = perPage;
        }

        if (!isEmpty(serpapi.page)) {
            const page = Number(serpapi.page);

            if (page < 1) {
                this.warn(
                    `page=${page} sent as page=1: APITube pages start at 1 and treat page=0 as page=1 without an error, which silently returns the first page twice.`
                );
                out.page = 1;
            } else {
                out.page = page;
            }
        }

        return out;
    }

    capMulti(items, label) {
        const unique = [...new Set(items)];

        if (unique.length > MAX_MULTI_VALUES) {
            this.warn(
                `${label} had ${unique.length} values; APITube applies at most ${MAX_MULTI_VALUES} and ignores the rest without saying so. Kept: ${unique.slice(0, MAX_MULTI_VALUES).join(', ')}.`
            );
        }

        return unique.slice(0, MAX_MULTI_VALUES);
    }

    toResponse(payload, serpapiParams, apitubeParams) {
        const articles = payload.results || [];

        return {
            search_metadata: {
                id: payload.request_id || null,
                status: payload.status === 'ok' ? 'Success' : 'Error',
                json_endpoint: payload.path || null,
                total_time_taken: null
            },
            search_parameters: { engine: 'google_news', ...serpapiParams },
            news_results: articles.map((article, index) => this.toNewsResult(article, index)),
            _apitube_parameters: apitubeParams,
            _warnings: [...this.warnings]
        };
    }

    toNewsResult(article, index) {
        return {
            position: index + 1,
            title: article.title || '',
            source: {
                name: article.source?.domain || '',
                icon: article.source?.favicon || null,
                authors: article.author?.name ? [article.author.name] : []
            },
            link: article.href || '',
            thumbnail: article.image || null,
            thumbnail_small: article.image || null,
            date: article.published_at || null,
            iso_date: article.published_at || null,
            story_token: article.story?.id != null ? String(article.story.id) : null,
            serpapi_link: null,

            // Everything Google News does not have. Kept rather than discarded — this is the
            // reason to migrate, so throwing it away in the compatibility layer would be silly.
            _apitube: {
                id: article.id,
                body: article.body,
                body_html: article.body_html,
                description: article.description,
                summary: article.summary,
                language: article.language,
                categories: article.categories,
                topics: article.topics,
                industries: article.industries,
                entities: article.entities,
                locations_mentioned: article.locations_mentioned,
                sentiment: article.sentiment,
                keywords: article.keywords,
                links: article.links,
                media: article.media,
                readability: article.readability,
                shares: article.shares,
                story: article.story,
                source: article.source,
                is_breaking: article.is_breaking,
                is_duplicate: article.is_duplicate,
                read_time: article.read_time,
                words_count: article.words_count,
                characters_count: article.characters_count,
                sentences_count: article.sentences_count,
                paragraphs_count: article.paragraphs_count
            }
        };
    }

    async request(path, params) {
        const url = new URL(`${this.baseUrl}${path}`);

        for (const [key, value] of Object.entries(params)) {
            if (!isEmpty(value)) {
                url.searchParams.set(key, value);
            }
        }

        const response = await this.fetchImpl(url.toString(), {
            headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' }
        });

        const text = await response.text();

        let payload;

        try {
            payload = JSON.parse(text);
        } catch {
            // A 502 from the gateway is HTML, and JSON.parse on it hides the real problem.
            throw new SerpApiShimError(
                `APITube returned a non-JSON body (HTTP ${response.status}) for ${url.pathname}: ${text.slice(0, 200)}`,
                { status: response.status, url: url.toString() }
            );
        }

        if (payload.status === 'not_ok' || payload.errors?.length) {
            const error = payload.errors?.[0] || {};

            throw new SerpApiShimError(`APITube ${error.code || response.status}: ${error.message || 'request failed'}`, {
                code: error.code,
                status: error.status || response.status,
                requestId: payload.request_id,
                url: url.toString()
            });
        }

        return payload;
    }

    warn(message) {
        this.warnings.push(message);

        if (this.strict) {
            throw new SerpApiShimError(message);
        }

        if (typeof this.onWarning === 'function') {
            this.onWarning(message);
        }
    }
}

export class SerpApiShimError extends Error {
    constructor(message, { code, status, requestId, url } = {}) {
        super(message);
        this.name = 'SerpApiShimError';
        this.code = code;
        this.status = status;
        this.requestId = requestId;
        this.url = url;
    }
}

// Prefix every bare term in a boolean expression with `title:` — APITube's query language is
// field-scoped, so an unqualified expression does not search headlines at all.
export function qualifyExpression(expression) {
    return expression
        .replace(/("[^"]+"|\([^)]*\)|[^\s()]+)/g, token => {
            if (/^(AND|OR|NOT)$/i.test(token)) {
                return token;
            }

            if (token.startsWith('(')) {
                return `(${qualifyExpression(token.slice(1, -1))})`;
            }

            if (token.includes(':')) {
                return quoteColonValue(token);
            }

            return `title:${token}`;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

export function quoteColonValue(token) {
    const at = token.indexOf(':');
    const field = token.slice(0, at);
    const value = token.slice(at + 1);

    if (!value.includes(':') || value.startsWith('"')) {
        return token;
    }

    return `${field}:"${value}"`;
}

function splitTerms(text) {
    return (text.match(/"[^"]+"|\S+/g) || []).map(term => term.trim()).filter(Boolean);
}

function stripQuotes(value) {
    return String(value).replace(/^"|"$/g, '');
}

function normaliseDomain(source) {
    return String(source)
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/.*$/, '')
        .toLowerCase();
}

function toIsoBoundary(date) {
    const trimmed = String(date).trim();

    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
}

function firstDefined(...values) {
    return values.find(value => !isEmpty(value));
}

function isEmpty(value) {
    return value === undefined || value === null || value === '';
}
