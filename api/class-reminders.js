// api/class-reminders.js — Vercel Cron target to DM class reminders (GMT+5)
import { Telegraf } from 'telegraf';
import { kv } from '@vercel/kv';

const SUBS_CLASS_KEY = 'subs:class';
const SUBS_ATTENDANCE_KEY = 'subs:attendance';

// GMT+5 schedule (remind 5 mins before class)
const CLASS_REMINDER_HOUR_GMT5 = 18;
const CLASS_REMINDER_MINUTE_GMT5 = 25;
const CLASS_SCHEDULE_BY_GMT5_DAY = {
  // 1=Mon .. 4=Thu (based on getUTCDay after +5h offset)
  1: 'Database Design Concepts',
  2: 'Computer Systems',
  3: 'Business Skills for E- Commerce',
  4: 'Website Design',
};

function nowInGmt5() {
  return new Date(Date.now() + 5 * 60 * 60 * 1000);
}

function getGmt5Parts() {
  const d = nowInGmt5();
  return { day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

async function removeFromAllLists(userId) {
  try {
    await Promise.all([
      kv.srem(SUBS_ATTENDANCE_KEY, String(userId)),
      kv.srem(SUBS_CLASS_KEY, String(userId)),
    ]);
  } catch (e) {
    console.error('kv.srem error', e);
  }
}

export default async function handler(req, res) {
  try {
    if (!process.env.BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

    const missing = [];
    if (!process.env.KV_REST_API_URL) missing.push('KV_REST_API_URL');
    if (!process.env.KV_REST_API_TOKEN) missing.push('KV_REST_API_TOKEN');
    if (missing.length) {
      return res.status(200).json({
        ok: false,
        error: 'Missing Vercel KV env vars for local dev',
        missing,
        hint: 'Run: vercel env pull .env.local (then restart vercel dev)',
      });
    }

    // Optional protection: if CRON_SECRET is set, require ?secret=...
    const url = new URL(req.url, `http://${req.headers.host}`);
    const secret = url.searchParams.get('secret');
    const force = url.searchParams.get('force') === '1';
    if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { day, hour, minute } = getGmt5Parts();
    const className = CLASS_SCHEDULE_BY_GMT5_DAY[day];

    // Safety: if someone hits this endpoint at the wrong time/day, skip unless forced
    if (!force) {
      if (!className) {
        return res.status(200).json({ ok: true, skipped: true, reason: 'no class today', day });
      }
      // Allow a small 1-minute window to avoid missing due to small cron delays
      const scheduledMinutes = CLASS_REMINDER_HOUR_GMT5 * 60 + CLASS_REMINDER_MINUTE_GMT5;
      const nowMinutes = hour * 60 + minute;
      if (Math.abs(nowMinutes - scheduledMinutes) > 1) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: 'not scheduled time',
          day,
          hour,
          minute,
        });
      }
    }

    if (!className) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'no class today', day });
    }

    const bot = new Telegraf(process.env.BOT_TOKEN);
    const userIds = (await kv.smembers(SUBS_CLASS_KEY)).map((id) => Number(id));
    const text = `${className} class starts in 5 mins`;

    let sent = 0;
    let removed = 0;
    let failed = 0;

    for (const uid of userIds) {
      try {
        await bot.telegram.sendMessage(uid, text);
        sent += 1;
        await new Promise((r) => setTimeout(r, 50));
      } catch (e) {
        failed += 1;
        const code = e?.response?.error_code;
        const desc = e?.response?.description || e.message;
        console.error('class reminder send error to', uid, code, desc);
        if (String(code) === '403') {
          removed += 1;
          await removeFromAllLists(uid);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      day,
      hour,
      minute,
      className,
      total: userIds.length,
      sent,
      removed,
      failed,
    });
  } catch (err) {
    console.error('class-reminders error:', err?.message || err);
    return res.status(200).json({ ok: false, error: err?.message || 'unknown error' });
  }
}

