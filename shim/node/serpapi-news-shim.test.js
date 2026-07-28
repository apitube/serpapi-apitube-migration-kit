/*
 * Tests for the SerpApi Google News -> APITube shim.
 *
 * No network: fetch is stubbed and the assertions are on the parameters the shim builds
 * and the warnings it emits.
 *
 *   node --test serpapi-news-shim.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SerpApiNewsShim, SerpApiShimError, qualifyExpression } from './serpapi-news-shim.js';

const ARTICLE = {
    id: 3067099440,
    href: 'https://www.bbc.co.uk/news/articles/c8dng1v72lno',
    published_at: '2026-07-27T07:40:49.000Z',
    title: 'Tesla robotaxi rollout slips',
    description: 'The rollout is slower than promised',
    body: 'Full article text.',
    body_html: '<p>Full article text.</p>',
    language: 'en',
    image: 'https://example.com/i.jpg',
    author: { id: 7, name: 'Jane Doe' },
    categories: [{ id: 'medtop:04000000', name: 'economy, business and finance' }],
    topics: [{ id: 'industry.financial_news', name: 'Finance Industry News' }],
    industries: [{ id: 408, name: 'Trading Currency' }],
    entities: [{ id: 1, name: 'Tesla', type: 'organization', sentiment: { score: 0.5 } }],
    locations_mentioned: [{ name: 'United States', country: 'US' }],
    source: { id: 446812, domain: 'bbc.co.uk', favicon: 'https://icon', bias: 'center', rankings: { opr: 9 } },
    sentiment: { overall: { score: 0.4 }, title: { score: 0 }, body: { score: 0.2 } },
    summary: [{ sentence: 'First.' }],
    keywords: ['tesla'],
    links: [{ url: 'https://example.com/ref', type: 'link' }],
    media: [],
    readability: { reading_age: 22 },
    shares: { total: 0 },
    story: { id: 3067099440, uri: 'story-uri' },
    is_breaking: false,
    is_duplicate: false,
    read_time: 3,
    words_count: 369,
    characters_count: 2370,
    sentences_count: 24,
    paragraphs_count: 1
};

function makeShim(options = {}) {
    const calls = [];
    const warnings = [];

    const fetchImpl = async url => {
        calls.push(new URL(url));

        const body = url.includes('/v1/news/count')
            ? { status: 'ok', count: 4210 }
            : { status: 'ok', request_id: 'req-1', path: url, results: [ARTICLE] };

        return { status: 200, text: async () => JSON.stringify(options.body ?? body) };
    };

    const shim = new SerpApiNewsShim({
        apiKey: 'test-key',
        fetchImpl: options.fetchImpl || fetchImpl,
        onWarning: message => warnings.push(message),
        ...options.shim
    });

    return {
        shim,
        warnings,
        params: () => Object.fromEntries(calls[calls.length - 1].searchParams),
        calls
    };
}

test('apiKey is required', () => {
    assert.throws(() => new SerpApiNewsShim({}), SerpApiShimError);
});

test('a non-google_news engine is refused rather than silently reinterpreted', async () => {
    const { shim } = makeShim();

    await assert.rejects(() => shim.search({ engine: 'google' }), /only covers engine=google_news/);
});

test('a single term becomes title=', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla' });

    assert.equal(params().title, 'tesla');
});

test('adjacent terms AND, matching Google', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla musk' });

    assert.equal(params().title, 'tesla,musk');
});

test('a quoted phrase stays a phrase', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: '"artificial intelligence"' });

    assert.equal(params().title, '"artificial intelligence"');
});

test('boolean expressions get their title: prefixes', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla OR rivian' });

    assert.equal(params().query, 'title:tesla OR title:rivian');
    assert.equal(params().title, undefined);
});

test('site: becomes source.domain and is normalised', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla site:https://www.theguardian.com/uk' });

    assert.equal(params()['source.domain'], 'theguardian.com');
    assert.equal(params().title, 'tesla');
});

test('-site: becomes ignore.source.domain', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla -site:cnn.com' });

    assert.equal(params()['ignore.source.domain'], 'cnn.com');
    assert.equal(params()['ignore.title'], undefined, 'the domain must not also be read as a negated term');
});

test('a negated word becomes ignore.title', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla -musk' });

    assert.equal(params().title, 'tesla');
    assert.equal(params()['ignore.title'], 'musk');
});

test('when: maps to a relative date', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla when:7d' });

    assert.equal(params()['published_at.start'], 'NOW-7d');
});

test('when:<n>m is refused, because m means months', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla when:30m' });

    assert.equal(params()['published_at.start'], undefined);
    assert.ok(warnings.some(w => w.includes('MONTHS, not minutes')));
});

test('after:/before: map to absolute bounds', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla after:2026-07-20 before:2026-07-27' });

    assert.equal(params()['published_at.start'], '2026-07-20T00:00:00Z');
    assert.equal(params()['published_at.end'], '2026-07-27T00:00:00Z');
});

test('intitle: is free — APITube only searches headlines', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'intitle:tesla' });

    assert.equal(params().title, 'tesla');
});

test('allintitle: behaves the same way', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'allintitle:tesla musk' });

    assert.equal(params().title, 'tesla,musk');
});

test('location: maps to location.name, and warns that it resolves against an index', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'protest location:"New York City"' });

    assert.equal(params()['location.name'], 'New York City');
    assert.ok(warnings.some(w => w.includes('ER0218')));
});

test('source: is refused, because source.name silently returns the whole index', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla source:BBC' });

    assert.equal(params()['source.name'], undefined);
    assert.ok(warnings.some(w => w.includes('filters NOTHING')));
});

test('wildcards are refused', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'immuni*' });

    assert.equal(params().title, undefined);
    assert.ok(warnings.some(w => w.includes('ENTIRE index')));
});

test('strict mode throws instead of warning', async () => {
    const { shim } = makeShim({ shim: { strict: true } });

    await assert.rejects(() => shim.search({ q: 'immuni*' }), SerpApiShimError);
});

test('hl becomes language.code', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla', hl: 'en' });

    assert.equal(params()['language.code'], 'en');
    assert.ok(warnings.some(w => w.includes('INTERFACE language')));
});

test('regional hl forms are narrowed to two letters', async () => {
    for (const [input, expected] of [['en-US', 'en'], ['pt-BR', 'pt'], ['zh-CN', 'zh'], ['zh_TW', 'zh']]) {
        const { shim, params, warnings } = makeShim();

        await shim.search({ q: 'tesla', hl: input });

        assert.equal(params()['language.code'], expected, input);
        assert.ok(warnings.some(w => w.includes('ER0061')), input);
    }
});

test("Google's legacy language codes are modernised", async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla', hl: 'iw' });

    assert.equal(params()['language.code'], 'he');
});

test('unsupported languages are dropped with a reason', async () => {
    for (const code of ['ru', 'uk']) {
        const { shim, params, warnings } = makeShim();

        await shim.search({ q: 'tesla', hl: code });

        assert.equal(params()['language.code'], undefined, code);
        assert.ok(warnings.some(w => w.includes('ER0237')), code);
    }
});

test('gl becomes source.country.code, with uk fixed to gb', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla', gl: 'uk' });

    assert.equal(params()['source.country.code'], 'gb');
    assert.ok(warnings.some(w => w.includes('ER0212')));
});

test('gl is dropped when site: is present, because the combination returns zero', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla site:theguardian.com', gl: 'gb' });

    assert.equal(params()['source.country.code'], undefined);
    assert.ok(warnings.some(w => w.includes('country_code "un"')));
});

test('so=1 sorts by date', async () => {
    const { shim, params } = makeShim();

    await shim.search({ q: 'tesla', so: 1 });

    assert.equal(params()['sort.by'], 'published_at');
    assert.equal(params()['sort.order'], 'desc');
});

test('so=0 falls back to date and explains why', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla', so: 0 });

    assert.equal(params()['sort.by'], 'published_at');
    assert.ok(warnings.some(w => w.includes('500 ER0183')));
    assert.ok(warnings.some(w => w.includes('source.rank.opr')));
});

test('tokens are dropped, each with its own re-expression', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({
        q: 'tesla',
        topic_token: 'CAAqIQ',
        section_token: 'CAQiS',
        publication_token: 'CAAqBw',
        story_token: 'CAAqNQ',
        kgmid: '/m/0dr90d'
    });

    for (const key of ['topic_token', 'section_token', 'publication_token', 'story_token', 'kgmid']) {
        assert.equal(params()[key], undefined, key);
    }

    assert.ok(warnings.some(w => w.includes('category.id')));
    assert.ok(warnings.some(w => w.includes('source.domain')));
    assert.ok(warnings.some(w => w.includes('organization.name')));
});

test('SerpApi-only switches are dropped quietly but explicitly', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla', no_cache: true, async: true, zero_trace: true, device: 'mobile' });

    for (const key of ['no_cache', 'async', 'zero_trace', 'device']) {
        assert.equal(params()[key], undefined, key);
    }

    assert.equal(warnings.filter(w => /no_cache|async|zero_trace|device/.test(w)).length, 4);
});

test('output=html points at the export formats', async () => {
    const { shim, warnings } = makeShim();

    await shim.search({ q: 'tesla', output: 'html' });

    assert.ok(warnings.some(w => w.includes('export=csv')));
});

test('SerpApi parameter names are never forwarded', async () => {
    const { shim, params } = makeShim();

    await shim.search({ engine: 'google_news', q: 'tesla', gl: 'us', hl: 'en', so: 1, api_key: 'serp-key' });

    for (const key of ['engine', 'q', 'gl', 'hl', 'so', 'api_key']) {
        assert.equal(params()[key], undefined, key);
    }
});

test('an unknown parameter is reported rather than passed through', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla', madeUp: 'value' });

    assert.equal(params().madeUp, undefined);
    assert.ok(warnings.some(w => w.includes('ENTIRE index')));
});

test('per_page is capped at 250', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla', per_page: 500 });

    assert.equal(params().per_page, '250');
    assert.ok(warnings.some(w => w.includes('ER0171')));
});

test('page 0 is sent as page 1', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla', page: 0 });

    assert.equal(params().page, '1');
    assert.ok(warnings.some(w => w.includes('first page twice')));
});

test('more than three domains are capped, with a warning', async () => {
    const { shim, params, warnings } = makeShim();

    await shim.search({ q: 'tesla site:a.com site:b.com site:c.com site:d.com' });

    assert.equal(params()['source.domain'], 'a.com,b.com,c.com');
    assert.ok(warnings.some(w => w.includes('at most 3')));
});

test('the response keeps the SerpApi shape', async () => {
    const { shim } = makeShim();

    const response = await shim.search({ q: 'tesla' });

    assert.equal(response.search_metadata.status, 'Success');
    assert.equal(response.search_parameters.engine, 'google_news');

    const item = response.news_results[0];

    assert.equal(item.position, 1);
    assert.equal(item.title, 'Tesla robotaxi rollout slips');
    assert.equal(item.link, 'https://www.bbc.co.uk/news/articles/c8dng1v72lno');
    assert.equal(item.source.name, 'bbc.co.uk');
    assert.deepEqual(item.source.authors, ['Jane Doe']);
    assert.equal(item.iso_date, '2026-07-27T07:40:49.000Z');
    assert.equal(item.serpapi_link, null);
});

test('APITube extras ride along on _apitube', async () => {
    const { shim } = makeShim();

    const { _apitube } = (await shim.search({ q: 'tesla' })).news_results[0];

    assert.equal(_apitube.body, 'Full article text.');
    assert.equal(_apitube.sentiment.overall.score, 0.4);
    assert.equal(_apitube.entities.length, 1);
    assert.equal(_apitube.readability.reading_age, 22);
    assert.equal(_apitube.source.bias, 'center');
});

test('count() strips paging and sorting before asking', async () => {
    const { shim, params } = makeShim();

    const total = await shim.count({ q: 'tesla', page: 2, per_page: 100, so: 1 });

    assert.equal(total, 4210);
    assert.equal(params().page, undefined);
    assert.equal(params().per_page, undefined);
    assert.equal(params()['sort.by'], undefined);
});

test('an APITube error surfaces its code and request id', async () => {
    const { shim } = makeShim({
        body: {
            status: 'not_ok',
            request_id: 'req-9',
            errors: [{ status: 400, code: 'ER0212', message: "source country code 'uk' not found." }]
        }
    });

    await assert.rejects(
        () => shim.search({ q: 'tesla' }),
        error => error.code === 'ER0212' && error.requestId === 'req-9'
    );
});

test('a non-JSON body becomes a readable error', async () => {
    const { shim } = makeShim({
        fetchImpl: async () => ({ status: 502, text: async () => '<html>Bad Gateway</html>' })
    });

    await assert.rejects(() => shim.search({ q: 'tesla' }), /non-JSON body \(HTTP 502\)/);
});

test('a full Google query splits into every parameter it implies', async () => {
    const { shim, params } = makeShim();

    await shim.search({
        engine: 'google_news',
        q: 'tesla OR rivian -musk site:bbc.co.uk when:7d',
        hl: 'en-US',
        so: 1
    });

    const p = params();

    assert.equal(p.query, 'title:tesla OR title:rivian');
    assert.equal(p['ignore.title'], 'musk');
    assert.equal(p['source.domain'], 'bbc.co.uk');
    assert.equal(p['published_at.start'], 'NOW-7d');
    assert.equal(p['language.code'], 'en');
    assert.equal(p['sort.by'], 'published_at');
});

test('qualifyExpression handles groups and colon values', () => {
    assert.equal(
        qualifyExpression('tesla AND ("Elon Musk" OR rivian)'),
        'title:tesla AND (title:"Elon Musk" OR title:rivian)'
    );
    assert.equal(qualifyExpression('category.id:medtop:04000000'), 'category.id:"medtop:04000000"');
});
