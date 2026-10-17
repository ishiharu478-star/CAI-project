export const VERSION = 'cai v1';
export function dayKey(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function minuteKey(now = new Date()) { return String(Math.floor(now.getTime() / 60000)); }
export function stripBotMention(content, botId) {
  return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}
export function explicitMention(content, botId) { return new RegExp(`<@!?${botId}>`).test(content); }
export function memoryQuery(prompt) {
  const explicit = prompt.match(/(?:過去ログ|ログ検索|思い出して|覚えてる|前に話した|前の話|以前の話|この前の話)[：:\s]*([\s\S]*)/);
  if (!explicit) return null;
  return (explicit[1].replace(/^(?:を|について|の|検索して)[\s：:]*/, '').trim() || prompt).slice(0, 200);
}
// Discord's content limit is 2000 UTF-16 code units; avoid splitting emoji.
export function splitMessage(text, limit = 1900) {
  const chunks = [];
  let rest = String(text).trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
export function safeError(error) {
  const code = /^[A-Z_0-9]{1,40}$/.test(String(error?.code)) ? error.code : undefined;
  const status = Number(error?.status ?? error?.statusCode);
  return { type: error?.name === 'AbortError' ? 'AbortError' : 'Error', ...(code && { code }), ...(Number.isFinite(status) && { status }) };
}
export function errorText(error) {
  const messages = {
    USER_QUOTA: '今日は30回使ったで！ 続きは日本時間の午前0時になってからな 🌙',
    QUOTA_GUARD: '無料枠を守るため、今日はここでひと休みや。管理者に確認してもらってな ☕',
    RATE_GUARD: 'ちょっとペースを落とすで。1分ほど待ってからもう一度話しかけてな。',
    MEDIA_TOO_LARGE: '添付は1ファイル200MBまで、1回の合計も200MBまでで頼むで。',
    MEDIA_UNSUPPORTED: 'その形式はまだ読めへん。対応している画像か動画で送ってな。',
    MEDIA_FAILED: '添付をうまく読み込めへんかった。少し待つか、小さめのファイルで試してな。',
    MEDIA_TOO_MANY: '1回の添付は4つまでにしてな。',
    EMPTY_RESPONSE: 'うまく言葉にできへんかった。聞き方を少し変えて、もう一度頼むで。',
    GEMINI_EMPTY: 'うまく言葉にできへんかった。聞き方を少し変えて、もう一度頼むで。',
    GEMINI_TIMEOUT: '考えるのに時間がかかりすぎたみたいや。添付を小さくするか、質問を分けてみてな。',
    GEMINI_RATE_LIMIT: 'Gemini側の無料枠か混雑の上限に当たったみたいや。少し待ってから試してな。',
    GEMINI_UNAVAILABLE: '今Gemini側が混み合ってるみたいや。少し待ってからもう一度頼むで。',
  };
  if (messages[error?.code]) return messages[error.code];
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 429) return 'Gemini側の無料枠か混雑の上限に当たったみたいや。少し待ってから試してな。';
  if ([400, 413].includes(status)) return '質問や添付をうまく処理できへんかった。内容を短くするか、添付を小さくして試してな。';
  if ([401, 403, 404].includes(status)) return '今はAIにつながれへんみたい。管理者に設定を確認してもらってな。';
  return 'すまん、今ちょっと調子悪いわ。少し待ってからもう一度頼むで。';
}
