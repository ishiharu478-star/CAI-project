// Discord debug text can contain credentials, URLs and session data. Recognize
// only fixed SDK markers and emit our own messages; never forward SDK objects.
const PREFIX = '[cai Discord]';
const MAX_SECONDS = 31 * 24 * 60 * 60;
const MAX_WAIT_MS = MAX_SECONDS * 1000;
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED']);
const CLOSE_CODES = new Set([1000, 1001, 1006, 1011, 1012, 1013, 4000, 4001, 4002, 4003, 4004,
  4005, 4007, 4008, 4009, 4010, 4011, 4012, 4013, 4014]);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError',
  'DiscordAPIError', 'DiscordjsError', 'HTTPError', 'RateLimitError']);
const PHASE_MESSAGES = Object.freeze({
  idle: '診断待機中', requesting_gateway: '接続開始: Discord Gateway情報を取得中',
  gateway_received: 'Gateway情報を取得したで', connecting_gateway: 'Discord Gatewayへ接続中',
  identifying: 'Discord Botの認証処理中', waiting_ready: 'Discordの準備完了を待機中',
  ready: 'Discord接続完了', reconnecting: 'Discordとの再接続をSDKが処理中',
  rate_limited: 'Discord API制限: SDKの制限解除待ち', failed: 'Discord接続の失敗を検出',
});
const EXACT_ERRORS = new Map([
  ['Used disallowed intents', 'DISALLOWED_INTENTS'], ['Used invalid intents', 'INVALID_INTENTS'],
  ['An invalid token was provided.', 'INVALID_TOKEN'], ['Invalid token', 'INVALID_TOKEN'],
  ['Authentication failed', 'INVALID_TOKEN'], ['Opening handshake has timed out', 'HANDSHAKE_TIMEOUT'],
  ['WebSocket was closed before the connection was established', 'CONNECTION_CLOSED'],
]);
function ownValue(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  // Ignore accessors as well as raw serialization hooks supplied by upstream errors.
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function safeCode(error, depth = 0) {
  if (depth > 3 || !error) return undefined;
  const code = ownValue(error, 'code');
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return code;
  if (code === 'TokenInvalid') return 'INVALID_TOKEN';
  if (typeof code === 'number' && CLOSE_CODES.has(code)) return code;
  const status = ownValue(error, 'status');
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  const message = ownValue(error, 'message');
  if (typeof message === 'string') {
    if (EXACT_ERRORS.has(message)) return EXACT_ERRORS.get(message);
    const response = /^Unexpected server response: ([1-5]\d{2})$/.exec(message);
    if (response) return Number(response[1]);
  }
  return safeCode(ownValue(error, 'cause'), depth + 1);
}
function hint(code) {
  if (code === 4014 || code === 'DISALLOWED_INTENTS') return 'Developer PortalでMessage Content IntentをONにして保存してな';
  if (code === 4013 || code === 'INVALID_INTENTS') return 'BotのGateway Intent設定を確認してな';
  if (code === 4004 || code === 401 || code === 'INVALID_TOKEN') return 'RenderのDISCORD_TOKENがBot Tokenか確認してな';
  if (code === 403) return 'Discord側のアクセス制限・Bot Token・権限設定を確認してな';
  if (code === 429) return 'Discord側のHTTP制限。SDKの待機中は再デプロイを繰り返さず待ってな';
  if (NETWORK_CODES.has(code) || ['NETWORK_ERROR', 'HANDSHAKE_TIMEOUT', 'CONNECTION_CLOSED'].includes(code)) return 'Discordまでの通信を確認中。SDKの接続処理はそのまま続くで';
  return '接続段階とコードを確認してな';
}
function boundedMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_WAIT_MS, Math.max(0, value)) : 0;
}

