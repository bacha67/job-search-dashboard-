'use strict';

const ethiojobs = require('../scrapers/ethiojobs');
const jiji      = require('../scrapers/hahujobs');    // Jiji Ethiopia
const kebenajob = require('../scrapers/kebenajob');
const etcareers = require('../scrapers/etcareers');
const afriwork  = require('../scrapers/afriwork');
const geezjobs  = require('../scrapers/geezjobs');
const linkedin  = require('../scrapers/linkedin');
const logger    = require('../utils/logger');

// ─── Data Ingestion Aggregator ─────────────────────────────────────────────
// Runs all scrapers in PARALLEL via Promise.allSettled() so one slow/blocked
// scraper never delays the others. Each scraper hits a different domain so
// parallel requests don't trigger rate-limits on the same server.
// Returns one unified flat array. Failures are logged but never crash the pipeline.

/**
 * Run all 7 scrapers in parallel and merge results.
 * @returns {Promise<Array>} Unified job list from all portals
 */
async function ingestAll() {
  logger.step('📡', 'Starting parallel data ingestion from all 7 portals...');

  const scrapers = [
    ethiojobs,   // ✅ Ethiojobs.net  — primary source
    etcareers,   // ✅ ETcareers.com  — IT category confirmed working
    kebenajob,   // ✅ Kebenajobs.com — WordPress blog parser
    jiji,        // ✅ Jiji Ethiopia  — general job marketplace
    afriwork,    // ⚡ Afriwork.com   — may be blocked, fails gracefully
    geezjobs,    // ⚡ GeezJobs.com   — may be blocked, fails gracefully
    linkedin,    // ⚡ LinkedIn       — guest API, may be rate-limited, fails gracefully
  ];

  // Run all scrapers simultaneously — if one fails/blocks it doesn't delay others
  const results = await Promise.allSettled(
    scrapers.map(s => s.scrape())
  );

  const allJobs = [];
  let succeeded = 0, failed = 0;

  results.forEach((result, i) => {
    const name = scrapers[i].SOURCE_NAME;
    if (result.status === 'fulfilled') {
      const jobs = result.value || [];
      allJobs.push(...jobs);
      logger.ok(`  ✅ ${name}: ${jobs.length} jobs`);
      succeeded++;
    } else {
      logger.warn(`  ❌ ${name}: failed — ${result.reason?.message || result.reason}`);
      failed++;
    }
  });

  logger.ok(
    `Ingestion complete — ${succeeded}/${scrapers.length} portals succeeded | ` +
    `${failed} failed | ${allJobs.length} total jobs`
  );
  return allJobs;
}

module.exports = { ingestAll };
