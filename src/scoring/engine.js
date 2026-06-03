'use strict';

// ─── Stage 04: Heuristic Scoring Engine ────────────────────────────────────
// 100% free — no external API calls. All scores are derived from keyword
// matching against the job's title, description, and company name.

// ══════════════════════════════════════════════════════════════════════════
// SALARY SCORE — company profile heuristics
// ══════════════════════════════════════════════════════════════════════════

const SALARY_TIERS = [
  // Tier 10: UN agencies & top international orgs
  {
    score: 10,
    patterns: [
      /\bUN[A-Z]+\b/, /united nations/, /\bwfp\b/, /\bwho\b/, /\bunde?p\b/,
      /\bunhcr\b/, /\bunicef\b/, /world bank/, /\bifc\b/, /\bifad\b/,
      /\badb\b/, /african development bank/, /\bimf\b/,
    ],
    reason: 'UN/Multilateral agencies offer top-tier ETB-equivalent compensation packages far above local market.',
  },
  // Tier 9: Large INGOs & global brands
  {
    score: 9,
    patterns: [
      /\binge?o\b/, /international.*organization/, /save the children/, /oxfam/,
      /care ethiopia/, /mercy corps/, /world vision/, /plan international/,
      /catholic relief/, /\bmsf\b/, /doctors without/, /danish refugee/,
      /\bnrc\b/, /norwegian refugee/, /\byango\b/, /\bbolt\b/, /\bubur\b/,
      /meta\b/, /google ethiopia/, /microsoft.*ethiopia/, /amazon.*ethiopia/,
    ],
    reason: 'International NGOs and global brands in Ethiopia apply headquarters-benchmarked salary scales well above local fresh-graduate rates.',
  },
  // Tier 8: Commercial banks & telecom
  {
    score: 8,
    patterns: [
      /commercial bank of ethiopia/, /\bcbe\b/,
      /awash bank/, /dashen bank/, /abyssinia bank/, /zemen bank/,
      /nib bank/, /wegagen bank/, /lion bank/, /abay bank/, /debub global/,
      /enat bank/, /oromia bank/, /siinqee bank/, /hijra bank/, /tsedey bank/,
      /amhara bank/, /cooperative bank/,
      /ethio telecom/, /ethiotelecom/, /safaricom ethiopia/, /telebirr/,
      /\binsurance\b.*s\.c/, /nyala insurance/, /ethiopian insurance/,
    ],
    reason: 'Ethiopian commercial banks and telecom companies maintain structured graduate salary scales that are among the highest in the local formal sector.',
  },
  // Tier 7: Large local corporates & funded startups
  {
    score: 7,
    patterns: [
      /ethiopian airlines/, /\beal\b/, /ethio airlines/,
      /\bhal\b/, /habesha/, /meta abo/, /st. george/, /bedele/,
      /flutterwave/, /telebirr/, /\bm-pesa\b/, /\bhello cash\b/,
      /\bkaizen\b/, /\bnext\b.*tech/, /\biCog\b/, /icog labs/,
      /\bgebeya\b/, /\babyssinia\b/,
      /startup/, /tech company/, /software company/, /fintech/,
      /s\.c\./, /share company/, /plc\b/,
    ],
    reason: 'Large local corporates and funded tech startups offer salaries moderately above the fresh-graduate average with structured growth bands.',
  },
  // Tier 5–6: Medium-sized local companies (default for unknowns)
  {
    score: 5,
    patterns: [/.*/],   // catch-all — always matches
    reason: 'Salary estimate is benchmarked to the local SME average for fresh CS/IT graduates (~8,000–12,000 ETB/month) given no premium company signal was detected.',
  },
];

const SALARY_LOW_SIGNALS = [
  /school/, /college/, /academy/, /ngo.*local/, /local.*ngo/,
  /church/, /clinic/, /pharmacy/,
];

/**
 * Parse an explicit ETB/Birr salary amount from description text.
 * Returns the numeric amount, or null if not stated.
 */
function parseEtbAmount(text) {
  const patterns = [
    /(?:ETB|birr)[\s:]*([\d,]+)/i,
    /([\d,]+)[\s]*(?:ETB|birr)/i,
    /salary[:\s]+(?:ETB|birr)?[\s]*([\d,]+)/i,
    /([\d,]+)[\s]*(?:per month|monthly)/i,
  ];
  for (const rx of patterns) {
    const m = rx.exec(text);
    if (m) {
      const amount = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isNaN(amount) && amount > 1000) return amount; // sanity check
    }
  }
  return null;
}

/**
 * Score salary from 1–10 based on company tier.
 * If an explicit ETB amount is found in the description, apply a bonus/penalty
 * on top of the company-tier baseline.
 */
