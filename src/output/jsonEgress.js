'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

// ─── Stage 05b: Dashboard JSON Egress ────────────────────────────────────
// Writes each qualified + scored job as a JSON object to data/jobs.json.
// This file is consumed by the Next.js/React dashboard frontend.
// Format: rolling array of the last MAX_STORED jobs, newest first.

const DATA_DIR    = path.join(process.cwd(), 'data');
const JSON_FILE   = path.join(DATA_DIR, 'jobs.json');
// Mirror: Next.js public folder (Vercel hosting)
const PUBLIC_COPY = path.join(process.cwd(), 'dashboard', 'public', 'data', 'jobs.json');
// Mirror: GitHub Pages docs folder
const DOCS_COPY   = path.join(process.cwd(), 'docs', 'data', 'jobs.json');
const MAX_STORED  = 500; // keep last 500 jobs to prevent unbounded growth

/**
 * Generate a stable slug-based job_id from the source URL.
 * Format: {source_prefix}_{urlHash8}
 */
function generateJobId(job) {
  const hash = crypto.createHash('md5').update(job.sourceUrl || job.id).digest('hex').slice(0, 8);
  const prefix = (job.source || 'job').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  return `${prefix}_${hash}`;
}

/**
 * Extract top skills from the job's skillsFound array (from scoring engine).
 * Falls back to extracting from title if no skills found.
 */
function extractSkills(job) {
  if (job.skillsFound && job.skillsFound.length > 0) {
    return job.skillsFound.slice(0, 8);
  }
  // Fallback: extract from title keywords
  const titleSkills = [];
  const title = (job.title || '').toLowerCase();
  const quickMap = {
    'react'    : 'React',    'node'     : 'Node.js',   'python'  : 'Python',
    'flutter'  : 'Flutter',  'java'     : 'Java',      'php'     : 'PHP',
    'laravel'  : 'Laravel',  'django'   : 'Django',    'android' : 'Android',
    'angular'  : 'Angular',  'vue'      : 'Vue.js',    'docker'  : 'Docker',
    'aws'      : 'AWS',      'linux'    : 'Linux',     'c#'      : 'C#',
    '.net'     : '.NET',     'sql'      : 'SQL',       'mysql'   : 'MySQL',
    'mongodb'  : 'MongoDB',  'typescript': 'TypeScript',
  };
  for (const [key, label] of Object.entries(quickMap)) {
    if (title.includes(key)) titleSkills.push(label);
  }
  return titleSkills.length > 0 ? titleSkills : ['General IT'];
}

/**
 * Convert a scored job object into the dashboard JSON format.
 */
function buildJobJson(job) {
  const salary     = (job.scores?.salary     || 5);
  const upgrade    = (job.scores?.upgrade    || 5);
  const skills     = (job.scores?.skills     || 1);
  const reputation = (job.scores?.reputation || 5);
  // Use engine's weighted total if available; fall back to simple average
  const overall    = job.scores?.total
    ? job.scores.total
    : parseFloat(((salary + upgrade + skills) / 3).toFixed(1));
  const isTop = overall >= 8.5;

  return {
    job_id          : generateJobId(job),
    title           : job.title || '',
    company         : job.company || '',
    source          : job.source || '',
    link            : job.sourceUrl || '',
    location        : job.location || 'Ethiopia',
    career_level    : job.careerLevel || 'Entry Level',
    job_type        : job.workExpName || '',
    is_top_rated    : isTop,
    metrics         : {
      salary          : parseFloat(salary.toFixed(1)),
      upgrade         : parseFloat(upgrade.toFixed(1)),
      skills          : parseFloat(skills.toFixed(1)),
      reputation      : parseFloat(reputation.toFixed(1)),
      overall_average : overall,   // weighted total (salary 40%, skills 30%, upgrade 20%, rep 10%)
    },
    extracted_skills: extractSkills(job),
    snapshot        : job.snapshot || [],
    score_reasons   : {
      salary  : job.reasons?.salary  || '',
      upgrade : job.reasons?.upgrade || '',
      skills  : job.reasons?.skills  || '',
    },
    timestamp       : new Date().toISOString(),

  };
}

/**
 * Load current jobs array from disk (or return empty array).
 */
function loadExisting() {
  try {
    if (!fs.existsSync(JSON_FILE)) return [];
    const raw = fs.readFileSync(JSON_FILE, 'utf8').trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Write jobs array to disk, sorted newest-first, capped at MAX_STORED.
 */
function persist(jobs) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const sorted  = jobs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const trimmed = sorted.slice(0, MAX_STORED);
  const payload = JSON.stringify(trimmed, null, 2);

  // Primary data file
  fs.writeFileSync(JSON_FILE, payload, 'utf8');

  // Mirror → dashboard/public/data/jobs.json  (Vercel static asset)
  _mirrorWrite(PUBLIC_COPY, payload);

  // Mirror → docs/data/jobs.json  (GitHub Pages)
  _mirrorWrite(DOCS_COPY, payload);
}

function _mirrorWrite(dest, payload) {
  try {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, payload, 'utf8');
  } catch (e) {
    // Non-fatal — folder may not exist in some environments
  }
}

/**
 * Append a batch of scored jobs to the JSON egress file.
 * Deduplicates by job_id — won't double-add previously stored entries.
 *
 * @param {Array} scoredJobs  Array of scored job objects from engine.js
 * @returns {number}          Count of new jobs added
 */
function appendJobs(scoredJobs) {
  if (!scoredJobs || scoredJobs.length === 0) return 0;

  const existing   = loadExisting();
  const existingIds = new Set(existing.map(j => j.job_id));

  const newEntries = [];
  for (const job of scoredJobs) {
    const entry = buildJobJson(job);
    if (!existingIds.has(entry.job_id)) {
      newEntries.push(entry);
      existingIds.add(entry.job_id);
    }
  }

  if (newEntries.length > 0) {
    persist([...newEntries, ...existing]);
    logger.ok(`[JSON Egress] Wrote ${newEntries.length} new jobs to ${JSON_FILE}`);
  } else {
    logger.dim(`[JSON Egress] No new jobs to write (all already stored)`);
  }

  return newEntries.length;
}

/**
 * Return the full path to the jobs JSON file (for logging/debugging).
 */
function getFilePath() { return JSON_FILE; }

module.exports = { appendJobs, buildJobJson, getFilePath };
