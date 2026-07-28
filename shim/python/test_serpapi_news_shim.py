"""Tests for the SerpApi Google News -> APITube shim.

No network: the session is stubbed and the assertions are on the parameters the shim builds
and the warnings it emits.

    python -m pytest shim/python/test_serpapi_news_shim.py -q
    # or, without pytest:
    python shim/python/test_serpapi_news_shim.py
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from serpapi_news_shim import (  # noqa: E402
    SerpApiNewsShim,
    SerpApiShimError,
    qualify_expression,
)

ARTICLE = {
    "id": 3067099440,
    "href": "https://www.bbc.co.uk/news/articles/c8dng1v72lno",
    "published_at": "2026-07-27T07:40:49.000Z",
    "title": "Tesla robotaxi rollout slips",
    "description": "The rollout is slower than promised",
    "body": "Full article text.",
    "body_html": "<p>Full article text.</p>",
    "language": "en",
    "image": "https://example.com/i.jpg",
    "author": {"id": 7, "name": "Jane Doe"},
    "categories": [{"id": "medtop:04000000", "name": "economy, business and finance"}],
    "topics": [{"id": "industry.financial_news", "name": "Finance Industry News"}],
    "industries": [{"id": 408, "name": "Trading Currency"}],
    "entities": [{"id": 1, "name": "Tesla", "type": "organization", "sentiment": {"score": 0.5}}],
    "locations_mentioned": [{"name": "United States", "country": "US"}],
    "source": {
        "id": 446812,
        "domain": "bbc.co.uk",
        "favicon": "https://icon",
        "bias": "center",
        "rankings": {"opr": 9},
    },
    "sentiment": {"overall": {"score": 0.4}, "title": {"score": 0}, "body": {"score": 0.2}},
    "summary": [{"sentence": "First."}],
    "keywords": ["tesla"],
    "links": [{"url": "https://example.com/ref", "type": "link"}],
    "media": [],
    "readability": {"reading_age": 22},
    "shares": {"total": 0},
    "story": {"id": 3067099440, "uri": "story-uri"},
    "is_breaking": False,
    "is_duplicate": False,
    "read_time": 3,
    "words_count": 369,
    "characters_count": 2370,
    "sentences_count": 24,
    "paragraphs_count": 1,
}


class FakeResponse:
    def __init__(self, body, status_code=200):
        self.text = body if isinstance(body, str) else json.dumps(body)
        self.status_code = status_code


class FakeSession:
    def __init__(self, body=None, raw=None, status_code=200):
        self.calls = []
        self.body = body
        self.raw = raw
        self.status_code = status_code

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append({"url": url, "params": dict(params or {})})

        if self.raw is not None:
            return FakeResponse(self.raw, self.status_code)

        if self.body is not None:
            return FakeResponse(self.body, self.status_code)

        if url.endswith("/v1/news/count"):
            return FakeResponse({"status": "ok", "count": 4210})

        return FakeResponse({"status": "ok", "request_id": "req-1", "path": url, "results": [ARTICLE]})

    def last_params(self):
        return self.calls[-1]["params"] if self.calls else {}


def make_shim(**kwargs):
    session = FakeSession(**{k: v for k, v in kwargs.items() if k in ("body", "raw", "status_code")})
    warnings = []
    shim = SerpApiNewsShim(
        api_key="test-key",
        session=session,
        on_warning=warnings.append,
        strict=kwargs.get("strict", False),
    )

    return shim, session, warnings


class TestConstruction(unittest.TestCase):
    def test_api_key_required(self):
        with self.assertRaises(SerpApiShimError):
            SerpApiNewsShim(api_key="")

    def test_other_engines_refused(self):
        shim, _, _ = make_shim()

        with self.assertRaises(SerpApiShimError) as ctx:
            shim.search(engine="google")

        self.assertIn("only covers engine=google_news", str(ctx.exception))


class TestQuery(unittest.TestCase):
    def test_single_term(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla")

        self.assertEqual(session.last_params()["title"], "tesla")

    def test_adjacent_terms_and(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla musk")

        self.assertEqual(session.last_params()["title"], "tesla,musk")

    def test_phrase(self):
        shim, session, _ = make_shim()

        shim.search(q='"artificial intelligence"')

        self.assertEqual(session.last_params()["title"], '"artificial intelligence"')

    def test_boolean(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla OR rivian")

        params = session.last_params()

        self.assertEqual(params["query"], "title:tesla OR title:rivian")
        self.assertNotIn("title", params)

    def test_site_normalised(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla site:https://www.theguardian.com/uk")

        params = session.last_params()

        self.assertEqual(params["source.domain"], "theguardian.com")
        self.assertEqual(params["title"], "tesla")

    def test_negated_site_is_not_a_negated_term(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla -site:cnn.com")

        params = session.last_params()

        self.assertEqual(params["ignore.source.domain"], "cnn.com")
        self.assertNotIn("ignore.title", params)

    def test_negated_word(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla -musk")

        params = session.last_params()

        self.assertEqual(params["title"], "tesla")
        self.assertEqual(params["ignore.title"], "musk")

    def test_when_relative_date(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla when:7d")

        self.assertEqual(session.last_params()["published_at.start"], "NOW-7d")

    def test_when_minutes_refused(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla when:30m")

        self.assertNotIn("published_at.start", session.last_params())
        self.assertTrue(any("MONTHS, not minutes" in w for w in warnings))

    def test_after_before(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla after:2026-07-20 before:2026-07-27")

        params = session.last_params()

        self.assertEqual(params["published_at.start"], "2026-07-20T00:00:00Z")
        self.assertEqual(params["published_at.end"], "2026-07-27T00:00:00Z")

    def test_intitle_is_free(self):
        shim, session, _ = make_shim()

        shim.search(q="intitle:tesla")

        self.assertEqual(session.last_params()["title"], "tesla")

    def test_allintitle(self):
        shim, session, _ = make_shim()

        shim.search(q="allintitle:tesla musk")

        self.assertEqual(session.last_params()["title"], "tesla,musk")

    def test_location_warns_about_index(self):
        shim, session, warnings = make_shim()

        shim.search(q='protest location:"New York City"')

        self.assertEqual(session.last_params()["location.name"], "New York City")
        self.assertTrue(any("ER0218" in w for w in warnings))

    def test_source_operator_refused(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla source:BBC")

        self.assertNotIn("source.name", session.last_params())
        self.assertTrue(any("filters NOTHING" in w for w in warnings))

    def test_wildcards_refused(self):
        shim, session, warnings = make_shim()

        shim.search(q="immuni*")

        self.assertNotIn("title", session.last_params())
        self.assertTrue(any("ENTIRE index" in w for w in warnings))

    def test_strict_raises(self):
        shim, _, _ = make_shim()
        shim.strict = True

        with self.assertRaises(SerpApiShimError):
            shim.search(q="immuni*")

    def test_domains_capped(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla site:a.com site:b.com site:c.com site:d.com")

        self.assertEqual(session.last_params()["source.domain"], "a.com,b.com,c.com")
        self.assertTrue(any("at most 3" in w for w in warnings))


class TestLanguageAndCountry(unittest.TestCase):
    def test_hl(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla", hl="en")

        self.assertEqual(session.last_params()["language.code"], "en")
        self.assertTrue(any("INTERFACE language" in w for w in warnings))

    def test_regional_forms_narrowed(self):
        for value, expected in [("en-US", "en"), ("pt-BR", "pt"), ("zh-CN", "zh"), ("zh_TW", "zh")]:
            shim, session, warnings = make_shim()

            shim.search(q="tesla", hl=value)

            self.assertEqual(session.last_params()["language.code"], expected, value)
            self.assertTrue(any("ER0061" in w for w in warnings), value)

    def test_legacy_codes(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla", hl="iw")

        self.assertEqual(session.last_params()["language.code"], "he")

    def test_unsupported_languages(self):
        for code in ("ru", "uk"):
            shim, session, warnings = make_shim()

            shim.search(q="tesla", hl=code)

            self.assertNotIn("language.code", session.last_params(), code)
            self.assertTrue(any("ER0237" in w for w in warnings), code)

    def test_gl_uk_becomes_gb(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla", gl="uk")

        self.assertEqual(session.last_params()["source.country.code"], "gb")
        self.assertTrue(any("ER0212" in w for w in warnings))

    def test_gl_dropped_when_site_present(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla site:theguardian.com", gl="gb")

        self.assertNotIn("source.country.code", session.last_params())
        self.assertTrue(any('country_code "un"' in w for w in warnings))


class TestSortAndPaging(unittest.TestCase):
    def test_so_date(self):
        shim, session, _ = make_shim()

        shim.search(q="tesla", so=1)

        params = session.last_params()

        self.assertEqual(params["sort.by"], "published_at")
        self.assertEqual(params["sort.order"], "desc")

    def test_so_relevance_falls_back(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla", so=0)

        self.assertEqual(session.last_params()["sort.by"], "published_at")
        self.assertTrue(any("500 ER0183" in w for w in warnings))
        self.assertTrue(any("source.rank.opr" in w for w in warnings))

    def test_per_page_capped(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla", per_page=500)

        self.assertEqual(session.last_params()["per_page"], 250)
        self.assertTrue(any("ER0171" in w for w in warnings))

    def test_page_zero(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla", page=0)

        self.assertEqual(session.last_params()["page"], 1)
        self.assertTrue(any("first page twice" in w for w in warnings))


class TestDroppedParams(unittest.TestCase):
    def test_tokens_dropped_with_re_expressions(self):
        shim, session, warnings = make_shim()

        shim.search(
            q="tesla",
            topic_token="CAAqIQ",
            section_token="CAQiS",
            publication_token="CAAqBw",
            story_token="CAAqNQ",
            kgmid="/m/0dr90d",
        )

        params = session.last_params()

        for key in ("topic_token", "section_token", "publication_token", "story_token", "kgmid"):
            self.assertNotIn(key, params, key)

        self.assertTrue(any("category.id" in w for w in warnings))
        self.assertTrue(any("source.domain" in w for w in warnings))
        self.assertTrue(any("organization.name" in w for w in warnings))

    def test_serpapi_switches(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla", no_cache=True, zero_trace=True, device="mobile")
        shim.search(q="tesla", **{"async": True})

        params = session.last_params()

        for key in ("no_cache", "zero_trace", "device", "async"):
            self.assertNotIn(key, params, key)

        self.assertEqual(len([w for w in warnings if "no_cache" in w or "zero_trace" in w]), 2)

    def test_output_points_at_exports(self):
        shim, _, warnings = make_shim()

        shim.search(q="tesla", output="html")

        self.assertTrue(any("export=csv" in w for w in warnings))

    def test_own_names_never_forwarded(self):
        shim, session, _ = make_shim()

        shim.search(engine="google_news", q="tesla", gl="us", hl="en", so=1, api_key="serp-key")

        params = session.last_params()

        for key in ("engine", "q", "gl", "hl", "so", "api_key"):
            self.assertNotIn(key, params, key)

    def test_unknown_param_reported(self):
        shim, session, warnings = make_shim()

        shim.search(q="tesla", madeUp="value")

        self.assertNotIn("madeUp", session.last_params())
        self.assertTrue(any("ENTIRE index" in w for w in warnings))


class TestResponse(unittest.TestCase):
    def test_serpapi_shape(self):
        shim, _, _ = make_shim()

        response = shim.search(q="tesla")

        self.assertEqual(response["search_metadata"]["status"], "Success")
        self.assertEqual(response["search_parameters"]["engine"], "google_news")

        item = response["news_results"][0]

        self.assertEqual(item["position"], 1)
        self.assertEqual(item["title"], "Tesla robotaxi rollout slips")
        self.assertEqual(item["link"], "https://www.bbc.co.uk/news/articles/c8dng1v72lno")
        self.assertEqual(item["source"]["name"], "bbc.co.uk")
        self.assertEqual(item["source"]["authors"], ["Jane Doe"])
        self.assertEqual(item["iso_date"], "2026-07-27T07:40:49.000Z")
        self.assertIsNone(item["serpapi_link"])

    def test_apitube_extras(self):
        shim, _, _ = make_shim()

        extras = shim.search(q="tesla")["news_results"][0]["_apitube"]

        self.assertEqual(extras["body"], "Full article text.")
        self.assertEqual(extras["sentiment"]["overall"]["score"], 0.4)
        self.assertEqual(len(extras["entities"]), 1)
        self.assertEqual(extras["readability"]["reading_age"], 22)
        self.assertEqual(extras["source"]["bias"], "center")

    def test_count_strips_paging(self):
        shim, session, _ = make_shim()

        total = shim.count(q="tesla", page=2, per_page=100, so=1)

        params = session.last_params()

        self.assertEqual(total, 4210)
        for key in ("page", "per_page", "sort.by"):
            self.assertNotIn(key, params, key)


class TestErrors(unittest.TestCase):
    def test_error_surfaces_code(self):
        shim, _, _ = make_shim(
            body={
                "status": "not_ok",
                "request_id": "req-9",
                "errors": [{"status": 400, "code": "ER0212", "message": "not found"}],
            }
        )

        with self.assertRaises(SerpApiShimError) as ctx:
            shim.search(q="tesla")

        self.assertEqual(ctx.exception.code, "ER0212")
        self.assertEqual(ctx.exception.request_id, "req-9")

    def test_non_json_body(self):
        shim, _, _ = make_shim(raw="<html>Bad Gateway</html>", status_code=502)

        with self.assertRaises(SerpApiShimError) as ctx:
            shim.search(q="tesla")

        self.assertIn("non-JSON body (HTTP 502)", str(ctx.exception))


class TestCombined(unittest.TestCase):
    def test_full_google_query_splits(self):
        shim, session, _ = make_shim()

        shim.search(
            engine="google_news",
            q="tesla OR rivian -musk site:bbc.co.uk when:7d",
            hl="en-US",
            so=1,
        )

        params = session.last_params()

        self.assertEqual(params["query"], "title:tesla OR title:rivian")
        self.assertEqual(params["ignore.title"], "musk")
        self.assertEqual(params["source.domain"], "bbc.co.uk")
        self.assertEqual(params["published_at.start"], "NOW-7d")
        self.assertEqual(params["language.code"], "en")
        self.assertEqual(params["sort.by"], "published_at")

    def test_qualify_expression(self):
        self.assertEqual(
            qualify_expression('tesla AND ("Elon Musk" OR rivian)'),
            'title:tesla AND (title:"Elon Musk" OR title:rivian)',
        )
        self.assertEqual(qualify_expression("category.id:medtop:04000000"), 'category.id:"medtop:04000000"')


if __name__ == "__main__":
    unittest.main(verbosity=1)
