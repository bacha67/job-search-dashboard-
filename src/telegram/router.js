'use strict';

const axios        = require('axios');
const { markSeen } = require('../db/store');
const jsonEgress   = require('../output/jsonEgress');
const logger       = require('../utils/logger');

// ─── Stage 04: Telegram Router ────────────────────────────────────────────────
// Formats Gemini-processed job objects into HTML messages and sends them.
// All content fields (description, responsibilities, requirements, score.reason)
// come pre-extracted from Gemini — no builders or parsers needed here.

function getTelegramUrl() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  return `https://api.telegram.org/bot${token}`;
}

// ─────────────────────────────────────────────────────────────────────────
// HTML ESCAPING — only 3 entities needed for Telegram HTML parse_mode
// ─────────────────────────────────────────────────────────────────────────

function h(s) {
  return String(s ?? 'Not specified')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────
// FORMATTER — uses Gemini fields directly (no parsing/prediction needed)
// ─────────────────────────────────────────────────────────────────────────

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━';

function formatTelegramMessage(job) {
  const score = job.score || job.scores || {};

  // ── Header fields ──────────────────────────────────────────────────────
  const company  = h(job.company);
  const title    = h(job.title);
  const location = h(job.location || 'Ethiopia');
  const deadline = h(job.deadline || 'Not specified');

  // ── Description (2-3 sentences from Gemini) ───────────────────────────
  const description = h(job.description || 'No description available.');

  // ── Responsibilities (Gemini array → bullet list) ─────────────────────
  const responsibilities = Array.isArray(job.responsibilities) && job.responsibilities.length > 0
    ? job.responsibilities
    : (typeof job.responsibilities === 'string' && job.responsibilities
        ? job.responsibilities.split(/[.;]+/).filter(s => s.trim().length > 8)
        : ['Check job posting for full details']);

  const responsibilityLines = responsibilities
    .slice(0, 5)
    .map(r => `- ${h(r)}`)
    .join('\n');

  // ── Requirements section ───────────────────────────────────────────────
  const education  = h(job.education  || 'Not specified');

  // Experience: show years + ✅ badge if fresh grad ok
  const expRaw     = String(job.experience ?? 'Not specified');
  const freshBadge = job.isFreshGradOk ? ' ✅ <b>Fresh Graduate OK!</b>' : '';
  const experience = h(expRaw) + freshBadge;

  // Skills: pull from requirements array (Gemini provides these)
  const reqArray = Array.isArray(job.requirements) ? job.requirements : [];
  const skills   = reqArray.length > 0
    ? reqArray.slice(0, 5).map(r => h(r)).join(', ')
    : 'See job posting for details';

  // ── Salary ────────────────────────────────────────────────────────────
  const salary = h(job.salary || 'Not disclosed');

  // ── How to Apply ──────────────────────────────────────────────────────
  let howToApply;
  const applyUrl = job.applyUrl || job.sourceUrl || job.url || '';
  const applyRaw = job.howToApply || '';
  const loc      = (job.location || '').trim();

  // Check if location looks like a physical address (comma, sub-city, street, etc.)
  const isAddress = /,|sub.?city|kebele|street|avenue|bole|kirkos|yeka|addis|road/i.test(loc);

  if (applyUrl && applyUrl.startsWith('http')) {
    howToApply = `🌐 <a href="${h(applyUrl)}">Click Here to Apply</a>`;
    if (isAddress) {
      howToApply += `\n📌 In-person: <a href="https://maps.google.com/?q=${encodeURIComponent(loc + ' Ethiopia')}">Get Directions</a>`;
    }
  } else if (applyRaw.includes('@')) {
    // Email address
    howToApply = `📧 <a href="mailto:${h(applyRaw)}">${h(applyRaw)}</a>`;
  } else if (isAddress) {
    howToApply = `📌 In-person: <a href="https://maps.google.com/?q=${encodeURIComponent(loc + ' Ethiopia')}">${h(loc)}</a>`;
  } else {
    howToApply = h(applyRaw || 'Check the source portal for application details');
  }

  // ── Score breakdown ───────────────────────────────────────────────────
  // Gemini returns score.salary (0-4), score.skills (0-3),
  //                  score.growth (0-2), score.reputation (0-1), score.total (0-10)
  const total      = score.total      ?? '?';
  const salScore   = score.salary     ?? score.sal ?? '-';
  const sklScore   = score.skills     ?? score.skl ?? '-';
  const grwScore   = score.growth     ?? score.upgrade ?? '-';
  const repScore   = score.reputation ?? score.rep ?? '-';
  const reason     = h(score.reason   || '');

  // Visual score bar
  const scoreBar = typeof total === 'number'
    ? (total >= 8 ? '🟢🟢🟢🟢🟢' :
       total >= 6 ? '🟢🟢🟢🟡⚪' :
       total >= 4 ? '🟢🟢🟡⚪⚪' : '🟢🟡⚪⚪⚪')
    : '';

  const source = h(job.source || 'EthioJobs');

  // ── Assemble message ───────────────────────────────────────────────────
  const lines = [
    DIVIDER,
    `🏢 <b>Company:</b> ${company}`,
    `💼 <b>Position:</b> ${title}`,
    `📍 <b>Location:</b> ${location}`,
    `⏰ <b>Deadline:</b> ${deadline}`,
    DIVIDER,
    ``,
    `📋 <b>About the Role:</b>`,
    description,
    ``,
    `🎯 <b>Your Responsibilities:</b>`,
    responsibilityLines,
    ``,
    `📌 <b>Requirements:</b>`,
    `- 🎓 Education: ${education}`,
    `- 💼 Experience: ${experience}`,
    `- 🛠 Skills: ${skills}`,
    ``,
    `💰 <b>Salary:</b> ${salary}`,
    ``,
    `🔗 <b>How to Apply:</b>`,
    howToApply,
    ``,
    `⭐ <b>Job Score: ${total}/10</b>  ${scoreBar}`,
    `💰 ${salScore}/4 | 🛠 ${sklScore}/3 | 📈 ${grwScore}/2 | 🏆 ${repScore}/1`,
    reason ? `💡 ${reason}` : '',
    ``,
    `📣 <b>Source:</b> ${source} | @Ethio_Fresh_Jobs`,
    DIVIDER,
  ].filter(line => line !== null && line !== undefined);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// SENDER
// ─────────────────────────────────────────────────────────────────────────

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

/**
 * Send all jobs to Telegram with 2 second delay between messages.
 * @param {Array}   jobs    — Gemini-processed job objects
 * @param {boolean} dryRun
 * @returns {number}        Count of successfully sent messages
 */
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

module.exports = { sendAll, formatTelegramMessage };
