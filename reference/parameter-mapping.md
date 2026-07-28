# Parameter mapping

Every documented `engine=google_news` parameter and its APITube equivalent. Verified against the live APITube API on 27 July 2026.

**Endpoint:** `https://serpapi.com/search?engine=google_news` → `https://api.apitube.io/v1/news/everything`

**Auth:** `api_key=` in the query string works on both. APITube also accepts `X-API-Key:` as a header.

## The table

| SerpApi | APITube | Fidelity | Note |
|---------|---------|----------|------|
| `engine=google_news` | — | n/a | Endpoint choice, not a filter |
| `api_key` | `api_key` or `X-API-Key` | Exact | |
| `q` | `title`, `query`, `source.domain`, `published_at.start` | Split | Google operators map to different parameters — see [query-operators.md](query-operators.md) |
| `gl` | `source.country.code` | Approximate | Google's search country → the publisher's country. **`uk` must become `gb`** |
| `hl` | `language.code` | Approximate | Google's interface language → the article's language. Two letters only |
| `so=1` | `sort.by=published_at&sort.order=desc` | Exact | Sort by date |
| `so=0` | — | **Dropped** | `sort.by=relevance` returns `500 ER0183` with a search term |
| `topic_token` | — | **Dropped** | Opaque Google token. Use `category.id` (IPTC) or `topic.id` |
| `section_token` | — | **Dropped** | Sub-section of a Google topic |
| `publication_token` | `source.domain` | Manual | Re-express the publisher as a domain |
| `story_token` | — | **Dropped** | `story.id` exists on every APITube article but is not a filter |
| `kgmid` | `organization.name` / `person.name` | Manual | Knowledge Graph id → an entity name |
| `no_cache` | — | Dropped | APITube queries an index; there is no scrape cache |
| `async` | — | Dropped | No async job submission |
| `output=html` | — | Dropped | JSON only, plus eight export formats |
| `zero_trace` | — | Dropped | SerpApi enterprise feature |
| — | `page` | New | SerpApi has no pagination |
| — | `per_page` | New | Up to 250; SerpApi returns one fixed page |

## `gl` — country codes

`gl` is the country of the Google search; `source.country.code` is where the publisher is based. Related, not identical: a US-targeted Google News search happily returns British publishers.

Google accepts `uk`; APITube does not.

```bash
# 400 ER0212 "source country code 'uk' not found."
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&source.country.code=uk"

# 200
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&source.country.code=gb"
```

Verified working: `us`, `gb`, `ca`, `au`, `in`, `de`, `fr`, `jp`, `br`. Rejected with `400 ER0212`: `uk`, and anything that is a language code rather than a country code (`en`, `el`, `cs`).

## `hl` — language codes

`hl` is Google's interface language; `language.code` is the language the article is written in. For a single-language query they usually agree.

**Two-letter codes only.** Google's regional forms are rejected outright:

```bash
# 400 ER0061 "language.code must be between 1 and 2 characters."
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&language.code=en-US"
```

`en-US` → `en`, `pt-BR` → `pt`, `zh-CN` and `zh-TW` → `zh` (the Simplified/Traditional distinction is lost).

Verified working: `en`, `es`, `fr`, `de`, `pt`, `it`, `nl`, `ja`, `zh`, `ko`, `ar`, `hi`, `he`.

Rejected with `400 ER0237`: `ru`, `uk` (Ukrainian), and `iw` — Google's legacy code for Hebrew, which must become `he`.

## `so` — sorting

| SerpApi | Meaning | APITube |
|---------|---------|---------|
| `so=0` (default) | Relevance | **No equivalent.** `sort.by=relevance` with a search term returns `500 ER0183` |
| `so=1` | Date | `sort.by=published_at&sort.order=desc` |

If your code relied on relevance ordering, the closest substitute is `sort.by=source.rank.opr`, which orders by the publisher's Open Page Rank. That ranks *publishers*, not *articles* — a different question, but a defensible one.

## Pagination — new, not mapped

SerpApi's Google News endpoint has no `num`, `start` or `page`. You send a query and get one page.

```bash
# APITube: 250 per request, pages from 1
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&per_page=250&page=1"
```

`per_page` above 250 returns `400 ER0171 "Limit is out of range."` Page numbering starts at 1, and `page=0` is silently treated as `page=1`.

The total count comes from a separate endpoint:

```bash
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&title=tesla"
# {"status":"ok","count":29744, ...}
```

Call it once per filter set, not once per page.

## Parameters APITube adds

None of these have a SerpApi counterpart. They are the reason to migrate rather than the cost of it.

| Parameter | What it filters on |
|-----------|--------------------|
| `category.id` | IPTC MediaTopic — a real taxonomy instead of Google's topic tokens |
| `topic.id`, `industry.id` | Two further classification axes |
| `organization.name`, `person.name`, `location.name` | Named entities, resolved against an index |
| `sentiment.overall.score.min` / `.max` | Sentiment, also available as `sentiment.title.*` and `sentiment.body.*` |
| `entity.sentiment.score.min` | Sentiment **towards a specific entity** |
| `source.rank.opr` | Publisher Open Page Rank |
| `source.bias` | Publisher political leaning |
| `is_breaking`, `is_duplicate`, `has_video` | Article flags |
| `published_at.start` / `.end` | Absolute or relative dates — see the `NOW-` warning in the README |
| `ignore.*` | A negative form for most filters |

## What a full conversion looks like

```bash
# SerpApi
curl "https://serpapi.com/search?engine=google_news&q=tesla+site:theguardian.com+when:7d&gl=uk&hl=en-US&so=1&api_key=YOUR_KEY"
```

```bash
# APITube
curl "https://api.apitube.io/v1/news/everything?title=tesla&source.domain=theguardian.com&published_at.start=NOW-7d&source.country.code=gb&language.code=en&sort.by=published_at&sort.order=desc&per_page=250" \
  -H "X-API-Key: YOUR_API_KEY"
```

Three of those conversions would fail silently or loudly if done literally: `uk` is rejected, `en-US` is rejected, and `when:7d` has to move out of `q` into its own parameter.

**And the converted request still returns zero.** Combining `source.domain` with `source.country.code` is usually a mistake: many publishers carry `country_code: "un"` (Unknown) in the source index, so pinning the country filters them out. `theguardian.com` is one of them — `source.domain=theguardian.com` returns thousands of articles, and adding `source.country.code=gb` returns none.

```bash
# 3 658 articles
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&source.domain=theguardian.com"

# 0 articles — the Guardian's source record says country "un"
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&source.domain=theguardian.com&source.country.code=gb"
```

Since `gl` is Google's *search* country rather than a publisher attribute, dropping it when `site:` is present is usually the faithful conversion, not a lossy one. The shim warns when both are set.
