'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── Ethiojobs Scraper ─────────────────────────────────────────────────────
//
// ARCHITECTURE NOTE (important for future maintainers):
// ──────────────────────────────────────────────────────
// Ethiojobs.net is a Next.js application. The job LISTING pages render
// zero job cards in server HTML — all cards are injected client-side by
// React. Cheerio finds 0 job links on listing pages (confirmed by test).
//
// The ONLY reliable way to get listing data is to read the JSON blob that
// Next.js embeds in every page inside <script id="__NEXT_DATA__">.
//
// However, individual JOB DETAIL pages (/jobs/[slug]) ARE fully server-side
// rendered for SEO. Cheerio works perfectly there — we use it to grab the
// complete rawText of every detail page.
//
// Approach:
//   Listing pages  → __NEXT_DATA__ JSON  (cheerio = 0 results, proven)
//   Detail pages   → cheerio rawText     (SSR, cheerio works great)

const SOURCE_NAME = 'Ethiojobs';
const BASE_URL    = 'https://ethiojobs.net';

// Category URLs — Engineering excluded (returns civil/structural engineers,
// not software engineers — confirmed in testing).
const CATEGORY_URLS = [
  `${BASE_URL}/jobs?category=Information+Technology`,
  `${BASE_URL}/jobs?category=Computer+Science`,
  `${BASE_URL}/jobs?category=Telecommunication`,
];

const MAX_LISTING_PAGES  = parseInt(process.env.ETHIOJOBS_MAX_PAGES  || '8',  10);
const MAX_CATEGORY_PAGES = parseInt(process.env.ETHIOJOBS_CAT_PAGES  || '5',  10);
const MAX_JOBS           = parseInt(process.env.MAX_JOBS_PER_PORTAL   || '80', 10);
const TIMEOUT            = parseInt(process.env.REQUEST_TIMEOUT_MS    || '15000', 10);
const DELAY              = parseInt(process.env.REQUEST_DELAY_MS      || '1500',  10);

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection'     : 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// ─────────────────────────────────────────────────────────────────────────
// IT FILTERS (applied on listing data before fetching detail pages)
// ─────────────────────────────────────────────────────────────────────────

const IT_CATALOGS = new Set([
  'information technology', 'it & telecom', 'it and telecom',
  'software', 'technology', 'computer science', 'telecommunications', 'telecom', 'ict',
]);

const IT_TITLE_WORDS = [
  'software', 'developer', 'programmer', 'it officer', 'it support', 'it specialist',
  'it technician', 'ict officer', 'ict support', 'network engineer', 'network admin',
  'systems engineer', 'system admin', 'database admin', 'database developer',
  'database engineer', 'software engineer', 'data engineer', 'cloud engineer',
  'devops engineer', 'ml engineer', 'ai engineer', 'security engineer',
  'devops', 'data analyst', 'data scientist', 'machine learning', 'artificial intelligence',
  'cybersecur', 'help desk', 'helpdesk', 'tech support', 'technical support',
  'web developer', 'web designer', 'mobile developer', 'mobile app',
  'frontend', 'front-end', 'backend', 'back-end', 'fullstack', 'full-stack', 'full stack',
  'flutter', 'react', 'android developer', 'ios developer', 'kotlin', 'ui/ux', 'ux designer',
  'computer science', 'computer engineer', 'information technology',
  'mis officer', 'mis analyst', 'erp developer', 'odoo', 'sap',
  'product designer',  // UI/UX product designers
];

// Titles that look like 'engineering' but are NOT IT
const NON_IT_TITLE_REJECT = [
  /\barchitect\b(?!.*software|.*it\b|.*tech|.*solution)/i,
  /\bstructural\b/i, /\bcivil\s+engineer/i,
  /\bmechanical\s+engineer/i, /\belectrical\s+engineer/i,
  /\bchemical\s+engineer/i, /\bgeologist\b/i, /\bmining\b/i,
  /\bshot\s*firer\b/i, /\bnurse\b/i, /\bdoctor\b/i, /\bphysician\b/i,
  /\baccountant\b/i, /\bauditor\b/i,
  /\bdriver\b/i, /\bsecurity\s+officer\b/i, /\bguard\b/i,
  /\bchef\b/i, /\bcook\b/i, /\bwaiter\b/i,
  /\bwash\s+(intern|officer)\b/i,
  /\bfacilities\s+engineer\b/i, /\bmaintenance\s+engineer\b/i,
  /\bmonitoring\s+.{0,10}evaluation\b/i,  // M&E Specialist
  /\bvideo\s+content\b/i, /\bmedia\s+specialist\b/i,
  /\bbrand\s+manager\b/i, /\bmarketing\s+(officer|manager)\b/i,
  /\bregional\s+manager\b/i, /\bgeneral\s+manager\b/i,
  /\bsales\b/i, /\bprocurement\b/i, /\blogistics\b/i,
];

