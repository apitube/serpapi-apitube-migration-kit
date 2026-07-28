# The stage that disappears

SerpApi's Google News response has no article text. It has a `title`, a `link`, a `source.name` and a date. To do anything with the content you follow the link and fetch the page yourself.

That whole stage goes away.

## What the code looks like now

```js
const { news_results } = await serpapi({ engine: 'google_news', q: 'tesla' });

for (const item of news_results) {
    const html = await fetch(item.link).then(r => r.text());   // the expensive part
    const text = extractArticleText(html);                     // the fragile part
    analyse(text);
}
```

Everything after the first line is infrastructure you maintain: a fetcher, retries, timeouts, a user-agent policy, an HTML-to-text extractor, and per-publisher special cases for the ones that paywall or lazy-load.

## What it looks like after

```js
const { results } = await apitube({ title: 'tesla', per_page: 250 });

for (const article of results) {
    analyse(article.body);
}
```

`body` and `body_html` are in the response.

```bash
curl "https://api.apitube.io/v1/news/everything?api_key=YOUR_API_KEY&title=tesla&per_page=1"
```

A single article carries all of this — verified against a live response on 27 July 2026:

| Field | Example value |
|-------|---------------|
| `body` | Full plain text |
| `body_html` | The same with markup |
| `description` | Lead paragraph |
| `summary[]` | Extractive sentences, each with its own sentiment |
| `words_count` / `characters_count` / `sentences_count` / `paragraphs_count` | `369` / `2370` / `24` / `1` |
| `read_time` | `3` (minutes) |
| `readability` | Flesch–Kincaid grade, reading ease, ARI, difficulty level, target audience, reading age |

## And the enrichment you would otherwise build

The fetch stage usually exists so you can run your own NLP on the text. Most of that is already done:

| Field | What it gives you |
|-------|-------------------|
| `entities[]` | Named entities with `type`, `frequency`, and **sentiment towards that entity** |
| `sentiment` | `overall`, `title` and `body`, scored separately |
| `categories[]` | IPTC MediaTopics with confidence scores |
| `topics[]`, `industries[]` | Two further classification axes |
| `locations_mentioned[]` | Places named in the text, with coordinates |
| `keywords[]` | Extracted keywords |
| `links[]` | Outbound links found in the article |
| `source.bias` | Publisher political leaning |
| `source.rankings.opr` | Publisher Open Page Rank |
| `is_breaking`, `is_duplicate` | Article flags |
| `story.id` | Cluster identity — articles covering the same story share it |

## The arithmetic

SerpApi's Google News page returns roughly a hundred results, and each one needs its own HTTP request to become usable text. APITube returns 250 **with** the text in one request.

For a job that processes 10 000 articles a day:

| | SerpApi + fetcher | APITube |
|---|-------------------|---------|
| Requests to the news API | ~100 | 40 |
| Requests to publisher sites | ~10 000 | 0 |
| Extraction failures to handle | Some percentage of 10 000 | 0 |
| Paywalled pages returning a stub | Yours to detect | Already extracted |

The second column is not a smaller version of the first — it is a different architecture. That is the honest case for the migration, and it matters more than any parameter mapping in this kit.

## Filtering locally instead of in `q`

APITube searches headlines only, so a `q` that relied on body matches will select less. With the body in the response, you can do the second pass yourself:

```js
const { results } = await apitube({ title: 'tesla', per_page: 250 });
const mentionsRobotaxi = results.filter(a => a.body.toLowerCase().includes('robotaxi'));
```

That trades API-side selectivity for bandwidth. It is the right trade when the headline filter already narrows things down, and the wrong one when it does not — in which case use an entity or category filter instead of a keyword.
