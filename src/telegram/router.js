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

// Helper to escape HTML characters and default to 'Not specified'
function h(val) {
  if (val === null || val === undefined || String(val).trim() === '' || String(val).trim() === 'null') {
    return 'Not specified';
  }
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

function formatTelegramMessage(job) {
  const company = h(job.company);
  const title = h(job.title);
  const location = h(job.location);
  const deadline = h(job.deadline);
  const description = h(job.description);

  // Responsibilities formatting (up to 4 items):
  let respLines = '';
  if (Array.isArray(job.responsibilities) && job.responsibilities.length > 0) {
    respLines = job.responsibilities.slice(0, 4).map(r => `- ${h(r)}`).join('\n');
  } else if (typeof job.responsibilities === 'string' && job.responsibilities.trim().length > 0) {
    const splitResps = job.responsibilities.split(/[.;\n]+/).map(s => s.trim()).filter(s => s.length > 0);
    if (splitResps.length > 0) {
      respLines = splitResps.slice(0, 4).map(r => `- ${h(r)}`).join('\n');
    } else {
      respLines = `- Not specified`;
    }
  } else {
    respLines = `- Not specified`;
  }

  const education = h(job.education);

  // Experience formatting:
  let experienceText = '';
  if (job.experience === null || job.experience === undefined || String(job.experience).trim() === '' || String(job.experience).trim() === 'Not specified') {
    experienceText = 'Not specified';
  } else {
    const isFresh = job.isFreshGradOk === true || String(job.isFreshGradOk).toLowerCase() === 'true';
    experienceText = `${h(job.experience)} years${isFresh ? ' ✅ Fresh Graduate OK!' : ''}`;
  }

  // Skills formatting:
  let skillsStr = 'Not specified';
  if (Array.isArray(job.requirements) && job.requirements.length > 0) {
    skillsStr = job.requirements.map(r => h(r)).join(', ');
  } else if (typeof job.requirements === 'string' && job.requirements.trim().length > 0) {
    skillsStr = h(job.requirements);
  }

  const salary = h(job.salary);

  // How to Apply formatting:
  let applyInfo = 'Not specified';
  const applyUrl = job.applyUrl || '';
  const howToApply = job.howToApply || '';
  const emailMatch = howToApply.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  if (applyUrl && applyUrl.trim().startsWith('http')) {
    applyInfo = `<a href="${h(applyUrl.trim())}">Click here to apply</a>`;
  } else {
    const hasAddress = /sub.?city|kebele|street|avenue|building|bldg|road|office|floor|in.?person/i.test(howToApply);
    if (hasAddress) {
      applyInfo = `${h(howToApply)}\nhttps://maps.google.com/?q=${encodeURIComponent(howToApply.trim())}+Ethiopia`;
    } else if (emailMatch) {
      applyInfo = h(emailMatch[0]);
    } else if (howToApply.trim()) {
      applyInfo = h(howToApply);
    }
  }

  // Score formatting:
  const score = job.score || job.scores || {};
  const totalScore = score.total !== null && score.total !== undefined ? score.total : 'Not specified';
  const salaryScore = score.salary !== null && score.salary !== undefined ? score.salary : 'Not specified';
  const skillsScore = score.skills !== null && score.skills !== undefined ? score.skills : 'Not specified';
  const growthScore = score.growth !== null && score.growth !== undefined ? score.growth : 'Not specified';
  const repScore = score.reputation !== null && score.reputation !== undefined ? score.reputation : 'Not specified';
  const reasonScore = score.reason !== null && score.reason !== undefined ? h(score.reason) : 'Not specified';

  const source = h(job.source || 'EthioJobs');
  const jobUrl = h(job.url || job.sourceUrl || '#');

  return `━━━━━━━━━━━━━━━━━━━━━
🏢 <b>Company:</b> ${company}
💼 <b>Position:</b> ${title}
📍 <b>Location:</b> ${location}
⏰ <b>Deadline:</b> ${deadline}
━━━━━━━━━━━━━━━━━━━━━

📋 <b>About the Role:</b>
${description}

🎯 <b>Your Responsibilities:</b>
${respLines}

📌 <b>Requirements:</b>
- 🎓 Education: ${education}
- 💼 Experience: ${experienceText}
- 🛠 Skills: ${skillsStr}

💰 <b>Salary:</b> ${salary}

🔗 <b>How to Apply:</b>
${applyInfo}

⭐ <b>Job Score: ${totalScore}/10</b>
💰 Salary: ${salaryScore}/4 | 🛠 Skills: ${skillsScore}/3 | 📈 Growth: ${growthScore}/2 | 🏆 Rep: ${repScore}/1
💡 ${reasonScore}

📣 <b>Source:</b> ${source} | <a href="${jobUrl}">View Original</a>
━━━━━━━━━━━━━━━━━━━━━`;
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

module.exports = { sendAll, formatTelegramMessage };
