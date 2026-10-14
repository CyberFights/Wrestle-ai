'use strict';

/*
 * Tests for the keyless GENERAL web-search providers in research.js
 * (duckduckgo_web / bing_web) — run with: npm test
 *
 * These exist because of a real failure mode: the original keyless chain
 * (DuckDuckGo Instant Answers → Wikipedia → OpenAlex) contains no general
 * web search at all. The Instant Answer API returns empty fields for most
 * queries, Wikipedia only returns Wikipedia articles and OpenAlex only
 * papers, so a Google-style query ("best espresso machine under $500",
 * a price, a current event, a product page) came back as "no matching
 * data" even though the same query in a search engine answers instantly.
 *
 * The stub below serves HTML results pages in the shapes the real
 * html.duckduckgo.com / bing.com endpoints serve, so parsing, redirect
 * decoding, fallback and result capping can be checked with no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createResearchClient } = require('../research');

// A DuckDuckGo html-endpoint page, trimmed to the markup the parser reads:
// redirector hrefs (uddg=), a direct href, <b> highlights in snippets, and
// HTML entities in both text and attribute values.
const DUCKDUCKGO_HTML = `<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fespresso-guide&amp;rut=deadbeef">Best Espresso Machines &amp; Grinders</a></h2>
    <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fespresso-guide">example.com</a></div></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fespresso-guide">We tested <b>12 espresso machines</b> &#8212; the winner costs $499 &amp; ships free.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/beans?fresh=1&amp;roast=light">Fresh Beans, Tested</a></h2>
    <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="https://example.com/beans">example.com</a></div></div>
    <a class="result__snippet" href="https://example.com/beans">Second snippet.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fno-snippet&amp;rut=beef">Snippetless Result</a></h2>
    <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fno-snippet">example.com</a></div></div>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fthird&amp;rut=cafe">Third Result</a></h2>
    <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fthird">example.com</a></div></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fthird">Third snippet.</a>
  </div>
</div>
</body></html>`;

// What DuckDuckGo serves when nothing matches (and, in the same shape, a
// bot-challenge page): markup, but no result anchors at all.
const DUCKDUCKGO_NO_RESULTS_HTML = '<html><body><div class="no-results">No results found.</div></body></html>';

function bingRedirect(target) {
  const encoded = Buffer.from(target, 'utf8').toString('base64');
  return `https://www.bing.com/ck/a?!&&p=abc123&u=${encodeURIComponent(`a1${encoded}`)}&ntb=1`;
}

const BING_HTML = `<html><body><ol id="b_results">
<li class="b_algo" data-id="1"><h2><a href="https://example.com/bing-one" h="ID=SERP,1">Bing &amp; One</a></h2><div class="b_caption"><p>First <strong>Bing</strong> snippet.</p></div></li>
<li class="b_algo" data-id="2"><h2><a href="${bingRedirect('https://example.com/bing-redirected')}">Redirected Result</a></h2><div class="b_caption"><p>Second snippet.</p></div></li>
<li class="b_ad"><h2><a href="https://example.com/ad">Ad, Not A Web Result</a></h2><p>Ad snippet.</p></li>
</ol></body></html>`;

const PAYLOADS = {
  '/duckduckgo-web': DUCKDUCKGO_HTML,
  '/duckduckgo-web-empty': DUCKDUCKGO_NO_RESULTS_HTML,
  '/bing-web': BING_HTML
};

function startStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAYLOADS[url.pathname] || '<html><body></body></html>');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        requests,
        providers: {
          duckduckgo_web: { url: `${base}/duckduckgo-web` },
          duckduckgo_web_empty: { url: `${base}/duckduckgo-web-empty` },
          bing_web: { url: `${base}/bing-web` }
        },
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function makeClient(providers, extra = {}) {
  return createResearchClient({
    providers,
    cacheTtlMs: 0,
    logger: { warn() {} },
    ...extra
  });
}

test('duckduckgo_web returns real web results for a Google-style query', async t => {
  const stub = await startStub();
  t.after(() => stub.close());

  const client = makeClient({ duckduckgo_web: stub.providers.duckduckgo_web });
  const result = await client.search('best espresso machine under $500', { provider: 'duckduckgo_web' });

  assert.equal(result.provider, 'duckduckgo_web');
  assert.deepEqual(result.results, [
    {
      title: 'Best Espresso Machines & Grinders', // &amp; decoded, tags gone
      url: 'https://example.com/espresso-guide', // uddg redirector resolved
      snippet: 'We tested 12 espresso machines — the winner costs $499 & ships free.'
    },
    {
      title: 'Fresh Beans, Tested',
      url: 'https://example.com/beans?fresh=1&roast=light', // &amp; in href decoded
      snippet: 'Second snippet.'
    },
    {
      // No snippet on the page for this one — and the next result's
      // snippet must not slide up into its place.
      title: 'Snippetless Result',
      url: 'https://example.com/no-snippet',
      snippet: ''
    },
    {
      title: 'Third Result',
      url: 'https://example.com/third',
      snippet: 'Third snippet.'
    }
  ]);

  // The request carried the query and no credential of any kind, and —
  // unlike the JSON providers — it presented a browser user agent, which
  // is what the public results page requires to answer at all.
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].query.get('q'), 'best espresso machine under $500');
  assert.equal(stub.requests[0].headers['x-api-key'], undefined);
  assert.equal(stub.requests[0].headers.authorization, undefined);
  assert.match(stub.requests[0].headers['user-agent'], /Mozilla\/5\.0/);
});

test('bing_web normalizes results and decodes /ck/a redirectors', async t => {
  const stub = await startStub();
  t.after(() => stub.close());

  // The alias "bing" must resolve to the bing_web provider.
  const client = makeClient({ bing_web: stub.providers.bing_web });
  const result = await client.search('espresso machine prices', { provider: 'bing' });

  assert.equal(result.provider, 'bing_web');
  assert.deepEqual(result.results, [
    { title: 'Bing & One', url: 'https://example.com/bing-one', snippet: 'First Bing snippet.' },
    { title: 'Redirected Result', url: 'https://example.com/bing-redirected', snippet: 'Second snippet.' }
  ], 'direct and redirector links both land on the real source; the b_ad block is not a result');
  assert.match(stub.requests[0].headers['user-agent'], /Mozilla\/5\.0/);
});

test('an empty DuckDuckGo page falls back to Bing instead of reporting no data', async t => {
  const stub = await startStub();
  t.after(() => stub.close());

  const client = makeClient(
    {
      duckduckgo_web: { url: stub.providers.duckduckgo_web_empty.url },
      bing_web: stub.providers.bing_web
    },
    { providerOrder: ['duckduckgo_web', 'bing_web', 'duckduckgo', 'wikipedia', 'openalex'] }
  );
  const result = await client.search('a query with no duckduckgo match');

  assert.equal(result.provider, 'bing_web');
  assert.equal(result.results[0].url, 'https://example.com/bing-one');
  assert.deepEqual(stub.requests.map(r => r.path), ['/duckduckgo-web-empty', '/bing-web']);
});

test('maxResults caps results-page providers, which return a full page', async t => {
  const stub = await startStub();
  t.after(() => stub.close());

  const client = makeClient({ duckduckgo_web: stub.providers.duckduckgo_web });
  const result = await client.search('cap me', { provider: 'duckduckgo_web', maxResults: 2 });

  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].url, 'https://example.com/beans?fresh=1&roast=light');
});

test('zero configuration tries general web search before the niche keyless APIs', () => {
  const client = createResearchClient({ logger: { warn() {} } });

  for (const name of ['duckduckgo_web', 'bing_web', 'duckduckgo', 'wikipedia', 'openalex']) {
    assert.ok(client.configuredProviders.includes(name), `${name} should be configured with no key`);
  }
  const order = client.providerOrder;
  assert.ok(order.indexOf('duckduckgo_web') < order.indexOf('duckduckgo'), 'web search precedes Instant Answers');
  assert.ok(order.indexOf('bing_web') < order.indexOf('wikipedia'), 'web search precedes Wikipedia');
  assert.ok(order.indexOf('duckduckgo_web') < order.indexOf('openalex'), 'web search precedes OpenAlex');
});
