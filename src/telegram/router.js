'use strict';

const axios        = require('axios');
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
// MARKDOWNV2 ESCAPING
// Required characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
// ─────────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!')
    .replace(/\|/g, '\\|')
    .replace(/-/g, '\\-')
    .replace(/\+/g, '\\+')
    .replace(/=/g, '\\=')
    .replace(/>/g, '\\>')
    .replace(/</g, '\\<')
    .replace(/~/g, '\\~')
    .replace(/#/g, '\\#')
    .replace(/\{/g, '\\{').replace(/\}/g, '\\}')
    .replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .trim();
}

// Escape only the URL-unsafe chars for inline links — parentheses only
function escUrl(url) {
  return String(url || '').replace(/\)/g, '%29');
}

// ─────────────────────────────────────────────────────────────────────────
// CONTENT EXTRACTORS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a 2–3 sentence description paragraph from snapshot + job fields.
 */
function buildDescription(job) {
  const desc = (job.description || '').replace(/<[^>]+>/g, ' ').trim();
  // Use first ~350 chars of description if available
  if (desc.length > 80) {
    const sentences = desc.match(/[^.!?]+[.!?]+/g) || [];
    return sentences.slice(0, 3).join(' ').trim() || desc.slice(0, 300) + '…';
  }
  // Fall back to snapshot[0] (Tools & Stack line)
  const snap0 = ((job.snapshot || [])[0] || '')
    .replace(/🔧 \*Tools & Stack:\* /i, '')
    .replace(/[*_]/g, '').trim();
  return snap0 || `${job.title} role at ${job.company} in ${job.location || 'Ethiopia'}.`;
}

/**
 * Extract 3–4 role responsibilities from snapshot or predict from job title.
 */
function buildRoleBullets(job) {
  const snap1 = ((job.snapshot || [])[1] || '')
    .replace(/📋 \*Primary Tasks:\* /i, '')
    .replace(/[*_]/g, '').trim();

  if (snap1 && snap1.length > 20) {
    // Split by period or semicolon to get individual duties
    const tasks = snap1.split(/[.;]+/).map(s => s.trim()).filter(s => s.length > 8);
    if (tasks.length >= 2) return tasks.slice(0, 4);
  }

  // Predict from job title keywords
  const t = (job.title || '').toLowerCase();
  if (t.includes('frontend') || t.includes('react'))
    return ['Build and maintain React UI components', 'Collaborate with backend developers on API integration', 'Ensure cross-browser compatibility and responsiveness', 'Write clean, reusable component code'];
  if (t.includes('backend') || t.includes('node') || t.includes('python'))
    return ['Design and implement RESTful APIs', 'Write server-side logic and database queries', 'Collaborate with frontend developers on integration', 'Maintain and optimize existing backend services'];
  if (t.includes('flutter') || t.includes('mobile') || t.includes('android'))
    return ['Develop cross-platform mobile applications', 'Integrate REST APIs and third-party services', 'Implement UI screens from design mockups', 'Debug and optimize app performance'];
  if (t.includes('full') || t.includes('fullstack'))
    return ['Build end-to-end web features (frontend + backend)', 'Design database schemas and API endpoints', 'Deploy and maintain web applications', 'Collaborate with product team on requirements'];
  if (t.includes('data') || t.includes('analyst'))
    return ['Collect, clean, and analyze datasets', 'Build dashboards and reports for stakeholders', 'Write SQL queries and automate data pipelines', 'Present insights to non-technical audiences'];
  if (t.includes('network') || t.includes('sysadmin') || t.includes('system admin'))
    return ['Configure and maintain network infrastructure', 'Monitor server uptime and performance metrics', 'Troubleshoot connectivity and hardware issues', 'Maintain IT asset inventory and documentation'];
  if (t.includes('cybersecurity') || t.includes('security'))
    return ['Monitor systems for vulnerabilities and threats', 'Conduct security audits and penetration tests', 'Implement security policies and access controls', 'Respond to security incidents and alerts'];
  // Generic IT
  return [
    'Provide technical support and troubleshoot IT issues',
    'Maintain hardware, software, and network systems',
    'Document processes and create user guides',
    'Collaborate with team members on IT projects',
  ];
}

/**
 * Extract requirements from description or return a default.
 */
function buildRequirements(job) {
  const text = (job.description || '').toLowerCase();
  // Look for a requirements / qualifications section
  const reqMatch = text.match(/(?:requirements?|qualifications?|we need|must have|minimum)[:\s]+([^]+?)(?:\n\n|apply|deadline|how to)/i);
  if (reqMatch) {
    return reqMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 300);
  }
  // Check career level / degree signals
  if (text.includes('bachelor') || text.includes('degree')) {
    return 'Bachelor\'s degree in Computer Science, IT, or related field. Fresh graduates welcome.';
  }
  return 'Not specified \u2014 likely needs CS/IT degree or equivalent. Fresh graduates encouraged to apply.';
}

