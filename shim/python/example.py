"""Runnable examples for the SerpApi Google News -> APITube shim.

    APITUBE_API_KEY=your_key python example.py
"""

import json
import os
import sys

from serpapi_news_shim import SerpApiNewsShim

api_key = os.environ.get("APITUBE_API_KEY")

if not api_key:
    print("Set APITUBE_API_KEY first: https://dashboard.apitube.io", file=sys.stderr)
    sys.exit(1)

warnings = []
client = SerpApiNewsShim(api_key=api_key, on_warning=warnings.append)


def report(label, response):
    print(f"\n=== {label} ===")
    print(f"sent: {json.dumps(response['_apitube_parameters'])}")
    print(f"returned: {len(response['news_results'])}")

    for item in response["news_results"][:3]:
        print(f"  {(item.get('iso_date') or '')[:10]}  {item['title']}")
        print(f"     {item['source']['name']}  {item['_apitube']['words_count']} words")

    if warnings:
        print("  warnings:")
        for warning in warnings:
            print(f"    - {warning}")
        warnings.clear()


# 1. The straight port: a Google News query, unchanged.
report("Straight port", client.search(engine="google_news", q="tesla", hl="en", so=1))

# 2. Operators split into separate parameters.
report("Operators", client.search(q="tesla OR rivian -musk when:7d", per_page=5))

# 3. site: maps exactly — but coverage per domain varies, so check yours.
report("One publisher", client.search(q="tesla site:bbc.co.uk", per_page=5))

# 4. gl=uk would be rejected as-is; the shim sends gb.
report("UK search", client.search(q="tesla", gl="uk", hl="en-US", per_page=5))

# 5. `async` is a Python keyword — pass saved queries through a dict.
report("Keyword-named parameter", client.search(**{"q": "tesla", "async": True, "per_page": 5}))

# 6. Everything that does not carry over, in one call. Every filter is dropped,
# so what comes back is an unfiltered page — which is exactly what a literal port would
# have returned silently. Read the warnings, not the results.
report(
    "A query full of gaps",
    client.search(
        q="immuni* source:BBC when:30m",
        topic_token="CAAqIQ",
        kgmid="/m/0dr90d",
        so=0,
        hl="ru",
        output="html",
        no_cache=True,
        per_page=500,
    ),
)

# 7. The total count, which SerpApi never reports.
print(f"\n=== Count ===\n  {client.count(q='tesla')} articles match title=tesla")
