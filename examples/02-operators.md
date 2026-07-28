# Operators become parameters

Google packs filters into one string. APITube gives each its own parameter. A `q` that looked compact usually turns into three or four of them — and reads better afterwards.

All counts verified on 27 July 2026.

## One at a time

```bash
# q=tesla
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla"
# 29 747 articles

# q=tesla musk        (Google ANDs adjacent terms; so does APITube's comma)
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla,musk"
# 2 659 articles

# q="artificial intelligence"
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=%22artificial%20intelligence%22"
# 9 868 articles

# q=tesla OR rivian
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&query=title%3A(tesla%20OR%20rivian)"
# 31 674 articles

# q=tesla -musk
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&ignore.title=musk"
# 27 088 articles
```

Note the `title:` prefixes inside `query=`. APITube's query language is field-scoped: `query=tesla OR rivian` without them does not search headlines at all.

## `site:`

```bash
# q=tesla site:bbc.co.uk
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&source.domain=bbc.co.uk"

# q=tesla -site:cnn.com
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&ignore.source.domain=cnn.com"
```

Three domains maximum — a fourth is dropped without an error. The domain is normalised: `site:https://www.theguardian.com/uk` is `source.domain=theguardian.com`.

Two things to check before relying on it:

- **Coverage varies by publisher.** `theguardian.com`, `apnews.com`, `techcrunch.com` and `bbc.co.uk` return four-figure counts; `bloomberg.com`, `nytimes.com` and `forbes.com` return double or single digits; `reuters.com` and `cnn.com` return zero. A domain absent from the source index returns `400 ER0214` instead — `www.reuters.com` does.
- **Do not add a country filter on top.** Many publishers carry `country_code: "un"` in the source index, so `source.domain=theguardian.com&source.country.code=gb` returns zero while the domain alone returns thousands.

## `when:`

```bash
# q=tesla when:7d
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&title=tesla&published_at.start=NOW-7d"
# 1 611 articles
```

The unit letters are not Google's:

| Expression | `title=tesla` matches |
|------------|----------------------|
| `NOW-1h` | 2 |
| `NOW-24h` | 80 |
| `NOW-1d` | 80 |
| `NOW-7d` | 1 611 |
| `NOW-1MONTH` | 4 632 |
| **`NOW-30m`** | **28 509** ← thirty **months** |
| `NOW-1y` | 27 795 |

`m` is months. There is no minutes unit; for a sub-hour window use an absolute timestamp:

```bash
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&published_at.start=2026-07-27T06%3A00%3A00Z"
```

## `after:` and `before:`

```bash
# q=tesla after:2026-07-20 before:2026-07-27
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&published_at.start=2026-07-20T00%3A00%3A00Z&published_at.end=2026-07-27T00%3A00%3A00Z"
```

## `intitle:` and `allintitle:` — free

APITube only ever searches headlines, so these operators have nothing left to express. `intitle:tesla` is just `title=tesla`.

## `location:`

```bash
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&location.name=London"
# 17 810 articles
```

This is the location **mentioned in the article**, not the publisher's. It resolves against an entity index, so only exact index names work:

| Value | Result |
|-------|--------|
| `London`, `Paris`, `Berlin`, `Tokyo` | `200` |
| `New York City` | `200` |
| `New York` | `400 ER0218 "entity location name 'New York' not found."` |
| `California` | `400 ER0218` |

## `source:` — do not translate it literally

There is no `source.name` parameter. Sending one returns `200` and filters nothing:

```bash
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&source.name=BBC"
# {"count":3050237243}  ← the whole index
```

Use `source.domain` with an actual domain.

## Everything at once

```
q=tesla OR rivian -musk when:7d
```

```bash
curl "https://api.apitube.io/v1/news/everything?query=title%3A(tesla%20OR%20rivian)&ignore.title=musk&published_at.start=NOW-7d&per_page=250" \
  -H "X-API-Key: YOUR_API_KEY"
```

Returns a full page of 250. Add `site:theguardian.com` on top and it returns zero — one publisher's seven-day coverage of one topic is a small number, and often nothing. Narrow the topic or the publisher, rarely both.
