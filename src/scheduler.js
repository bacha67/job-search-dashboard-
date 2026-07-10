'use strict';

// Load .env before anything else
require('dotenv').config();

const cron         = require('node-cron');
const { execSync } = require('child_process');
const logger       = require('./utils/logger');

// ── Imports ──────────────────────────────────────────────────────────────────
const { ingestAll }      = require('./ingestion');          // all 7 scrapers in parallel
const { scrapeEthioJobs} = require('./scrapers/ethiojobs'); // Ethiojobs only (alias)
const { sanitize }       = require('./filter/sanitizer');   // fast keyword pre-filter
const { scoreAll }       = require('./scoring/engine');      // heuristic fallback scorer
const { processAllJobs } = require('./ai/groq');          // Groq AI stage (LLaMA 3.3 70B)
const { sendAll }        = require('./telegram/router');     // Telegram sender
const { writeJobsJson }  = require('./output/jsonEgress');  // dashboard JSON writer
const { totalSeen }      = require('./db/store');

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const RUN_ONCE = args.includes('--once') || DRY_RUN;
// --ethio-only: use only Ethiojobs scraper instead of all 7 scrapers
const ETHIO_ONLY = args.includes('--ethio-only');

// ── Auto-push to GitHub → GitHub Pages dashboard auto-updates ────────────────
function pushDataToGitHub(newJobCount) {
  if (newJobCount === 0) return;
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
    execSync('git add docs/data/jobs.json data/jobs.json', { cwd: process.cwd(), stdio: 'pipe' });
    execSync(`git commit -m "data: update jobs.json — ${newJobCount} new job(s) [skip ci]"`, { cwd: process.cwd(), stdio: 'pipe' });
    execSync('git push origin main', { cwd: process.cwd(), stdio: 'pipe' });
    logger.ok(`[GitHub] Pushed jobs.json (${newJobCount} new) → dashboard updates in ~30s`);
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || '').split('\n')[0];
    logger.warn(`[GitHub] Auto-push skipped: ${msg}`);
  }
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────
async function runPipeline() {
  const startTime = Date.now();

  logger.step('⚡', '═══════════════════════════════════════════════');
  logger.step('⚡', '  ETHIOPIAN TECH JOB BOT — PIPELINE START');
  logger.step('⚡', '═══════════════════════════════════════════════');
  if (DRY_RUN)    logger.warn('DRY RUN — no Telegram messages will be sent');
  if (ETHIO_ONLY) logger.warn('ETHIO ONLY — using single scraper (Ethiojobs)');

  try {
    // ── Step 1: Scrape ────────────────────────────────────────────────────
    // Default: all 7 scrapers in parallel (ETcareers + Kebenajob + Jiji etc.
    // contribute 40+ extra jobs per run beyond Ethiojobs alone).
    // Use --ethio-only flag or ETHIO_ONLY=true env to restrict to Ethiojobs only.
    const rawJobs = ETHIO_ONLY
      ? await scrapeEthioJobs()
      : await ingestAll();

    logger.ok(`Step 1 complete — ${rawJobs.length} raw jobs scraped`);

    if (rawJobs.length === 0) {
      logger.info('No jobs scraped this cycle.');
      printStats(startTime, 0, 0, 0, 0);
      return;
    }

    // ── Step 2: Pre-filter (free keyword pass before hitting Gemini API) ──
    // Sanitize removes duplicates, senior/lead roles, and non-tech titles.
    // This protects Gemini API quota — only relevant candidates go to AI.
    const preFiltered = sanitize(rawJobs);
    logger.ok(`Step 2 complete — ${preFiltered.length}/${rawJobs.length} passed keyword pre-filter`);

    if (preFiltered.length === 0) {
      logger.info('No qualifying jobs after pre-filter. All done.');
      printStats(startTime, rawJobs.length, 0, 0, 0);
      return;
    }

    // ── Step 3: Gemini AI — extract fields, score, validate IT + fresh grad ─
    let processedJobs;
    const hasGemini = !!process.env.GEMINI_API_KEY;

    if (hasGemini) {
      logger.step('🤖', `Step 3: Gemini AI processing ${preFiltered.length} pre-filtered job(s)...`);
      processedJobs = await processAllJobs(preFiltered);
      logger.ok(`Step 3 complete — ${processedJobs.length} jobs passed AI filter (isIT + isFreshGradOk)`);
    } else {
      // Fallback: heuristic scoring when Gemini key not available
      logger.step('🧠', `Step 3: Heuristic scoring ${preFiltered.length} job(s) (no GEMINI_API_KEY)...`);
      processedJobs = scoreAll(preFiltered);
      logger.ok(`Step 3 complete — ${processedJobs.length} jobs scored`);
    }

    if (processedJobs.length === 0) {
      logger.info('No qualifying jobs after AI filter. All done.');
      printStats(startTime, rawJobs.length, preFiltered.length, 0, 0);
      return;
    }

    // Sort best score first
    processedJobs.sort((a, b) => {
      const totA = a.score?.total ?? a.scores?.total ?? 0;
      const totB = b.score?.total ?? b.scores?.total ?? 0;
      return totB - totA;
    });

    logger.ok(`Top job: "${processedJobs[0].title}" @ ${processedJobs[0].company} [${processedJobs[0].score?.total ?? processedJobs[0].scores?.total ?? '?'}/10]`);

    // ── Step 4: Send to Telegram ───────────────────────────────────────────
    const sent = await sendAll(processedJobs, DRY_RUN);
    logger.ok(`Step 4 complete — ${sent}/${processedJobs.length} messages sent to Telegram`);

    // ── Step 5: Write dashboard JSON ──────────────────────────────────────
    const written = writeJobsJson(processedJobs);
    logger.ok(`Step 5 complete — ${written} new jobs written to dashboard JSON`);

    // Push updated JSON to GitHub → GitHub Pages auto-serves it
    if (!DRY_RUN) pushDataToGitHub(sent);

    printStats(startTime, rawJobs.length, preFiltered.length, processedJobs.length, sent);

  } catch (err) {
    logger.error(`Pipeline crashed: ${err.message}`);
    logger.error(err.stack);
  }
}

