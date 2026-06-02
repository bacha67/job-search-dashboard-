'use strict';

const { hasSeen } = require('../db/store');
const logger      = require('../utils/logger');

// ─── Stage 03: Data Sanitizer & Filter ────────────────────────────────────

// ── Tech Field Keywords ───────────────────────────────────────────────────
// A job TITLE must match at least one of these to qualify as a tech role.
// Keep these SPECIFIC — avoid generic words like 'engineer' alone.
const FIELD_KEYWORDS = [
  // Software / Development
  'software', 'developer', 'development', 'programmer', 'programming',
  'software engineer', 'software developer',
  // IT specific
  'information technology', 'it officer', 'it support', 'it technician',
  'ict officer', 'ict support',
  // Web / Mobile
  'web developer', 'web designer', 'mobile developer', 'mobile app',
  'frontend', 'front-end', 'front end',
  'backend', 'back-end', 'back end',
  'full.?stack', 'fullstack',
  // Specializations
  'devops', 'cloud engineer', 'site reliability',
  'data analyst', 'data science', 'machine learning', 'ml engineer',
  'artificial intelligence', 'ai engineer',
  'network engineer', 'network admin', 'system admin', 'sysadmin',
  'database admin', 'database developer', '\\bdba\\b',
  'cybersecurity', 'cyber security', 'security analyst',
  'ui.?ux', 'ux designer', 'product designer',
  // Languages & Frameworks (as job titles)
  'flutter developer', 'react developer', 'node developer',
  'python developer', 'java developer', 'php developer',
  'laravel developer', 'django developer', 'android developer',
  'ios developer', 'kotlin developer',
  // Support / Tech roles
  'helpdesk', 'help desk', 'tech support', 'it helpdesk',
  // ERP
  'erp consultant', 'sap consultant', 'odoo developer',
  // Computer Science
  'computer science', 'computer engineering',
];

// ── Hard-Reject Title Patterns ────────────────────────────────────────────
// Titles matching these are ALWAYS non-tech — reject regardless of category.
const NON_TECH_TITLE_PATTERNS = [
  /shot\s*firer/i, /electrician/i, /electrical\s+engineer/i,
  /tiktok/i, /beautiful\s*girl/i, /model\s*recruit/i,
  /driver/i, /accountant/i, /accounting/i, /finance\s+officer/i,
  /nurse/i, /midwife/i, /health\s+(officer|provider|worker|care)/i,
  /construction/i, /civil\s+engineer/i, /architect/i,
  /secretary/i, /receptionist/i, /cashier/i, /cleaner/i,
  /cook\b/i, /chef\b/i, /waiter/i, /bartender/i,
  /sales\s+(rep|agent|officer)/i, /marketing\s+officer/i,
  /procurement/i, /logistics/i, /warehouse/i, /supply\s+chain/i,
  /auditor/i, /tax\s+officer/i, /legal\s+officer/i,
  /teacher\b/i, /instructor\b(?!.*coding)/i, /trainer(?!.*it|.*tech|.*software)/i,
  /guard\b/i, /security\s+officer/i, /janitor/i, /cleaner/i,
];

// ── Entry-Level / Fresh-Graduate Keywords ─────────────────────────────────
// A job must match at least one of these to qualify.
const ENTRY_KEYWORDS = [
  '0 year',
  'zero year',
  'no experience',
  'no prior experience',
  'fresh graduate',
  'fresh grad',
  'newly graduate',
  'recent graduate',
  'entry.?level',
  'entry level',
  '\\bintern\\b',
  'internship',
  'trainee',
  'graduate trainee',
  'junior',                       // often implies <1 yr
  'career_level.*entry',          // Ethiojobs structured field
];