/**
 * Build the "How to Apply" section.
 * Shows clickable URL + Google Maps link for in-person addresses.
 */
function buildApplySection(job) {
  const url  = job.sourceUrl || '';
  const loc  = (job.location || '').trim();

  // Looks like an actual street address (has comma or "st." or "sub-city" etc.)
  const isAddress = /,|sub.?city|kebele|street|avenue|bole|kirkos|yeka|addis/i.test(loc);

  if (url) {
    const mapsLink = isAddress
      ? `\nIn\\-person: [${esc(loc)}](https://maps.google.com/?q=${encodeURIComponent(loc)})`
      : '';
    return `[Click to Apply](${escUrl(url)})${mapsLink}`;
  }
  if (isAddress) {
    return `In\\-person at: [${esc(loc)}](https://maps.google.com/?q=${encodeURIComponent(loc)})`;
  }
  return 'Check the source portal for application details\\.';
}

// ─────────────────────────────────────────────────────────────────────────
// MESSAGE FORMATTER — MarkdownV2
// ─────────────────────────────────────────────────────────────────────────

/**
 * Format a scored job into the new clean MarkdownV2 Telegram message.
 */
function formatTelegramMessage(job) {
  const { title, company, source, scores, snapshot } = job;

  // Scores (out of 10 each)
  const sal  = scores?.salary     || 5;
  const skl  = scores?.skills     || 5;
  const grw  = scores?.upgrade    || 5;
  const rep  = scores?.reputation || 5;
  const tot  = scores?.total      || parseFloat(((sal + skl + grw) / 3).toFixed(1));

  // Map 0–10 scores to weighted sub-scores for display
  const salDisplay = ((sal / 10) * 4).toFixed(1);   // /4
  const sklDisplay = ((skl / 10) * 3).toFixed(1);   // /3
  const grwDisplay = ((grw / 10) * 2).toFixed(1);   // /2
  const repDisplay = ((rep / 10) * 1).toFixed(1);   // /1

  const description  = buildDescription(job);
  const roleBullets  = buildRoleBullets(job);
  const requirements = buildRequirements(job);
  const applySection = buildApplySection(job);

  const bulletLines = roleBullets
    .map(b => `• ${esc(b)}`)
    .join('\n');

  const lines = [
    `🏢 *${esc(company)}*`,
    `💼 *${esc(title)}*`,
    ``,
    `📋 *Description:*`,
    esc(description),
    ``,
    `🎯 *Your Role:*`,
    bulletLines,
    ``,
    `📌 *Requirements:*`,
    esc(requirements),
    ``,
    `🔗 *Source:* ${esc(source)}`,
    ``,
    `📍 *How to Apply:*`,
    applySection,
    ``,
    `⭐ *Job Rating: ${esc(String(tot))}/10*`,
    `💰 Salary: ${esc(salDisplay)}/4 \\| 🛠 Skills: ${esc(sklDisplay)}/3 \\| 📈 Growth: ${esc(grwDisplay)}/2 \\| 🏆 Reputation: ${esc(repDisplay)}/1`,
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// SENDER
// ─────────────────────────────────────────────────────────────────────────

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
    jsonEgress.appendJobs([job]);
    return true;
  }

  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set in .env');

  try {
    const resp = await axios.post(`${getTelegramUrl()}/sendMessage`, {
      chat_id                  : chatId,
      text                     : message,
      parse_mode               : 'MarkdownV2',
      disable_web_page_preview : false,   // allow link preview for apply URL
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

    // Rate limit → wait for retry_after seconds then retry once
    if (errData?.error_code === 429) {
      const wait = (errData.parameters?.retry_after || 5) * 1000;
      logger.warn(`Telegram rate-limited. Waiting ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      return sendJob(job, dryRun);
    }

    // MarkdownV2 parse error → retry as plain text fallback
    if (errData?.error_code === 400) {
      logger.warn(`MarkdownV2 parse error for "${job.title}", retrying as plain text…`);
      try {
        const plain = message.replace(/\\(.)/g, '$1').replace(/[*_`[\]()~>#+=|{}.!-]/g, '');
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
  logger.step('🚀', `Routing ${jobs.length} job(s) to Telegram${dryRun ? ' [DRY RUN]' : ''}…`);

  if (jobs.length === 0) {
    logger.info('No new jobs to send this cycle.');
    return 0;
  }

  let sent = 0;
  // 3s delay — more conservative than Claude's 2s, avoids Telegram rate-limit (30msg/s for channels)
  const DELAY = 3000;

  for (let i = 0; i < jobs.length; i++) {
    const ok = await sendJob(jobs[i], dryRun);
    if (ok) sent++;
    if (i < jobs.length - 1) await new Promise(r => setTimeout(r, DELAY));
  }

  logger.ok(`Telegram routing complete: ${sent}/${jobs.length} messages sent`);
  return sent;
}

module.exports = { sendAll, formatTelegramMessage };
