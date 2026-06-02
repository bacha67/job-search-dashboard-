'use strict';

const axios   = require('axios');
const logger  = require('../utils/logger');

// ─── Ethiojobs Scraper ─────────────────────────────────────────────────────
// Ethiojobs is a Next.js app. All job data is embedded as JSON inside the
// <script id="__NEXT_DATA__"> tag on the listing page. We parse it directly.
// NOTE: The sector= URL param is ignored server-side; Ethiojobs always returns
// the same mixed pool of jobs. We rely on client-side catalog filtering.

const SOURCE_NAME = 'Ethiojobs';
const BASE_URL    = 'https://ethiojobs.net';

// IT-related catalog names exactly as they appear in job data
const IT_CATALOGS = new Set([
  'information technology',
  'it & telecom',
  'it and telecom',
  'engineering',
  'software',
  'technology',
  'computer science',
  'telecommunications',
  'telecom',
  'ict',
]);

// Scrape multiple pages of the main jobs listing
const LISTING_URLS = [
  `${BASE_URL}/jobs`,
  `${BASE_URL}/jobs?page=2`,
  `${BASE_URL}/jobs?page=3`,
];

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection'     : 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

function extractNextData(html) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match || !match[1]) return null;
    return JSON.parse(match[1]);
  } catch (err) {
    logger.warn(`[Ethiojobs] Failed to parse __NEXT_DATA__: ${err.message}`);
    return null;
  }
}

/**
 * Check if a raw job's catalogs contain an IT-related category.
 */
function isITJob(raw) {
  const catalogs = (raw.catalogs || []).map(c => c.name.toLowerCase());
  if (catalogs.some(c => IT_CATALOGS.has(c))) return true;

  // Also match by title keywords as a second pass
  const title = (raw.title || '').toLowerCase();
  const IT_TITLE_WORDS = [
    'software', 'developer', 'programmer', 'it ', 'ict', 'network',
    'system admin', 'database', 'devops', 'data ', 'web ', 'mobile ',
    'flutter', 'react', 'python', 'java', 'php', 'engineer',
    'cybersecur', 'help desk', 'helpdesk', 'tech support',
  ];
  return IT_TITLE_WORDS.some(k => title.includes(k));
}

async function fetchListingPage(url) {
  try {
    logger.dim(`  Fetching: ${url}`);
    const resp = await axios.get(url, {
      headers: HEADERS, timeout: TIMEOUT, responseType: 'text',
    });
    const nextData = extractNextData(resp.data);
    if (!nextData) { logger.warn(`[Ethiojobs] No __NEXT_DATA__ at ${url}`); return []; }
    const jobs = nextData?.props?.pageProps?.jobs?.data || [];
    logger.dim(`  Found ${jobs.length} raw jobs at ${url}`);
    return jobs;
  } catch (err) {
    logger.error(`[Ethiojobs] Failed to fetch ${url}: ${err.message}`);
    return [];
  }
}

async function fetchJobDetail(slug) {
  const detailUrl = `${BASE_URL}/jobs/${slug}`;
  try {
    const resp = await axios.get(detailUrl, {
      headers: HEADERS, timeout: TIMEOUT, responseType: 'text',
    });
    const nextData = extractNextData(resp.data);
    return nextData?.props?.pageProps?.job || null;
  } catch (err) {
    logger.warn(`[Ethiojobs] Detail fetch failed for ${slug}: ${err.message}`);
    return null;
  }
}

function normalizeJob(raw, detail) {
  const full   = detail || raw;
  const jobUrl = `${BASE_URL}/jobs/${raw.slug}`;
  const descHtml = full.description  || raw.description  || '';
  const reqHtml  = full.requirement  || raw.requirement   || '';
  const rawText  = (descHtml + ' ' + reqHtml)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    id         : `ethiojobs_${raw.id}`,
    source     : SOURCE_NAME,
    sourceUrl  : jobUrl,
    title      : raw.title || '',
    company    : raw.company?.name || 'Unknown Company',
    companySlug: raw.company?.slug || '',
    careerLevel: raw.career_level_name?.label || '',
    workExpName: raw.work_experience_name || '',
    description: rawText,
    descHtml   : descHtml + ' ' + reqHtml,
    categories : (raw.catalogs || []).map(c => c.name),
    salary     : raw.salary_currency || null,
    location   : [raw.city, raw.state].filter(Boolean).join(', '),
    deadline   : raw.date_expiry || null,
    published  : raw.date_published || null,
    applyMethod: raw.application_method || null,
    applyEmail : raw.application_email || null,
  };
}

async function scrape() {
  logger.step('🌐', `Scraping ${SOURCE_NAME}...`);

  const seen  = new Set();
  const jobs  = [];
  const max   = parseInt(process.env.MAX_JOBS_PER_PORTAL || '50', 10);
  const delay = parseInt(process.env.REQUEST_DELAY_MS    || '2000', 10);

  for (const url of LISTING_URLS) {
    const rawJobs = await fetchListingPage(url);

    // ── Client-side IT filter ──────────────────────────────────────────
    const itJobs = rawJobs.filter(isITJob);
    logger.dim(`  IT-relevant: ${itJobs.length}/${rawJobs.length} after catalog filter`);

    for (const raw of itJobs) {
      if (!raw.slug || seen.has(raw.slug)) continue;
      seen.add(raw.slug);

      const detail     = await fetchJobDetail(raw.slug);
      await new Promise(r => setTimeout(r, delay));

      jobs.push(normalizeJob(raw, detail));
      if (jobs.length >= max) { logger.dim(`  Hit max (${max}) for ${SOURCE_NAME}`); break; }
    }

    if (jobs.length >= max) break;
    await new Promise(r => setTimeout(r, delay));
  }

  logger.ok(`[Ethiojobs] Scraped ${jobs.length} IT jobs total`);
  return jobs;
}

module.exports = { scrape, SOURCE_NAME };
