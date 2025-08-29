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

    const link = buildLink(ctx.chat, ctx.message.message_id);
    const groupName = ctx.chat.title || 'a group';
    const excerpt = text.replace(/\s+/g,' ').slice(0,160);

    const subs = await listSubscribers();
    // Fan-out politely. For this scale, a simple loop is fine.
    const payload = `🔔 “Attendance” mentioned\nIn ${groupName}: “${excerpt}”` + (link ? '' : '\n(Direct link not available for this group)');
    const markup = link ? { reply_markup: { inline_keyboard: [[{ text: 'Open message', url: link }]] } } : undefined;

    for (const uid of subs) {
      try {
        await ctx.api.sendMessage(uid, payload, markup);
        // small delay to be gentle with limits
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        const code = e?.response?.error_code;
        if (String(code) === '403') {
          // user blocked the bot; remove from set
          await removeSubscriber(uid);
        } else {
          console.error('DM error to', uid, e?.response?.description || e?.message || e);
        }
      }
    }
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
