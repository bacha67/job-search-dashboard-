'use strict';

const axios    = require('axios');
const { markSeen } = require('../db/store');
const logger       = require('../utils/logger');

// ─── Stage 05: Telegram Router ─────────────────────────────────────────────

function getTelegramUrl() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  return `https://api.telegram.org/bot${token}`;
}

/**
 * Format a scored job into a clean Telegram Markdown message.
 * Uses Telegram MarkdownV2-safe text (*bold*, _italic_).
 * @param {object} job  Scored job object from engine.js
 * @returns {string}
 */
function formatMessage(job) {
  const { title, company, source, sourceUrl, scores, reasons, snapshot } = job;

  // Escape characters that break Telegram Markdown (non-MarkdownV2 mode)
  const esc = (s) => String(s)
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');

  // We use standard Markdown (not V2) to keep it compatible with parse_mode: 'Markdown'
  const safeTitle   = title;
  const safeCompany = company;
  const [snap1, snap2] = snapshot;

  return [
    `🏷️ *JOB HEADER*`,
    `• *Position:* ${safeTitle}`,
    `• *Company:* ${safeCompany}`,
    `• *Source & Link:* [${source}](${sourceUrl})`,
    ``,
    `📝 *OPERATIONAL SNAPSHOT*`,
    `• ${snap1}`,
    `• ${snap2}`,
    ``,
    `📊 *METRIC SCORE ANALYSIS*`,
    `• *Salary Score* [${scores.salary}/10]: ${reasons.salary}`,
    `• *Future Upgrade* [${scores.upgrade}/10]: ${reasons.upgrade}`,
    `• *Skills Gained* [${scores.skills}/10]: ${reasons.skills}`,
    `---`,
  ].join('\n');
}

/**
 * Send a single scored job to the Telegram channel.
 * Marks the job as seen in SQLite after a successful send.
 *
 * @param {object} job     Scored job object
 * @param {boolean} dryRun If true, print to console instead of sending
 */
async function sendJob(job, dryRun = false) {
  const message = formatMessage(job);
  const chatId  = process.env.TELEGRAM_CHAT_ID;

  if (dryRun) {
    logger.info(`[DRY RUN] Would send to ${chatId}:`);
    console.log('\n' + message + '\n');
    markSeen(job.id, job.source, job.title);
    return true;
  }

  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set in .env');

  try {
    const resp = await axios.post(`${getTelegramUrl()}/sendMessage`, {
      chat_id                : chatId,
      text                   : message,
      parse_mode             : 'Markdown',
      disable_web_page_preview: true,
    }, { timeout: 15000 });

    if (resp.data.ok) {
      markSeen(job.id, job.source, job.title);
      logger.ok(`Sent to Telegram: "${job.title}" @ ${job.company}`);
      return true;
    }
    throw new Error(resp.data.description || 'Unknown Telegram error');

  } catch (err) {
    const errData = err.response?.data;

    // Rate limit: wait and retry once
    if (errData?.error_code === 429) {
      const wait = (errData.parameters?.retry_after || 5) * 1000;
      logger.warn(`Telegram rate-limited. Waiting ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return sendJob(job, dryRun);
    }

    // Bad Request: message may have Markdown syntax issue — retry as plain text
    if (errData?.error_code === 400) {
      logger.warn(`Markdown error for "${job.title}", retrying as plain text...`);
      try {
        await axios.post(`${getTelegramUrl()}/sendMessage`, {
          chat_id: chatId,
          text   : message.replace(/[*_`\[]/g, ''),
        }, { timeout: 15000 });
        markSeen(job.id, job.source, job.title);
        return true;
      } catch (e2) { /* fall through */ }
    }

    logger.error(`Failed to send "${job.title}": ${errData?.description || err.message}`);
    return false;
  }
}

/**
 * Send all scored jobs to Telegram, with a 3-second delay between messages
 * to respect Telegram's rate limits (30 messages/second to channels).
 *
 * @param {Array}   jobs
 * @param {boolean} dryRun
 * @returns {number} Count of successfully sent messages
 */
async function sendAll(jobs, dryRun = false) {
  logger.step('🚀', `Routing ${jobs.length} job(s) to Telegram${dryRun ? ' [DRY RUN]' : ''}...`);

  if (jobs.length === 0) {
    logger.info('No new jobs to send this cycle.');
    return 0;
  }

  let sent = 0;
  const INTER_MESSAGE_DELAY = 3000; // 3 seconds between messages

  for (const job of jobs) {
    const ok = await sendJob(job, dryRun);
    if (ok) sent++;
    // Polite delay between messages
    if (jobs.indexOf(job) < jobs.length - 1) {
      await new Promise(r => setTimeout(r, INTER_MESSAGE_DELAY));
    }
  }

  logger.ok(`Telegram routing complete: ${sent}/${jobs.length} messages sent`);
  return sent;
}

module.exports = { sendAll, formatMessage };
