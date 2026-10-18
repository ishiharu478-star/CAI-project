// Trace only fixed processing stages. Discord objects, identifiers, content,
// operation results and errors must never be given to the logger.
const PREFIX = '[cai Message]';
const STAGES = new Set(['reference', 'settings', 'quota', 'typing', 'history', 'memory_search',
  'budget', 'web', 'gemini', 'reply', 'followup', 'save', 'accounting', 'refund']);
const MAX_ELAPSED_SECONDS = 31 * 24 * 60 * 60;
const MAX_PENDING_TIMERS = 32;
let sequence = 0;

export function createMessageDiagnostics({ logger = console, now = Date.now, waitMs = 15000,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const delay = typeof waitMs === 'number' && Number.isFinite(waitMs)
    ? Math.max(1, Math.min(24 * 60 * 60 * 1000, Math.floor(waitMs))) : 15000;
  function log(level, text) {
    try {
      const write = logger?.[level];
      if (typeof write === 'function') {
        const result = write.call(logger, text);
        if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
          Promise.resolve(result).catch(() => {});
        }
      }
    } catch { /* Observability must not change the chatbot's result. */ }
  }
  function clock() {
    try {
      const value = now();
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    } catch { return undefined; }
  }
  function elapsed(startedAt) {
    const current = clock();
    if (startedAt === undefined || current === undefined) return 0;
    return Math.min(MAX_ELAPSED_SECONDS, Math.max(0, Math.floor((current - startedAt) / 1000)));
  }
  return {
    begin() {
      sequence = sequence >= 999999999 ? 1 : sequence + 1;
      const tag = `m${sequence}`;
      const pending = new Set();
      let finished = false;
      log('log', `${PREFIX} ${tag} received`);
      function cancel(record) {
        if (!record) return;
        record.active = false;
        pending.delete(record);
        if (record.timer !== undefined) {
          try { clearTimeoutImpl(record.timer); } catch { /* Best effort only. */ }
          record.timer = undefined;
        }
      }
      function watch(stage) {
        // Bot stages are sequential. A cap also bounds retained metadata if a
        // caller accidentally starts many operations on the same trace.
        if (finished || pending.size >= MAX_PENDING_TIMERS) return undefined;
        const record = { active: true, timer: undefined, startedAt: clock() };
        pending.add(record);
        try {
          record.timer = setTimeoutImpl(() => {
            if (!record.active || finished) return;
            record.active = false;
            record.timer = undefined;
            pending.delete(record);
            log('warn', `${PREFIX} ${tag} stage=${stage} waiting elapsedSeconds=${elapsed(record.startedAt)}`);
          }, delay);
          try { record.timer?.unref?.(); } catch { /* A timer must not affect the operation. */ }
        } catch { cancel(record); }
        return record;
      }
      return {
        async run(stage, fn) {
          const safeStage = typeof stage === 'string' && STAGES.has(stage) ? stage : 'unknown';
          if (finished) return await fn();
          log('log', `${PREFIX} ${tag} stage=${safeStage} started`);
          const record = watch(safeStage);
          try {
            const result = await fn();
            if (!finished) log('log', `${PREFIX} ${tag} stage=${safeStage} completed`);
            return result;
          } catch (error) {
            if (!finished) log('warn', `${PREFIX} ${tag} stage=${safeStage} failed`);
            throw error;
          } finally { cancel(record); }
        },
        finish() {
          if (finished) return;
          finished = true;
          for (const record of pending) cancel(record);
          log('log', `${PREFIX} ${tag} handler_finished`);
        },
      };
    },
  };
}
