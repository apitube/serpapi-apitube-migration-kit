# Your first request

```bash
# SerpApi
curl "https://serpapi.com/search?engine=google_news&q=tesla&gl=us&hl=en&api_key=YOUR_KEY"
```

```bash
# APITube
curl "https://api.apitube.io/v1/news/everything?title=tesla&source.country.code=us&language.code=en&per_page=250" \
  -H "X-API-Key: YOUR_API_KEY"
```

Verified: returns `200` with 250 articles.

## What changed, and why it matters

**`q` → `title`.** SerpApi searches the way Google News does — headline and body. APITube's `title` searches headlines only. Expect fewer results for the same term. The compensation is that the full body arrives in the response, so you can filter locally.

**`gl` → `source.country.code`.** On Google this is the country you are searching *from*; on APITube it is where the publisher is based. Related questions, not the same one. And `gl=uk` has to become `gb`:

```bash
# 400 ER0212 "source country code 'uk' not found."
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&source.country.code=uk"
```

**`hl` → `language.code`.** On Google this is the interface language; on APITube it is the language the article is written in. Two-letter codes only:

```bash
# 400 ER0061 "language.code must be between 1 and 2 characters."
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&language.code=en-US"
```

`en-US` → `en`, `pt-BR` → `pt`, `zh-CN` and `zh-TW` → `zh`. Google's legacy `iw` must become `he`. There is no `ru` and no `uk` (Ukrainian) — both return `400 ER0237`.

## Pagination, which SerpApi does not have

The Google News endpoint has no `num`, `start` or `page`: you send a query and get one page. On APITube:

```bash
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&per_page=250&page=1"
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&per_page=250&page=2"
```

250 is the maximum; `per_page=251` returns `400 ER0171`. Pages start at 1, and `page=0` is silently treated as `page=1` — worth knowing before you write the loop.

## The total, which SerpApi never reports

```bash
curl "https://api.apitube.io/v1/news/count?api_key=YOUR_API_KEY&title=tesla"
# {"status":"ok","count":29791}
```

Call it once per filter set, not once per page.

## Sorting

```bash
# so=1 (date)
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&sort.by=published_at&sort.order=desc"

# so=0 (relevance) — 500 ER0183
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&sort.by=relevance"
```

Relevance sorting fails with a search term present. If ordering matters, `sort.by=source.rank.opr` ranks by publisher Open Page Rank — a different question, but a usable one.
