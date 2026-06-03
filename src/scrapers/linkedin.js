'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── LinkedIn Scraper ─────────────────────────────────────────────────────
// LinkedIn's main job search page is React-rendered (JS required), so
// cheerio can't parse it directly. Instead we use LinkedIn's guest jobs API
// which powers their infinite scroll and returns real HTML fragments.
//
// Note: LinkedIn aggressively rate-limits and blocks scrapers with 429/999.
// This scraper fails gracefully — returns [] on any block. The pipeline
// continues uninterrupted (same pattern as Afriwork / GeezJobs).

const SOURCE_NAME = 'LinkedIn';

// Guest API — returns HTML job card fragments (no auth needed)
// f_E=1,2 → Internship + Entry Level   |  f_TPR=r86400 → last 24h
const SEARCH_QUERIES = [
  { keywords: 'software+developer', label: 'Software Dev' },
  { keywords: 'IT+officer',         label: 'IT Officer'   },
  { keywords: 'web+developer',      label: 'Web Dev'      },
  { keywords: 'data+analyst',       label: 'Data Analyst' },
];

const LOCATION    = 'Ethiopia';
const GUEST_API   = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const MAX_PER_QRY = 10;
const TIMEOUT     = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);
const DELAY       = parseInt(process.env.REQUEST_DELAY_MS   || '2000',  10);

// Browser-like headers — LinkedIn checks these
const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer'        : 'https://www.linkedin.com/jobs/search/',
  'Cache-Control'  : 'no-cache',
  'Sec-Fetch-Dest' : 'empty',
  'Sec-Fetch-Mode' : 'cors',
  'Sec-Fetch-Site' : 'same-origin',
};

// ─────────────────────────────────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse LinkedIn guest API HTML fragment — returns raw card objects.
 */
function parseGuestApiHtml(html) {
  const $     = cheerio.load(html);
  const cards = [];

  // LinkedIn guest API returns <li> elements with these selectors
  $('li').each((_, el) => {
    const $el = $(el);

    const title = $el.find(
      '.base-search-card__title, h3.base-search-card__title, .job-search-card__title'
    ).first().text().trim();

    if (!title) return;

    const company = $el.find(
      '.base-search-card__subtitle, h4.base-search-card__subtitle, .job-search-card__company-name'
    ).first().text().trim();

    const location = $el.find(
      '.job-search-card__location, .base-search-card__metadata span'
    ).first().text().trim();

    const postedDate = $el.find(
      'time, .job-search-card__listdate, .base-search-card__metadata time'
    ).first().attr('datetime') || null;

    // Job URL — strip tracking params
    let href = $el.find('a.base-card__full-link, a[href*="/jobs/view/"]').first().attr('href') || '';
    if (href.includes('?')) href = href.split('?')[0];

    if (!href || !title) return;

    cards.push({ title, company: company || 'LinkedIn Company', location, href, postedDate });
  });

  return cards;
}

/**
 * Normalize a parsed card into our system's job shape.
 */
function normalizeJob(card) {
  const jobId = 'lnkd_' + Buffer.from(card.href).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 20);

  return {
    id          : jobId,
    source      : SOURCE_NAME,
    sourceUrl   : card.href,
    title       : card.title,
    company     : card.company,
    companySlug : '',
    careerLevel : 'Entry Level',
    workExpName : 'Entry Level',
    description : '',          // LinkedIn doesn't expose description in list view
    descHtml    : '',
    categories  : ['Information Technology'],
    salary      : null,
    location    : card.location || LOCATION,
    deadline    : null,
    published   : card.postedDate,
    applyMethod : 'URL',
    applyEmail  : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN SCRAPER
// ─────────────────────────────────────────────────────────────────────────

async function scrape() {
  logger.step('🌐', `Scraping ${SOURCE_NAME}...`);

  const seen = new Set();
  const jobs = [];

  for (const query of SEARCH_QUERIES) {
    const url = `${GUEST_API}?keywords=${query.keywords}&location=${encodeURIComponent(LOCATION)}&f_E=1%2C2&f_TPR=r86400&start=0`;

    try {
      logger.dim(`  [LinkedIn] Trying: ${query.label} (${query.keywords})`);

      const resp = await axios.get(url, {
        headers : HEADERS,
        timeout : TIMEOUT,
        maxRedirects: 3,
      });

      // LinkedIn returns 999 for bot-detected requests — treat same as 403
      if (resp.status === 999 || resp.status === 429) {
        logger.warn(`[LinkedIn] Blocked (${resp.status}) on "${query.label}" — skipping`);
        continue;
      }

      const html  = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      const cards = parseGuestApiHtml(html);

      logger.dim(`  [LinkedIn] "${query.label}" → ${cards.length} cards parsed`);

      for (const card of cards.slice(0, MAX_PER_QRY)) {
        if (!card.href || seen.has(card.href)) continue;
        seen.add(card.href);
        jobs.push(normalizeJob(card));
      }

    } catch (err) {
      // 403, 429, 999, network error — all treated as blocked, not a crash
      const status = err.response?.status;
      const msg    = status
        ? `HTTP ${status} — LinkedIn is blocking this request`
        : err.message;
      logger.warn(`[LinkedIn] ${query.label} blocked: ${msg}`);
    }

    // Polite delay between queries
    await new Promise(r => setTimeout(r, DELAY));
  }

  if (jobs.length === 0) {
    logger.warn('[LinkedIn] No jobs retrieved — site may be blocking scraper (this is normal). Pipeline continues.');
  } else {
    logger.ok(`[LinkedIn] Scraped ${jobs.length} jobs total`);
  }

  return jobs;
}

module.exports = { scrape, SOURCE_NAME };
