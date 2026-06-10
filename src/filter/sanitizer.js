'use strict';

const { hasSeen } = require('../db/store');
const logger      = require('../utils/logger');

// ─── Stage 03: Data Sanitizer & Filter ────────────────────────────────────
// CRITICAL PIPELINE CONTROLS (per spec):
//  Field: CS, IT, SE, CE, Sysadmin/Network Admin, MIS ONLY
//  Level: 0 yrs exp, fresh graduate, entry level, internship
//  Hard-reject: senior, lead, manager, director, 3+ years, experienced

// ══════════════════════════════════════════════════════════════════════════
// GATE 0: HARD-REJECT PATTERNS — instant discard regardless of any other signal
// ══════════════════════════════════════════════════════════════════════════
// Seniority patterns — checked in JOB TITLE + careerLevel ONLY.
// NOT in description — descriptions legitimately say "report to a senior developer"
// or "work under senior management" for entry-level roles.
const SENIORITY_TITLE_PATTERNS = [
  /\bsenior\b/i,
  /\blead\s+(developer|engineer|software|data|system)/i,
  /\bteam\s+lead\b/i, /\btech\s+lead\b/i,
  /\b(engineering|product|technical|IT|software|project)\s+manager\b/i,
  /\bdirector\b/i, /\bcto\b/i, /\bvp\s+of\b/i, /\bhead\s+of\b/i,
  /\bprinciple\s+(engineer|developer|architect)/i,
  /\bstaff\s+(engineer|developer|scientist)/i,
  /\barchitect\b(?!\s*intern)/i,
];

// Experience hard-reject — checked in FULL TEXT (title + description).
// 3+ years anywhere is a genuine disqualifier.
const EXP_HARD_PATTERNS = [
  /\b([3-9]|[1-9]\d+)\s*\+?\s*years?\s*(of\s+)?(work|relevant|professional|related)?\s*experience\b/i,
  /minimum\s+(of\s+)?([3-9]|[1-9]\d+)\s*years?/i,
  /at\s+least\s+([3-9]|[1-9]\d+)\s*years?/i,
  /([3-9]|[1-9]\d+)\+\s*years?\b/i,
  /\bexperienced\s+professional\b/i,
  /proven\s+(track\s+record|experience)\s+of\s+\d+/i,
];

// ══════════════════════════════════════════════════════════════════════════
// GATE 1: TECH FIELD VALIDATION — STRICT (CS/IT/SE/CE/Sysadmin/MIS only)
// ══════════════════════════════════════════════════════════════════════════

// These keywords must appear in the JOB TITLE to qualify
const TECH_TITLE_KEYWORDS = [
  // Software Engineering / Development
  'software', 'developer', 'development', 'programmer', 'coding',
  'software engineer', 'software developer',
  // IT / ICT
  'information technology', 'it officer', 'it support', 'it specialist',
  'it technician', 'it administrator', 'it admin', 'it manager',
  'ict officer', 'ict support', 'ict specialist', 'ict administrator',
  // Web / Mobile
  'web developer', 'web designer', 'web engineer',
  'mobile developer', 'mobile app', 'app developer',
  'frontend', 'front-end', 'front end',
  'backend', 'back-end', 'back end',
  'full stack', 'full-stack', 'fullstack',
  // Computer Science / Engineering
  'computer science', 'computer engineering',
  // Systems / Network / MIS
  'system admin', 'systems admin', 'sysadmin', 'system administrator', 'systems administrator',
  'network admin', 'network administrator', 'network engineer',
  'management information system', 'mis officer', 'mis analyst',
  'database admin', 'database developer', 'database engineer',
  'system analyst', 'systems analyst', 'information systems', 'information system',
  'data officer', 'database officer', 'network officer', 'it coordinator', 'ict coordinator',
  'computer technician', 'computer support',
  // ERP / Business Systems
  'erp developer', 'erp consultant', 'erp administrator', 'odoo', 'sap consultant',
  // Digital / Fintech
  'digital payment', 'digital banking', 'fintech', 'payment system',
  // GIS
  'gis analyst', 'gis officer', 'gis developer',
  // Specializations
  'devops', 'cloud engineer', 'site reliability',
  'data analyst', 'data scientist', 'data engineer', 'ml engineer',
  'machine learning', 'artificial intelligence', 'ai engineer',
  'cybersecurity', 'cyber security', 'security analyst', 'security engineer',
  'ui/ux', 'ui ux', 'ux designer', 'product designer',
  // Specific language/framework roles
  'flutter', 'react', 'node.js', 'nodejs', 'python', 'java', 'php',
  'laravel', 'django', 'android', 'ios', 'kotlin', 'swift',
  '.net developer', 'erp developer', 'odoo', 'sap consultant',
  // Support
  'helpdesk', 'help desk', 'tech support', 'technical support',
  'it helpdesk', 'it help desk',
];

