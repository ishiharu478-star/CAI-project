import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildWebContext, chooseWebMode, fetchPublicText, isPublicAddress, validatePublicUrl,
} from '../src/web.js';

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

function fakeRequests(responses, observations = []) {
  return (url, options, callback) => {
    observations.push({ url: url.href, options });
    const req = new EventEmitter();
    req.destroy = (error) => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => {
      const response = responses.shift();
      if (response?.never) return;
      queueMicrotask(() => {
        if (response?.error) { req.emit('error', response.error); return; }
        const res = new PassThrough();
        res.statusCode = response?.status ?? 200;
        res.headers = { 'content-type': 'text/html; charset=utf-8', ...response?.headers };
        callback(res);
        if (response?.chunks) response.chunks.forEach((chunk) => res.write(chunk));
        res.end(response?.body ?? '<p>Public page</p>');
      });
    };
    return req;
  };
}

test('Web planning uses explicit/current needs and keeps history searches local', () => {
  assert.equal(chooseWebMode('こんにちは'), 'none');
  assert.equal(chooseWebMode('過去ログを検索して'), 'none');
  assert.equal(chooseWebMode('今日の会話ログを検索して'), 'none');
  assert.equal(chooseWebMode('前の会話を覚えている？'), 'none');
  assert.equal(chooseWebMode('前の会話とネットで調べて比べて'), 'search');
  assert.equal(chooseWebMode('今日の大阪の天気は？'), 'search');
  assert.equal(chooseWebMode('Look up the latest Node.js release'), 'search');
  assert.equal(chooseWebMode('これ読んで https://example.com/latest'), 'url');
  assert.equal(chooseWebMode('最新情報も調べて https://example.com/'), 'both');
  assert.equal(chooseWebMode('Web検索しないで https://example.com/'), 'none');
});

test('public address policy blocks private, reserved, mapped and local IPv6 ranges', () => {
  for (const ip of [
    '127.0.0.1', '0.0.0.0', '10.1.1.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '2002:7f00:1::1', '2001:db8::1',
  ]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
});

test('rejects localhost, non-HTTPS, credentials, alternate port and all mixed DNS answers', async () => {
  let lookups = 0;
  const lookup = async () => { lookups += 1; return publicLookup(); };
  for (const url of [
    'https://localhost/', 'https://localhost./', 'https://thing.local/',
    'https://127.1/', 'https://2130706433/', 'https://[::ffff:127.0.0.1]/',
    'http://example.com/', 'https://user:secret@example.com/', 'https://example.com:8443/',
  ]) await assert.rejects(validatePublicUrl(url, { lookup }));
  assert.equal(lookups, 0);
  await assert.rejects(validatePublicUrl('https://example.com/', {
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
  }));
});

test('pins request lookup to the validated DNS address and strips active HTML content', async () => {
  const observations = [];
  let lookups = 0;
  const lookup = async () => { lookups += 1; return publicLookup(); };
  const result = await fetchPublicText('https://example.com/', {
    lookup,
    requestImpl: fakeRequests([{ body: '<title>Safe</title><script>steal the token</script><p>Hello</p>' }], observations),
  });
  assert.equal(lookups, 1);
  const pinned = await new Promise((resolve, reject) => observations[0].options.lookup('example.com', {}, (error, address, family) => {
    if (error) reject(error); else resolve({ address, family });
  }));
  assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 });
  assert.equal(observations[0].options.agent, false);
  const context = await buildWebContext({ prompt: 'https://example.com/', mode: 'url', fetchImpl: async () => result });
  assert.match(context.text, /Hello/u);
  assert.doesNotMatch(context.text, /steal the token/u);
  assert.deepEqual(context.sources, [{ title: 'Safe', url: 'https://example.com/' }]);
});

test('redirect target is revalidated before a second connection', async () => {
  const observations = [];
  const requestImpl = fakeRequests([{ status: 302, headers: { location: 'https://169.254.169.254/' } }], observations);
  await assert.rejects(fetchPublicText('https://example.com/', { lookup: publicLookup, requestImpl }), /non-public/u);
  assert.equal(observations.length, 1);
});

test('allows two public redirects and rejects a third redirect', async () => {
  const observations = [];
  const result = await fetchPublicText('https://example.com/', {
    lookup: publicLookup,
    requestImpl: fakeRequests([
      { status: 302, headers: { location: '/one' } },
      { status: 301, headers: { location: '/two' } },
      { body: 'final' },
    ], observations),
  });
  assert.equal(result.url, 'https://example.com/two');
  assert.equal(observations.length, 3);
  await assert.rejects(fetchPublicText('https://example.com/', {
    lookup: publicLookup,
    requestImpl: fakeRequests(Array.from({ length: 3 }, () => ({ status: 302, headers: { location: '/again' } }))),
  }), /redirects/u);
});

