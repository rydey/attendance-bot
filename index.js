require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ====== Config ======
const KEYWORD_REGEX = /(^|\W)attendance(\W|$)/i; // word-boundaryish, case-insensitive
let BOT_USERNAME = null;

// Resolve bot username once on startup
(async () => {
  const me = await bot.telegram.getMe();
  BOT_USERNAME = me.username;
})().catch(err => {
  console.error('Failed to get bot info:', err);
  process.exit(1);
});

// ====== Helpers ======
function extractText(msg) {
  return (msg.text || msg.caption || '').trim();
}

/**
 * Build a deep link to the specific message if Telegram supports it.
 * - Public groups/channels: https://t.me/<username>/<message_id>
 * - Private supergroups/channels: https://t.me/c/<internal_id>/<message_id> (internal_id = chat.id without -100)
 * - Basic private groups: no message link (return null)
 */
function buildMessageLink(chat, messageId) {
  if (!chat) return null;

  // Public groups/channels with @username
  if (chat.username) {
    return `https://t.me/${chat.username}/${messageId}`;
  }

  // Private supergroup/channel (chat.id starts with -100)
  const idStr = String(chat.id || '');
  if (idStr.startsWith('-100')) {
    // Drop "-100" prefix → internal id
    const internal = idStr.slice(4);
    return `https://t.me/c/${internal}/${messageId}`;
  }

  // Basic private groups have no stable per-message URL
  return null;
}

/**
 * Simple, polite fan-out respecting rate limits.
 * Telegram global: ~30 msgs/sec; per-chat: ~1 msg/sec. We'll be conservative.
 */
async function notifyAllUsers(bot, previewText, linkUrl) {
  const users = db.listActiveUsers();
  for (const u of users) {
    try {
      const inline_keyboard = linkUrl ? [[{ text: 'Open message', url: linkUrl }]] : [];
      const suffix = linkUrl ? '' : '\n(Direct link not available for this group)';
      await bot.telegram.sendMessage(
        u.user_id,
        `🔔 “Attendance” mentioned\n${previewText}${suffix}`,
        { reply_markup: { inline_keyboard } }
      );
      // small delay ~60ms to spread load; increase if you have many subscribers
      await new Promise(r => setTimeout(r, 60));
    } catch (e) {
      const code = e?.response?.error_code;
      const desc = e?.response?.description || e.message;
      console.error(`DM error to ${u.user_id}:`, desc);
      // 403: bot was blocked by the user
      if (String(code) === '403') {
        db.markBlocked(u.user_id);
      }
    }
  }
}

// ====== Commands / Handlers ======
bot.start(async (ctx) => {
  db.addUser(ctx.from.id);
  const addToGroupUrl = BOT_USERNAME
    ? `https://t.me/${BOT_USERNAME}?startgroup=true`
    : 'https://t.me'; // fallback (shouldn’t happen after getMe resolves)

  return ctx.reply(
    'I’ll DM you when someone says “Attendance” in groups I’m in.'
  );
});

bot.help((ctx) => ctx.reply(
  'Add me to a group (➕ Add me to a group).\n' +
  'When “Attendance” appears, I’ll DM you.\n' +
  'Note: In small private groups, a direct message link may not be available.'
));

// Keyword detection in groups/supergroups
bot.on('message', async (ctx) => {
  const chatType = ctx.chat?.type;
  if (!['group', 'supergroup'].includes(chatType)) return;

  const text = extractText(ctx.message);
  if (!text) return;

  // Match keyword (case-insensitive, with loose boundaries)
  if (!KEYWORD_REGEX.test(text)) return;

  // Prepare preview + link (if available)
  const groupName = ctx.chat.title || 'a group';
  const normalized = text.replace(/\s+/g, ' ');
  const excerpt = normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized;

  const link = buildMessageLink(ctx.chat, ctx.message.message_id);
  const preview = `In ${groupName}: “${excerpt}”`;

  await notifyAllUsers(bot, preview, link);
});

// Track bot membership changes (optional: good logs)
bot.on('my_chat_member', (ctx) => {
  const chat = ctx.chat;
  const newStatus = ctx.update.my_chat_member?.new_chat_member?.status;
  console.log(`Bot membership change in ${chat?.title || chat?.id}: ${newStatus}`);
});

bot.catch((err, ctx) => {
  console.error(`Bot error for update ${ctx.update?.update_id}:`, err);
});

// ====== Start (long polling for local dev) ======
bot.launch().then(() => {
  console.log('✅ Attendance bot running (long polling). Ctrl+C to stop.');
  console.log('Make sure BotFather privacy mode is DISABLED for this bot.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