// Non-tech title patterns — ALWAYS discard (overrides category tag)
const NON_TECH_TITLE_REJECT = [
  /\belectrical\s+engineer\b/i, /\belectrician\b/i,
  /\bcivil\s+engineer\b/i, /\bmechanical\s+engineer\b/i,
  /\bchemical\s+engineer\b/i, /\bfire\b.{0,10}(safety|officer)/i,
  /\bshot\s*firer\b/i, /\bmining\b/i, /\bgeologist\b/i,
  /\baccountant\b/i, /\baccounting\b/i, /\bauditor\b/i, /\bfinance\s+officer\b/i,
  /\bnurse\b/i, /\bmidwife\b/i, /\bpharmacist\b/i, /\bphysician\b/i,
  /\bdoctor\b/i, /\bmedical\b/i, /\bhealth\s+(officer|worker)\b/i,
  /\bdriver\b/i, /\bsecretary\b/i, /\breceptionist\b/i, /\bcashier\b/i,
  /\bchef\b/i, /\bcook\b/i, /\bwaiter\b/i, /\bbartender\b/i,
  /\bcleaner\b/i, /\bjanitor\b/i, /\bguard\b/i, /\bsecurity\s+officer\b/i,
  /\bteacher\b/i, /\bprocurement\b/i, /\blogistics\b/i, /\bwarehouse\b/i,
  /\bmarketing\s+officer\b/i, /\bsales\s+(rep|agent|officer)\b/i,
  /tiktok/i, /beautiful\s+girl/i, /model\s+recruit/i,
  /\b(rfp|tender|bid|request\s+for\s+proposal|expression\s+of\s+interest|eoi)\b/i,
];

// ══════════════════════════════════════════════════════════════════════════
// GATE 2: ENTRY-LEVEL VALIDATION
// ══════════════════════════════════════════════════════════════════════════

const ENTRY_KEYWORDS = [
  '0 year', 'zero year', 'no experience', 'no prior experience',
  'fresh graduate', 'fresh grad', 'newly graduate', 'recent graduate',
  'newly graduated', 'entry.?level', 'entry level',
  '\\bintern\\b', 'internship', 'trainee', 'graduate trainee',
  '\\bjunior\\b', 'career_level.*entry',
  // Added: 0-1 year range is still entry-level territory
  '0.?1\\s*years?', 'up to 1 year', 'less than 1 year', '1 year.*experience',
];

const ENTRY_RX = ENTRY_KEYWORDS.map(p => new RegExp(p, 'i'));

// Career labels that hard-reject (Ethiojobs structured field)
const SENIOR_CAREER_LABELS = [
  /mid.?level.*[3-9]/i, /senior/i, /manager/i,
  /executive/i, /director/i, /head\s+of/i,
];

// ══════════════════════════════════════════════════════════════════════════
// GATE 3: EXPERIENCE REQUIREMENT — discard if requires 2+ years
// (1 year is borderline acceptable in the Ethiopian market for entry roles)
// Exception: if "junior" appears alongside 2+ yrs requirement, keep it.
// ══════════════════════════════════════════════════════════════════════════

const EXP_DISQUALIFIERS = [
  // 2 or more years explicitly required
  /\b([2-9]|[1-9]\d+)\s*[\+\-]?\s*years?\s*(of\s+)?(relevant\s+)?(work\s+)?experience\b/i,
  /minimum\s+of\s+([2-9]|[1-9]\d+)\s*years?/i,
  /at\s+least\s+([2-9]|[1-9]\d+)\s*years?/i,
  /([2-9]|[1-9]\d+)\+\s*years?\b/i,
  /senior\s+level/i, /managerial\s+level/i, /executive\s+level/i,
];

// ── Helper functions ──────────────────────────────────────────────────────

function matchesAny(text, rxList) {
  return rxList.some(rx => rx.test(text));
}

/**
 * GATE 0: Hard-reject check.
 * Seniority → title + careerLevel ONLY (descriptions mention senior staff legitimately).
 * Experience requirements → full text (3+ years anywhere is a real disqualifier).
 */
function isHardRejected(job) {
  const titleAndLevel = [job.title, job.careerLevel].join(' ');
  const fullText      = [job.title, job.description, job.careerLevel].join(' ');

  if (SENIORITY_TITLE_PATTERNS.some(rx => rx.test(titleAndLevel))) return true;
  if (EXP_HARD_PATTERNS.some(rx => rx.test(fullText))) return true;
  return false;
}

/**
 * GATE 1: Tech field check — title must match a specific tech keyword.
 * Non-tech title patterns are always rejected.
 */
function isTechField(job) {
  const title = (job.title || '').toLowerCase();

  // Always reject explicitly non-tech titles
  if (NON_TECH_TITLE_REJECT.some(rx => rx.test(title))) return false;

  // Must match a specific tech keyword in title (with word boundary protection for short acronyms)
  if (TECH_TITLE_KEYWORDS.some(kw => {
    if (/^(it|ict|mis|gis)\b/.test(kw)) {
      const rx = new RegExp('\\b' + kw + '\\b', 'i');
      return rx.test(title);
    }
    return title.includes(kw);
  })) return true;

  // For Ethiojobs: also trust the structured IT catalog category
  if (job.source === 'Ethiojobs' && job.categories?.length > 0) {
    const cats = job.categories.join(' ').toLowerCase();
    if (TECH_TITLE_KEYWORDS.some(kw => {
      if (/^(it|ict|mis|gis)\b/.test(kw)) {
        const rx = new RegExp('\\b' + kw + '\\b', 'i');
        return rx.test(cats);
      }
      return cats.includes(kw);
    })) return true;
  }

  return false;
}

