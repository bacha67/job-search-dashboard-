'use strict';

// Load .env before anything else
require('dotenv').config();

const cron    = require('node-cron');
const { execSync } = require('child_process');
const logger  = require('./utils/logger');
const { ingestAll } = require('./ingestion');
const { sanitize }  = require('./filter/sanitizer');
const { scoreAll }  = require('./scoring/engine');
const { sendAll }   = require('./telegram/router');
const { totalSeen } = require('./db/store');

// ─── Auto-push data to GitHub → GitHub Pages dashboard auto-updates ──────────
function pushDataToGitHub(newJobCount) {
  if (newJobCount === 0) return;

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO || 'bacha67/job-search-dashboard-';

  try {
    // Set remote URL with token so Render (no local git creds) can push
    if (token) {
      execSync(
        `git remote set-url origin https://x-access-token:${token}@github.com/${repo}.git`,
        { cwd: process.cwd(), stdio: 'pipe' }
      );
    }

    execSync('git add docs/data/jobs.json data/jobs.json dashboard/public/data/jobs.json', { cwd: process.cwd(), stdio: 'pipe' });
    execSync(`git commit -m "data: update jobs.json — ${newJobCount} new job(s) [skip ci]"`, { cwd: process.cwd(), stdio: 'pipe' });
    execSync('git push origin main', { cwd: process.cwd(), stdio: 'pipe' });
    logger.ok(`[GitHub] Pushed jobs.json (${newJobCount} new) → GitHub Pages dashboard will update in ~30s`);
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || '').split('\n')[0];
    logger.warn(`[GitHub] Auto-push skipped: ${msg}`);
  }
}

// ─── Parse CLI flags ────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RUN_ONCE = args.includes('--once') || DRY_RUN;

// ─── Pipeline ───────────────────────────────────────────────────────────────
/**
 * Execute the full pipeline:
 *   Ingest → Sanitize → Score → Send
 */
async function runPipeline() {
  const startTime = Date.now();

  logger.step('⚡', '═══════════════════════════════════════════════');
  logger.step('⚡', '  ETHIOPIAN TECH JOB BOT — PIPELINE START');
  logger.step('⚡', '═══════════════════════════════════════════════');

  if (DRY_RUN) {
    logger.warn('Running in DRY RUN mode — no messages will be sent to Telegram');
  }

  try {
    // ── Stage 01: Ingest ────────────────────────────────────────────────
    const raw = await ingestAll();

    // ── Stage 02: Sanitize / Filter ─────────────────────────────────────
    const filtered = sanitize(raw);

    if (filtered.length === 0) {
      logger.info('No new qualifying jobs found this cycle. All done.');
      printStats(startTime);
      return;
    }

    // ── Stage 03: Score ─────────────────────────────────────────────────
    logger.step('🧠', `Scoring ${filtered.length} qualifying job(s)...`);
    const scored = scoreAll(filtered);

    // Sort by combined score (descending) so best jobs send first
    scored.sort((a, b) => {
      const totalA = a.scores.salary + a.scores.upgrade + a.scores.skills;
      const totalB = b.scores.salary + b.scores.upgrade + b.scores.skills;
      return totalB - totalA;
    });

    logger.ok(`Top job this cycle: "${scored[0].title}" @ ${scored[0].company} ` +
      `[S:${scored[0].scores.salary} U:${scored[0].scores.upgrade} K:${scored[0].scores.skills}]`);

    // ── Stage 04: Send to Telegram ───────────────────────────────────────
    const sent = await sendAll(scored, DRY_RUN);

    // ── Stage 05: Push data/jobs.json to GitHub → triggers Vercel redeploy
    if (!DRY_RUN) pushDataToGitHub(sent);

    printStats(startTime, raw.length, filtered.length, sent);
  } catch (err) {
    logger.error(`Pipeline crashed: ${err.message}`);
    logger.error(err.stack);
  }
}

function printStats(startTime, total = 0, filtered = 0, sent = 0) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.step('📈', 'Pipeline Complete');
  logger.dim(`  Total ingested  : ${total}`);
  logger.dim(`  Passed filter   : ${filtered}`);
  logger.dim(`  Sent to channel : ${sent}`);
  logger.dim(`  All-time seen   : ${totalSeen()}`);
  logger.dim(`  Elapsed         : ${elapsed}s`);
  logger.step('⚡', '═══════════════════════════════════════════════\n');
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
if (RUN_ONCE) {
  // --dry-run or --once: run immediately and exit
  runPipeline().then(() => {
    if (!DRY_RUN) process.exit(0);
  });
} else {
  const cronExpression = process.env.SCRAPE_CRON || '0 */6 * * *';

  if (!cron.validate(cronExpression)) {
    logger.error(`Invalid SCRAPE_CRON expression: "${cronExpression}"`);
    process.exit(1);
  }

  logger.step('⏱️', `Scheduler started — cron: "${cronExpression}"`);
  logger.info('Running first pipeline cycle immediately on startup...');

  // Run immediately on startup, then on schedule
  runPipeline();

  cron.schedule(cronExpression, () => {
    logger.step('⏱️', 'Cron tick — starting pipeline...');
    runPipeline();
  });

  logger.info('Bot is running. Press Ctrl+C to stop.\n');
}
