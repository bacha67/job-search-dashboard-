'use strict';

const fs      = require('fs');
const path    = require('path');
const Database = require('better-sqlite3');
const logger  = require('../utils/logger');

// ─── SQLite KV store for job deduplication ─────────────────────────────────
const DB_PATH = path.join(__dirname, '../../seen_jobs.sqlite');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS seen_jobs (
        job_id    TEXT PRIMARY KEY,
        source    TEXT NOT NULL,
        title     TEXT,
        sent_at   INTEGER NOT NULL
      );
    `);
    logger.ok(`SQLite store ready at ${DB_PATH}`);

    // ── Pre-populate from docs/data/jobs.json on first startup ──────────────
    // This prevents re-sending jobs after a Render deploy/restart that wiped SQLite.
    // The committed jobs.json is always available in the repo clone.
    _seedFromJobsJson();
  }
  return db;
}

/**
 * Seed the SQLite dedup table from the committed docs/data/jobs.json.
 * This is a no-op if the table already has rows (i.e. not a fresh DB).
 * Runs once per process lifetime via getDb().
 */
function _seedFromJobsJson() {
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM seen_jobs').get().c;
    if (count > 0) return; // Already have data — skip seeding

    const jsonPath = path.join(__dirname, '../../docs/data/jobs.json');
    if (!fs.existsSync(jsonPath)) return;

    const jobs = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!Array.isArray(jobs) || jobs.length === 0) return;

    const insert = db.prepare(
      'INSERT OR IGNORE INTO seen_jobs (job_id, source, title, sent_at) VALUES (?, ?, ?, ?)'
    );
    const insertMany = db.transaction((rows) => {
      for (const j of rows) {
        insert.run(
          j.job_id,
          j.source || 'unknown',
          j.title  || '',
          new Date(j.timestamp || 0).getTime() || Date.now()
        );
      }
    });

    insertMany(jobs);
    logger.ok(`[Store] Seeded ${jobs.length} job IDs from jobs.json — re-sends prevented after restart`);
  } catch (e) {
    // Non-fatal — worst case: a few jobs may be re-sent after first deploy
    logger.warn(`[Store] Seed skipped: ${e.message}`);
  }
}

/**
 * Check if a job has already been sent.
 * @param {string} jobId
 * @returns {boolean}
 */
function hasSeen(jobId) {
  const row = getDb()
    .prepare('SELECT 1 FROM seen_jobs WHERE job_id = ?')
    .get(jobId);
  return !!row;
}

/**
 * Mark a job as sent.
 * @param {string} jobId
 * @param {string} source   e.g. 'ethiojobs'
 * @param {string} title
 */
function markSeen(jobId, source, title) {
  getDb()
    .prepare('INSERT OR IGNORE INTO seen_jobs (job_id, source, title, sent_at) VALUES (?, ?, ?, ?)')
    .run(jobId, source, title, Date.now());
}

/**
 * Return total number of jobs seen across all sources.
 */
function totalSeen() {
  return getDb()
    .prepare('SELECT COUNT(*) as c FROM seen_jobs')
    .get().c;
}

/**
 * Return recent sent jobs for a given source (last N).
 */
function recentSeen(source, limit = 10) {
  return getDb()
    .prepare('SELECT * FROM seen_jobs WHERE source = ? ORDER BY sent_at DESC LIMIT ?')
    .all(source, limit);
}

module.exports = { hasSeen, markSeen, totalSeen, recentSeen };