function isITJob(raw) {
  const title    = (raw.title || '').toLowerCase();
  const catalogs = (raw.catalogs || []).map(c => c.name.toLowerCase());
  if (NON_IT_TITLE_REJECT.some(rx => rx.test(title))) return false;
  if (catalogs.some(c => IT_CATALOGS.has(c))) return true;
  return IT_TITLE_WORDS.some(k => title.includes(k));
}

// ─────────────────────────────────────────────────────────────────────────
// LISTING PAGE — reads __NEXT_DATA__ (cheerio gives 0 results on this site)
// ─────────────────────────────────────────────────────────────────────────

function extractNextData(html) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match?.[1]) return null;
    return JSON.parse(match[1]);
  } catch (err) {
    logger.warn(`[Ethiojobs] __NEXT_DATA__ parse failed: ${err.message}`);
    return null;
  }
}

async function fetchListingPage(url) {
  try {
    logger.dim(`  [Ethiojobs] Listing: ${url}`);
    const resp     = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT, responseType: 'text' });
    const nextData = extractNextData(resp.data);
    if (!nextData) return { jobs: [], lastPage: 1 };

    const jobsObj  = nextData?.props?.pageProps?.jobs || {};
    const jobs     = jobsObj.data || [];
    const meta     = jobsObj.meta || {};
    const lastPage = meta.lastPage || meta.last_page || 1;
    const curPage  = meta.pageNumber || meta.current_page || '?';
    logger.dim(`  [Ethiojobs] ${jobs.length} raw jobs (page ${curPage}/${lastPage} | total: ${meta.total || '?'})`);
    return { jobs, lastPage };
  } catch (err) {
    logger.error(`[Ethiojobs] Listing fetch failed ${url}: ${err.message}`);
    return { jobs: [], lastPage: 1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DETAIL PAGE — cheerio scrapes the SSR-rendered HTML for rawText + fields
// ─────────────────────────────────────────────────────────────────────────

async function fetchDetailPage(slug) {
  const url = `${BASE_URL}/jobs/${slug}`;
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT, responseType: 'text' });
    const html = resp.data;
    const $    = cheerio.load(html);

    // ── 1. Grab complete rawText — full visible page text ─────────────────
    // Remove nav, footer, scripts, styles to get job-relevant text only
    $('nav, footer, script, style, header, [class*="navbar"], [class*="footer"]').remove();
    const rawText = $('body').text().replace(/\s+/g, ' ').trim();

    // ── 2. Also try __NEXT_DATA__ for structured fields (bonus) ──────────
    const nextData   = extractNextData(html);
    const structured = nextData?.props?.pageProps?.job || null;

    return { rawText, structured, url };
  } catch (err) {
    logger.warn(`[Ethiojobs] Detail fetch failed for ${slug}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// NORMALISE — merges listing raw + detail into our pipeline job shape
// rawText is included as a top-level field AND mapped into description
// ─────────────────────────────────────────────────────────────────────────

function cleanHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeJob(raw, detail) {
  const jobUrl = `${BASE_URL}/jobs/${raw.slug}`;
  const s      = detail?.structured;

  const descHtml      = s?.description  || s?.body         || '';
  const reqHtml       = s?.requirement  || s?.requirements  || '';
  const fullText      = detail?.rawText || cleanHtml(descHtml + ' ' + reqHtml);
  const responsibilities = cleanHtml(s?.responsibilities || s?.duties || '');

  return {
    // ── Core identity ───────────────────────────────────────────────────
    id          : `ethiojobs_${raw.id}`,
    source      : SOURCE_NAME,
    sourceUrl   : jobUrl,
    url         : jobUrl,               // alias (Claude's shape)

    // ── Job metadata ────────────────────────────────────────────────────
    title       : raw.title             || '',
    company     : raw.company?.name     || 'Unknown Company',
    companySlug : raw.company?.slug     || '',
    location    : [raw.city, raw.state].filter(Boolean).join(', ') || 'Ethiopia',
    deadline    : raw.date_expiry       || s?.deadline || null,

    // ── Content ─────────────────────────────────────────────────────────
    rawText     : fullText,             // FULL page text (Claude's requirement)
    description : fullText,             // mapped into pipeline description field
    descHtml    : descHtml + ' ' + reqHtml,
    responsibilities,

    // ── Structured fields ────────────────────────────────────────────────
    categories  : (raw.catalogs || []).map(c => c.name),
    careerLevel : raw.career_level_name?.label || s?.career_level || '',
    workExpName : raw.work_experience_name     || '',
    experience  : raw.work_experience_name     || '',
    education   : raw.education_level_name?.label || s?.education_level || '',
    salary      : raw.salary_currency   || s?.salary || null,
    published   : raw.date_published    || null,
    applyMethod : raw.application_method || s?.how_to_apply || null,
    applyEmail  : raw.application_email  || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN SCRAPER
// ─────────────────────────────────────────────────────────────────────────

async function scrape() {
  logger.step('🌐', `Scraping ${SOURCE_NAME}...`);

  const seen     = new Set();
  const rawItJobs = [];

  // ── Phase 1: Collect IT job slugs via __NEXT_DATA__ pagination ──────────

  // A) Main listing pages 1..MAX_LISTING_PAGES
  const { jobs: page1, lastPage } = await fetchListingPage(`${BASE_URL}/jobs`);
  const maxPage = Math.min(lastPage, MAX_LISTING_PAGES);
  logger.dim(`[Ethiojobs] ${lastPage} total pages — scraping up to ${maxPage}`);

  page1.filter(isITJob).forEach(j => {
    if (j.slug && !seen.has(j.slug)) { seen.add(j.slug); rawItJobs.push(j); }
  });

  for (let page = 2; page <= maxPage; page++) {
    await new Promise(r => setTimeout(r, DELAY));
    const { jobs } = await fetchListingPage(`${BASE_URL}/jobs?page=${page}`);
    if (jobs.length === 0) { logger.dim(`[Ethiojobs] Page ${page} empty — stopping`); break; }
    jobs.filter(isITJob).forEach(j => {
      if (j.slug && !seen.has(j.slug)) { seen.add(j.slug); rawItJobs.push(j); }
    });
  }

  // B) Category pages — paginated (these ARE server-filtered)
  for (const catUrl of CATEGORY_URLS) {
    for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
      await new Promise(r => setTimeout(r, DELAY));
      const pageUrl = page === 1 ? catUrl : `${catUrl}&page=${page}`;
      const { jobs, lastPage: catLast } = await fetchListingPage(pageUrl);
      if (jobs.length === 0) break;
      jobs.filter(isITJob).forEach(j => {
        if (j.slug && !seen.has(j.slug)) { seen.add(j.slug); rawItJobs.push(j); }
      });
      if (page >= catLast) break;
    }
  }

  logger.ok(`[Ethiojobs] ${rawItJobs.length} unique IT jobs found across all pages`);

  // ── Phase 2: Fetch full detail pages (cheerio rawText) ──────────────────
  const toFetch = rawItJobs.slice(0, MAX_JOBS);
  const jobs    = [];

  for (const raw of toFetch) {
    try {
      const detail = await fetchDetailPage(raw.slug);
      await new Promise(r => setTimeout(r, DELAY));
      jobs.push(normalizeJob(raw, detail));
      logger.dim(`  ✓ ${jobs.length}/${toFetch.length} — ${raw.title} @ ${raw.company?.name || '?'}`);
    } catch (err) {
      // Skip failed individual jobs — never crash the whole scraper
      logger.warn(`[Ethiojobs] Skipping "${raw.title}": ${err.message}`);
    }
  }

  logger.ok(`[Ethiojobs] Scraped ${jobs.length} full IT job records`);
  return jobs;
}

// Export our convention + Claude's requested alias
module.exports = { scrape, SOURCE_NAME, scrapeEthioJobs: scrape };