// ── Stats printer ─────────────────────────────────────────────────────────────
function printStats(startTime, raw = 0, preFiltered = 0, aiQualified = 0, sent = 0) {
  const elapsed   = ((Date.now() - startTime) / 1000).toFixed(1);
  const hasGemini = !!process.env.GEMINI_API_KEY;
  logger.step('📈', 'Pipeline Complete');
  logger.dim(`  Total scraped   : ${raw}`);
  logger.dim(`  Pre-filtered    : ${preFiltered}`);
  if (hasGemini) logger.dim(`  AI qualified    : ${aiQualified}`);
  logger.dim(`  Sent to channel : ${sent}`);
  logger.dim(`  All-time seen   : ${totalSeen()}`);
  logger.dim(`  Elapsed         : ${elapsed}s`);
  logger.step('⚡', '═══════════════════════════════════════════════\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (RUN_ONCE) {
  // --once or --dry-run: run once and exit
  runPipeline().then(() => process.exit(0));
} else {
  const cronExpression = process.env.SCRAPE_CRON || '0 */6 * * *';

  if (!cron.validate(cronExpression)) {
    logger.error(`Invalid SCRAPE_CRON expression: "${cronExpression}"`);
    process.exit(1);
  }

  // Health-check HTTP server (required by cloud hosting platforms like Koyeb)
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
      lastRun,
      cycles    : cycleCount,
      uptime    : Math.floor(process.uptime()) + 's',
      timestamp : new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  });

  healthServer.listen(PORT, () => logger.ok(`Health server running on port ${PORT}`));

  async function runPipelineTracked() {
    cycleCount++;
    lastRun = new Date().toISOString();
    return runPipeline();
  }

  logger.step('⏱️', `Scheduler started — cron: "${cronExpression}"`);
  logger.info('Running first pipeline cycle immediately on startup...');

  runPipelineTracked();
  cron.schedule(cronExpression, () => {
    logger.step('⏱️', 'Cron tick — starting pipeline...');
    runPipelineTracked();
  }, {
    scheduled: true,
    timezone: "Africa/Addis_Ababa"
  });

  logger.info('Bot is running. Press Ctrl+C to stop.\n');
}
