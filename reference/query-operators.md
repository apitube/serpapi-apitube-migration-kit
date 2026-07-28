# Google operators in `q`, translated

SerpApi documents exactly two operators for `q`:

> "Parameter defines the query you want to search. You can use anything that you would use in a regular Google News search. e.g. `site:`, `when:`."

Everything else is whatever Google News itself happens to support — quotes, `OR`, `-`, `intitle:`. Those work in practice but are not part of SerpApi's contract, so treat the mappings below for them as best-effort on both sides.

On APITube these are not operators at all. Each one becomes a separate parameter, which is why a `q` string usually splits into three or four of them.

All counts verified on 27 July 2026.

## The table

| Google operator | APITube | Note |
|-----------------|---------|------|
| `tesla` | `title=tesla` | 29 747 articles |
| `tesla musk` | `title=tesla,musk` | Comma is AND — 2 659 articles |
| `"artificial intelligence"` | `title="artificial intelligence"` | 9 868 articles. Phrase semantics survive |
| `tesla OR rivian` | `query=title:(tesla OR rivian)` | 31 674 articles |
| `tesla -musk` | `title=tesla&ignore.title=musk` | 27 088 articles |
| `site:theguardian.com` | `source.domain=theguardian.com` | Max 3 domains |
| `-site:cnn.com` | `ignore.source.domain=cnn.com` | |
| `when:7d` | `published_at.start=NOW-7d` | See the units warning below |
| `after:2026-07-20` | `published_at.start=2026-07-20T00:00:00Z` | |
| `before:2026-07-27` | `published_at.end=2026-07-27T00:00:00Z` | |
| `intitle:tesla` | `title=tesla` | **Free** — APITube only ever searches headlines |
| `allintitle:tesla musk` | `title=tesla,musk` | Same reason |
| `location:London` | `location.name=London` | 17 810 articles. Mentioned location, not publisher location — **exact index names only**, see below |
| `source:BBC` | `source.domain=bbc.co.uk` | **`source.name` does not exist** — see below |

## `when:` — the units are not what you expect

APITube's relative dates read `m` as **months**, not minutes:

| Expression | `title=tesla` matches |
|------------|----------------------|
| `NOW-1h` | 2 |
| `NOW-24h` | 80 |
| `NOW-1d` | 80 |
| `NOW-7d` | 1 611 |
| `NOW-1MONTH` | 4 632 |
| **`NOW-30m`** | **28 509** ← thirty months |
| `NOW-1y` | 27 795 |

`NOW-30m` is not a filter, it is the whole index with a date on it. Google's `when:` only accepts `h`, `d` and `y` anyway, so the safe conversions are `when:1h → NOW-1h`, `when:7d → NOW-7d`, `when:1y → NOW-1y`. If you need sub-hour freshness, use an absolute `published_at.start` timestamp.

## `location:` — exact names only

`location.name` filters on places named in the article, and it resolves against APITube's entity index rather than matching text. A name that is not an index entry returns `400 ER0218` instead of zero results.

Verified on 27 July 2026:

| Value | Result |
|-------|--------|
| `London`, `Paris`, `Berlin`, `Tokyo` | `200` |
| `New York City` | `200` |
| `New York` | `400 ER0218 "entity location name 'New York' not found."` |
| `California` | `400 ER0218` |

Look the exact form up before hard-coding it — "New York" failing while "New York City" works is not something you would guess.

## `source:` — the trap worth reading twice

There is no `source.name` parameter on APITube. Sending one returns `200` and **ignores it entirely**:

```bash
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&source.name=BBC"
# {"count":3050237243}   ← the entire index

curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY"
# {"count":3050237323}   ← the entire index, again
```

The articles that come back are unrelated — a `source.name=BBC` query returned articles from `fakti.bg`. This is APITube's general behaviour for unrecognised parameters: they are dropped without comment, and the response looks successful.

Convert `source:` to `source.domain` with an actual domain. The shim refuses to send `source.name` at all.

## Combining operators

```
tesla OR rivian -musk when:7d
```

becomes two parameters plus a `query` expression:

```bash
curl "https://api.apitube.io/v1/news/everything?query=title%3A(tesla%20OR%20rivian)&ignore.title=musk&published_at.start=NOW-7d&per_page=250" \
  -H "X-API-Key: YOUR_API_KEY"
```

That returns a full page of 250. Add `site:` on top and it usually does not:

```bash
# 200, zero results — a real answer, not an error
curl "https://api.apitube.io/v1/news/everything?query=title%3A(tesla%20OR%20rivian)&ignore.title=musk&source.domain=theguardian.com&published_at.start=NOW-7d&per_page=250" \
  -H "X-API-Key: YOUR_API_KEY"
```

Verified against `theguardian.com`, `techcrunch.com` and `apnews.com` — all three return zero for that query. Narrow the topic **or** the publisher, rarely both: one domain's seven-day coverage of one topic is a small number on any index, and here it is often zero.

Note that `query=` and `title=` are alternatives, not companions: the boolean expression carries its own `title:` prefixes, so a separate `title=` would AND on top of it.

## What SerpApi cannot do and APITube can

SerpApi's `q` is mutually exclusive with its advanced parameters:

> "Parameter can't be used together with any of the Advanced Parameters."

So you cannot search for a keyword *within* a Google News topic, or *within* a publication's feed — it is one or the other. On APITube every filter composes:

```bash
# keyword + category + sentiment + publisher rank, all at once
curl "https://api.apitube.io/v1/news/everything?title=tesla&category.id=medtop:04000000&sentiment.overall.score.min=0.2&sort.by=source.rank.opr&per_page=250" \
  -H "X-API-Key: YOUR_API_KEY"
```

That composability is the practical reason most `q` strings get shorter after migrating: half of what the operators were doing becomes a parameter, and the rest becomes a filter that Google News had no way to express.

## Colons inside `query=` values

APITube's `query` parser treats `:` as the field separator. Any value that contains one — an IPTC code, a URL, a timestamp — must be quoted:

```bash
# 400 ER0701 "Could not parse query"
query=category.id:medtop:04000000

# 200
query=category.id:"medtop:04000000"
```

## Wildcards

Google News does not support `*` in the way a search engine index does, and APITube supports it not at all — but `title=` accepts a wildcard string without complaining and returns the entire index with a `200`. If your `q` strings contain `*`, expand them into an `OR` list before migrating:

```bash
query=title:(immunity OR immunization OR immunology)
```
