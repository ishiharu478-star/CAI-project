import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { cleanupPendingFiles, MAX_MEDIA_BYTES, prepareMedia, validateAttachments } from '../src/media.js';

const attachment = (extra = {}) => ({ url: 'https://cdn.discordapp.com/attachments/123/456/image.png?ex=abc',
  name: 'image.png', contentType: 'image/png', size: 3, ...extra });

function harness({ processing = false, failUpload = false, failDelete = false } = {}) {
  const pending = new Set();
  const uploads = [];
  const deleted = [];
  const warnings = [];
  const store = {
    queueFile: async (name) => pending.add(name), removeFile: async (name) => pending.delete(name),
    pendingFiles: async () => [...pending],
  };
  const ai = { files: {
    upload: async ({ file, config }) => {
      assert.equal(pending.has(config.name), true, 'upload must already have a durable cleanup entry');
      assert.equal(config.httpOptions, undefined, 'SDK must add required resumable upload headers');
      assert.equal((await readFile(file)).toString(), 'abc');
      uploads.push(file);
      if (failUpload) throw new Error('secret-key-do-not-log');
      return { name: config.name, uri: `https://generativelanguage.googleapis.com/v1beta/${config.name}`, state: processing ? 'PROCESSING' : 'ACTIVE' };
    },
    get: async ({ name }) => ({ name, uri: `https://generativelanguage.googleapis.com/v1beta/${name}`, state: 'ACTIVE' }),
    delete: async ({ name }) => {
      deleted.push(name);
      if (failDelete) throw new Error('secret-key-do-not-log');
    },
  } };
  const fetchImpl = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('abc', { headers: { 'content-type': 'image/png' } });
  };
  return { ai, store, uploads, deleted, pending, fetchImpl, warnings, logger: { warn: (message) => warnings.push(message) } };
}

test('attachment metadata rejects unsafe URLs, unsupported formats and combined size', () => {
  for (const url of ['http://cdn.discordapp.com/attachments/1/2/x.png', 'https://cdn.discordapp.com.evil.test/attachments/x',
    'https://127.0.0.1/attachments/x', 'https://cdn.discordapp.com:8443/attachments/x',
    'https://user:password@cdn.discordapp.com/attachments/x', 'https://cdn.discordapp.com/not-attachments/x']) {
    assert.throws(() => validateAttachments([attachment({ url })]), { code: 'MEDIA_FAILED' });
  }
  assert.throws(() => validateAttachments([attachment({ size: MAX_MEDIA_BYTES + 1 })]), { code: 'MEDIA_TOO_LARGE' });
  assert.throws(() => validateAttachments([attachment({ size: MAX_MEDIA_BYTES }), attachment()]), { code: 'MEDIA_TOO_LARGE' });
  assert.throws(() => validateAttachments(Array.from({ length: 5 }, () => attachment())), { code: 'MEDIA_TOO_LARGE' });
  assert.throws(() => validateAttachments([attachment({ contentType: 'application/pdf', name: 'image.png' })]), { code: 'MEDIA_UNSUPPORTED' });
  assert.throws(() => validateAttachments([attachment({ size: Number.NaN })]), { code: 'MEDIA_FAILED' });
  assert.equal(validateAttachments([attachment({ contentType: null, name: 'photo.JPG' })])[0].mimeType, 'image/jpeg');
});

test('media is streamed to disk, processed, and deleted once with its queue entry', async () => {
  const h = harness({ processing: true });
  const prepared = await prepareMedia({ ...h, attachments: [attachment()], pollIntervalMs: 1 });
  assert.equal(prepared.parts[0].fileData.mimeType, 'image/png');
  assert.equal(h.pending.size, 1);
  await cleanupPendingFiles(h);
  assert.equal(h.deleted.length, 0, 'periodic cleanup must leave active files available to the model');
  await prepared.cleanup();
  await prepared.cleanup();
  assert.equal(h.deleted.length, 1);
  assert.equal(h.pending.size, 0);
  await assert.rejects(access(dirname(h.uploads[0])));
});

test('failed upload still removes local bytes and the prequeued remote resource', async () => {
  const h = harness({ failUpload: true });
  await assert.rejects(prepareMedia({ ...h, attachments: [attachment()] }), { code: 'MEDIA_FAILED' });
  assert.equal(h.pending.size, 0);
  assert.equal(h.deleted.length, 1);
  await assert.rejects(access(dirname(h.uploads[0])));
});

