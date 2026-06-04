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
// HTML ESCAPING — HTML parse_mode only needs these 3 entities escaped
// Much simpler than MarkdownV2's 17+ special characters
// ─────────────────────────────────────────────────────────────────────────

function h(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────
// CONTENT BUILDERS
// ─────────────────────────────────────────────────────────────────────────

/** Strip HTML tags and decode entities from scraped HTML */
function clean(text) {
  return (text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Build a 2–3 sentence "About the Role" summary.
 */
function buildAboutRole(job) {
  const desc = clean(job.description || job.descHtml || '');
  if (desc.length > 80) {
    const sentences = desc.match(/[^.!?]+[.!?]+/g) || [];
    const joined = sentences.slice(0, 3).join(' ').trim();
    if (joined.length > 30) return joined;
  }
  // Fallback: describe by title + company
  return `${h(job.title)} role at ${h(job.company)}, based in ${h(job.location || 'Ethiopia')}. ` +
    `This is an entry-level position open to fresh graduates and junior candidates.`;
}

/**
 * Build responsibility bullet points.
 * Uses scraped responsibilities → snapshot → title-based prediction.
 */
function buildResponsibilities(job) {
  // Try scraped responsibilities field
  const raw = clean(job.responsibilities || '');
  if (raw.length > 30) {
    const bullets = raw
      .split(/[.;\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10)
      .slice(0, 5);
    if (bullets.length >= 2) return bullets;
  }

  // Try snapshot[1] (Primary Tasks line)
  const snap1 = clean((job.snapshot || [])[1] || '').replace(/📋\s*Primary Tasks:\s*/i, '');
  if (snap1.length > 20) {
    const bullets = snap1.split(/[.;]+/).map(s => s.trim()).filter(s => s.length > 8).slice(0, 4);
    if (bullets.length >= 2) return bullets;
  }

  // Predict from job title
  const t = (job.title || '').toLowerCase();
  if (t.includes('frontend') || t.includes('react') || t.includes('ui'))
    return ['Build and maintain responsive UI components', 'Integrate REST APIs with frontend interfaces', 'Ensure cross-browser compatibility', 'Collaborate with design and backend teams', 'Write clean, maintainable component code'];
  if (t.includes('backend') || t.includes('node') || t.includes('api'))
    return ['Design and implement RESTful APIs', 'Write server-side business logic', 'Design and optimize database schemas', 'Collaborate with frontend developers', 'Write unit and integration tests'];
  if (t.includes('flutter') || t.includes('mobile') || t.includes('android') || t.includes('ios'))
    return ['Develop cross-platform mobile applications', 'Integrate third-party APIs and services', 'Implement UI from design mockups', 'Debug and optimize app performance', 'Publish and maintain apps on app stores'];
  if (t.includes('fullstack') || t.includes('full stack') || t.includes('full-stack'))
    return ['Build end-to-end web features (frontend + backend)', 'Design database schemas and REST API endpoints', 'Deploy and maintain web applications', 'Write automated tests', 'Collaborate with the product team on requirements'];
  if (t.includes('data analyst') || t.includes('data science'))
    return ['Collect, clean, and analyze large datasets', 'Build dashboards and reports for stakeholders', 'Write SQL queries and automate data pipelines', 'Identify trends and present actionable insights', 'Support data-driven decision making'];
  if (t.includes('devops') || t.includes('cloud') || t.includes('sre'))
    return ['Manage CI/CD pipelines and deployments', 'Monitor infrastructure and application performance', 'Automate operational tasks with scripts', 'Maintain cloud resources (AWS/GCP/Azure)', 'Respond to incidents and implement fixes'];
  if (t.includes('network') || t.includes('sysadmin') || t.includes('system admin'))
    return ['Configure and maintain network infrastructure', 'Monitor server uptime and performance', 'Troubleshoot hardware and connectivity issues', 'Maintain IT asset inventory', 'Document configurations and procedures'];
  if (t.includes('cybersecurity') || t.includes('security'))
    return ['Monitor systems for threats and vulnerabilities', 'Conduct security audits and risk assessments', 'Implement access controls and security policies', 'Respond to security incidents', 'Train staff on cybersecurity best practices'];
  if (t.includes('machine learning') || t.includes('ai') || t.includes('ml'))
    return ['Design and train machine learning models', 'Preprocess and analyze training datasets', 'Evaluate model performance and improve accuracy', 'Deploy models to production environments', 'Research and apply state-of-the-art techniques'];
  // Generic IT
  return [
    'Provide technical support and troubleshoot IT issues',
    'Maintain hardware, software, and network systems',
    'Document processes and create user guides',
    'Assist with system setup and configuration',
    'Collaborate with team members on IT projects',
  ];
}

/**
 * Format the requirements block (Education / Experience / Skills / Other).
 */
function buildRequirements(job) {
  const desc = clean(job.description || '');
  const req  = clean(job.requirements || '');

  // Education
  let education = job.education || '';
  if (!education) {
    if (/master|msc|m\.sc/i.test(desc + req))       education = "Master's degree in CS/IT or related field";
    else if (/bachelor|bsc|b\.sc|degree/i.test(desc + req)) education = "Bachelor's degree in CS/IT or related field";
    else if (/diploma|level iv|level 4/i.test(desc + req))  education = 'Diploma in IT or related field';
    else education = "Bachelor's degree in CS/IT or equivalent";
  }

  // Experience — check for fresh grad signals
  const expRaw = (job.experience || job.workExpName || job.careerLevel || '').toLowerCase();
  const descLower = (desc + req).toLowerCase();
  const isFreshFriendly =
    /fresh|entry.?level|junior|0.?year|no experience|graduate trainee|internship/i.test(expRaw + ' ' + descLower);
  let experience = job.experience || job.workExpName || '';
  if (!experience || experience === 'Entry Level') {
    experience = isFreshFriendly
      ? 'Fresh Graduate / No Experience Required ✅'
      : (job.careerLevel || 'Not specified');
  } else if (isFreshFriendly && !experience.includes('✅')) {
    experience += ' ✅';
  }

  // Skills — from skillsFound array or snapshot
  let skills = '';
  if (job.skillsFound && job.skillsFound.length > 0) {
    skills = job.skillsFound.join(', ');
  } else {
    const snap0 = clean((job.snapshot || [])[0] || '').replace(/🔧\s*Tools & Stack:\s*/i, '');
    skills = snap0 || 'General IT skills';
  }

  // Other requirements (certifications, age, gender, etc.)
  let other = 'Not specified';
  const otherMatch = (desc + ' ' + req).match(
    /(?:certification|certified|license|aged?\s+\d|applicants?.*only|preference.*given)[^.]{0,100}/i
  );
  if (otherMatch) other = otherMatch[0].trim();

  return { education, experience, skills, other };
}

/**
 * Build the "How to Apply" section with Maps link for addresses.
 */
function buildHowToApply(job) {
  const url   = job.sourceUrl   || '';
  const email = job.applyEmail  || '';
  const method = (job.applyMethod || '').toLowerCase();
  const loc   = (job.location   || '').trim();

  const isAddress = /,|sub.?city|kebele|street|avenue|bole|kirkos|yeka|addis|road/i.test(loc);
  const mapsLink  = isAddress
    ? `\n📌 In-person: <a href="https://maps.google.com/?q=${encodeURIComponent(loc + ' Ethiopia')}">Get Directions</a>`
    : '';

  if (email)                     return `📧 <a href="mailto:${h(email)}">${h(email)}</a>${mapsLink}`;
  if (url && url.startsWith('http')) return `🌐 <a href="${h(url)}">Click Here to Apply</a>${mapsLink}`;
  if (method.includes('email'))  return `📧 Apply via email (check job details)${mapsLink}`;
  if (method.includes('url'))    return `🌐 <a href="${h(url || '')}">Apply Online</a>${mapsLink}`;
  if (isAddress)                 return mapsLink.replace('\n📌 ', '');
  return 'Check source portal for application details';
}

/**
 * Format deadline date nicely.
 */
function formatDeadline(deadline) {
  if (!deadline) return 'Not specified';
  try {
    const d = new Date(deadline);
    if (isNaN(d.getTime())) return deadline;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return deadline; }
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN FORMATTER — Telegram HTML parse_mode
// ─────────────────────────────────────────────────────────────────────────

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━';

function formatTelegramMessage(job) {
  const scores = job.scores || {};
  const sal    = scores.salary     || 5;
  const skl    = scores.skills     || 5;
  const grw    = scores.upgrade    || 5;
  const rep    = scores.reputation || 5;
  const total  = scores.total      || parseFloat(((sal + skl + grw) / 3).toFixed(1));

  // Score bar (filled dots per score /10)
  const scoreBar = total >= 8 ? '🟢🟢🟢🟢🟢' :
                   total >= 6 ? '🟢🟢🟢🟡⚪' :
                   total >= 4 ? '🟢🟢🟡⚪⚪' : '🟢🟡⚪⚪⚪';

  const about        = buildAboutRole(job);
  const bullets      = buildResponsibilities(job);
  const { education, experience, skills, other } = buildRequirements(job);
  const howToApply   = buildHowToApply(job);
  const deadline     = formatDeadline(job.deadline);
  const salary       = job.salary ? h(String(job.salary)) : 'Not disclosed';

  // Score breakdown line
  const scoreDetail = scores.total
    ? `💰 ${((sal/10)*4).toFixed(1)}/4 · 🛠 ${((skl/10)*3).toFixed(1)}/3 · 📈 ${((grw/10)*2).toFixed(1)}/2 · 🏆 ${((rep/10)*1).toFixed(1)}/1`
    : '';

  const lines = [
    DIVIDER,
    `🏢 <b>Company:</b> ${h(job.company)}`,
    `💼 <b>Position:</b> ${h(job.title)}`,
    `📍 <b>Location:</b> ${h(job.location || 'Ethiopia')}`,
    `⏰ <b>Deadline:</b> ${h(deadline)}`,
    DIVIDER,
    ``,
    `📋 <b>About the Role:</b>`,
    h(about),
    ``,
    `🎯 <b>Your Responsibilities:</b>`,
    ...bullets.map(b => `• ${h(b)}`),
    ``,
    `📌 <b>Requirements:</b>`,
    `- <b>Education:</b> ${h(education)}`,
    `- <b>Experience:</b> ${h(experience)}`,
    `- <b>Skills:</b> ${h(skills)}`,
    `- <b>Other:</b> ${h(other)}`,
    ``,
    `💰 <b>Salary:</b> ${salary}`,
    ``,
    `🔗 <b>How to Apply:</b>`,
    howToApply,
    ``,
    `⭐ <b>Job Score: ${total}/10</b>  ${scoreBar}`,
    scoreDetail ? scoreDetail : '',
    ``,
    `📣 <b>Source:</b> ${h(job.source || 'EthioJobs')} | @Ethio_Fresh_Jobs`,
    DIVIDER,
  ].filter(line => line !== null);

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

    // Rate limit → wait retry_after seconds, then retry once
    if (errData?.error_code === 429) {
      const wait = (errData.parameters?.retry_after || 5) * 1000;
      logger.warn(`Telegram rate-limited. Waiting ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
      return sendJob(job, dryRun);
    }

    // HTML parse error → retry as plain text fallback
    if (errData?.error_code === 400) {
      logger.warn(`HTML parse error for "${job.title}", retrying as plain text…`);
      try {
        const plain = message.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
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
 * Send all scored jobs to Telegram with delay between posts.
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
