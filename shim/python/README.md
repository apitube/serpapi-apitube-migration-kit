# Python shim

A drop-in replacement for a SerpApi `engine=google_news` client. Same parameter names, same response shape, APITube underneath.

Python 3.8+. One dependency: `requests`.

## Install

```bash
pip install -r requirements.txt
```

Copy `serpapi_news_shim.py` into your project, or import it directly:

```python
from serpapi_news_shim import SerpApiNewsShim
```

## Use

```python
import os
from serpapi_news_shim import SerpApiNewsShim

client = SerpApiNewsShim(api_key=os.environ["APITUBE_API_KEY"])

response = client.search(q="tesla site:bbc.co.uk when:7d", hl="en", so=1)

for item in response["news_results"]:
    print(item["position"], item["title"], item["source"]["name"])
```

That one `q` string becomes four APITube parameters: `query`, `source.domain`, `published_at.start` and `sort.by`. The shim does the splitting.

`async` is a Python keyword, so pass it through a dict if you have it in saved queries:

```python
client.search(**{"q": "tesla", "async": True})
```

## Options

| Option | Default | What it does |
|--------|---------|--------------|
| `api_key` | — | Required. Your APITube key |
| `base_url` | `https://api.apitube.io` | Override for testing |
| `session` | new `requests.Session()` | Inject a session for tests |
| `on_warning` | `warnings.warn` | Receives every lossy-conversion message |
| `strict` | `False` | Raise instead of warning when a conversion cannot be done faithfully |
| `timeout` | `30` | Per-request timeout in seconds |

## Methods

| Method | What it does |
|--------|--------------|
| `search(**params)` | Translates and queries `/v1/news/everything`, returns the SerpApi response shape |
| `count(**params)` | Total matches for the same filters, from `/v1/news/count`. SerpApi does not report a total |

Any `engine` other than `google_news` raises rather than guessing.

## Parity with the Node shim

Both shims produce **byte-identical** APITube parameters for the same input — verified case by case across 21 inputs, including the awkward ones: `site:` with a full URL, `-site:` next to a negated word, `when:30m`, `hl=zh_TW`, and four domains in one query.

If you run both languages against the same saved queries, the requests match.

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
| `after:` / `before:` | `published_at.start` / `.end` |
| `intitle:` / `allintitle:` | Stripped — APITube only searches headlines anyway |
| `location:"New York City"` | `location.name=New York City` |

## Warnings are the point

```python
collected = []
client = SerpApiNewsShim(api_key=key, on_warning=collected.append)

for query in saved_queries:
    client.search(**query)

print("\n".join(dict.fromkeys(collected)))
```

Every warning is a real behaviour change, not boilerplate. Collect them once and you have the migration to-do list.

## What the shim protects you from

Same list as the Node shim: unknown parameters silently returning the whole index, `source.name` doing the same, wildcards doing the same, `when:30m` meaning thirty months, `gl` combined with `site:` returning zero because publishers carry `country_code: "un"`, `hl=en-US` returning `400 ER0061`, `page=0` silently equalling `page=1`, silent 3-value caps, and non-JSON `502` bodies.

## Response extras

Everything APITube returns that Google News does not is kept on `item["_apitube"]`: the full `body` and `body_html`, an extractive `summary`, named entities with per-entity sentiment, sentiment for title and body separately, IPTC categories, topics, industries, mentioned locations, outbound links, publisher bias and Open Page Rank, readability scores, share counts and length metrics.

`response["_warnings"]` carries the warnings for that call, and `response["_apitube_parameters"]` shows exactly what was sent.

## Test

```bash
python -m pytest test_serpapi_news_shim.py -q
```

or without pytest:

```bash
python test_serpapi_news_shim.py
```

41 tests, no network.
