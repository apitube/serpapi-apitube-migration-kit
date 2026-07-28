# Before / after examples

Real SerpApi Google News requests and their APITube equivalents. Every APITube request here was executed against the live API; the counts are what it actually returned on 27 July 2026.

| File | What it covers |
|------|----------------|
| [01-first-request.md](01-first-request.md) | **Start here.** The straight port, and the three parameters that change meaning |
| [02-operators.md](02-operators.md) | `site:`, `when:`, `-`, `OR`, quotes — each becomes its own parameter |
| [03-no-scraping.md](03-no-scraping.md) | The stage that disappears: following `link` to fetch the article |
| [04-gaps.md](04-gaps.md) | Queries that do not migrate, and what to do instead |

All examples use `X-API-Key: YOUR_API_KEY`. `api_key=` in the query string works too.