/**
 * GATE 2: Entry-level check.
 * Strategy:
 *  1. Structured career level label (Ethiojobs) → trust it
 *  2. Text keywords in title/desc → trust them
 *  3. No label + no keyword → allow through (Gate 3 will discard if exp required)
 */
function isEntryLevel(job) {
  const levelLabel = (job.careerLevel || '').toLowerCase();

  if (levelLabel) {
    // Positive structured signal
    if (levelLabel.includes('entry') || levelLabel.includes('intern') ||
        levelLabel.includes('fresh') || levelLabel.includes('trainee') ||
        levelLabel.includes('junior')) return true;
    // Negative structured signal
    if (SENIOR_CAREER_LABELS.some(rx => rx.test(levelLabel))) return false;
  }

  // Free-text keyword check
  const text = [job.title, job.description].join(' ');
  if (matchesAny(text, ENTRY_RX)) return true;

  // No label and no keyword → allow through (Gate 3 catches 1+ yr requirements)
  if (!levelLabel) return true;

  return false;
}

/**
 * GATE 3: Experience requirement check — discard if clearly requires 2+ yrs.
 * Exception 1: if "junior" appears alongside 2+ yrs requirement, keep it.
 * Exception 2: if GEMINI_API_KEY is set, SKIP this gate entirely — Gemini's
 *              isFreshGradOk flag is far more accurate than a regex on a
 *              mixed multi-position description (ETcareers bundles multiple
 *              roles together, so one role's exp requirement blocks another).
 */
function hasExperienceRequirement(job) {
  // Defer to Gemini when available — it reads role-specific experience correctly
  if (process.env.GEMINI_API_KEY) return false;

  const text = [job.title, job.description, job.careerLevel].join(' ');
  if (!EXP_DISQUALIFIERS.some(rx => rx.test(text))) return false;
  // Junior exception — keep even if 2+ yrs mentioned
  if (/\bjunior\b/i.test(text)) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN FILTER
// ══════════════════════════════════════════════════════════════════════════

/**
 * Filter jobs through all CRITICAL PIPELINE CONTROLS:
 *  Gate 0: Hard-reject (senior/lead/3+yrs) — instant discard
 *  Gate 1: Tech field (CS/IT/SE/CE/Sysadmin/MIS only)
 *  Gate 2: Entry level / fresh grad / intern / 0-1 yrs
 *  Gate 3: No explicit 2+ yr experience requirement (junior exception applies)
 *  Gate 4a: Dedup by job ID (SQLite — persists across runs)
 *  Gate 4b: Dedup by title+company (in-memory Set — catches re-posted jobs)
 */
function sanitize(jobs) {
  logger.step('📐', `Sanitizing ${jobs.length} ingested jobs...`);

  // In-memory title+company dedup (catches same job posted with different IDs)
  const titleCompanySeen = new Set();

  const results        = [];
  let skippedHard      = 0;
  let skippedField     = 0;
  let skippedLevel     = 0;
  let skippedExpReq    = 0;
  let skippedDedup     = 0;

  for (const job of jobs) {
    // Gate 0: Hard reject
    if (isHardRejected(job)) {
      skippedHard++;
      continue;
    }

    // Gate 1: Tech field
    if (!isTechField(job)) {
      skippedField++;
      continue;
    }

    // Gate 2: Entry level
    if (!isEntryLevel(job)) {
      skippedLevel++;
      continue;
    }

    // Gate 3: Experience requirement
    if (hasExperienceRequirement(job)) {
      skippedExpReq++;
      logger.dim(`  ✗ Exp-required: ${job.title} @ ${job.company}`);
      continue;
    }

    // Gate 4a: Dedup by job ID (SQLite)
    if (hasSeen(job.id)) {
      skippedDedup++;
      continue;
    }

    // Gate 4b: Dedup by title+company (in-memory Set)
    const dedupKey = `${(job.title || '').toLowerCase().trim()}|${(job.company || '').toLowerCase().trim()}`;
    if (titleCompanySeen.has(dedupKey)) {
      skippedDedup++;
      continue;
    }
    titleCompanySeen.add(dedupKey);

    results.push(job);
    logger.dim(`  ✓ Passed: ${job.title} @ ${job.company} [${job.source}]`);
  }

  logger.ok(
    `Filter: ${results.length} qualified | ` +
    `${skippedHard} hard-rejected | ${skippedField} non-tech | ` +
    `${skippedLevel} non-entry | ${skippedExpReq} exp-required | ` +
    `${skippedDedup} already-sent`
  );

  return results;
}

module.exports = { sanitize, isTechField };
