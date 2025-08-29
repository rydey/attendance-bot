// api/telegram.js — Vercel serverless webhook
import { Telegraf, Markup } from 'telegraf';

const KEYWORD = /(^|\W)attendance(\W|$)/i;

function extractText(msg) {
  return (msg?.text || msg?.caption || '').trim();
}
function buildLink(chat, messageId) {
  if (chat?.username) return `https://t.me/${chat.username}/${messageId}`;
  const idStr = String(chat?.id || '');
  if (idStr.startsWith('-100')) return `https://t.me/c/${idStr.slice(4)}/${messageId}`;
  return null; // basic private groups have no per-message link
}
function getBody(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

let bot;
let botUsername;

function initBot() {
  if (bot) return bot;
  if (!process.env.BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

  bot = new Telegraf(process.env.BOT_TOKEN);
  bot.telegram.getMe().then(me => { botUsername = me.username; }).catch(()=>{});

  bot.start(async (ctx) => {
    await ctx.reply(
      'I’ll DM you when someone says “Attendance” in groups I’m in.',
      Markup.inlineKeyboard([
        [Markup.button.url('➕ Add me to a group',
          botUsername ? `https://t.me/${botUsername}?startgroup=true` : 'https://t.me')]
      ])
    );
  });

  bot.on('message', async (ctx) => {
    if (!['group','supergroup'].includes(ctx.chat?.type)) return;
    const text = extractText(ctx.message);
    if (!text || !KEYWORD.test(text)) return;

    const link = buildLink(ctx.chat, ctx.message.message_id);
    const groupName = ctx.chat.title || 'a group';
    const excerpt = text.replace(/\s+/g,' ').slice(0,160);

    await ctx.api.sendMessage(
      ctx.from.id,
      `🔔 “Attendance” mentioned\nIn ${groupName}: “${excerpt}”` + (link ? '' : '\n(Direct link not available for this group)'),
      link ? { reply_markup: { inline_keyboard: [[{ text: 'Open message', url: link }]] } } : undefined
    );
  });

  // No bot.launch() in webhook/serverless mode
  return bot;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK'); // makes GET /api/telegram show OK
  try {
    const update = getBody(req);
    const b = initBot();
    await b.handleUpdate(update);
    res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook error:', err?.message || err);
    res.status(200).send('OK'); // still 200 so Telegram doesn’t spam retries
  }
}
