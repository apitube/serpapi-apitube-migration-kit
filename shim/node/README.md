# Node.js shim

A drop-in replacement for a SerpApi `engine=google_news` client. Same parameter names, same response shape, APITube underneath.

Node 18+ (global `fetch`). No dependencies.

## Install

Copy `serpapi-news-shim.js` into your project, or import it directly:

```js
import { SerpApiNewsShim } from './serpapi-news-shim.js';
```

## Use

```js
const client = new SerpApiNewsShim({ apiKey: process.env.APITUBE_API_KEY });

const response = await client.search({
    engine: 'google_news',
    q: 'tesla site:bbc.co.uk when:7d',
    hl: 'en',
    so: 1
});

for (const item of response.news_results) {
    console.log(item.position, item.title, item.source.name);
}
```

That one `q` string becomes four APITube parameters: `query`, `source.domain`, `published_at.start` and `sort.by`. The shim does the splitting.

## Options

| Option | Default | What it does |
|--------|---------|--------------|
| `apiKey` | — | Required. Your APITube key |
| `baseUrl` | `https://api.apitube.io` | Override for testing |
| `fetchImpl` | `globalThis.fetch` | Inject a fetch for tests |
| `onWarning` | `console.warn` | Receives every lossy-conversion message |
| `strict` | `false` | Throw instead of warning when a conversion cannot be done faithfully |

## Methods

| Method | What it does |
|--------|--------------|
| `search(params)` | Translates and queries `/v1/news/everything`, returns the SerpApi response shape |
| `count(params)` | Total matches for the same filters, from `/v1/news/count`. SerpApi has no equivalent — it does not report a total |

Any `engine` other than `google_news` throws rather than guessing: the other SerpApi engines scrape different Google surfaces and have no APITube equivalent.

## What the `q` parser handles

| In `q` | Becomes |
|--------|---------|
| `tesla` | `title=tesla` |
| `tesla musk` | `title=tesla,musk` (AND, matching Google) |
| `"artificial intelligence"` | `title="artificial intelligence"` |
| `tesla OR rivian` | `query=title:tesla OR title:rivian` |
| `tesla -musk` | `title=tesla` + `ignore.title=musk` |
| `site:bbc.co.uk` | `source.domain=bbc.co.uk` |
| `-site:cnn.com` | `ignore.source.domain=cnn.com` |
| `when:7d` | `published_at.start=NOW-7d` |
| `after:2026-07-20` | `published_at.start=2026-07-20T00:00:00Z` |
| `before:2026-07-27` | `published_at.end=2026-07-27T00:00:00Z` |
| `intitle:` / `allintitle:` | Stripped — APITube only searches headlines anyway |
| `location:"New York City"` | `location.name=New York City` |
| `site:https://www.theguardian.com/uk` | `source.domain=theguardian.com` (scheme, `www.` and path removed) |

`-site:cnn.com` is parsed as a negated domain, not as a negated search term. That ordering matters and is covered by a test.

## Warnings are the point

The shim warns on every conversion that loses something. Collect them once during migration and you have a to-do list:

```js
const warnings = [];
const client = new SerpApiNewsShim({
    apiKey: process.env.APITUBE_API_KEY,
    onWarning: message => warnings.push(message)
});

for (const query of savedQueries) {
    await client.search(query);
}

console.log([...new Set(warnings)].join('\n'));
```

Typical output:

```
q="tesla" searches HEADLINES only on APITube: Google News matches the article body too…
hl="en-US" narrowed to language.code=en: APITube accepts two-letter codes only (400 ER0061)…
gl="uk" mapped to source.country.code=gb: APITube uses the ISO code (400 ER0212 for "uk")…
so=0 (relevance) dropped: sort.by=relevance returns 500 ER0183 on APITube…
topic_token="CAAqIQ" dropped: an opaque Google identifier with no lookup table…
when:30m dropped: APITube reads "m" in NOW-30m as MONTHS, not minutes…
```

Every one of those is a real behaviour change, not boilerplate.

## What the shim protects you from

- **Unknown parameters.** APITube ignores what it does not recognise and returns the **entire index** with a `200`. A forwarded `q=`, `gl=` or `so=` looks like a successful query and is not one. The shim keeps an allow-list.
- **`source.name`.** It does not exist on APITube. `source:BBC` in a `q` is dropped with an explanation rather than translated into a parameter that silently matches everything.
- **Wildcards.** `q=immuni*` returns the whole index with a `200`. The shim refuses to send it.
- **`when:30m`.** APITube reads `m` as months. Thirty months is not a filter. Dropped, with a pointer to absolute timestamps.
- **`gl` plus `site:`.** Many publishers carry `country_code: "un"` in the source index, so the combination usually returns zero. The shim drops `gl` when a domain filter is present and says why.
- **`hl=en-US`.** Returns `400 ER0061`. Narrowed to `en`.
- **`page=0`.** APITube treats it as `page=1` without an error. Normalised, with a warning, so your new pagination loop does not silently repeat the first page.
- **Silent 3-value caps.** More than three domains, and APITube applies the first three without saying so. The shim truncates explicitly.
- **Non-JSON 502 bodies.** Parsed as text first, so you get a real error rather than a JSON parser exception.

## Response extras

Everything APITube returns that Google News does not is kept on `item._apitube` rather than discarded: the full `body` and `body_html`, an extractive `summary`, named entities with per-entity sentiment, sentiment for title and body separately, IPTC categories, topics, industries, mentioned locations, outbound links, publisher bias and Open Page Rank, readability scores, share counts and length metrics.

The article text is the big one. Code written against SerpApi usually follows every `link` and fetches the page itself; that stage disappears.

`response._warnings` carries the warnings for that specific call, and `response._apitube_parameters` shows exactly what was sent — useful when a conversion surprises you.

## Test

```bash
node --test serpapi-news-shim.test.js
```

41 tests, no network. The Python shim has the same 41 and produces byte-identical parameters.
