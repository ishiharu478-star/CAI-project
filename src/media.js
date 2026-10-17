import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_MEDIA_BYTES = 200_000_000;
export const MAX_ATTACHMENTS = 4;
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],
  ['.mp4', 'video/mp4'], ['.mpeg', 'video/mpeg'], ['.mpg', 'video/mpeg'],
  ['.mov', 'video/quicktime'], ['.avi', 'video/x-msvideo'], ['.flv', 'video/x-flv'],
  ['.webm', 'video/webm'], ['.wmv', 'video/x-ms-wmv'], ['.3gp', 'video/3gpp'],
]);
const SUPPORTED_TYPES = new Set(TYPES.values());
const MIME_ALIASES = new Map([['video/mov', 'video/quicktime'], ['video/avi', 'video/x-msvideo'], ['video/wmv', 'video/x-ms-wmv'], ['video/mpg', 'video/mpeg'], ['image/jpg', 'image/jpeg']]);
// The durable queue includes uploads that are currently in use by this process.
const ACTIVE_FILES = new Set();

function mediaError(code) {
  return Object.assign(new Error(code), { code });
}

function normalizeMime(value) {
  const mime = String(value ?? '').split(';')[0].trim().toLowerCase();
  return MIME_ALIASES.get(mime) ?? mime;
}

function safeAttachmentUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw mediaError('MEDIA_FAILED'); }
  if (url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname) || url.username || url.password
      || (url.port && url.port !== '443') || !url.pathname.startsWith('/attachments/')) {
    throw mediaError('MEDIA_FAILED');
  }
  return url.href;
}

/** Validate metadata before any download or Gemini request. MB means decimal MB. */
export function validateAttachments(attachments = []) {
  if (!Array.isArray(attachments)) throw mediaError('MEDIA_FAILED');
  if (attachments.length > MAX_ATTACHMENTS) throw mediaError('MEDIA_TOO_LARGE');
  let total = 0;
  return attachments.map((attachment) => {
    if (!attachment || !Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw mediaError('MEDIA_FAILED');
    }
    total += attachment.size;
    if (attachment.size > MAX_MEDIA_BYTES || total > MAX_MEDIA_BYTES) throw mediaError('MEDIA_TOO_LARGE');
    const mime = normalizeMime(attachment.contentType);
    // Generic/missing Discord metadata can use the filename; an explicit unsupported MIME cannot.
    const mimeType = (!mime || mime === 'application/octet-stream')
      ? TYPES.get(extname(String(attachment.name ?? '')).toLowerCase()) : mime;
    if (!SUPPORTED_TYPES.has(mimeType)) throw mediaError('MEDIA_UNSUPPORTED');
    return { ...attachment, url: safeAttachmentUrl(attachment.url), mimeType };
  });
}

function httpOptions(timeoutMs) {
  return { timeout: timeoutMs, retryOptions: { attempts: 1 } };
}

function isMissing(error) {
  return Number(error?.status ?? error?.code) === 404;
}

/** Keep failed provider deletions in PostgreSQL for a later startup retry. Never log payloads. */
async function deleteRemoteFile({ name, ai, store, logger, timeoutMs = 10_000 }) {
  let deleted = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ai.files.delete({ name, config: { httpOptions: httpOptions(timeoutMs), abortSignal: AbortSignal.timeout(timeoutMs) } });
      deleted = true;
      break;
    } catch (error) {
      if (isMissing(error)) { deleted = true; break; }
    }
  }
  if (deleted) {
    try { await store.removeFile(name); } catch { logger.warn?.('media_cleanup_queue_update_failed'); }
  } else {
    logger.warn?.('media_remote_cleanup_pending');
  }
  return deleted;
}

export async function cleanupPendingFiles({ ai, store, logger = console, timeoutMs = 10_000 }) {
  if (!store) return;
  let names;
  try { names = await store.pendingFiles(); } catch { logger.warn?.('media_cleanup_queue_read_failed'); return; }
  // Only this bot's queued Files resources are eligible; no provider-wide listing/deletion.
  for (const item of names) {
    const name = typeof item === 'string' ? item : item?.name;
    if (typeof name !== 'string' || !/^files\/[a-z0-9-]+$/.test(name)) continue;
    if (ACTIVE_FILES.has(name)) continue;
    await deleteRemoteFile({ name, ai, store, logger, timeoutMs });
  }
}

