'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── Ethiojobs Scraper ─────────────────────────────────────────────────────
// Ethiojobs is a Next.js app. All job data is embedded as JSON inside the
// <script id="__NEXT_DATA__"> tag on every page. We parse it directly instead
// of using cheerio on the rendered HTML — gives us clean structured data.
//
// Pagination: We read `last_page` from the first response and auto-generate
// all subsequent page URLs, capped at MAX_LISTING_PAGES to stay within the
// GitHub Actions 30-min timeout.
//
// Category URLs: Ethiojobs ignores URL filter params server-side (returns the
// same mixed pool regardless). We apply client-side IT catalog + title filtering.
// We hit both the main listing AND category URLs to maximise coverage in case
// the API starts honouring category filters.

const SOURCE_NAME = 'Ethiojobs';
const BASE_URL    = 'https://ethiojobs.net';

// Category search URLs — tried in addition to paginated main listing.
// NOTE: 'Engineering' is intentionally excluded — it returns structural/civil
// engineers, not software/IT engineers. The sanitizer catches this too, but
// better to exclude at source.
const CATEGORY_URLS = [
  `${BASE_URL}/jobs?category=Information+Technology`,
  `${BASE_URL}/jobs?category=Computer+Science`,
  `${BASE_URL}/jobs?category=Telecommunication`,
];

// Safety caps
const MAX_LISTING_PAGES  = parseInt(process.env.ETHIOJOBS_MAX_PAGES    || '8',  10);
const MAX_CATEGORY_PAGES = parseInt(process.env.ETHIOJOBS_CAT_PAGES    || '5',  10);
const MAX_JOBS           = parseInt(process.env.MAX_JOBS_PER_PORTAL     || '80', 10);

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection'     : 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);
const DELAY   = parseInt(process.env.REQUEST_DELAY_MS   || '2000',  10);

// IT-related catalog names exactly as they appear in Ethiojobs job data
const IT_CATALOGS = new Set([
  'information technology', 'it & telecom', 'it and telecom',
  'engineering', 'software', 'technology', 'computer science',
  'telecommunications', 'telecom', 'ict',
]);

// Title keyword fallback when catalog tags aren't present.
// IMPORTANT: 'engineer' alone is NOT included — it matches structural/civil/
// mechanical engineers. Only specific tech-prefixed variants are allowed.
const IT_TITLE_WORDS = [
  'software', 'developer', 'programmer', 'it officer', 'it support',
  'ict officer', 'ict support', 'it specialist', 'it technician',
  'network engineer', 'network admin', 'systems engineer', 'system admin',
  'database admin', 'database developer', 'database engineer',
  'software engineer', 'data engineer', 'cloud engineer', 'devops engineer',
  'ml engineer', 'ai engineer', 'security engineer', 'platform engineer',
  'devops', 'data analyst', 'data scientist', 'machine learning',
  'artificial intelligence', 'cybersecur', 'help desk', 'helpdesk',
  'tech support', 'technical support', 'web developer', 'web designer',
  'mobile developer', 'mobile app', 'frontend', 'front-end', 'backend',
  'back-end', 'fullstack', 'full-stack', 'full stack',
  'flutter', 'react', 'python developer', 'java developer', 'php developer',
  'android developer', 'ios developer', 'kotlin', 'ui/ux', 'ux designer',
  'computer science', 'computer engineer', 'information technology',
  'mis officer', 'mis analyst', 'erp developer', 'odoo', 'sap',
];

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function extractNextData(html) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match?.[1]) return null;
    return JSON.parse(match[1]);
  } catch (err) {
    logger.warn(`[Ethiojobs] Failed to parse __NEXT_DATA__: ${err.message}`);
    return null;
  }
}

// Non-IT title patterns — reject immediately even if catalog says 'Engineering'
// (Ethiojobs uses 'Engineering' catalog for ALL engineering disciplines)
const NON_IT_TITLE_REJECT = [
  /\barchitect\b(?!.*software|.*it\b|.*tech|.*solution)/i, // allow "Software Architect"
  /\bstructural\b/i, /\bcivil\s+engineer/i,
  /\bmechanical\s+engineer/i, /\belectrical\s+engineer/i,
  /\bchemical\s+engineer/i, /\bfire\b.{0,12}(safety|officer)/i,
  /\bgeologist\b/i, /\bmining\b/i, /\bshot\s*firer\b/i,
  /\bnurse\b/i, /\bdoctor\b/i, /\bphysician\b/i,
  /\baccountant\b/i, /\bauditor\b/i,
  /\bdriver\b/i, /\bsecurity\s+officer\b/i, /\bguard\b/i,
  /\bchef\b/i, /\bcook\b/i, /\bwaiter\b/i,
  /\bwash\s+intern\b/i, /\bwash\s+officer\b/i,
  /\bfacilities\s+engineer\b/i, /\bmaintenance\s+engineer\b/i,
];

