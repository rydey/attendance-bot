// api/telegram.js — Vercel serverless webhook with Vercel KV fan-out
import { Telegraf, Markup } from 'telegraf';
import { kv } from '@vercel/kv';

const KEYWORD = /(^|\W)attendance(\W|$)/i;
const SUBS_KEY = 'subs:attendance'; // a Redis set of user_ids

function extractText(msg) {
  return (msg?.text || msg?.caption || '').trim();
}
function buildLink(chat, messageId) {
  if (chat?.username) return `https://t.me/${chat.username}/${messageId}`;
  const idStr = String(chat?.id || '');
  if (idStr.startsWith('-100')) return `https://t.me/c/${idStr.slice(4)}/${messageId}`;
  return null; // basic private groups: no per-message link
}
function getBody(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

let bot;
let botUsername;

async function addSubscriber(userId) {
  try { await kv.sadd(SUBS_KEY, String(userId)); } catch (e) { console.error('kv.sadd error', e); }
}
async function listSubscribers() {
  try { return (await kv.smembers(SUBS_KEY)).map(id => Number(id)); } catch (e) { console.error('kv.smembers error', e); return []; }
}
async function removeSubscriber(userId) {
  try { await kv.srem(SUBS_KEY, String(userId)); } catch (e) { console.error('kv.srem error', e); }
}

// use bot.telegram for webhook mode
async function notifyAllUsers(bot, userIds, previewText, linkUrl) {
  const inline_keyboard = linkUrl ? [[{ text: 'Open message', url: linkUrl }]] : [];
  const suffix = linkUrl ? '' : '\n(Direct link not available for this group)';

  for (const uid of userIds) {
    try {
      await bot.telegram.sendMessage(
        uid,
        `🔔 "Attendance" mentioned\n${previewText}${suffix}`,
        { reply_markup: { inline_keyboard } }
      );
      await new Promise(r => setTimeout(r, 50)); // gentle rate limit
    } catch (e) {
      const code = e?.response?.error_code;
      const desc = e?.response?.description || e.message;
      console.error('send error to', uid, code, desc);
      // if you maintain a subscriber list, remove on 403 (blocked)
      if (String(code) === '403') {
        await removeSubscriber(uid);
      }
    }
  }
}

function initBot() {
  if (bot) return bot;
  if (!process.env.BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

  bot = new Telegraf(process.env.BOT_TOKEN);
  bot.telegram.getMe().then(me => { botUsername = me.username; }).catch(()=>{});

  // /start — ONLY reply in private, and store the user id
  bot.start(async (ctx) => {
    if (ctx.chat?.type !== 'private') return; // prevent group noise
    await addSubscriber(ctx.from.id);
    await ctx.reply(
      'You’ll get a DM when someone says “Attendance” in groups I’m in.',
      Markup.inlineKeyboard([
        [Markup.button.url('➕ Add me to a group',
          botUsername ? `https://t.me/${botUsername}?startgroup=true` : 'https://t.me')]
      ])
    );
  });

  // Optional: /stop to opt out (private only)
  bot.command('stop', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    await removeSubscriber(ctx.from.id);
    await ctx.reply('Okay, I won’t DM you anymore for “Attendance”. You can /start again anytime.');
  });

  // Group messages → keyword detect → DM all subscribers
  bot.on('message', async (ctx) => {
    if (!['group','supergroup'].includes(ctx.chat?.type)) return;

    const text = extractText(ctx.message);
    if (!text || !KEYWORD.test(text)) return;

    const groupName = ctx.chat.title || 'a group';
    const link = buildLink(ctx.chat, ctx.message.message_id);
    const excerpt = text.replace(/\s+/g,' ').slice(0,160);
    const preview = `In ${groupName}: "${excerpt}"`;

    // get your subscriber IDs from KV / DB
    const subs = await listSubscribers();
    await notifyAllUsers(bot, subs, preview, link);
  });

  // No bot.launch() in webhook mode
  return bot;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK'); // GET shows OK in browser
  try {
    const update = getBody(req);
    const b = initBot();
    await b.handleUpdate(update);
    res.status(200).send('OK');
  } catch (err) {
    console.error('telegram webhook error:', err?.message || err);
    // still 200 so Telegram doesn’t retry-bomb
    res.status(200).send('OK');
  }
}