test('enforces body size with and without Content-Length and rejects binary', async () => {
  await assert.rejects(fetchPublicText('https://example.com/', {
    lookup: publicLookup,
    requestImpl: fakeRequests([{ headers: { 'content-length': String(1024 * 1024 + 1) } }]),
  }), /1 MB/u);
  await assert.rejects(fetchPublicText('https://example.com/', {
    lookup: publicLookup,
    requestImpl: fakeRequests([{ chunks: [Buffer.alloc(1024 * 1024, 65), Buffer.from('x')] }]),
  }), /1 MB/u);
  await assert.rejects(fetchPublicText('https://example.com/', {
    lookup: publicLookup,
    requestImpl: fakeRequests([{ headers: { 'content-type': 'application/pdf' } }]),
  }), /supported text/u);
  await assert.rejects(fetchPublicText('https://example.com/', {
    lookup: publicLookup,
    requestImpl: fakeRequests([{ body: 'binary\0data' }]),
  }), /Binary/u);
});

test('deadline covers DNS resolution and stalled response', async () => {
  await assert.rejects(fetchPublicText('https://example.com/', {
    lookup: async () => new Promise(() => {}), timeoutMs: 15,
    requestImpl: fakeRequests([]),
  }), /timed out/u);
  await assert.rejects(fetchPublicText('https://example.com/', {
    lookup: publicLookup, timeoutMs: 15,
    requestImpl: fakeRequests([{ never: true }]),
  }), /timed out/u);
});

test('search sends only a bounded current prompt and exposes at most five safe RSS sources', async () => {
  const requests = [];
  const items = Array.from({ length: 8 }, (_, i) => `<item><title>Node.js ${i}</title><link>https://news.example.com/${i}</link><description><![CDATA[<p>Snippet ${i}</p>]]></description></item>`).join('');
  const context = await buildWebContext({
    prompt: `<@123456789012345678> 最新 Node.js ${'a'.repeat(500)}`,
    mode: 'search', lookup: publicLookup,
    fetchImpl: async (url) => { requests.push(url); return { url, text: `<rss><channel>${items}</channel></rss>` }; },
  });
  assert.equal(requests.length, 1);
  const query = new URL(requests[0]).searchParams.get('q');
  assert.equal(query.length, 300);
  assert.doesNotMatch(query, /123456789012345678/u);
  assert.equal(context.sources.length, 5);
  assert.match(context.text, /Snippet 0/u);
  assert.doesNotMatch(context.text, /Node\.js 5/u);
  assert.match(context.text, /信頼できない/u);
  assert.match(context.text, /最新性の独立確認は未実施/u);
});

test('unrelated cached RSS results cannot count generic official-documentation words as topic evidence', async () => {
  let lookups = 0;
  const context = await buildWebContext({
    prompt: 'Node.js official documentation', mode: 'search',
    lookup: async () => { lookups += 1; return publicLookup(); },
    fetchImpl: async (url) => ({ url, text: `<rss><channel><title>Node.js official documentation</title>
      <item><title>YouTube Help official documentation</title><link>https://support.google.com/youtube/</link><description>Latest official documentation for YouTube Help.</description></item>
      <item><title>YouTube TV</title><link>https://tv.youtube.com/</link><description>Current streaming information and official updates.</description></item>
      <item><title>Zhihu</title><link>https://www.zhihu.com/</link><description>Search for answers and read the latest news.</description></item>
      </channel></rss>` }),
  });
  assert.deepEqual(context.sources, []);
  assert.equal(lookups, 0);
  assert.match(context.text, /未確認/u);
  assert.doesNotMatch(context.text, /YouTube|Zhihu/u);
});

test('Japanese topic relevance excludes command and generic current-information tokens', async () => {
  const context = await buildWebContext({
    prompt: '最新の大阪の天気をネットで調べてください', mode: 'search', lookup: publicLookup,
    fetchImpl: async (url) => ({ url, text: `<rss><channel>
      <item><title>YouTube 最新情報</title><link>https://www.youtube.com/</link><description>ネットの最新情報を検索してください。</description></item>
      <item><title>大阪の天気予報</title><link>https://weather.example.com/osaka</link><description>大阪の気象データです。</description></item>
      </channel></rss>` }),
  });
  assert.deepEqual(context.sources, [{ title: '大阪の天気予報', url: 'https://weather.example.com/osaka' }]);
  assert.doesNotMatch(context.text, /YouTube/u);
});

test('failed search and inaccessible URLs produce explicit unverified context', async () => {
  const context = await buildWebContext({
    prompt: '最新情報 https://example.com/', mode: 'both',
    fetchImpl: async () => { throw new Error('blocked'); },
  });
  assert.deepEqual(context.sources, []);
  assert.match(context.text, /未確認/u);
  assert.match(context.text, /Web検索を取得できへんかった/u);
  assert.deepEqual(await buildWebContext({ prompt: '過去ログを検索して' }), { text: '', sources: [] });
});

test('URL reads are capped at two and never execute scripts', async () => {
  let calls = 0;
  const context = await buildWebContext({
    prompt: 'https://one.example.com/ https://two.example.com/ https://three.example.com/', mode: 'url',
    fetchImpl: async (url) => { calls += 1; return { url, text: '<p>Visible</p><script>Hidden forever' }; },
  });
  assert.equal(calls, 2);
  assert.equal(context.sources.length, 2);
  assert.doesNotMatch(context.text, /Hidden forever/u);
});
