# SerpApi Google News → APITube migration kit

Everything you need to move off SerpApi's `engine=google_news` and onto the [APITube News API](https://apitube.io): a parameter map, a drop-in shim for Node.js and Python, and an honest list of what does not carry over.

Every mapping here was executed against the live APITube API before being written down. Where something does not work, it says so.

## Read this first: you are replacing a scraper with an index

SerpApi does not have a news database. It runs a Google News search on request and parses the page. That single fact explains almost every difference below:

| | SerpApi `google_news` | APITube |
|---|----------------------|---------|
| **What you get back** | Title, link, source name, date, thumbnail | Full `body` and `body_html`, plus everything below |
| **Article text** | **None** — you follow the link and fetch it yourself | Included in the response |
| **Pagination** | **None.** One request, one page of results | `page` + `per_page`, up to 250 per request |
| **Filtering** | Google's `q` operators (`site:`, `when:`, `-`, `OR`) | 60+ structured parameters |
| **Enrichment** | None | Entities, sentiment (title/body/overall/per-entity), IPTC categories, topics, industries, publisher bias and rank, readability |
| **Result identity** | Opaque tokens (`story_token`, `topic_token`) | Stable integer ids |
| **Determinism** | Google's ranking, which changes between calls | An index you query with explicit filters |

If your code follows every `link` and fetches the article itself, the migration deletes that entire stage.

## The three things that break silently

**1. There is no pagination to port.** SerpApi's Google News endpoint has no `num`, `start` or `page` parameter — you get one page and that is the query. Code written against it usually loops over queries rather than pages. On APITube the same result set is `per_page=250` plus `page=1,2,3…`, and the count comes from a separate endpoint. This is a gain, but it changes the shape of the loop.

**2. Tokens do not translate.** `topic_token`, `publication_token`, `section_token`, `story_token` and `kgmid` are opaque Google identifiers. There is no lookup table, and nothing on APITube accepts them. Every token-based query has to be re-expressed as a filter — the shim tells you which one.

**3. `NOW-30m` means thirty MONTHS.** APITube's relative date syntax reads `m` as months, not minutes. Verified: `published_at.start=NOW-30m` returns 28 509 of the 29 744 `title=tesla` articles — effectively no filter. Minutes are not expressible; use `NOW-1h` as the floor.

```
NOW-1h   →  2 articles      (hours)
NOW-24h  →  80 articles
NOW-1d   →  80 articles     (days — matches 24h, as it should)
NOW-7d   →  1 611 articles
NOW-1MONTH → 4 632 articles
NOW-30m  →  28 509 articles ← thirty months, not thirty minutes
NOW-1y   →  27 795 articles
```

## What is in here

| Path | What it gives you |
|------|-------------------|
| [`reference/parameter-mapping.md`](reference/parameter-mapping.md) | Every `google_news` parameter → its APITube equivalent |
| [`reference/query-operators.md`](reference/query-operators.md) | Google's `q` operators (`site:`, `when:`, `OR`, `-`, quotes) translated |
| [`reference/response-mapping.md`](reference/response-mapping.md) | `news_results` field by field, and what APITube adds |
| [`reference/limitations.md`](reference/limitations.md) | What does not carry over, plus live API quirks |
| [`shim/node/`](shim/node/) | `SerpApiNewsShim` — accepts `google_news` parameters, returns the SerpApi response shape |
| [`shim/python/`](shim/python/) | Same shim for Python |
| [`examples/`](examples/) | Before/after request pairs |
| [`tools/ai-migration-prompt.md`](tools/ai-migration-prompt.md) | System prompt for Claude/ChatGPT that converts your queries |

## Quick start

```bash
# SerpApi
curl "https://serpapi.com/search?engine=google_news&q=tesla&gl=us&hl=en&api_key=YOUR_KEY"
```

```bash
# APITube
curl "https://api.apitube.io/v1/news/everything?title=tesla&source.country.code=us&language.code=en&per_page=250" \
  -H "X-API-Key: YOUR_API_KEY"
```

Note what changed: `gl` and `hl` are Google **interface** settings — the country and language of the search you are simulating. `source.country.code` and `language.code` are properties of the **article**. They are close enough to be useful and different enough to check.

## Or use the shim

```js
import { SerpApiNewsShim } from './shim/node/serpapi-news-shim.js';

const client = new SerpApiNewsShim({ apiKey: process.env.APITUBE_API_KEY });

const response = await client.search({
    engine: 'google_news',
    q: 'tesla site:theguardian.com when:7d',
    gl: 'us',
    hl: 'en'
});

for (const item of response.news_results) {
    console.log(item.position, item.title, item.source.name);
}
```

Same parameters in, same `news_results` shape out, APITube underneath — and a warning for every conversion that loses something.

## `site:` works, but check your domain first

`site:` maps to `source.domain`, and the parameter itself is exact. Two things to verify before you rely on it.

**Coverage is not uniform.** A domain that is indexed but has no articles returns `0` results with a `200` — no error to catch. On 27 July 2026, `theguardian.com`, `apnews.com`, `techcrunch.com` and `bbc.co.uk` all returned four-figure counts, while `bloomberg.com`, `nytimes.com` and `forbes.com` returned double or single digits, and `reuters.com` and `cnn.com` returned **zero**. A domain missing from the source index entirely returns `400 ER0214` — `www.reuters.com` does, while `reuters.com` does not.

**Counts for a single domain are not currently stable.** Repeating the identical `source.domain` count request returns alternating values — `theguardian.com` alternated between 3 658 and 4 831 across six consecutive calls, `bbc.co.uk` between 909 and 741 — and the `source` object attached to the returned articles is sometimes a different publisher's record (the articles themselves are correct; the `source.domain` and `source.id` fields on them are not). Filters that do not resolve a domain, such as `title=`, are stable across repeats.

Until that settles, treat a domain count as an order of magnitude rather than a number, and do not key anything on `source.id` from a domain-filtered query.

```bash
# stable
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&title=tesla"

# alternates between two values on repeat
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&source.domain=theguardian.com"
```

## License

MIT. Use it, fork it, ship it.
