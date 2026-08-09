"""SerpApi Google News -> APITube shim.

Accepts the parameters you already send to ``engine=google_news``, returns the shape you already
parse, and queries APITube underneath. Every conversion that loses something calls ``on_warning``.

Produces byte-identical APITube parameters to the Node shim for the same input.

    from serpapi_news_shim import SerpApiNewsShim

    client = SerpApiNewsShim(api_key=os.environ["APITUBE_API_KEY"])
    response = client.search(q="tesla site:bbc.co.uk when:7d")
"""

from __future__ import annotations

import json
import re
import warnings as _warnings
from typing import Any, Callable, Optional

import requests

APITUBE_BASE_URL = "https://api.apitube.io"

MAX_MULTI_VALUES = 3
MAX_PER_PAGE = 250

# Google's search country vs APITube's ISO publisher country. Only the codes that actually differ.
COUNTRY_FIXUPS = {"uk": "gb"}

# Google's legacy language codes and the ISO 639-1 codes APITube accepts.
LANGUAGE_FIXUPS = {"iw": "he", "in": "id", "ji": "yi"}

UNSUPPORTED_LANGUAGES = {
    "ru": "APITube has no Russian (400 ER0237). There is no substitute.",
    "uk": "APITube has no Ukrainian (400 ER0237). There is no substitute.",
}

# SerpApi parameters with no APITube counterpart, and why.
DROPPED_PARAMS = {
    "topic_token": (
        "topic_token is an opaque Google identifier with no lookup table. "
        "Re-express it as category.id (IPTC) or topic.id."
    ),
    "section_token": (
        "section_token is a sub-section of a Google topic. Re-express it as a narrower category.id."
    ),
    "story_token": (
        "story_token identifies a Google cluster. APITube articles carry story.id for grouping, "
        "but it is not a filter."
    ),
    "kgmid": "kgmid is a Google Knowledge Graph id. Re-express it as organization.name or person.name.",
    "no_cache": "no_cache has no meaning against an index — APITube is not a scraper with a cache.",
    "async": "async has no equivalent: APITube has no asynchronous job submission.",
    "zero_trace": "zero_trace is a SerpApi enterprise feature with no APITube counterpart.",
    "device": "device changes which Google page is scraped. APITube serves one index regardless of device.",
}

KNOWN_PARAMS = {
    "engine", "api_key", "q", "gl", "hl", "so", "topic_token", "section_token", "publication_token",
    "story_token", "kgmid", "no_cache", "async", "output", "zero_trace", "device",
    # not SerpApi's, but people add them when they discover APITube pages
    "page", "per_page", "num",
}