function isITJob(raw) {
  const title    = (raw.title || '').toLowerCase();
  const catalogs = (raw.catalogs || []).map(c => c.name.toLowerCase());

  // Hard-reject non-IT engineering/health/other titles first
  if (NON_IT_TITLE_REJECT.some(rx => rx.test(title))) return false;

  // Trust the structured catalog tag
  if (catalogs.some(c => IT_CATALOGS.has(c))) return true;

  // Fallback: title keyword match
  return IT_TITLE_WORDS.some(k => title.includes(k));
}

/** Strip HTML tags and decode common entities */
function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────
// LISTING PAGE FETCH — reads __NEXT_DATA__ for job list + pagination info
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fetch one listing page. Returns { jobs, lastPage }.
 */
async function fetchListingPage(url) {
  try {
    logger.dim(`  [Ethiojobs] Fetching: ${url}`);
    const resp     = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT, responseType: 'text' });
    const nextData = extractNextData(resp.data);
    if (!nextData) {
      logger.warn(`[Ethiojobs] No __NEXT_DATA__ at ${url}`);
      return { jobs: [], lastPage: 1 };
    }
    const jobsObj  = nextData?.props?.pageProps?.jobs || {};
    const jobs     = jobsObj.data || [];
    // Pagination lives under jobs.meta (confirmed by structure inspection)
    const meta     = jobsObj.meta || {};
    const lastPage = meta.lastPage || meta.last_page || 1;
    const curPage  = meta.pageNumber || meta.current_page || '?';
    logger.dim(`  [Ethiojobs] ${jobs.length} raw jobs (page ${curPage} / ${lastPage} | total: ${meta.total || '?'})`);
    return { jobs, lastPage };
  } catch (err) {
    logger.error(`[Ethiojobs] Failed to fetch ${url}: ${err.message}`);
    return { jobs: [], lastPage: 1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DETAIL PAGE FETCH — full job info from __NEXT_DATA__ on individual job page
// Also falls back to cheerio HTML parsing if __NEXT_DATA__ structure differs
// ─────────────────────────────────────────────────────────────────────────

async function fetchJobDetail(slug) {
  const detailUrl = `${BASE_URL}/jobs/${slug}`;
  try {
    const resp     = await axios.get(detailUrl, { headers: HEADERS, timeout: TIMEOUT, responseType: 'text' });
    const nextData = extractNextData(resp.data);

    // Primary: structured JSON from Next.js
    const job = nextData?.props?.pageProps?.job;
    if (job) return { source: 'json', data: job };

    // Fallback: cheerio HTML parse for key fields
    const $        = cheerio.load(resp.data);
    const html     = resp.data;

    const title    = $('h1').first().text().trim();
    const company  = $('.company-name, [class*="company"]').first().text().trim();
    const location = $('.location, [class*="location"]').first().text().trim();
    const deadline = $('[class*="deadline"], [class*="expir"]').first().text().trim();

    // Try to get description block
    const descBlock = $('[class*="description"], [class*="detail"], .job-body, main article').first().html() || '';

    // Extract responsibilities / requirements sections
    let responsibilities = '';
    let requirements     = '';
    $('h2, h3, h4, strong, b').each((_, el) => {
      const heading = $(el).text().toLowerCase().trim();
      if (/responsibilit|duties|role|what you.ll do/i.test(heading)) {
        responsibilities = $(el).nextAll('ul, ol, p').first().text().trim();
      }
      if (/requirement|qualification|must have|you need/i.test(heading)) {
        requirements = $(el).nextAll('ul, ol, p').first().text().trim();
      }
    });

    // How to apply
    const applySection = $('[class*="apply"], [class*="how-to"]').first().text().trim() ||
                         $('a[href^="mailto:"]').first().attr('href')?.replace('mailto:', '') || '';

    return {
      source: 'html',
      data: { title, company, location, deadline, descHtml: descBlock, responsibilities, requirements, applyInfo: applySection },
    };

  } catch (err) {
    logger.warn(`[Ethiojobs] Detail fetch failed for ${slug}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// NORMALISER — merges listing raw data + detail into our standard job shape
// ─────────────────────────────────────────────────────────────────────────

function normalizeJob(raw, detail) {
  const jobUrl = `${BASE_URL}/jobs/${raw.slug}`;

  let descHtml = '', reqHtml = '', responsibilities = '', applyInfo = '';

  if (detail?.source === 'json') {
    const d      = detail.data;
    descHtml      = d.description  || d.body      || '';
    reqHtml       = d.requirement  || d.requirements || '';
    responsibilities = stripHtml(d.responsibilities || d.duties || '');
    applyInfo     = d.how_to_apply || d.apply_instructions || '';
  } else if (detail?.source === 'html') {
    const d      = detail.data;
    descHtml      = d.descHtml || '';
    responsibilities = d.responsibilities || '';
    reqHtml       = d.requirements || '';
    applyInfo     = d.applyInfo   || '';
  }

  // Combine all text for sanitizer's experience-requirement checks
  const fullText = stripHtml(descHtml + ' ' + reqHtml);

  return {
    id              : `ethiojobs_${raw.id}`,
    source          : SOURCE_NAME,
    sourceUrl       : jobUrl,
    title           : raw.title           || '',
    company         : raw.company?.name   || 'Unknown Company',
    companySlug     : raw.company?.slug   || '',
    careerLevel     : raw.career_level_name?.label || '',
    workExpName     : raw.work_experience_name     || '',
    description     : fullText,
    descHtml        : descHtml + ' ' + reqHtml,
    responsibilities: responsibilities,
    categories      : (raw.catalogs || []).map(c => c.name),
    salary          : raw.salary_currency  || null,
    location        : [raw.city, raw.state].filter(Boolean).join(', ') || 'Ethiopia',
    deadline        : raw.date_expiry      || null,
    published       : raw.date_published   || null,
    applyMethod     : raw.application_method || applyInfo || null,
    applyEmail      : raw.application_email  || null,
    experience      : raw.work_experience_name || '',
    education       : raw.education_level_name?.label || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN SCRAPER
// ─────────────────────────────────────────────────────────────────────────

async function scrape() {
  logger.step('🌐', `Scraping ${SOURCE_NAME}...`);

  const seen = new Set();   // track slugs already queued
  const rawItJobs = [];     // raw IT job objects from listing pages

  // ── Phase 1: Collect raw job listings via auto-pagination ───────────────
  // Step A: Fetch page 1 to get total page count
  const { jobs: page1Jobs, lastPage } = await fetchListingPage(`${BASE_URL}/jobs`);
  const cappedLastPage = Math.min(lastPage, MAX_LISTING_PAGES);

  logger.dim(`[Ethiojobs] Total pages: ${lastPage} — will scrape up to ${cappedLastPage}`);

  // Filter IT jobs from page 1
  page1Jobs.filter(isITJob).forEach(j => {
    if (j.slug && !seen.has(j.slug)) { seen.add(j.slug); rawItJobs.push(j); }
  });

  // Step B: Fetch remaining pages 2..cappedLastPage
  for (let page = 2; page <= cappedLastPage; page++) {
    await new Promise(r => setTimeout(r, DELAY));
    const { jobs } = await fetchListingPage(`${BASE_URL}/jobs?page=${page}`);
    if (jobs.length === 0) {
      logger.dim(`[Ethiojobs] Page ${page} returned 0 jobs — stopping pagination`);
      break;
    }
    jobs.filter(isITJob).forEach(j => {
      if (j.slug && !seen.has(j.slug)) { seen.add(j.slug); rawItJobs.push(j); }
    });
  }

  // Step C: Paginate through category URLs for IT-specific jobs
  // The ?category=Information+Technology URL has 93+ pages of IT-tagged jobs
  for (const catUrl of CATEGORY_URLS) {
    for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
      await new Promise(r => setTimeout(r, DELAY));
      const pageUrl   = page === 1 ? catUrl : `${catUrl}&page=${page}`;
      const { jobs, lastPage } = await fetchListingPage(pageUrl);
      if (jobs.length === 0) break;
      jobs.filter(isITJob).forEach(j => {
        if (j.slug && !seen.has(j.slug)) { seen.add(j.slug); rawItJobs.push(j); }
      });
      if (page >= lastPage) break;  // no more pages for this category
    }
  }

  logger.ok(`[Ethiojobs] Found ${rawItJobs.length} unique IT jobs across all listing pages`);

  // ── Phase 2: Fetch detail pages for each job ─────────────────────────────
  const jobs   = [];
  const toFetch = rawItJobs.slice(0, MAX_JOBS);

  for (const raw of toFetch) {
    const detail = await fetchJobDetail(raw.slug);
    await new Promise(r => setTimeout(r, DELAY));
    jobs.push(normalizeJob(raw, detail));
    logger.dim(`  ✓ ${jobs.length}/${toFetch.length} — ${raw.title} @ ${raw.company?.name || '?'}`);
  }

  logger.ok(`[Ethiojobs] Scraped ${jobs.length} full IT job records`);
  return jobs;
}

// Export using our convention + Claude's alias for compatibility
module.exports = { scrape, SOURCE_NAME, scrapeEthioJobs: scrape };