// ── Disqualifier Keywords ─────────────────────────────────────────────────
// If any of these patterns are found, the job is discarded.
// We look for "N years" where N >= 1.
const DISQUALIFIER_PATTERNS = [
  /\b([1-9]\d*)\s*[\+\-]?\s*years?\s*(of\s+)?(relevant\s+)?(work\s+)?experience/i,
  /minimum\s+of\s+([1-9]\d*)\s*years?/i,
  /at\s+least\s+([1-9]\d*)\s*years?/i,
  /([1-9]\d*)\s*[\+]\s*years?/i,
  // Career level labels that indicate mid/senior
  /mid[\s\-]?level\s*\(\s*[3-9]/i,
  /senior\s+level/i,
  /managerial\s+level/i,
  /executive\s+level/i,
];

// ── Ethiojobs structured career level IDs that map to non-entry ───────────
// From the scraped data: career_level 2 = "Mid Level(3-5 years)"
// Entry level is typically career_level 0 or 1. We'll be conservative
// and only allow career_level 0 or if label contains "entry" or "intern".
const DISQUALIFY_CAREER_LABELS = [
  /mid.?level.*[3-9]/i,
  /senior/i,
  /manager/i,
  /executive/i,
  /director/i,
  /head\s+of/i,
];

/**
 * Build a compiled regex list from an array of pattern strings.
 */
function buildRegexList(patterns) {
  return patterns.map(p => new RegExp(p, 'i'));
}

const FIELD_RX   = buildRegexList(FIELD_KEYWORDS);
const ENTRY_RX   = buildRegexList(ENTRY_KEYWORDS);

/**
 * Check if a string matches any regex in a list.
 */
function matchesAny(text, regexList) {
  return regexList.some(rx => rx.test(text));
}

/**
 * Check if the job title qualifies as a tech field.
 * Logic:
 *  1. Reject immediately if title matches a known non-tech pattern.
 *  2. Accept if title matches a specific tech keyword.
 *  3. For Jiji/Kebenajob (hardcoded 'Information Technology' category),
 *     only trust the TITLE — not the category — to prevent false positives.
 */
function isTechField(job) {
  const title = (job.title || '').toLowerCase();

  // Hard reject: explicit non-tech titles
  if (NON_TECH_TITLE_PATTERNS.some(rx => rx.test(title))) return false;

  // Accept: title matches a specific tech keyword
  if (matchesAny(title, FIELD_RX)) return true;

  // For Ethiojobs: also trust the catalog categories
  if (job.source === 'Ethiojobs' && job.categories && job.categories.length > 0) {
    const catText = job.categories.join(' ').toLowerCase();
    if (matchesAny(catText, FIELD_RX)) return true;
  }

  return false;
}

/**
 * Check if the job description / career level indicates entry-level.
 * Strategy:
 *  1. If Ethiojobs provides a structured career level label → use it strictly.
 *  2. If no structured label (HTML scrapers) → check text for ENTRY_KEYWORDS.
 *  3. If still no signal → allow through IF no disqualifier text exists.
 *     The experience disqualifier gate (Gate 3) will then be the final arbiter.
 */
function isEntryLevel(job) {
  const levelLabel = (job.careerLevel || '').toLowerCase();

  // ── Structured label available (Ethiojobs) ─────────────────────────
  if (levelLabel) {
    // Explicit positive signals
    if (levelLabel.includes('entry') || levelLabel.includes('intern') ||
        levelLabel.includes('fresh') || levelLabel.includes('trainee') ||
        levelLabel.includes('junior')) {
      return true;
    }
    // Explicit disqualifier
    if (DISQUALIFY_CAREER_LABELS.some(rx => rx.test(levelLabel))) {
      return false;
    }
  }

  // ── Text-based check (all sources) ─────────────────────────────────
  const text = [job.title, job.description].join(' ');
  if (matchesAny(text, ENTRY_RX)) return true;

  // ── No structured label + no entry keyword found ────────────────────
  // For HTML-scraped jobs where experience level isn't listed:
  // Allow through — Gate 3 (hasExperienceRequirement) will discard any
  // job that explicitly demands ≥1 year in its description text.
  if (!levelLabel) return true;

  return false;
}

/**
 * Return true if the job clearly requires ≥1 year of experience.
 * This is a hard discard.
 */
function hasExperienceRequirement(job) {
  const text = [job.title, job.description, job.careerLevel].join(' ');

  for (const pattern of DISQUALIFIER_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Main filter function. Returns only jobs that:
 *  1. Match a tech field
 *  2. Are entry-level / fresh-graduate / intern
 *  3. Do NOT require ≥1 year of experience
 *  4. Have NOT already been sent (SQLite dedup check)
 *
 * @param {Array} jobs  Raw normalized jobs from ingestion
 * @returns {Array}     Filtered jobs ready for scoring
 */
function sanitize(jobs) {
  logger.step('📐', `Sanitizing ${jobs.length} ingested jobs...`);

  const results = [];
  let   skippedField  = 0;
  let   skippedLevel  = 0;
  let   skippedExpReq = 0;
  let   skippedDedup  = 0;

  for (const job of jobs) {
    // ── Gate 1: Must be a tech-field role ──────────────────────────────
    if (!isTechField(job)) {
      skippedField++;
      continue;
    }

    // ── Gate 2: Must signal entry-level ────────────────────────────────
    if (!isEntryLevel(job)) {
      skippedLevel++;
      continue;
    }

    // ── Gate 3: Must NOT demand ≥1 year of experience ──────────────────
    if (hasExperienceRequirement(job)) {
      skippedExpReq++;
      logger.dim(`  ✗ Discarded (exp req): ${job.title} @ ${job.company}`);
      continue;
    }

    // ── Gate 4: Dedup check against SQLite ─────────────────────────────
    if (hasSeen(job.id)) {
      skippedDedup++;
      continue;
    }

    results.push(job);
    logger.dim(`  ✓ Passed:   ${job.title} @ ${job.company} [${job.source}]`);
  }

  logger.ok(`Filter results: ${results.length} qualified | ` +
    `${skippedField} not-tech | ${skippedLevel} not-entry | ` +
    `${skippedExpReq} exp-required | ${skippedDedup} already-sent`);

  return results;
}

module.exports = { sanitize };
