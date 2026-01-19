// api/telegram.js — Vercel serverless webhook with Vercel KV fan-out
import { Telegraf, Markup } from 'telegraf';
import { kv } from '@vercel/kv';

const KEYWORD = /(^|\W)attendance(\W|$)/i;
const SUBS_ATTENDANCE_KEY = 'subs:attendance'; // a Redis set of user_ids
const SUBS_CLASS_KEY = 'subs:class'; // a Redis set of user_ids

// Class reminder schedule (GMT+5)
// Assumption: "GMT +5, 18:25" is the reminder time (5 mins before 18:30 class).
const CLASS_REMINDER_HOUR_GMT5 = 18;
const CLASS_REMINDER_MINUTE_GMT5 = 25;
const CLASS_SCHEDULE_BY_GMT5_DAY = {
  // 1=Mon .. 4=Thu (based on getUTCDay after +5h offset)
  1: 'Database Design Concepts',
  2: 'Computer Systems',
  3: 'Business Skills for E- Commerce',
  4: 'Website Design',
};

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

async function setSub(key, userId, enabled) {
  try {
    if (enabled) await kv.sadd(key, String(userId));
    else await kv.srem(key, String(userId));
  } catch (e) {
    console.error('kv subscription error', key, e);
  }
}
async function isSub(key, userId) {
  try {
    // Redis SISMEMBER returns 1/0
    return (await kv.sismember(key, String(userId))) === 1;
  } catch (e) {
    console.error('kv.sismember error', key, e);
    return false;
  }
}
async function listSubs(key) {
  try {
    return (await kv.smembers(key)).map(id => Number(id));
  } catch (e) {
    console.error('kv.smembers error', key, e);
    return [];
  }
}
async function removeFromAllLists(userId) {
  await Promise.all([
    setSub(SUBS_ATTENDANCE_KEY, userId, false),
    setSub(SUBS_CLASS_KEY, userId, false),
  ]);
}

async function getSettings(userId) {
  const [attendance, classReminders] = await Promise.all([
    isSub(SUBS_ATTENDANCE_KEY, userId),
    isSub(SUBS_CLASS_KEY, userId),
  ]);
  return { attendance, classReminders };
}

function formatSettingsText(settings) {
  const att = settings.attendance ? 'ON' : 'OFF';
  const cls = settings.classReminders ? 'ON' : 'OFF';
  const lines = [
    'Choose your reminders:',
    '',
    'Attendance reminders = I DM you when someone says “Attendance” in a group I’m in.',
    '',
    `Attendance reminders: ${att}`,
    `Class reminders: ${cls}`,
    '',
    `Class reminders schedule (GMT+5, ${String(CLASS_REMINDER_HOUR_GMT5).padStart(2, '0')}:${String(CLASS_REMINDER_MINUTE_GMT5).padStart(2, '0')}):`,
    `Every Monday — ${CLASS_SCHEDULE_BY_GMT5_DAY[1]}`,
    `Tuesday — ${CLASS_SCHEDULE_BY_GMT5_DAY[2]}`,
    `Wed — ${CLASS_SCHEDULE_BY_GMT5_DAY[3]}`,
    `Thurs — ${CLASS_SCHEDULE_BY_GMT5_DAY[4]}`,
    '',
    'Tip: Class reminders say “{class} class starts in 5 mins”.',
  ];
  return lines.join('\n');
}

function buildMenuKeyboard(settings) {
  const attendanceOnlySelected = settings.attendance && !settings.classReminders;
  const bothSelected = settings.attendance && settings.classReminders;
  const disabledSelected = !settings.attendance && !settings.classReminders;

  const addToGroupUrl = botUsername
    ? `https://t.me/${botUsername}?startgroup=true`
    : 'https://t.me';

  return Markup.inlineKeyboard([
    [Markup.button.callback(`${attendanceOnlySelected ? '✅ ' : ''}Attendance reminders`, 'preset:attendance')],
    [Markup.button.callback(`${bothSelected ? '✅ ' : ''}Attendance + Class reminders`, 'preset:both')],
    [Markup.button.callback(`${disabledSelected ? '✅ ' : ''}Disable reminders`, 'preset:none')],
    [Markup.button.url('➕ Add me to a group', addToGroupUrl)],
  ]);
}

async function showMenu(ctx, { preferEdit = false } = {}) {
  if (ctx.chat?.type !== 'private') return;
  const settings = await getSettings(ctx.from.id);
  const text = formatSettingsText(settings);
  const keyboard = buildMenuKeyboard(settings);

  if (preferEdit && ctx.updateType === 'callback_query') {
    try {
      await ctx.editMessageText(text, keyboard);
      return;
    } catch {
      // fall through to reply if edit fails (e.g. message too old / not modified)
    }
  }

  await ctx.reply(text, keyboard);
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
        await removeFromAllLists(uid);
      }
    }
  }
}

function initBot() {
  if (bot) return bot;
  if (!process.env.BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

  bot = new Telegraf(process.env.BOT_TOKEN);
  bot.telegram.getMe().then(me => { botUsername = me.username; }).catch(()=>{});

  // /start — ONLY reply in private, show menu
  bot.start(async (ctx) => {
    await showMenu(ctx);
  });

  // /settings — show menu again (private only)
  bot.command(['settings', 'menu'], async (ctx) => {
    await showMenu(ctx);
  });

  bot.action('preset:attendance', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const userId = ctx.from.id;
    await Promise.all([
      setSub(SUBS_ATTENDANCE_KEY, userId, true),
      setSub(SUBS_CLASS_KEY, userId, false),
    ]);
    await ctx.answerCbQuery('Attendance reminders enabled.');
    await showMenu(ctx, { preferEdit: true });
  });

  bot.action('preset:both', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const userId = ctx.from.id;
    await Promise.all([
      setSub(SUBS_ATTENDANCE_KEY, userId, true),
      setSub(SUBS_CLASS_KEY, userId, true),
    ]);
    await ctx.answerCbQuery('Attendance + Class reminders enabled.');
    await showMenu(ctx, { preferEdit: true });
  });

  bot.action('preset:none', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    await removeFromAllLists(ctx.from.id);
    await ctx.answerCbQuery('Reminders disabled.');
    await showMenu(ctx, { preferEdit: true });
  });

  // /stop to opt out (private only) — disables all reminders
  bot.command('stop', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    await removeFromAllLists(ctx.from.id);
    await ctx.reply('Okay — all reminders disabled. You can /start anytime to re-enable.');
  });

  // Group messages → keyword detect → DM attendance subscribers
  bot.on('message', async (ctx) => {
    if (!['group','supergroup'].includes(ctx.chat?.type)) return;

    const text = extractText(ctx.message);
    if (!text || !KEYWORD.test(text)) return;

    const groupName = ctx.chat.title || 'a group';
    const link = buildLink(ctx.chat, ctx.message.message_id);
    const excerpt = text.replace(/\s+/g,' ').slice(0,160);
    const preview = `In ${groupName}: "${excerpt}"`;

    // get your subscriber IDs from KV / DB
    const subs = await listSubs(SUBS_ATTENDANCE_KEY);
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
