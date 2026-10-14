'use strict';

/*
 * Tests for the USGS earthquake catalog provider.
 *
 * Why this provider exists, in one exchange: asked for "all Mid-Atlantic Ridge
 * earthquakes in the last 30 days", the keyless web-search chain returned
 * Wikipedia, YouTube, a celebrity magazine and a language-learning site. The
 * model correctly reported it had zero verifiable data — honest, and useless.
 * The catalog answer was one keyless JSON request away.
 *
 * These tests pin down both halves: a seismic query reaches the catalog with
 * sensible parameters (and gets real, citable events), while every other query
 * skips the provider entirely so general web research is unchanged.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createResearchClient } = require('../research');

// A real event, verbatim from the catalog shape (M 6.8 central MAR, 13 Oct 2026).
const FEATURES = [{
  type: 'Feature',
  properties: {
    mag: 6.8,
    place: 'central Mid-Atlantic Ridge',
    time: 1791894187248,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u214',
    title: 'M 6.8 - central Mid-Atlantic Ridge',
    magType: 'mww',
    status: 'reviewed',
    alert: 'green',
    tsunami: 1
  },
  geometry: { type: 'Point', coordinates: [-19.4308, -0.4085, 10] }
}];

let requestUrls = [];
let respond = { count: 1, features: FEATURES, url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?stub=1' };

const usgsStub = http.createServer((req, res) => {
  requestUrls.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      count: respond.count,
      status: 200,
      url: respond.url
    },
    features: respond.features
  }));
});

// A stand-in "general web" provider, so a non-seismic query has somewhere to go.
let generalHits = 0;
const generalStub = http.createServer((req, res) => {
  generalHits += 1;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ results: [{ title: 'Paris', url: 'https://example.com/paris', content: 'Paris is the capital of France.' }] }));
});

let server;
let port;

function client(providerOrder) {
  return createResearchClient({
    providers: {
      usgs: { url: `http://127.0.0.1:${port}/` },
      tavily: { apiKey: 'test-key', url: `http://127.0.0.1:${port}/general` }
    },
    providerOrder: providerOrder || ['usgs', 'tavily'],
    cacheTtlMs: 0,
    logger: { warn() {} }
  });
}

function paramsOf(url) {
  return new URL(url, 'http://127.0.0.1').searchParams;
}

test.before(async () => {
  await new Promise(resolve => usgsStub.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => generalStub.listen(0, '127.0.0.1', resolve));
  port = usgsStub.address().port;
});

test.after(async () => {
  await new Promise(resolve => usgsStub.close(resolve));
  await new Promise(resolve => generalStub.close(resolve));
});

test('a seismic query gets the catalog with a derivable window, region and magnitude floor', async () => {
  requestUrls = [];
  const result = await client().search('list all Mid-Atlantic Ridge earthquakes in the last 30 days', { maxResults: 5 });

  assert.equal(result.provider, 'usgs');
  assert.equal(requestUrls.length, 1);
  const params = paramsOf(requestUrls[0]);
  assert.equal(params.get('format'), 'geojson');
  assert.equal(params.get('eventtype'), 'earthquake');
  assert.equal(params.get('minmagnitude'), '4.5', 'an unstated magnitude defaults to M4.5+');
  assert.equal(params.get('orderby'), 'time');
  assert.equal(params.get('limit'), '5');
  // "Mid-Atlantic Ridge" becomes the ridge corridor bbox, the same box used to
  // verify this repo's incident reports.
  assert.equal(params.get('minlatitude'), '-40');
  assert.equal(params.get('maxlatitude'), '56');
  assert.equal(params.get('minlongitude'), '-45');
  assert.equal(params.get('maxlongitude'), '10');
  const hours = (Date.parse(params.get('endtime')) - Date.parse(params.get('starttime'))) / 3600000;
  assert.ok(Math.abs(hours - 720) < 1, `window should be 30 days, got ${hours} hours`);

  // The event arrives as something quotable, with magnitude/depth/time from the
  // catalog rather than from the model's memory of a headline.
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].title, /M 6\.8 - central Mid-Atlantic Ridge/);
  assert.match(result.results[0].title, /2026-10-13 12:23 UTC/);
  assert.match(result.results[0].snippet, /Magnitude 6\.8 \(mww\)/);
  assert.match(result.results[0].snippet, /depth 10 km/);
  assert.equal(result.results[0].url, 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u214');
  assert.equal(result.results[0].publishedDate, '2026-10-13');
});

test('a stated magnitude and window narrow the query; "biggest" orders by magnitude', async () => {
  requestUrls = [];
  await client().search('biggest earthquakes of magnitude 6.0+ near Iceland in the last 24 hours', { maxResults: 3 });

  const params = paramsOf(requestUrls[0]);
  assert.equal(params.get('minmagnitude'), '6');
  assert.equal(params.get('orderby'), 'magnitude');
  assert.equal(params.get('minlatitude'), '62');
  assert.equal(params.get('maxlongitude'), '-13');
  const hours = (Date.parse(params.get('endtime')) - Date.parse(params.get('starttime'))) / 3600000;
  assert.ok(Math.abs(hours - 24) < 1, `window should be 24 hours, got ${hours} hours`);
});

test('the other named regions resolve to their own boxes', async () => {
  for (const [query, expected] of [
    ['quakes near the Reykjanes Ridge', '59'],
    ['earthquakes near the Azores', '35']
  ]) {
    requestUrls = [];
    await client().search(query, { maxResults: 2 });
    assert.equal(paramsOf(requestUrls[0]).get('minlatitude'), expected, query);
  }
});

test('a zero-match catalog query is reported as a result, not a failed lookup', async () => {
  requestUrls = [];
  respond = { count: 0, features: [], url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?stub=empty' };
  try {
    const result = await client().search('were there any earthquakes on the Mid-Atlantic Ridge in the last 24 hours?', { maxResults: 5 });

    assert.equal(result.provider, 'usgs', 'the catalog answers even when the answer is "none"');
    assert.equal(result.results.length, 1);
    assert.match(result.results[0].title, /no events matched \(M4\.5\+/);
    assert.match(result.results[0].title, /the Mid-Atlantic Ridge/);
    assert.match(result.results[0].snippet, /returned 0 earthquakes/);
    assert.match(result.results[0].snippet, /not a failed lookup/);
    // The link is the catalog query itself, so the claim is checkable.
    assert.match(result.results[0].url, /earthquake\.usgs\.gov/);
  } finally {
    respond = { count: 1, features: FEATURES, url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?stub=1' };
  }
});

test('a non-seismic query never reaches the catalog', async () => {
  requestUrls = [];
  generalHits = 0;
  respond = { count: 1, features: FEATURES, url: 'https://example.com' };

  const c = createResearchClient({
    providers: {
      usgs: { url: `http://127.0.0.1:${port}/` },
      tavily: { apiKey: 'test-key', url: `http://127.0.0.1:${generalStub.address().port}/` }
    },
    providerOrder: ['usgs', 'tavily'],
    cacheTtlMs: 0,
    logger: { warn() {} }
  });

  const result = await c.search('what is the capital of France', { maxResults: 3 });

  assert.equal(result.provider, 'tavily', 'general web search still answers general questions');
  assert.equal(requestUrls.length, 0, 'the earthquake catalog must not be consulted for a geography question');
  assert.equal(generalHits, 1);
});