test('provider cleanup failure retains a durable entry and sanitized logs for startup retry', async () => {
  const h = harness({ failDelete: true });
  const prepared = await prepareMedia({ ...h, attachments: [attachment()] });
  await prepared.cleanup();
  assert.equal(h.pending.size, 1);
  assert.equal(h.deleted.length, 2);
  assert.deepEqual(h.warnings, ['media_remote_cleanup_pending']);
  await assert.rejects(access(dirname(h.uploads[0])));
  h.ai.files.delete = async () => {};
  await cleanupPendingFiles(h);
  assert.equal(h.pending.size, 0);
});

test('404 cleanup is complete and does not retry unrelated provider files', async () => {
  const h = harness();
  h.pending.add('files/cai-expired');
  h.pending.add('https://evil.test/delete');
  let calls = 0;
  h.ai.files.delete = async () => { calls += 1; throw Object.assign(new Error('gone'), { status: 404 }); };
  await cleanupPendingFiles(h);
  assert.equal(calls, 1);
  assert.deepEqual([...h.pending], ['https://evil.test/delete']);
});

test('a CDN body with a forbidden response MIME or oversized content length never reaches upload', async () => {
  for (const headers of [{ 'content-type': 'text/html' }, { 'content-length': String(MAX_MEDIA_BYTES + 1) }]) {
    const h = harness();
    h.fetchImpl = async () => new Response('abc', { headers });
    await assert.rejects(prepareMedia({ ...h, attachments: [attachment()] }),
      { code: headers['content-type'] ? 'MEDIA_UNSUPPORTED' : 'MEDIA_TOO_LARGE' });
    assert.equal(h.uploads.length, 0);
  }
});

test('partial multi-file preparation cleans already uploaded media', async () => {
  const h = harness();
  let calls = 0;
  h.fetchImpl = async () => {
    if (++calls === 2) throw new Error('download failed with secret URL');
    return new Response('abc', { headers: { 'content-type': 'image/png' } });
  };
  await assert.rejects(prepareMedia({ ...h, attachments: [attachment(), attachment()] }), { code: 'MEDIA_FAILED' });
  assert.equal(h.uploads.length, 1);
  assert.equal(h.pending.size, 0);
  assert.equal(h.deleted.length, 1);
  await assert.rejects(access(dirname(h.uploads[0])));
});

test('installed SDK preserves resumable upload headers, streams file chunks and deletes its named file', async (t) => {
  const h = harness();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  let resourceName;
  globalThis.fetch = async (url, options) => {
    const headers = new Headers(options.headers);
    requests.push({ url: String(url), method: options.method });
    if (String(url).includes('/upload/v1beta/files')) {
      assert.equal(headers.get('x-goog-upload-protocol'), 'resumable');
      assert.equal(headers.get('x-goog-upload-command'), 'start');
      assert.equal(headers.get('x-goog-upload-header-content-length'), '3');
      resourceName = JSON.parse(options.body).file.name;
      assert.ok(h.pending.has(resourceName));
      return new Response('{}', { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload-session-test' } });
    }
    if (String(url).endsWith('/upload-session-test')) {
      assert.equal(headers.get('x-goog-upload-command'), 'upload, finalize');
      assert.equal(await options.body.text(), 'abc');
      return new Response(JSON.stringify({ file: { name: resourceName, state: 'ACTIVE',
        mimeType: 'image/png', uri: `https://generativelanguage.googleapis.com/v1beta/${resourceName}` } }),
      { headers: { 'x-goog-upload-status': 'final' } });
    }
    assert.equal(options.method, 'DELETE');
    assert.ok(String(url).endsWith(`/v1beta/${resourceName}`));
    return new Response('{}');
  };
  const ai = new GoogleGenAI({ apiKey: 'test-only-key', httpOptions: { timeout: 1000, retryOptions: { attempts: 1 } } });
  const prepared = await prepareMedia({ ...h, ai, attachments: [attachment()] });
  assert.equal(prepared.parts.length, 1);
  await prepared.cleanup();
  assert.equal(h.pending.size, 0);
  assert.equal(requests.length, 3);
});