async function downloadAttachment({ attachment, path, fetchImpl, signal, streamed }) {
  const response = await fetchImpl(attachment.url, { redirect: 'error', signal });
  if (!response.ok || !response.body) throw mediaError('MEDIA_FAILED');
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const contentLength = Number(lengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw mediaError('MEDIA_FAILED');
    if (contentLength > MAX_MEDIA_BYTES || streamed.total + contentLength > MAX_MEDIA_BYTES) {
      await response.body.cancel().catch(() => {});
      throw mediaError('MEDIA_TOO_LARGE');
    }
  }
  const actualType = normalizeMime(response.headers.get('content-type'));
  if (actualType && actualType !== 'application/octet-stream' && actualType !== attachment.mimeType) {
    await response.body.cancel().catch(() => {});
    throw mediaError('MEDIA_UNSUPPORTED');
  }
  let fileBytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      fileBytes += chunk.length;
      streamed.total += chunk.length;
      if (fileBytes > MAX_MEDIA_BYTES || streamed.total > MAX_MEDIA_BYTES) {
        callback(mediaError('MEDIA_TOO_LARGE'));
      } else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
  if (fileBytes === 0) throw mediaError('MEDIA_FAILED');
}

/** Download sequentially to temporary disk, upload, and return an idempotent cleanup. */
export async function prepareMedia({ attachments = [], ai, store, logger = console,
  timeoutMs = 120_000, fetchImpl = globalThis.fetch, pollIntervalMs = 1000 } = {}) {
  const validated = validateAttachments(attachments);
  if (!validated.length) return { parts: [], cleanup: async () => {} };
  if (!ai?.files || !store?.queueFile || !store?.removeFile) throw mediaError('MEDIA_FAILED');
  const directory = await mkdtemp(join(tmpdir(), 'cai-media-'));
  const names = new Set();
  const streamed = { total: 0 };
  const signal = AbortSignal.timeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let cleaning;
  const cleanup = () => {
    cleaning ??= (async () => {
      // Delete local bytes even when the provider is temporarily unreachable.
      try { await rm(directory, { recursive: true, force: true }); }
      catch { logger.warn?.('media_local_cleanup_failed'); }
      try {
        for (const name of names) await deleteRemoteFile({ name, ai, store, logger });
      } finally {
        for (const name of names) ACTIVE_FILES.delete(name);
      }
    })();
    return cleaning;
  };
  try {
    const parts = [];
    for (let index = 0; index < validated.length; index += 1) {
      const attachment = validated[index];
      const path = join(directory, `attachment-${index}`);
      await downloadAttachment({ attachment, path, fetchImpl, signal, streamed });
      // Prequeue a known resource name, covering a lost upload response or process restart.
      const requestedName = `files/cai-${randomUUID()}`;
      names.add(requestedName);
      ACTIVE_FILES.add(requestedName);
      await store.queueFile(requestedName);
      let file = await ai.files.upload({ file: path, config: {
        name: requestedName, mimeType: attachment.mimeType,
        // SDK 1.x replaces required resumable headers when upload.httpOptions is supplied.
        // The GeminiService client already sets request timeout and disables automatic retries.
        abortSignal: signal,
      } });
      if (!file?.name) throw mediaError('MEDIA_FAILED');
      names.add(file.name);
      ACTIVE_FILES.add(file.name);
      if (file.name !== requestedName) await store.queueFile(file.name);
      while (file.state === 'PROCESSING') {
        if (Date.now() >= deadline || signal.aborted) throw mediaError('MEDIA_FAILED');
        await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
        file = await ai.files.get({ name: file.name, config: {
          httpOptions: httpOptions(Math.max(1, deadline - Date.now())), abortSignal: signal,
        } });
      }
      if (signal.aborted || file.state !== 'ACTIVE' || !file.uri) throw mediaError('MEDIA_FAILED');
      parts.push({ fileData: { fileUri: file.uri, mimeType: attachment.mimeType } });
    }
    return { parts, cleanup };
  } catch (error) {
    await cleanup();
    if (['MEDIA_TOO_LARGE', 'MEDIA_UNSUPPORTED', 'MEDIA_FAILED'].includes(error?.code)) throw error;
    throw mediaError('MEDIA_FAILED');
  }
}