class SerpApiShimError(Exception):
    def __init__(self, message, code=None, status=None, request_id=None, url=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.url = url


class SerpApiNewsShim:
    def __init__(
        self,
        api_key: str,
        base_url: str = APITUBE_BASE_URL,
        session: Optional[Any] = None,
        on_warning: Optional[Callable[[str], None]] = None,
        strict: bool = False,
        timeout: int = 30,
    ):
        if not api_key:
            raise SerpApiShimError("api_key is required. Get one at https://dashboard.apitube.io")

        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.on_warning = on_warning or (lambda message: _warnings.warn(message, stacklevel=2))
        self.strict = strict
        self.timeout = timeout
        self.warnings: list[str] = []

    def search(self, **params) -> dict:
        self.warnings = []

        engine = params.get("engine")

        if engine and engine != "google_news":
            raise SerpApiShimError(
                f'This shim only covers engine=google_news; got "{engine}". Other SerpApi engines '
                "scrape different Google surfaces and have no APITube equivalent."
            )

        apitube_params = self.translate_params(params)
        payload = self.request("/v1/news/everything", apitube_params)

        return self.to_response(payload, params, apitube_params)

    # SerpApi returns the count inside the search response; APITube needs a separate call.
    def count(self, **params):
        apitube_params = self.translate_params(params)

        for key in ("page", "per_page", "sort.by", "sort.order"):
            apitube_params.pop(key, None)

        payload = self.request("/v1/news/count", apitube_params)
        total = payload.get("count")

        return total if isinstance(total, int) else None

    def translate_params(self, serpapi: dict) -> dict:
        out: dict = {}

        for key in serpapi:
            if key not in KNOWN_PARAMS:
                self.warn(
                    f'Unknown SerpApi parameter "{key}" was not forwarded. APITube ignores parameters '
                    "it does not recognise and returns the ENTIRE index with a 200, so forwarding it "
                    "would look like success."
                )

        for key, reason in DROPPED_PARAMS.items():
            if not _is_empty(serpapi.get(key)):
                self.warn(f'{key}="{serpapi[key]}" dropped: {reason}')

        if not _is_empty(serpapi.get("publication_token")):
            self.warn(
                f'publication_token="{serpapi["publication_token"]}" dropped: it is an opaque Google '
                "identifier. Use source.domain with the publisher's actual domain instead."
            )

        output = serpapi.get("output")

        if not _is_empty(output) and output != "json":
            self.warn(
                f'output="{output}" dropped: APITube returns JSON. For other formats use '
                "export=csv|tsv|xlsx|xml|rss|parquet|jsonl on the request."
            )

        out.update(self.translate_query(serpapi.get("q")))
        out.update(self.translate_language(serpapi))
        out.update(self.translate_country(serpapi, out))
        out.update(self.translate_sort(serpapi))
        out.update(self.translate_paging(serpapi))

        return out

    # Google packs several filters into one string; APITube wants them as separate parameters.
    def translate_query(self, q) -> dict:
        if _is_empty(q):
            return {}

        out: dict = {}
        rest = str(q).strip()

        domains: list[str] = []
        ignore_domains: list[str] = []

        def take_site(match):
            (ignore_domains if match.group(1) else domains).append(_normalise_domain(match.group(2)))
            return " "

        rest = re.sub(r"(-?)site:(\S+)", take_site, rest, flags=re.IGNORECASE)

        def take_when(match):
            out["published_at.start"] = f"NOW-{match.group(1)}{match.group(2).lower()}"
            return " "

        rest = re.sub(r"\bwhen:(\d+)([hdy])\b", take_when, rest, flags=re.IGNORECASE)

        def take_when_minutes(match):
            amount = match.group(1)
            self.warn(
                f"when:{amount}m dropped: APITube reads \"m\" in NOW-{amount}m as MONTHS, not minutes "
                "— NOW-30m returns almost the whole index. Use an absolute published_at.start "
                "timestamp for sub-hour windows."
            )
            return " "

        rest = re.sub(r"\bwhen:(\d+)m\b", take_when_minutes, rest, flags=re.IGNORECASE)

        def take_after(match):
            out["published_at.start"] = _to_iso_boundary(match.group(1))
            return " "

        rest = re.sub(r"\bafter:(\S+)", take_after, rest, flags=re.IGNORECASE)

        def take_before(match):
            out["published_at.end"] = _to_iso_boundary(match.group(1))
            return " "

        rest = re.sub(r"\bbefore:(\S+)", take_before, rest, flags=re.IGNORECASE)

        def take_location(match):
            name = _strip_quotes(match.group(1))
            out["location.name"] = name
            self.warn(
                f"location:{name} became location.name={name}, which resolves against APITube's entity "
                'index rather than matching free text. Exact names only: "New York City" resolves, '
                '"New York" and "California" return 400 ER0218.'
            )
            return " "

        rest = re.sub(r'\blocation:("[^"]+"|\S+)', take_location, rest, flags=re.IGNORECASE)

        def take_source(match):
            self.warn(
                f"source:{_strip_quotes(match.group(1))} dropped: APITube has no source.name parameter. "
                "Sending one returns 200 and filters NOTHING — the whole index comes back. "
                "Use site:<domain> instead."
            )
            return " "

        rest = re.sub(r'\bsource:("[^"]+"|\S+)', take_source, rest, flags=re.IGNORECASE)

        # intitle:/allintitle: are free — APITube only ever searches headlines.
        rest = re.sub(r"\b(all)?intitle:", " ", rest, flags=re.IGNORECASE)

        if domains:
            out["source.domain"] = ",".join(self.cap_multi(domains, "site:"))

        if ignore_domains:
            out["ignore.source.domain"] = ",".join(self.cap_multi(ignore_domains, "-site:"))

        negated: list[str] = []

        def take_negation(match):
            negated.append(_strip_quotes(match.group(1)))
            return " "

        rest = re.sub(r'(?:^|\s)-("[^"]+"|[^\s"]+)', take_negation, rest)

        if negated:
            out["ignore.title"] = ",".join(self.cap_multi(negated, "negation"))

        rest = re.sub(r"\s+", " ", rest).strip()

        if not rest:
            return out

        if re.search(r"[*?]", rest):
            message = (
                f'q="{rest}" contains a wildcard. APITube has no wildcard support, and title= accepts '
                "one without error while returning the ENTIRE index. Expand it into an OR list: "
                "query=title:(term1 OR term2)."
            )

            if self.strict:
                raise SerpApiShimError(message)

            self.warn(message)

            return out

        self.warn(
            f'q="{rest}" searches HEADLINES only on APITube. Google News matches the article body too, '
            "so expect fewer results. The full body is in the response if you want to filter locally."
        )

        out.update(self.text_to_params(rest))

        return out

    def text_to_params(self, text: str) -> dict:
        has_boolean = bool(re.search(r"\b(AND|OR|NOT)\b", text)) or "(" in text

        if not has_boolean:
            phrase = re.match(r'^"([^"]+)"$', text)

            if phrase:
                return {"title": f'"{phrase.group(1)}"'}

            # Google ANDs adjacent terms, and so does APITube's comma — this one is faithful.
            return {"title": ",".join(_split_terms(text))}

        return {"query": qualify_expression(text)}

    def translate_language(self, serpapi: dict) -> dict:
        hl = serpapi.get("hl")

        if _is_empty(hl):
            return {}

        code = str(hl).strip().lower()

        if "-" in code or "_" in code:
            short = re.split(r"[-_]", code)[0]
            self.warn(
                f'hl="{hl}" narrowed to language.code={short}: APITube accepts two-letter codes only '
                "(400 ER0061 otherwise). Any regional distinction is lost."
            )
            code = short

        if code in LANGUAGE_FIXUPS:
            self.warn(
                f'hl="{code}" mapped to language.code={LANGUAGE_FIXUPS[code]}: APITube uses the current '
                "ISO 639-1 code, not Google's legacy one."
            )
            code = LANGUAGE_FIXUPS[code]

        if code in UNSUPPORTED_LANGUAGES:
            self.warn(f'hl="{code}" dropped: {UNSUPPORTED_LANGUAGES[code]}')

            return {}

        self.warn(
            f'hl="{hl}" became language.code={code}: on Google this is the INTERFACE language, on '
            "APITube it is the language the article is written in. Related, not identical."
        )

        return {"language.code": code}

    def translate_country(self, serpapi: dict, current: dict) -> dict:
        gl = serpapi.get("gl")

        if _is_empty(gl):
            return {}

        code = str(gl).strip().lower()

        if code in COUNTRY_FIXUPS:
            self.warn(
                f'gl="{code}" mapped to source.country.code={COUNTRY_FIXUPS[code]}: APITube uses the ISO '
                f'code (400 ER0212 for "{code}").'
            )
            code = COUNTRY_FIXUPS[code]

        if current.get("source.domain"):
            self.warn(
                f'gl="{gl}" dropped because site: is already narrowing to a publisher. Many publishers '
                'carry country_code "un" in APITube\'s source index, so combining source.domain with '
                "source.country.code usually returns zero — theguardian.com does."
            )

            return {}

        self.warn(
            f'gl="{gl}" became source.country.code={code}: on Google this is the country you are '
            "searching FROM, on APITube it is where the publisher is based."
        )

        return {"source.country.code": code}

    def translate_sort(self, serpapi: dict) -> dict:
        so = serpapi.get("so")

        if _is_empty(so):
            return {}

        so = str(so)

        if so == "1":
            return {"sort.by": "published_at", "sort.order": "desc"}

        if so == "0":
            self.warn(
                "so=0 (relevance) dropped: sort.by=relevance returns 500 ER0183 on APITube when a search "
                "term is present. Falling back to publication date. The closest quality proxy is "
                "sort.by=source.rank.opr, which ranks publishers rather than articles."
            )

            return {"sort.by": "published_at", "sort.order": "desc"}

        self.warn(f'so="{so}" is not a documented SerpApi value (0 = relevance, 1 = date). Ignored.')

        return {}

    def translate_paging(self, serpapi: dict) -> dict:
        out: dict = {}

        size = _first_defined(serpapi.get("per_page"), serpapi.get("num"))

        if not _is_empty(size):
            per_page = int(size)

            if per_page > MAX_PER_PAGE:
                self.warn(
                    f"per_page={per_page} capped at {MAX_PER_PAGE}: APITube returns 400 ER0171 "
                    '"Limit is out of range. Your plan allows up to 250 results per page." above that.'
                )
                per_page = MAX_PER_PAGE

            out["per_page"] = per_page

        if not _is_empty(serpapi.get("page")):
            page = int(serpapi["page"])

            if page < 1:
                self.warn(
                    f"page={page} sent as page=1: APITube pages start at 1 and treat page=0 as page=1 "
                    "without an error, which silently returns the first page twice."
                )
                out["page"] = 1
            else:
                out["page"] = page

        return out

    def cap_multi(self, items: list[str], label: str) -> list[str]:
        unique = list(dict.fromkeys(items))

        if len(unique) > MAX_MULTI_VALUES:
            kept = ", ".join(unique[:MAX_MULTI_VALUES])
            self.warn(
                f"{label} had {len(unique)} values; APITube applies at most {MAX_MULTI_VALUES} and "
                f"ignores the rest without saying so. Kept: {kept}."
            )

        return unique[:MAX_MULTI_VALUES]

    def to_response(self, payload: dict, serpapi_params: dict, apitube_params: dict) -> dict:
        articles = payload.get("results") or []

        return {
            "search_metadata": {
                "id": payload.get("request_id"),
                "status": "Success" if payload.get("status") == "ok" else "Error",
                "json_endpoint": payload.get("path"),
                "total_time_taken": None,
            },
            "search_parameters": {"engine": "google_news", **serpapi_params},
            "news_results": [self.to_news_result(a, i) for i, a in enumerate(articles)],
            "_apitube_parameters": apitube_params,
            "_warnings": list(self.warnings),
        }

    def to_news_result(self, article: dict, index: int) -> dict:
        source = article.get("source") or {}
        author = article.get("author") or {}
        story = article.get("story") or {}

        return {
            "position": index + 1,
            "title": article.get("title") or "",
            "source": {
                "name": source.get("domain") or "",
                "icon": source.get("favicon"),
                "authors": [author["name"]] if author.get("name") else [],
            },
            "link": article.get("href") or "",
            "thumbnail": article.get("image"),
            "thumbnail_small": article.get("image"),
            "date": article.get("published_at"),
            "iso_date": article.get("published_at"),
            "story_token": str(story["id"]) if story.get("id") is not None else None,
            "serpapi_link": None,
            # Everything Google News does not have. Kept rather than discarded — this is the
            # reason to migrate, so throwing it away in the compatibility layer would be silly.
            "_apitube": {
                key: article.get(key)
                for key in (
                    "id", "body", "body_html", "description", "summary", "language", "categories",
                    "topics", "industries", "entities", "locations_mentioned", "sentiment", "keywords",
                    "links", "media", "readability", "shares", "story", "source", "is_breaking",
                    "is_duplicate", "read_time", "words_count", "characters_count", "sentences_count",
                    "paragraphs_count",
                )
            },
        }

    def request(self, path: str, params: dict) -> dict:
        url = f"{self.base_url}{path}"
        clean = {k: v for k, v in params.items() if not _is_empty(v)}

        response = self.session.get(
            url,
            params=clean,
            headers={"X-API-Key": self.api_key, "Accept": "application/json"},
            timeout=self.timeout,
        )

        try:
            payload = json.loads(response.text)
        except ValueError:
            # A 502 from the gateway is HTML, and json.loads on it hides the real problem.
            raise SerpApiShimError(
                f"APITube returned a non-JSON body (HTTP {response.status_code}) for {path}: "
                f"{response.text[:200]}",
                status=response.status_code,
                url=url,
            ) from None

        if payload.get("status") == "not_ok" or payload.get("errors"):
            error = (payload.get("errors") or [{}])[0]

            raise SerpApiShimError(
                f"APITube {error.get('code') or response.status_code}: "
                f"{error.get('message') or 'request failed'}",
                code=error.get("code"),
                status=error.get("status") or response.status_code,
                request_id=payload.get("request_id"),
                url=url,
            )

        return payload

    def warn(self, message: str) -> None:
        self.warnings.append(message)

        if self.strict:
            raise SerpApiShimError(message)

        if callable(self.on_warning):
            self.on_warning(message)


def qualify_expression(expression: str) -> str:
    """Prefix every bare term with `title:` — APITube's query language is field-scoped, so an
    unqualified expression does not search headlines at all."""

    def replace(match):
        token = match.group(0)

        if re.fullmatch(r"(AND|OR|NOT)", token, flags=re.IGNORECASE):
            return token

        if token.startswith("("):
            return f"({qualify_expression(token[1:-1])})"

        if ":" in token:
            return quote_colon_value(token)

        return f"title:{token}"

    qualified = re.sub(r'("[^"]+"|\([^)]*\)|[^\s()]+)', replace, expression)

    return re.sub(r"\s+", " ", qualified).strip()


def quote_colon_value(token: str) -> str:
    at = token.index(":")
    field, value = token[:at], token[at + 1:]

    if ":" not in value or value.startswith('"'):
        return token

    return f'{field}:"{value}"'


def _split_terms(text: str) -> list[str]:
    return [t.strip() for t in re.findall(r'"[^"]+"|\S+', text) if t.strip()]


def _strip_quotes(value: str) -> str:
    return re.sub(r'^"|"$', "", str(value))


def _normalise_domain(source: str) -> str:
    value = str(source).strip()
    value = re.sub(r"^https?://", "", value, flags=re.IGNORECASE)
    value = re.sub(r"^www\.", "", value, flags=re.IGNORECASE)
    value = re.sub(r"/.*$", "", value)

    return value.lower()


def _to_iso_boundary(date: str) -> str:
    trimmed = str(date).strip()

    return f"{trimmed}T00:00:00Z" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", trimmed) else trimmed


def _first_defined(*values):
    for value in values:
        if not _is_empty(value):
            return value

    return None


def _is_empty(value: Any) -> bool:
    return value is None or value == ""
