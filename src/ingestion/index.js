'use strict';

const ethiojobs = require('../scrapers/ethiojobs');
const jobsico   = require('../scrapers/hahujobs');  // hahujobs.com is defunct — now Jobsico Ethiopia
const kebenajob = require('../scrapers/kebenajob');
const logger    = require('../utils/logger');

// ─── Data Ingestion Aggregator ─────────────────────────────────────────────
// Runs all three scrapers in sequence (not parallel) to avoid hammering
// multiple servers simultaneously. Returns one unified array.

/**
 * Run all scrapers and merge results.
 * @returns {Promise<Array>} Unified job list
 */
async function ingestAll() {
  logger.step('📡', 'Starting data ingestion from all portals...');
  const allJobs = [];

  const scrapers = [ethiojobs, jobsico, kebenajob];

  for (const scraper of scrapers) {
    try {
      const jobs = await scraper.scrape();
      allJobs.push(...jobs);
      logger.ok(`Ingested ${jobs.length} jobs from ${scraper.SOURCE_NAME}`);
    } catch (err) {
      logger.error(`Scraper ${scraper.SOURCE_NAME} threw an uncaught error: ${err.message}`);
      // Don't crash the entire pipeline — continue with next scraper
    }
  }

  logger.ok(`Total ingested: ${allJobs.length} jobs from all portals`);
  return allJobs;
}

module.exports = { ingestAll };
