# Queries that do not migrate

Everything here was checked against the live APITube API on 27 July 2026. Where APITube returns an error, the code is quoted. Where it returns `200` and does the wrong thing, that is called out — those are the ones that reach production.

## Google's tokens

`topic_token`, `section_token`, `publication_token`, `story_token` and `kgmid` are opaque Google identifiers. There is no lookup table and nothing on APITube accepts them.

| Token | Re-express as |
|-------|---------------|
| `topic_token=CAAqIQ...` | `category.id=medtop:04000000` (IPTC) or `topic.id` |
| `section_token` | A narrower `category.id` |
| `publication_token` | `source.domain=bbc.co.uk` |
| `story_token` | Nothing. `story.id` groups articles but is not a filter |
| `kgmid=/m/0dr90d` | `organization.name=Tesla` or `person.name=Elon Musk` |

```bash
# a Google "Business" topic becomes an IPTC code
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&category.id=medtop%3A04000000&per_page=250"
```

Entity names resolve against an index, so use the form the index knows: `organization.name=Apple` works, `Apple Inc` returns `400 ER0220`.

## Relevance ordering

```bash
# 500 ER0183
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&sort.by=relevance"
```

SerpApi's default `so=0` is Google's relevance ranking. APITube has no working relevance sort with a search term present. The substitutes:

```bash
# newest first
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&sort.by=published_at&sort.order=desc"

# most authoritative publishers first
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&sort.by=source.rank.opr"
```

`source.rank.opr` ranks publishers, not articles. Different question, usable answer.

## Google's clustering

`highlight` and `stories[]` express "this is the lead article, these are the related ones". APITube gives every article a `story.id`, and articles covering the same story share it — but there is no lead article, no ordering within the cluster, and no cluster endpoint.

Group client-side:

```js
const clusters = new Map();
for (const article of results) {
    const key = article.story?.id;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(article);
}
```

## Body-text search

Google News matches the article body; APITube's `title=` does not. There is no `content=` parameter, and sending one is worse than useless — APITube ignores unknown parameters and returns the whole index with a `200`.

Search headlines, then filter the returned `body` locally. See [03-no-scraping.md](03-no-scraping.md).

## Wildcards

```bash
# 200 — and the results have nothing to do with immunology
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=immuni*"
```

No error. Expand into an OR list:

```bash
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&query=title%3A(immunity%20OR%20immunization%20OR%20immunology)"
```

## `source:BBC`

```bash
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&source.name=BBC"
# {"count":3050237243}   ← the entire index

curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY"
# {"count":3050237323}   ← the entire index, again
```

`source.name` does not exist. Articles returned for that query came from `fakti.bg`. Use `source.domain`.

## Languages and countries Google accepts and APITube does not

| Sent | Result |
|------|--------|
| `hl=en-US`, `pt-BR`, `zh-CN`, `zh-TW` | `400 ER0061` — two-letter codes only |
| `hl=ru`, `hl=uk` | `400 ER0237` — no Russian, no Ukrainian |
| `hl=iw` | `400 ER0237` — Google's legacy Hebrew code; use `he` |
| `gl=uk` | `400 ER0212` — use `gb` |

Verified working: `en`, `es`, `fr`, `de`, `pt`, `it`, `nl`, `ja`, `zh`, `ko`, `ar`, `hi`, `he`; `us`, `gb`, `ca`, `au`, `in`, `de`, `fr`, `jp`, `br`.

## `when:30m`

APITube reads `m` as months:

```bash
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&title=tesla&published_at.start=NOW-30m"
# 28 509 of 29 747 articles — thirty months, not thirty minutes
```

There is no minutes unit. For a sub-hour window, use an absolute timestamp.

## SerpApi-only switches

`no_cache`, `async`, `zero_trace` and `device` describe how SerpApi scrapes Google. None has an APITube counterpart, and none needs one — there is no scrape to configure.

`output=html` has no equivalent either, but the export formats cover most of what it was for:

```bash
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&export=csv"
```

Eight formats: `json`, `jsonl`, `csv`, `tsv`, `xlsx`, `xml`, `rss`, `parquet` — all verified returning `200` with the right content type.

## Silent caps worth knowing

- **Three values per multi-value filter.** A fourth domain is dropped without an error.
- **`per_page` above 250** returns `400 ER0171`.
- **`page=0`** is treated as `page=1` — no error, and your first two pages come back identical.
- **`source.domain` plus `source.country.code`** usually returns zero: many publishers carry `country_code: "un"` in the source index.

## Everything at once

The shim reports all of the above in one call, so you do not discover them one query at a time:

```js
await client.search({
    q: 'immuni* source:BBC when:30m',
    topic_token: 'CAAqIQ',
    kgmid: '/m/0dr90d',
    so: 0,
    hl: 'ru',
    output: 'html',
    no_cache: true,
    per_page: 500
});
```

Nine warnings, one request, and a list of what to fix. Note that the request still returns 250 articles — with every filter dropped, nothing is left to narrow it. That is exactly what a literal port would have returned silently.
