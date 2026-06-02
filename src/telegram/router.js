'use strict';

const axios      = require('axios');
const { markSeen } = require('../db/store');
const jsonEgress   = require('../output/jsonEgress');
const logger       = require('../utils/logger');

// ─── Stage 05: Telegram Router + JSON Egress ───────────────────────────────

function getTelegramUrl() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  return `https://api.telegram.org/bot${token}`;
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGE FORMATTER — exactly matching user-specified CRITICAL PIPELINE spec
// Uses Telegram standard Markdown (* bold, _ italic)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Safe-escape for Telegram Markdown (non-V2).
 * Escapes characters that break formatting without using MarkdownV2 syntax.
 */
function esc(s) {
  return String(s || '')
    .replace(/\*/g, '')   // remove stray asterisks
    .replace(/_/g, '')    // remove stray underscores that break italic
    .replace(/`/g, "'")   // backtick → single quote
    .trim();
}

/**
 * Format a scored job into the CRITICAL PIPELINE Telegram Markdown payload.
 *
 * OUTPUT 1: TELEGRAM MARKDOWN PAYLOAD
 */
function formatTelegramMessage(job) {
  const { title, company, source, sourceUrl, scores, reasons, snapshot } = job;
  const [snap1, snap2] = snapshot || ['', ''];

  return [
    `🏷️ *JOB HEADER*`,
    `• *Position:* ${esc(title)}`,
    `• *Company:* ${esc(company)}`,
    `• *Source Platform:* ${esc(source)}`,
    `• *Direct Application Link:* [Apply Here](${sourceUrl})`,
    ``,
    `📝 *OPERATIONAL SNAPSHOT*`,
    `• ${esc(snap1)}`,
    `• ${esc(snap2)}`,
    ``,
    `📊 *METRIC SCORE ANALYSIS*`,
    `• *Salary Score* [${scores.salary}/10]: ${esc(reasons.salary)}`,
    `• *Future Upgrade* [${scores.upgrade}/10]: ${esc(reasons.upgrade)}`,
    `• *Skills Gained* [${scores.skills}/10]: ${esc(reasons.skills)}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

/**
 * Send a single scored job to Telegram channel.
 * On success: marks as seen in SQLite + writes to JSON egress.
 */
async function sendJob(job, dryRun = false) {
  const message = formatTelegramMessage(job);
  const chatId  = process.env.TELEGRAM_CHAT_ID;

  if (dryRun) {
    logger.info(`[DRY RUN] Would send to ${chatId}:`);
    console.log('\n' + message + '\n');
    markSeen(job.id, job.source, job.title);
    // Also write to JSON egress in dry-run so dashboard data is populated
    jsonEgress.appendJobs([job]);
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
      // OUTPUT 2: Write to dashboard JSON egress
      jsonEgress.appendJobs([job]);
      logger.ok(`Sent: "${job.title}" @ ${job.company} → ${chatId}`);
      return true;
    }
    throw new Error(resp.data.description || 'Unknown Telegram error');

  } catch (err) {
    const errData = err.response?.data;

    // Rate limit → wait and retry once
    if (errData?.error_code === 429) {
      const wait = (errData.parameters?.retry_after || 5) * 1000;
      logger.warn(`Telegram rate-limited. Waiting ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return sendJob(job, dryRun);
    }

    // Bad Markdown → retry as plain text fallback
    if (errData?.error_code === 400) {
      logger.warn(`Markdown parse error for "${job.title}", retrying as plain text...`);
      try {
        const plain = message.replace(/[*_`\[\]()]/g, '');
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
 * Send all scored jobs to Telegram with polite delay between posts.
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
  const DELAY = 3000; // 3s between messages (Telegram rate: 30 msg/s for channels)

  for (let i = 0; i < jobs.length; i++) {
    const ok = await sendJob(jobs[i], dryRun);
    if (ok) sent++;
    if (i < jobs.length - 1) await new Promise(r => setTimeout(r, DELAY));
  }

  logger.ok(`Telegram routing complete: ${sent}/${jobs.length} messages sent`);
  return sent;
}

module.exports = { sendAll, formatTelegramMessage };
