/*
 * Runnable examples for the SerpApi Google News -> APITube shim.
 *
 *   APITUBE_API_KEY=your_key node example.js
 */

import { SerpApiNewsShim } from './serpapi-news-shim.js';

const apiKey = process.env.APITUBE_API_KEY;

if (!apiKey) {
    console.error('Set APITUBE_API_KEY first: https://dashboard.apitube.io');
    process.exit(1);
}

const warnings = [];
const client = new SerpApiNewsShim({ apiKey, onWarning: message => warnings.push(message) });

function report(label, response) {
    console.log(`\n=== ${label} ===`);
    console.log(`sent: ${JSON.stringify(response._apitube_parameters)}`);
    console.log(`returned: ${response.news_results.length}`);

    for (const item of response.news_results.slice(0, 3)) {
        console.log(`  ${item.iso_date?.slice(0, 10)}  ${item.title}`);
        console.log(`     ${item.source.name}  ${item._apitube.words_count} words`);
    }

    if (warnings.length) {
        console.log('  warnings:');
        warnings.forEach(warning => console.log(`    - ${warning}`));
        warnings.length = 0;
    }
}

// 1. The straight port: a Google News query, unchanged.
report('Straight port', await client.search({ engine: 'google_news', q: 'tesla', hl: 'en', so: 1 }));

// 2. Operators split into separate parameters.
report('Operators', await client.search({ q: 'tesla OR rivian -musk when:7d', per_page: 5 }));

// 3. site: maps exactly — but coverage per domain varies, so check yours.
report('One publisher', await client.search({ q: 'tesla site:bbc.co.uk', per_page: 5 }));

// 4. gl=uk would be rejected as-is; the shim sends gb.
report('UK search', await client.search({ q: 'tesla', gl: 'uk', hl: 'en-US', per_page: 5 }));

// 5. What SerpApi cannot do at all: keyword AND category AND sentiment in one request.
const composed = await client.search({ q: 'earnings', per_page: 5 });
console.log(`\n=== Composability ===\nSerpApi: q is mutually exclusive with its advanced parameters.`);
console.log(`APITube: add category.id, sentiment.*, source.rank.opr to the same request — see the README.`);
console.log(`(this call returned ${composed.news_results.length})`);
warnings.length = 0;

// 6. Everything that does not carry over, in one call. Every filter is dropped,
// so what comes back is an unfiltered page — which is exactly what a literal port would
// have returned silently. Read the warnings, not the results.
report(
    'A query full of gaps',
    await client.search({
        q: 'immuni* source:BBC when:30m',
        topic_token: 'CAAqIQ',
        kgmid: '/m/0dr90d',
        so: 0,
        hl: 'ru',
        output: 'html',
        no_cache: true,
        per_page: 500
    })
);

// 7. The total count, which SerpApi never reports.
console.log(`\n=== Count ===\n  ${await client.count({ q: 'tesla' })} articles match title=tesla`);