function scoreSalary(job) {
  const hay  = (job.company + ' ' + job.description).toLowerCase();
  const desc = (job.description || job.salary || '').toLowerCase();

  // Downgrade first for low signals
  if (SALARY_LOW_SIGNALS.some(rx => rx.test(hay))) {
    const base = { score: 4, reason: 'Local school, clinic, or small organization — compensation typically reflects the lower end of fresh-graduate market benchmarks (~6,000–9,000 ETB/month).' };
    const etb  = parseEtbAmount(desc);
    if (etb && etb >= 15000) base.score = Math.min(10, base.score + 2);
    return base;
  }

  let result = { score: 5, reason: SALARY_TIERS[SALARY_TIERS.length - 1].reason };
  for (const tier of SALARY_TIERS) {
    if (tier.patterns.some(rx => rx.test(hay))) {
      result = { score: tier.score, reason: tier.reason };
      break;
    }
  }

  // ETB amount bonus/penalty on top of company tier
  const etb = parseEtbAmount(desc);
  if (etb !== null) {
    if (etb >= 15000) {
      result.score = Math.min(10, result.score + 2);
      result.reason += ` Salary stated at ${etb.toLocaleString()} ETB/month (above fresh-grad market).`;
    } else if (etb >= 8000) {
      result.score = Math.min(10, result.score + 1);
      result.reason += ` Salary stated at ${etb.toLocaleString()} ETB/month (mid-range for fresh grads).`;
    } else {
      result.score = Math.max(1, result.score - 1);
      result.reason += ` Salary stated at ${etb.toLocaleString()} ETB/month (below fresh-grad market average).`;
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════
// FUTURE UPGRADE SCORE — career trajectory heuristics
// ══════════════════════════════════════════════════════════════════════════

const UPGRADE_TIERS = [
  {
    score: 10,
    patterns: [
      /devops/, /cloud engineer/, /site reliability/, /\bsre\b/, /platform engineer/,
      /kubernetes/, /docker/, /terraform/, /\baws\b/, /azure/, /gcp/,
    ],
    reason: 'Cloud/DevOps roles have the fastest progression trajectory to Staff/Principal Engineer, with globally transferable certifications (AWS, GCP, CKA).',
  },
  {
    score: 9,
    patterns: [
      /software engineer/, /software developer/, /backend developer/, /backend engineer/,
      /frontend developer/, /frontend engineer/, /full.?stack/, /fullstack/,
      /mobile developer/, /flutter developer/, /android developer/, /ios developer/,
      /react developer/, /node.*developer/, /python developer/, /java developer/,
    ],
    reason: 'Production software engineering roles offer a direct path to Senior/Lead Engineer within 2–3 years through continuous code review cycles and system ownership.',
  },
  {
    score: 8,
    patterns: [
      /machine learning/, /\bml engineer\b/, /data engineer/, /ai engineer/,
      /nlp engineer/, /computer vision/,
    ],
    reason: 'ML/AI engineering is the highest-demand specialization with a steep learning curve that accelerates progression into Principal/Research Scientist tracks.',
  },
  {
    score: 7,
    patterns: [
      /data analyst/, /business intelligence/, /\bbi developer\b/, /\bpower bi\b/,
      /\btableau\b/, /data.*analyst/, /analyst.*data/,
      /network engineer/, /system administrator/, /sysadmin/, /network admin/,
      /erp.*developer/, /sap.*consultant/, /odoo.*developer/,
    ],
    reason: 'Data analysis and network engineering provide a structured path to Senior Analyst/Architect with consistent domain-specific promotion ladders.',
  },
  {
    score: 6,
    patterns: [
      /it officer/, /ict officer/, /it manager/, /systems officer/,
      /database administrator/, /\bdba\b/, /database admin/,
      /ui.?ux/, /ux designer/, /product designer/, /graphic.*web/,
    ],
    reason: 'IT Officer and general ICT roles offer steady but less specialized advancement — typically transitioning into IT Manager within 3–5 years.',
  },
  {
    score: 5,
    patterns: [
      /it support/, /tech support/, /helpdesk/, /help desk/, /service desk/,
      /desktop support/, /computer.*technician/, /it technician/,
    ],
    reason: 'IT support/helpdesk provides foundational ops experience but has a slower path to engineering tracks without deliberate upskilling in parallel.',
  },
  {
    score: 4,
    patterns: [
      /hardware/, /maintenance technician/, /repair technician/, /cctv/, /pos technician/,
    ],
    reason: 'Hardware maintenance roles offer limited vertical progression without transitioning into network or systems administration domains.',
  },
];

function scoreUpgrade(job) {
  const hay = (job.title + ' ' + job.description).toLowerCase();
  for (const tier of UPGRADE_TIERS) {
    if (tier.patterns.some(rx => rx.test(hay))) {
      return { score: tier.score, reason: tier.reason };
    }
  }
  return { score: 5, reason: 'This IT role has a moderate growth trajectory depending on the depth of technical work and mentorship quality at the organization.' };
}

// ══════════════════════════════════════════════════════════════════════════
// SKILLS GAINED SCORE — technology keyword extraction
// ══════════════════════════════════════════════════════════════════════════

// Each entry: [regex, weight, display_name]
const TECH_WEIGHTS = [
  // High-value frameworks & languages
  [/\breact\b/i,         2.0, 'React'],
  [/\bnext\.?js\b/i,     2.0, 'Next.js'],
  [/\bnode\.?js\b/i,     2.0, 'Node.js'],
  [/\bvue\.?js\b/i,      2.0, 'Vue.js'],
  [/\bangular\b/i,       1.8, 'Angular'],
  [/\bflutter\b/i,       2.2, 'Flutter'],
  [/\breact\s*native\b/i,2.0, 'React Native'],
  [/\bpython\b/i,        2.0, 'Python'],
  [/\bdjango\b/i,        2.0, 'Django'],
  [/\bfastapi\b/i,       2.0, 'FastAPI'],
  [/\bflask\b/i,         1.5, 'Flask'],
  [/\bjava\b/i,          1.8, 'Java'],
  [/\bspring\b/i,        1.8, 'Spring'],
  [/\bkotlin\b/i,        1.8, 'Kotlin'],
  [/\bswift\b/i,         1.8, 'Swift'],
  [/\bphp\b/i,           1.5, 'PHP'],
  [/\blaravel\b/i,       1.8, 'Laravel'],
  [/\bc#\b/i,            1.8, 'C#'],
  [/\.net\b/i,           1.8, '.NET'],
  [/\bgolang\b|\bgo\s+lang/i, 2.2, 'Go'],
  [/\brust\b/i,          2.0, 'Rust'],
  [/\bjavascript\b|\bjs\b/i, 1.5, 'JavaScript'],
  [/\btypescript\b/i,    1.8, 'TypeScript'],
  // Cloud & DevOps
  [/\baws\b/i,           2.5, 'AWS'],
  [/\bazure\b/i,         2.5, 'Azure'],
  [/\bgcp\b|google\s+cloud/i, 2.5, 'GCP'],
  [/\bdocker\b/i,        2.2, 'Docker'],
  [/\bkubernetes\b|\bk8s\b/i, 2.5, 'Kubernetes'],
  [/\bterraform\b/i,     2.2, 'Terraform'],
  [/\bci\/cd\b|\bgithub\s+actions\b|\bjenkins\b/i, 2.0, 'CI/CD'],
  // Databases
  [/\bpostgresql\b|\bpostgres\b/i, 1.5, 'PostgreSQL'],
  [/\bmysql\b/i,         1.3, 'MySQL'],
  [/\bmongodb\b/i,       1.5, 'MongoDB'],
  [/\bredis\b/i,         1.5, 'Redis'],
  [/\bfirebase\b/i,      1.5, 'Firebase'],
  // Networking & Security
  [/\bccna\b|\bcisco\b/i, 1.8, 'Cisco/CCNA'],
  [/\blinux\b/i,         1.5, 'Linux'],
  [/\bcybersecur/i,      2.0, 'Cybersecurity'],
  [/\bwireshark\b/i,     1.5, 'Wireshark'],
  // Data & ML
  [/\btensorflow\b/i,    2.2, 'TensorFlow'],
  [/\bpytorch\b/i,       2.2, 'PyTorch'],
  [/\bscikit/i,          1.8, 'scikit-learn'],
  [/\bpandas\b/i,        1.5, 'Pandas'],
  [/\bpower\s*bi\b/i,    1.5, 'Power BI'],
  [/\btableau\b/i,       1.5, 'Tableau'],
  // Low-value tools (still worth noting)
  [/\bgit\b/i,           0.8, 'Git'],
  [/\bms\s+office\b|microsoft\s+office/i, 0.3, 'MS Office'],
];

const MAX_POSSIBLE_WEIGHT = 10.0; // practical ceiling for normalizing to /10

function scoreSkills(job) {
  const hay    = (job.title + ' ' + job.description).toLowerCase();
  const found  = [];
  let   total  = 0;

  for (const [rx, weight, name] of TECH_WEIGHTS) {
    if (rx.test(hay)) {
      found.push(name);
      total += weight;
    }
  }

  // Normalize to 1–10 scale
  const raw   = Math.min(total, MAX_POSSIBLE_WEIGHT);
  const score = Math.max(1, Math.min(10, Math.round((raw / MAX_POSSIBLE_WEIGHT) * 10)));

  // Build reason sentence from detected tech
  let reason;
  if (found.length === 0) {
    reason = 'No specific named technologies detected in the listing — skills gained will depend heavily on the actual on-the-job work environment.';
  } else if (found.length <= 3) {
    reason = `The role exposes the candidate to ${found.join(', ')}, providing focused hands-on experience in a constrained but valuable toolset.`;
  } else {
    const top = found.slice(0, 5).join(', ');
    const extra = found.length > 5 ? ` and ${found.length - 5} more` : '';
    reason = `Rich multi-stack exposure: ${top}${extra} — this breadth significantly accelerates a graduate's market value and employability in 12–18 months.`;
  }

  return { score, found, reason };
}

// ══════════════════════════════════════════════════════════════════════════
// REPUTATION SCORE — brand recognition separate from salary
// ══════════════════════════════════════════════════════════════════════════

const REPUTATION_TIERS = [
  { score: 10, patterns: [/\bUN[A-Z]+\b/, /united nations/, /world bank/, /\bwfp\b/, /\bwho\b/, /\bimf\b/, /african development bank/] },
  { score: 9,  patterns: [/save the children/, /oxfam/, /care ethiopia/, /mercy corps/, /world vision/, /plan international/, /\bnrc\b/, /norwegian.*church/, /\bolt\b/, /\bbolt\b/, /\byango\b/] },
  { score: 8,  patterns: [/commercial bank of ethiopia/, /\bcbe\b/, /awash bank/, /dashen bank/, /abyssinia bank/, /ethio telecom/, /safaricom/, /ethiopian airlines/] },
  { score: 7,  patterns: [/\bplc\b/, /share company/, /s\.c\./, /icog/, /gebeya/, /startup/, /fintech/, /tech.*company/, /software.*company/] },
  { score: 5,  patterns: [/.*/] },  // catch-all
];

/**
 * Score company reputation from 1–10 as a separate dimension from salary.
 */
function scoreReputation(job) {
  const hay = (job.company + ' ' + (job.description || '')).toLowerCase();
  for (const tier of REPUTATION_TIERS) {
    if (tier.patterns.some(rx => rx.test(hay))) {
      return tier.score;
    }
  }
  return 5;
}

// ══════════════════════════════════════════════════════════════════════════
// OPERATIONAL SNAPSHOT — 2-bullet plain-text summary
// ══════════════════════════════════════════════════════════════════════════

/**
 * Generate a 2-bullet operational snapshot from the job description.
 * Bullet 1: Tech tools / stack mentioned.
 * Bullet 2: Primary tasks expected of the candidate.
 */
function buildSnapshot(job, skillsFound) {
  // Bullet 1 — Tech stack
  const stackLine = skillsFound.length > 0
    ? `🔧 *Tools & Stack:* ${skillsFound.slice(0, 6).join(', ')} ${skillsFound.length > 6 ? `(+${skillsFound.length - 6} more)` : ''}`
    : `🔧 *Tools & Stack:* General IT tools and standard office/enterprise software per job requirements`;

  // Bullet 2 — Primary tasks (extract first meaningful sentence from description)
  const sentences = job.description
    .split(/[.!?]\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 40 && s.length < 300);

  const taskSentence = sentences[0] || `Day-to-day responsibilities as defined in the ${job.title} role at ${job.company}`;

  const taskLine = `📋 *Primary Tasks:* ${taskSentence.charAt(0).toUpperCase()}${taskSentence.slice(1)}.`;

  return [stackLine, taskLine];
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Score a single job and return a complete scored job object.
 * @param {object} job  Normalized job from sanitizer
 * @returns {object}    Job with scores and formatted Telegram payload
 */
function score(job) {
  const salary  = scoreSalary(job);
  const upgrade = scoreUpgrade(job);
  const skills  = scoreSkills(job);
  const [snap1, snap2] = buildSnapshot(job, skills.found);

  return {
    ...job,
    scores: {
      salary : salary.score,
      upgrade: upgrade.score,
      skills : skills.score,
    },
    reasons: {
      salary : salary.reason,
      upgrade: upgrade.reason,
      skills : skills.reason,
    },
    snapshot: [snap1, snap2],
    skillsFound: skills.found,
  };
}

/**
 * Score an array of jobs.
 * @param {Array} jobs
 * @returns {Array}
 */
function scoreAll(jobs) {
  return jobs.map(score);
}

module.exports = { score, scoreAll };
