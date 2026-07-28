# Response mapping

SerpApi returns what it could parse off a Google News page. APITube returns an indexed, enriched record. The overlap is small — which is the point of migrating, but it means the response-handling code changes more than the request code does.

Field lists below are from SerpApi's `engine=google_news` documentation and from a live APITube response on 27 July 2026.

## Envelope

| SerpApi | APITube | Note |
|---------|---------|------|
| `search_metadata` | `request_id` | An id for support, not a status object |
| `search_parameters` | `path` | The full URL your filters produced |
| `news_results` | `results` | The articles |
| `menu_links`, `sub_menu_links` | — | Google News navigation, not data |
| `related_topics`, `related_publications` | — | Google suggestions |
| `top_stories_link` | — | |
| — | `status` | `"ok"` or `"not_ok"` |
| — | `page`, `limit` | SerpApi has no pagination |
| — | `has_next_pages`, `next_page`, `has_previous_page`, `previous_page` | Ready-made paging URLs |
| — | `export` | The same query as JSON, JSONL, CSV, TSV, XLSX, XML, RSS or Parquet |

There is no total-count field. `/v1/news/count` returns it as a separate call.

## Article

| SerpApi `news_results[]` | APITube `results[]` | Note |
|--------------------------|---------------------|------|
| `position` | — | Rebuild from the array index if you need it |
| `title` | `title` | |
| `link` | `href` | |
| `source.name` | `source.domain` | APITube identifies publishers by domain |
| `source.icon` | `source.favicon` | |
| `source.authors[]` | `author.name` | One author object, not an array |
| `thumbnail`, `thumbnail_small` | `image` | One URL, no size variants |
| `date` (deprecated) | `published_at` | ISO 8601 with milliseconds and `Z` |
| `iso_date` | `published_at` | Same field |
| `type` (e.g. `"Opinion"`) | — | Closest is `categories[]` |
| `video` (boolean) | `has_video` filter | |
| `topic_token`, `story_token` | `story.id` | Not a filter — grouping only |
| `serpapi_link` | — | |
| `highlight`, `stories[]` | `story.id` | Google's cluster becomes a shared id; group client-side |
| `related_topics[]` | `topics[]` | A real taxonomy with scores, not suggestions |
| **— (no equivalent)** | `body`, `body_html` | **The article text.** SerpApi gives you a link to fetch yourself |

## Everything APITube adds

None of this exists in a SerpApi Google News response.

| Field | What it is |
|-------|-----------|
| `id` | Stable integer article id |
| `description` | Lead paragraph |
| `summary[]` | Extractive summary sentences, each with its own sentiment |
| `language` | ISO 639-1 code of the article |
| `categories[]` | IPTC MediaTopics with `id`, `name`, `score`, `taxonomy` |
| `topics[]`, `industries[]` | Two further classification axes |
| `entities[]` | Named entities with `type`, `frequency`, per-entity `sentiment`, and links |
| `locations_mentioned[]` | Places named in the text, with `lat`/`lng` |
| `sentiment` | `overall`, `title` and `body`, scored separately |
| `source.bias` | Publisher political leaning |
| `source.rankings.opr` | Open Page Rank |
| `source.location` | Publisher country |
| `source.type` | Publisher classification |
| `links[]` | Outbound links found in the article |
| `media[]` | Embedded media |
| `keywords[]` | Extracted keywords |
| `readability` | Flesch–Kincaid grade, reading ease, ARI, difficulty level, target audience, reading age, average words per sentence, average syllables per word |
| `shares` | `total`, `facebook`, `twitter`, `reddit` |
| `is_breaking`, `is_duplicate`, `is_free` | Article flags |
| `read_time` | Minutes |
| `words_count`, `characters_count`, `sentences_count`, `paragraphs_count` | Length metrics |
| `story.id`, `story.uri` | Cluster identity |

## The shape of the change in your code

Typical SerpApi Google News code has three stages: query, parse `news_results`, then fetch each `link` to get the text. The third stage disappears.

```js
// before
const { news_results } = await serpapi({ engine: 'google_news', q: 'tesla' });

for (const item of news_results) {
    const html = await fetch(item.link).then(r => r.text());   // ← the expensive part
    const text = extractArticleText(html);                     // ← and the fragile part
    analyse(text);
}
```

```js
// after
const { results } = await apitube({ title: 'tesla', per_page: 250 });

for (const article of results) {
    analyse(article.body);                     // already there
    console.log(article.sentiment.overall.score, article.entities.length);
}
```

That deletes the fetcher, the extractor, the retry logic around both, and the part of your infrastructure that exists to look like a browser.

## Fields with no home

Three SerpApi fields have nothing to map onto, and the shim reports each one rather than filling it with a plausible value:

- **`position`** — Google's ranking within the page. APITube returns articles in the order you sorted them; there is no independent relevance rank to preserve.
- **`serpapi_link`** — a link back into SerpApi's own API.
- **`highlight` / `stories`** — Google's clustering. `story.id` is the closest thing and it is coarser: articles sharing a `story.id` are the same story, but there is no designated lead article.

The shim fills `position` from the array index, sets `serpapi_link` to `null`, and leaves `highlight`/`stories` off unless you group by `story.id` yourself.
