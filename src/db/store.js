'use strict';

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
  }
  return db;
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
