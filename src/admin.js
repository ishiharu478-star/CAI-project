import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { dayKey, safeError, splitMessage, VERSION } from './util.js';

export function adminCommand() {
  return new SlashCommandBuilder().setName('cai').setDescription('caiの管理（オーナー専用）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('status').setDescription('稼働状況と無料枠ガードの集計を見る'))
    .addSubcommand(sub => sub.setName('maintenance').setDescription('メンテナンスを切り替える')
      .addBooleanOption(opt => opt.setName('enabled').setDescription('trueでメンテ中').setRequired(true))
      .addStringOption(opt => opt.setName('message').setDescription('メンテ中の返答').setMaxLength(500)))
    .addSubcommand(sub => sub.setName('guard').setDescription('無料枠ガードの基準を変更する（Neonに保存）')
      .addIntegerOption(opt => opt.setName('daily').setDescription('AI Studioを確認して設定する1日API回数上限').setMinValue(1).setMaxValue(1000000))
      .addIntegerOption(opt => opt.setName('warn').setDescription('警告する割合（%）').setMinValue(1).setMaxValue(99))
      .addIntegerOption(opt => opt.setName('stop').setDescription('停止する割合（%）').setMinValue(2).setMaxValue(100)));
}

export function isOwnerAdmin(interaction, config) {
  return interaction.guildId === config.adminGuildId && interaction.user?.id === config.ownerId;
}

export function createAdminHandler({ store, config, client, logger = console }) {
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'cai') return;
    if (!isOwnerAdmin(interaction, config)) {
      await interaction.reply({ content: 'この操作は管理サーバーのオーナー専用やで。', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const sub = interaction.options.getSubcommand();
      let text;
      if (sub === 'status') {
        const key = dayKey('America/Los_Angeles');
        const status = await store.status(key, dayKey('Asia/Tokyo'));
        text = `${VERSION}\nDiscord: ${client.isReady() ? '接続中' : '再接続中'}\nGeminiモデル: ${config.model}\nGemini集計日（米国太平洋時間）: ${key}\n${JSON.stringify(status, null, 2)}\n1人30回のリセットは日本時間0時。ガードはcai内の推定・設定基準で、各社全体の残量ではないで。`;
      } else if (sub === 'maintenance') {
        const patch = { maintenance: interaction.options.getBoolean('enabled', true) };
        const message = interaction.options.getString('message');
        if (message != null) patch.maintenanceMessage = message;
        await store.setSettings(patch);
        text = patch.maintenance ? 'メンテモードにしたで 🔧 管理コマンドは引き続き使える。' : 'メンテ終了！ 戻ってきたで 👍';
      } else if (sub === 'guard') {
        const patch = {};
        for (const [option, key] of [['daily', 'dailyRequestLimit'], ['warn', 'warnPercent'], ['stop', 'stopPercent']]) {
          const value = interaction.options.getInteger(option);
          if (value != null) patch[key] = value;
        }
        if (!Object.keys(patch).length) text = `今の設定やで：\n${JSON.stringify(await store.getSettings(), null, 2)}`;
        else {
          const settings = await store.setSettings(patch);
          text = `ガード設定を保存したで。\n${JSON.stringify(settings, null, 2)}\n回数カウンターはリセットしてへんで。`;
        }
      } else text = 'その管理コマンドは見つからへんかったで。';
      const chunks = splitMessage(text);
      await interaction.editReply({ content: chunks.shift(), allowedMentions: { parse: [] } });
      for (const content of chunks) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error('Admin command failed', safeError(error));
      await interaction.editReply('設定を確認してな。警告の割合は停止の割合より小さくする必要があるで。DBの接続も確認してみてな。');
    }
  };
}
