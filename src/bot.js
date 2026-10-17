import { randomInt } from 'node:crypto';
import { buildWebContext, chooseWebMode } from './web.js';
import { validateAttachments } from './media.js';
import { dayKey, minuteKey, explicitMention, stripBotMention, memoryQuery, splitMessage, safeError, errorText } from './util.js';

const acknowledgements = ['おるで！ どうしたん？ 👀', '呼んだ？ caiやで 👍', 'ん、聞いてるで！', 'なんやなんや、話してみ？', 'はいよ！ スタンバイできてるで。'];
const coded = code => Object.assign(new Error(code), { code });
const allowedMentions = { parse: [], repliedUser: false };

export async function sendReply(message, text) {
  const sent = [];
  for (const content of splitMessage(text)) {
    const result = sent.length
      ? await message.channel.send({ content, allowedMentions })
      : await message.reply({ content, allowedMentions });
    sent.push(result.id);
  }
  return sent;
}

export function createMessageHandler({ store, gemini, config, logger = console,
  web = buildWebContext, validate = validateAttachments, now = () => new Date() }) {
  const busyUsers = new Set();
  const seen = new Map();
  const ackTimes = new Map();
  let active = 0;
  return async function onMessage(message, botId) {
    if (!message.guildId || message.author?.bot || message.webhookId || message.system) return;
    if (config.allowedGuildIds.length && !config.allowedGuildIds.includes(message.guildId)) return;
    const content = message.content || '';
    const mentioned = explicitMention(content, botId);
    let referenced = null;
    if (message.reference?.messageId) {
      try { referenced = await message.fetchReference(); } catch { /* Deleted or inaccessible reply target. */ }
      if (referenced && (referenced.guildId !== message.guildId || referenced.channelId !== message.channelId)) referenced = null;
    }
    const replyToCai = referenced?.author?.id === botId;
    if (!mentioned && !replyToCai) return;
    if (seen.has(message.id)) return;
    const stamp = now().getTime();
    seen.set(message.id, stamp);
    if (seen.size > 2000) {
      for (const [id, time] of seen) if (stamp - time > 300000) seen.delete(id);
      if (seen.size > 2000) seen.delete(seen.keys().next().value);
    }
    const userId = message.author.id;
    if (busyUsers.has(userId)) {
      await sendReply(message, '今の質問を考えてるとこや。答え終わるまでちょっと待ってな。').catch(() => {});
      return;
    }
    busyUsers.add(userId);
    let reserved = false;
    let delivered = false;
    let countedActive = false;
    let typingTimer;
    const userDay = dayKey('Asia/Tokyo', now());
    try {
      const settings = await store.getSettings();
      if (settings.maintenance) {
        await sendReply(message, settings.maintenanceMessage || '今はメンテ中やで。戻るまでちょっと待ってな 🔧');
        return;
      }
      let prompt = stripBotMention(content, botId);
      const attachments = [...(message.attachments?.values() || [])];
      // Only the explicitly referenced message may supply third-party context.
      // Never fetch surrounding channel messages or keep that quote in the database.
      if (mentioned && referenced && !replyToCai) {
        attachments.push(...(referenced.attachments?.values() || []));
      }
      if (!prompt && !attachments.length) {
        if (stamp - (ackTimes.get(userId) || 0) < 5000) return;
        if (ackTimes.size > 2000) ackTimes.clear();
        ackTimes.set(userId, stamp);
        const response = acknowledgements[randomInt(acknowledgements.length)];
        const ids = await sendReply(message, response);
        delivered = true;
        try {
          await store.saveExchange({ guildId: message.guildId, channelId: message.channelId, userId,
            userMessageId: message.id, botMessageIds: ids, prompt: '[呼びかけ]', response, threadKey: message.id });
        } catch (error) { logger.error('Conversation save failed', safeError(error)); }
        return;
      }
      validate(attachments);
      if (!prompt) prompt = 'この添付について説明して。';
      if (prompt.length > 12000) {
        await sendReply(message, '質問は1回12,000文字までにしてな。長い内容は分けて送ってくれると助かるで。');
        return;
      }
      if (active >= config.maxConcurrent) {
        await sendReply(message, '今ちょっと立て込んでるで。少し待ってからもう一度頼むわ。');
        return;
      }
      active++; countedActive = true;
      reserved = await store.reserveQuestion(userId, userDay, 30);
      if (!reserved) throw coded('USER_QUOTA');
      await message.channel.sendTyping().catch(() => {});
      typingTimer = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      typingTimer.unref?.();
      let threadKey = message.id;
      let history = [];
      let quotedText = '';
      if (replyToCai) {
        const exchange = await store.findExchange({ guildId: message.guildId, channelId: message.channelId, botMessageId: referenced.id });
        if (exchange) {
          threadKey = exchange.threadKey;
          history = await store.recent({ guildId: message.guildId, channelId: message.channelId, userId, threadKey, limit: 6 });
        } else quotedText = `caiへの返信先（会話記録なし）: ${(referenced.content || '').slice(0, 4000)}`;
      } else if (referenced) {
        quotedText = `返信先の発言（第三者の引用）: ${(referenced.content || '').slice(0, 4000)}`;
      } else if (message.reference?.messageId) {
        quotedText = '返信先は削除済み、または権限がないため取得できなかった。';
      }
      const query = memoryQuery(prompt);
      const memories = query ? await store.search({ guildId: message.guildId, channelId: message.channelId, userId, query, limit: 4 }) : [];
      const result = await store.withGenerationBudget({
        dayKey: dayKey('America/Los_Angeles', now()), minuteKey: minuteKey(now()),
        dailyLimit: settings.dailyRequestLimit, rpmLimit: config.rpmLimit,
        warnPercent: settings.warnPercent, stopPercent: settings.stopPercent,
      }, async () => {
        const mode = chooseWebMode(prompt);
        const context = mode === 'none' ? { text: '', sources: [] } : await web({ prompt, mode });
        return gemini.generate({ prompt, history, quotedText, memories, attachments,
          webContext: context.text, webSources: context.sources, webMode: 'none', currentTime: now().toISOString() });
      });
      let response = result.value.text;
      if (!response?.trim()) throw coded('EMPTY_RESPONSE');
      if (result.warning) response += `\n\n☕ 無料枠ガードのお知らせ：設定した1日上限の${settings.warnPercent}%に達してるで。${settings.stopPercent}%で今日は休憩するな。`;
      const ids = await sendReply(message, response);
      delivered = true;
      try {
        await store.saveExchange({ guildId: message.guildId, channelId: message.channelId, userId,
          userMessageId: message.id, botMessageIds: ids, prompt, response, threadKey });
      } catch (error) { logger.error('Conversation save failed', safeError(error)); }
      if (result.value.totalTokens != null) {
        await store.recordTokens(dayKey('America/Los_Angeles', now()), result.value.totalTokens)
          .catch(error => logger.error('Token accounting failed', safeError(error)));
      }
    } catch (error) {
      logger.error('Message handling failed', safeError(error));
      if (!delivered) await sendReply(message, errorText(error)).catch(() => {});
    } finally {
      clearInterval(typingTimer);
      if (reserved && !delivered) await store.refundQuestion(userId, userDay).catch(error => logger.error('Quota refund failed', safeError(error)));
      if (countedActive) active--;
      busyUsers.delete(userId);
    }
  };
}
