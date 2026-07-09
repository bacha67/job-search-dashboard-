'use strict';

const axios        = require('axios');
const { markSeen } = require('../db/store');
const jsonEgress   = require('../output/jsonEgress');
const logger       = require('../utils/logger');

function getTelegramUrl() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  return `https://api.telegram.org/bot${token}`;
}

// Escape HTML special characters; returns null for missing/empty values
function h(val) {
  if (val === null || val === undefined || String(val).trim() === '' || String(val).trim() === 'null') {
    return null;
  }
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

function formatTelegramMessage(job) {
  const company     = h(job.company);
  const title       = h(job.title);
  const location    = h(job.location);
  const deadline    = h(job.deadline);
  const description = h(job.description);

  // ── Responsibilities (up to 4 items, skip section if none) ──────────────
  let respBlock = null;
  if (Array.isArray(job.responsibilities) && job.responsibilities.length > 0) {
    const lines = job.responsibilities.slice(0, 4).map(r => `- ${h(r) || r}`).join('\n');
    respBlock = `✅ <b>Key Responsibilities:</b>\n${lines}`;
  } else if (typeof job.responsibilities === 'string' && job.responsibilities.trim().length > 0) {
    const parts = job.responsibilities.split(/[.;\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 4);
    if (parts.length > 0) {
      respBlock = `✅ <b>Key Responsibilities:</b>\n${parts.map(r => `- ${h(r) || r}`).join('\n')}`;
    }
  }

  // ── How to Apply ─────────────────────────────────────────────────────────
  const rawApplyUrl   = (job.applyUrl   || '').trim();
  const rawHowToApply = (job.howToApply || '').trim();
  const isAddress     = /sub.?city|kebele|street|avenue|building|bldg|road|office|floor|in.?person/i.test(rawHowToApply);

  let applyLine      = null;
  let directionsLine = null;

  if (rawApplyUrl.startsWith('http')) {
    applyLine = `🔗 <b><a href="${rawApplyUrl}">👉 APPLY NOW</a></b>`;
  } else if (rawHowToApply) {
    applyLine = `📨 <b>Apply via:</b> ${h(rawHowToApply) || rawHowToApply}`;
    if (isAddress) {
      directionsLine = `🗺 <a href="https://maps.google.com/?q=${encodeURIComponent(rawHowToApply)}+Ethiopia">📍 Get Directions</a>`;
    }
  }

  const jobUrl = h(job.url || job.sourceUrl) || '#';

    respBlock   ? respBlock.trim()                              : null,
    '',
    `🔗 <b>How to Apply:</b>\n${applyBlock}`,
    '',
    `📣 <a href="${jobUrl}">View Full Job Post</a> | @Ethio_Fresh_Jobs`,
    '━━━━━━━━━━━━━━━━━━━━━',
  ].filter(line => line !== null).join('\n');

  return lines;
}

async function sendJob(job, dryRun = false) {
  const message = formatTelegramMessage(job);
  const chatId  = process.env.TELEGRAM_CHAT_ID;

  if (dryRun) {
    logger.info(`[DRY RUN] Would send to ${chatId}:`);
    console.log('\n' + message + '\n');
    markSeen(job.id, job.source, job.title);
    jsonEgress.appendJobs([job]);
    return true;
  }

  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set in .env');

  try {
    const resp = await axios.post(`${getTelegramUrl()}/sendMessage`, {
      chat_id                  : chatId,
      text                     : message,
      parse_mode               : 'HTML',
      disable_web_page_preview : true,
    }, { timeout: 15000 });

    if (resp.data.ok) {
      markSeen(job.id, job.source, job.title);
      jsonEgress.appendJobs([job]);
      logger.ok(`Sent: "${job.title}" @ ${job.company} → ${chatId}`);
      return true;
    }
    throw new Error(resp.data.description || 'Unknown Telegram error');

  } catch (err) {
    const errData = err.response?.data;

    // Rate limit → wait retry_after seconds then retry once
    if (errData?.error_code === 429) {
      const wait = (errData.parameters?.retry_after || 5) * 1000;
      logger.warn(`Telegram rate-limited. Waiting ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      return sendJob(job, dryRun);
    }

    // HTML parse error → retry as stripped plain text
    if (errData?.error_code === 400) {
      logger.warn(`HTML parse error for "${job.title}", retrying as plain text…`);
      try {
        const plain = message
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        await axios.post(`${getTelegramUrl()}/sendMessage`, {
          chat_id: chatId, text: plain,
        }, { timeout: 15000 });
        markSeen(job.id, job.source, job.title);
        jsonEgress.appendJobs([job]);
        return true;
      } catch (e2) { /* fall through */ }
    }

    logger.error(`Failed to send "${job.title}": ${errData?.description || err.message}`);
    return false;
  }
}

async function sendAll(jobs, dryRun = false) {
  logger.step('🚀', `Routing ${jobs.length} job(s) to Telegram${dryRun ? ' [DRY RUN]' : ''}…`);

  if (jobs.length === 0) {
    logger.info('No new jobs to send this cycle.');
    return 0;
  }

  let sent = 0;
  const DELAY = 2000; // 2s between messages

  for (let i = 0; i < jobs.length; i++) {
    const ok = await sendJob(jobs[i], dryRun);
    if (ok) sent++;
    if (i < jobs.length - 1) await new Promise(r => setTimeout(r, DELAY));
  }

  logger.ok(`Telegram routing complete: ${sent}/${jobs.length} messages sent`);
  return sent;
}

module.exports = { sendAll };
