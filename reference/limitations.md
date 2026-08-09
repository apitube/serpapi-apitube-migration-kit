# What does not carry over

Everything here was checked against the live APITube API on 27 July 2026. Errors are quoted with their codes. The dangerous entries are the ones that return `200`.

## Things that fail silently

These return a successful response and do the wrong thing. They are the reason the shim keeps an allow-list instead of forwarding parameters.

**Unknown parameters are ignored.** APITube drops what it does not recognise and answers `200` with the query unfiltered. A forwarded `q=`, `gl=`, `hl=` or `so=` leaves you with the whole index and no indication anything went wrong.

**`source.name` does not exist.** It looks like it should, and it behaves like an unknown parameter:

```bash
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&source.name=BBC"
# {"count":3050237243}   ← the entire index

curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY"
# {"count":3050237323}   ← the entire index again
```

The articles returned for `source.name=BBC` came from `fakti.bg`. Use `source.domain`.

**Wildcards return everything.** `title=immuni*` is accepted and returns the whole index with a `200`. Expand into `query=title:(immunity OR immunization OR immunology)`.

**Multi-value filters apply the first 3.** `source.domain=a.com,b.com,c.com,d.com` filters on the first three. No error, nothing in the response to say so.

**`page=0` equals `page=1`.** Not a problem coming from SerpApi, which has no paging, but it will bite when you write the new pagination loop.

**`source.domain` plus `source.country.code` is usually empty.** Many publishers carry `country_code: "un"` in the source index. `theguardian.com` returns thousands of articles; `theguardian.com` + `source.country.code=gb` returns zero.

**Domain counts are currently unstable.** Repeating the same `source.domain` count returns alternating values (`theguardian.com`: 3 658 / 4 831 across six consecutive calls; `bbc.co.uk`: 909 / 741), and the `source` object attached to the returned articles is sometimes another publisher's record — the articles themselves are correct, their `source.domain` and `source.id` fields are not. Filters that do not resolve a domain, such as `title=`, are stable.

**And the `source` object itself is unreliable.** Sampling 750 articles from an unfiltered query on 27 July 2026 and comparing `source.domain` against the host of each article's own `href`:

| Comparison | Articles | |
|------------|----------|---|
| Match | 576 (77%) | correct |
| Same site, different subdomain | 44 (5%) | fine — `m.tuttojuve.com` vs `tuttojuve.com` |
| **Different site entirely** | **130 (17%)** | **wrong publisher** |

Examples of the third row, all from one sample:

```
source.domain=qcardio.com        href=www.thoroughbredracing.com
source.domain=hornbach.se        href=www.barandbench.com
source.domain=parterrebox.com    href=www.solidaires.org
```

The article and its `href` are correct; the publisher metadata attached to it is not. That affects `source.domain`, `source.id`, `source.bias`, `source.rankings` and `source.location` alike.

Until this settles: trust `href` for attribution, treat `source.*` as advisory, and expect a domain filter to return an incomplete set. The index also holds corrupted duplicates — `ww.electrek.co` (a `www.` that lost a character) carries 1 754 articles alongside `electrek.co`'s 1 578, so filtering on the correct spelling finds roughly half the coverage.

## Things that fail loudly

| What you send | What you get |
|---------------|--------------|
| `source.country.code=uk` | `400 ER0212 "source country code 'uk' not found."` — use `gb` |
| `language.code=en-US` | `400 ER0061 "language.code must be between 1 and 2 characters."` |
| `language.code=ru` or `uk` | `400 ER0237` — no Russian, no Ukrainian |
| `language.code=iw` | `400 ER0237` — Google's legacy Hebrew code; use `he` |
| `per_page=251` | `400 ER0171 "Limit is out of range. Your plan allows up to 250 results per page."` |
| `sort.by=relevance` with a search term | `500 ER0183` |
| `query=category.id:medtop:04000000` | `400 ER0701` — quote values containing a colon |
| `organization.name=Apple Inc` | `400 ER0220` — strip legal suffixes |
| `source.domain=www.reuters.com` | `400 ER0214` — the domain is not in the source index |

## Features with no equivalent

**Relevance ordering.** SerpApi's default `so=0` is Google's relevance ranking. APITube has no working relevance sort. `sort.by=source.rank.opr` orders by publisher authority, which answers a different question but is the closest available.

**Google's tokens.** `topic_token`, `section_token`, `publication_token`, `story_token` and `kgmid` are opaque Google identifiers with no lookup table. Every token-based query must be re-expressed:

| Token | Re-express as |
|-------|---------------|
| `topic_token` | `category.id` (IPTC) or `topic.id` |
| `section_token` | A narrower `category.id` |
| `publication_token` | `source.domain` |
| `story_token` | Nothing — `story.id` groups articles but is not a filter |
| `kgmid` | `organization.name` or `person.name` |

**Google's clustering.** `highlight` and `stories[]` express "this is the lead article and these are the related ones". APITube's `story.id` says only "these articles are the same story" — no lead, no ordering.

**Body-text search.** APITube searches headlines. There is no `content=` equivalent. The compensation is that the body is in the response, so you can filter locally — a good trade for narrow queries, a bad one for broad ones.

**Russian and Ukrainian.** Not in the index. If either is load-bearing, this migration does not work for you.

**`type: "Opinion"`.** SerpApi surfaces Google's article-type label. The nearest APITube signal is `categories[]`, which is a topic taxonomy rather than a format label.

## Things that are better, and change your code anyway

**Pagination exists.** 250 per request, `page` from 1. Code written against a single-page API needs a loop.

**And that loop needs more than a page counter.** Response time varies widely and is not reliably predictable. Measured 27 July 2026, the same request shape returned anywhere from 3 to 28 seconds. A larger page raises the average — on a search query `per_page=10` ran 3–14s against 18–26s at `per_page=250` — but the spread is wide enough that a modest `per_page=100`, and even a query with no `per_page` at all, also landed past 25 seconds. Requests that cross roughly 25 seconds intermittently return `500`. Give the loop a client timeout above 30 seconds and a retry on `500`.

**Counts come from a separate endpoint.** `/v1/news/count` with the same filters. Call it once per filter set.

**No scraping stage.** `body` and `body_html` are in the response, so the fetch-and-extract layer goes away — along with its retries, its user-agent handling and its failure modes.

**Filters compose.** SerpApi's `q` is mutually exclusive with its advanced parameters ("Parameter can't be used together with any of the Advanced Parameters"). On APITube, keyword + category + sentiment + publisher rank in one request is normal.

## Rate limits

APITube's documented limit is 50 requests per minute on the key used for this kit. A migration script that fires hundreds of verification queries needs a backoff — several "rejected" results during this kit's own testing turned out to be rate-limited requests rather than real errors, and only showed their true colours on a slower re-run.
