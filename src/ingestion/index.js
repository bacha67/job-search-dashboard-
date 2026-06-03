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
// Runs all scrapers in sequence to avoid hammering servers simultaneously.
// Returns one unified array. Each scraper fails gracefully without crashing.

/**
 * Run all scrapers and merge results.
 * @returns {Promise<Array>} Unified job list from all 6 portals
 */
async function ingestAll() {
  logger.step('📡', 'Starting data ingestion from all portals...');
  const allJobs = [];

  // Ordered by reliability — most reliable first
  const scrapers = [
    ethiojobs,   // ✅ Ethiojobs.net — primary source
    etcareers,   // ✅ ETcareers.com — IT category confirmed working
    kebenajob,   // ✅ Kebenajobs.com — WordPress blog parser
    jiji,        // ✅ Jiji Ethiopia — general job marketplace
    afriwork,    // ⚡ Afriwork.com — may be blocked, fails gracefully
    geezjobs,    // ⚡ GeezJobs.com — may be blocked, fails gracefully
    linkedin,    // ⚡ LinkedIn — guest API, may be rate-limited, fails gracefully
  ];

  for (const scraper of scrapers) {
    try {
      const jobs = await scraper.scrape();
      allJobs.push(...jobs);
      logger.ok(`Ingested ${jobs.length} jobs from ${scraper.SOURCE_NAME}`);
    } catch (err) {
      logger.error(`Scraper ${scraper.SOURCE_NAME} threw an uncaught error: ${err.message}`);
      // Don't crash the pipeline — continue with next scraper
    }
  }

  logger.ok(`Total ingested: ${allJobs.length} jobs from all ${scrapers.length} portals (7 sources)`);
  return allJobs;
}

module.exports = { ingestAll };
