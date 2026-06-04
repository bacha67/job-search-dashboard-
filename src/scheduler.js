'use strict';

// Load .env before anything else
require('dotenv').config();

const cron    = require('node-cron');
const { execSync } = require('child_process');
const logger  = require('./utils/logger');
const { ingestAll }      = require('./ingestion');
const { sanitize }       = require('./filter/sanitizer');
const { scoreAll }       = require('./scoring/engine');
const { sendAll }        = require('./telegram/router');
const { totalSeen }      = require('./db/store');
const { processAllJobs } = require('./ai/gemini');

// ─── Auto-push data to GitHub → GitHub Pages dashboard auto-updates ──────────
function pushDataToGitHub(newJobCount) {
  if (newJobCount === 0) return;

  // In GitHub Actions CI, the workflow handles git commit/push — skip here
  if (process.env.CI) {
    logger.dim('[GitHub] Running in CI — git push handled by workflow step');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO || 'bacha67/job-search-dashboard-';

  try {
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

    // ── Stage 02: Sanitize / Filter (fast keyword pre-filter) ────────────
    const filtered = sanitize(raw);

    if (filtered.length === 0) {
      logger.info('No new qualifying jobs found this cycle. All done.');
      printStats(startTime);
      return;
    }

    // ── Stage 03: AI or Heuristic scoring ───────────────────────────────
    let scored;
    const hasGemini = !!process.env.GEMINI_API_KEY;

    if (hasGemini) {
      // Gemini AI: extracts fields, validates isITJob + isFreshGradOk, scores
      logger.step('🤖', `Gemini AI processing ${filtered.length} pre-filtered job(s)...`);
      scored = await processAllJobs(filtered);

      if (scored.length === 0) {
        logger.info('Gemini found no qualifying IT/entry-level jobs this cycle.');
        printStats(startTime, raw.length, filtered.length, 0, 0);
        return;
      }
    } else {
      // Fallback: keyword-based heuristic scoring (no API key needed)
      logger.step('🧠', `Scoring ${filtered.length} qualifying job(s) (heuristic mode)...`);
      scored = scoreAll(filtered);
    }

    // Sort best jobs first
    scored.sort((a, b) => {
      const totA = a.scores?.total ?? (a.scores?.salary + a.scores?.upgrade + a.scores?.skills);
      const totB = b.scores?.total ?? (b.scores?.salary + b.scores?.upgrade + b.scores?.skills);
      return totB - totA;
    });

    logger.ok(
      `Top job: "${scored[0].title}" @ ${scored[0].company} ` +
      `[score: ${scored[0].scores?.total ?? '?'}/10]`
    );

    // ── Stage 04: Send to Telegram ───────────────────────────────────────
    const sent = await sendAll(scored, DRY_RUN);

    // ── Stage 05: Push data/jobs.json to GitHub → triggers dashboard update
    if (!DRY_RUN) pushDataToGitHub(sent);

    printStats(startTime, raw.length, filtered.length, scored.length, sent);
  } catch (err) {
    logger.error(`Pipeline crashed: ${err.message}`);
    logger.error(err.stack);
  }
}

function printStats(startTime, total = 0, filtered = 0, aiQualified = 0, sent = 0) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const hasGemini = !!process.env.GEMINI_API_KEY;
  logger.step('📈', 'Pipeline Complete');
  logger.dim(`  Total ingested  : ${total}`);
  logger.dim(`  Passed filter   : ${filtered}`);
  if (hasGemini) logger.dim(`  AI qualified    : ${aiQualified}`);
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

  // ── Health-check HTTP server (required by Koyeb / cloud hosting platforms) ─
  // Koyeb expects a web service listening on PORT. This tiny server satisfies
  // that requirement while the real cron work runs alongside it.
  const http = require('http');
  const PORT = process.env.PORT || 3000;

  let lastRun   = null;
  let cycleCount = 0;

  const healthServer = http.createServer((req, res) => {
    const status = {
      status    : 'ok',
      bot       : 'Ethiopian Tech Job Bot',
      channel   : process.env.TELEGRAM_CHAT_ID || '@Ethio_Fresh_Jobs',
      cron      : cronExpression,
      lastRun   : lastRun,
      cycles    : cycleCount,
      uptime    : Math.floor(process.uptime()) + 's',
      timestamp : new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  });

  healthServer.listen(PORT, () => {
    logger.ok(`Health server running on port ${PORT} (Koyeb keepalive)`);
  });

  // Patch runPipeline to track cycle stats
  const _originalRun = runPipeline;
  async function runPipelineTracked() {
    cycleCount++;
    lastRun = new Date().toISOString();
    return _originalRun();
  }

  logger.step('⏱️', `Scheduler started — cron: "${cronExpression}"`);
  logger.info('Running first pipeline cycle immediately on startup...');

  // Run immediately on startup, then on schedule
  runPipelineTracked();

  cron.schedule(cronExpression, () => {
    logger.step('⏱️', 'Cron tick — starting pipeline...');
    runPipelineTracked();
  });

  logger.info('Bot is running. Press Ctrl+C to stop.\n');
}