export function createConnectionDiagnostics({ client, logger = console, now = Date.now, intervalMs = 30000,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let phase = 'idle';
  let started = false;
  let stopped = false;
  let startedAt;
  let retryUntil = 0;
  let phaseBeforeRateLimit = 'requesting_gateway';
  let lastCode;
  let timer;
  let attached = false;
  const listeners = [];
  const ready = () => Boolean(client.isReady());
  const log = (level, message) => { if (typeof logger[level] === 'function') logger[level](`${PREFIX} ${message}`); };
  function changePhase(next) {
    if (stopped || phase === next) return;
    phase = next;
    log(next === 'failed' ? 'error' : 'log', PHASE_MESSAGES[next]);
  }
  function beginWaiting() { if (startedAt === undefined || phase === 'ready' || phase === 'failed') startedAt = now(); }
  function markReady() {
    if (stopped) return;
    startedAt = undefined; retryUntil = 0; lastCode = undefined;
    changePhase('ready');
  }
  function reconnect() {
    if (stopped) return;
    beginWaiting(); retryUntil = 0;
    changePhase('reconnecting');
  }
  function reportError(error) {
    if (stopped) return;
    const code = safeCode(error);
    if (code !== undefined) lastCode = code;
    const name = ownValue(error, 'name');
    const type = ERROR_NAMES.has(name) ? name : 'Error';
    log('warn', `通信エラー type=${type}${code === undefined ? '' : ` code=${code}`}。${hint(code)}`);
    if (!ready()) reconnect();
  }
  function rateLimited(data, observed429 = false) {
    if (stopped) return;
    const waitMs = Math.max(boundedMs(ownValue(data, 'retryAfter')), boundedMs(ownValue(data, 'timeToReset')),
      boundedMs(ownValue(data, 'sublimitTimeout')));
    retryUntil = Math.max(retryUntil, now() + waitMs);
    if (observed429) lastCode = 429;
    else if (lastCode !== 429) lastCode = 'RATE_LIMITED';
    if (!ready() && phase !== 'failed') {
      beginWaiting();
      if (phase !== 'rate_limited') phaseBeforeRateLimit = phase === 'idle' ? 'requesting_gateway' : phase;
      changePhase('rate_limited');
    }
    log('warn', `${observed429 ? 'HTTP 429' : 'Discord API制限'} retryAfterSeconds=${Math.min(MAX_SECONDS, Math.ceil(waitMs / 1000))}。SDKの待機中は再デプロイを繰り返さず待ってな`);
  }
  function clientDebug(value) {
    if (stopped || typeof value !== 'string' || value.length > 16384 || phase === 'failed') return;
    const first = value.split('\n', 1)[0].replace(/^\[WS => (?:Manager|Shard \d{1,6})\] /, '').trim();
    let next;
    if (first === 'Preparing to connect to the gateway...') next = 'requesting_gateway';
    else if (first === 'Fetched Gateway Information') next = 'gateway_received';
    else if (/^Connecting to wss:\/\/[^\s]{1,2048}$/.test(first)) next = 'connecting_gateway';
    else if (first === 'Waiting for identify throttle' || first === 'Identifying') next = 'identifying';
    else if (/^Waiting for event ready (?:for \d{1,8}ms|indefinitely)$/.test(first)) next = 'waiting_ready';
    else if (first === 'Failed to connect to the gateway URL specified due to a network error' || first === 'A network error occurred') {
      // Some SDK versions include an error below this static marker. Only
      // known code tokens and exact status lines may leave this function.
      const network = value.match(/\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|UND_ERR_ABORTED)\b/);
      const status = value.match(/(?:^|\n)\s*(?:Error: )?Unexpected server response: ([1-5]\d{2})\s*(?:\n|$)/);
      lastCode = status ? Number(status[1]) : network ? network[0] : 'NETWORK_ERROR';
      log('warn', `通信エラー code=${lastCode}。${hint(lastCode)}`);
      reconnect();
      return;
    }
    if (next && !ready()) { beginWaiting(); retryUntil = 0; changePhase(next); }
  }
  function restDebug(value) {
    if (stopped || typeof value !== 'string' || value.length > 16384) return;
    const first = value.split('\n', 1)[0];
    if (!/^(?:\[REST [^\]\r\n]{1,4096}\] )?Encountered unexpected 429 rate limit$/.test(first)) return;
    const match = /^\s*Retry After\s*:\s*(\d{1,16}(?:\.\d{1,6})?)ms\s*$/m.exec(value);
    rateLimited({ retryAfter: match ? Number(match[1]) : 0 }, true);
  }
  function listen(target, event, handler) {
    if (!target?.on) return;
    target.on(event, handler); listeners.push([target, event, handler]);
  }
  function attach() {
    if (attached) return;
    attached = true;
    listen(client, 'debug', clientDebug);
    listen(client, 'shardError', reportError);
    listen(client, 'shardDisconnect', event => {
      if (stopped) return;
      const code = ownValue(event, 'code');
      if (CLOSE_CODES.has(code)) { lastCode = code; log('warn', `接続切断 code=${code}。${hint(code)}`); }
      else log('warn', 'Discord接続の切断を検出');
      reconnect();
      if ([4004, 4013, 4014].includes(code)) changePhase('failed');
    });
    listen(client, 'shardReconnecting', reconnect);
    listen(client, 'shardReady', () => { if (ready()) markReady(); else if (!stopped) changePhase('waiting_ready'); });
    listen(client, 'shardResume', () => { if (ready()) markReady(); else if (!stopped) changePhase('waiting_ready'); });
    listen(client, 'clientReady', markReady);
    listen(client, 'invalidated', () => { reconnect(); lastCode = 'SESSION_INVALIDATED'; changePhase('failed'); });
    listen(client.rest, 'rateLimited', rateLimited);
    listen(client.rest, 'restDebug', restDebug);
  }
  function snapshot() {
    const remaining = Math.min(MAX_SECONDS, Math.max(0, Math.ceil((retryUntil - now()) / 1000)));
    const currentPhase = phase === 'rate_limited' && remaining === 0 ? phaseBeforeRateLimit : phase;
    const result = { phase: currentPhase,
      waitingSeconds: startedAt === undefined || currentPhase === 'ready' || currentPhase === 'idle' ? 0 : Math.min(MAX_SECONDS, Math.max(0, Math.floor((now() - startedAt) / 1000))),
      retryAfterSeconds: remaining };
    if (lastCode !== undefined) result.lastCode = lastCode;
    return result;
  }
  function start() {
    if (started && !stopped) return;
    stopped = false; started = true; attach();
    startedAt = now(); retryUntil = 0; lastCode = undefined;
    if (ready()) markReady(); else changePhase('requesting_gateway');
    timer = setIntervalImpl(() => {
      if (stopped || phase === 'failed') return;
      if (ready()) { if (phase !== 'ready') markReady(); return; }
      const state = snapshot();
      log('warn', `接続待機 phase=${state.phase} waitingSeconds=${state.waitingSeconds} retryAfterSeconds=${state.retryAfterSeconds}。SDKの処理を継続中`);
    }, intervalMs);
    timer?.unref?.();
  }
  function stop() {
    if (timer !== undefined) clearIntervalImpl(timer);
    timer = undefined; stopped = true; started = false;
    for (const [target, event, handler] of listeners.splice(0)) target.off(event, handler);
    attached = false; phase = 'idle'; startedAt = undefined; retryUntil = 0; lastCode = undefined;
  }
  function fail(error) {
    if (stopped) return;
    reportError(error); retryUntil = 0; changePhase('failed');
  }
  attach();
  return { start, stop, fail, snapshot };
}
