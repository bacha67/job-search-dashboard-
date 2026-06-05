'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const crypto  = require('crypto');
const logger  = require('../utils/logger');
const { hasSeen } = require('../db/store');
const { isTechField } = require('../filter/sanitizer');

// ─── Ethiojobs Scraper ──────────────────────────────────────────────────────
//
// LISTING PAGES: Next.js app — job data is in <script id="__NEXT_DATA__">
//   Structure: pageProps.jobs.data[] + pageProps.jobs.meta.lastPage
//
// DETAIL PAGES: SSR for SEO — body text has full content (~22KB).
//   Also has __NEXT_DATA__ with pageProps.data (structured job object).
//   We extract rawText from body + structured fields from __NEXT_DATA__.

const SOURCE_NAME = 'EthioJobs';
const BASE_URL    = 'https://ethiojobs.net';
const DELAY_MS    = 1500; // 1.5s between detail page fetches

const CATEGORY_URLS = [
  `${BASE_URL}/jobs?category=Information+Technology`,
  `${BASE_URL}/jobs?category=Computer+Science`,
  `${BASE_URL}/jobs?category=Engineering`,
  `${BASE_URL}/jobs?category=Telecommunication`,
];

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control'  : 'no-cache',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url) {
  const resp = await axios.get(url, { headers: HEADERS, timeout: 25000 });
  return resp.data;
}

function parseNextData(html) {
  const $ = cheerio.load(html);
  const ndTag = $('script').filter((_, el) => $(el).attr('id') === '__NEXT_DATA__').html();
  if (!ndTag) return null;
  try { return JSON.parse(ndTag); } catch { return null; }
}

// ─── Listing page ────────────────────────────────────────────────────────────

/**
 * Extract job slugs + total page count from a listing page __NEXT_DATA__.
 * Correct paths (confirmed by debug):
 *   slugs      → pageProps.jobs.data[].slug
 *   totalPages → pageProps.jobs.meta.lastPage
 */
function extractListingData(html) {
  const nd = parseNextData(html);
  if (!nd) return { jobs: [], totalPages: 1 };

  const pp         = nd?.props?.pageProps ?? {};
  const jobsObj    = pp.jobs ?? {};
  const jobs       = Array.isArray(jobsObj) ? jobsObj : (jobsObj.data ?? []);
  const totalPages = jobsObj.meta?.lastPage ?? jobsObj.lastPage ?? 1;

  const jobCards = jobs.map(j => ({
    title: String(j.title || '').trim(),
    slug: String(j.slug || j.jobSlug || '').trim()
  })).filter(j => j.slug);

  return { jobs: jobCards, totalPages: Number(totalPages) || 1 };
}

// ─── Detail page ─────────────────────────────────────────────────────────────

/**
 * Fetch a job detail page and return a raw job object.
 * - Extracts rawText from body (SSR rendered, ~22KB)
 * - Also extracts structured fields from __NEXT_DATA__.pageProps.data
 * Returns null on failure.
 */
async function scrapeDetailPage(slug) {
  const url = `${BASE_URL}/jobs/${slug}`;
  try {
    const html = await fetchHtml(url);
    const $    = cheerio.load(html);

    // Remove noise
    $('script, style, noscript, nav, footer, header, iframe, .cookie-banner').remove();
    const rawText = $('body').text().replace(/\s+/g, ' ').trim();

    if (rawText.length < 100) {
      // Try to get content from __NEXT_DATA__ on detail page
      const nd  = parseNextData(html);
      const job = nd?.props?.pageProps?.data ?? nd?.props?.pageProps?.job ?? null;
      if (!job) {
        logger.warn(`[Ethiojobs] Thin page, no fallback: ${url}`);
        return null;
      }
      // Build rawText from structured fields
      const descText = stripHtml(job.description);
      if (descText.length < 50) {
        logger.warn(`[Ethiojobs] Skipping empty job: ${url}`);
        return null;
      }
      return buildJobFromData(job, url, descText);
    }

    // Primary path: body text is rich — also try __NEXT_DATA__ for structured fields
    const nd  = parseNextData(html);
    const job = nd?.props?.pageProps?.data ?? nd?.props?.pageProps?.job ?? null;

    if (job) {
      return buildJobFromData(job, url, rawText.slice(0, 8000));
    }

    // Fallback: extract fields from HTML directly
    const title    = $('h1').first().text().trim() || slug.split('-').slice(1).join(' ');
    const company  = $('[class*="company"], [class*="employer"]').first().text().trim() || '';
    const location = $('[class*="location"], [class*="place"]').first().text().trim() || 'Addis Ababa, Ethiopia';
    const deadline = $('[class*="deadline"], [class*="expire"]').first().text().trim() || 'Not specified';

    return {
      id       : makeId(url),
      title    : title.slice(0, 200),
      company  : company.slice(0, 200),
      location : location.slice(0, 200),
      deadline : deadline.slice(0, 100),
      rawText  : rawText.slice(0, 8000),
      url,
      sourceUrl: url,
      source   : SOURCE_NAME,
    };

  } catch (err) {
    logger.warn(`[Ethiojobs] Detail fetch failed for ${slug}: ${err.message}`);
    return null;
  }
}

function buildJobFromData(job, url, rawText) {
  const desc = stripHtml(job.description || job.body || '');
  return {
    id       : makeId(url),
    title    : String(job.title || '').trim().slice(0, 200),
    company  : String(job.company?.name || job.company || job.employer || '').trim().slice(0, 200),
    location : String(job.location || job.city || 'Addis Ababa, Ethiopia').trim().slice(0, 200),
    deadline : String(job.deadline || job.expiry || job.closing_date || 'Not specified').trim().slice(0, 100),
    rawText  : (rawText + '\n\n' + desc).slice(0, 8000),
    url,
    sourceUrl: url,
    source   : SOURCE_NAME,
  };
}

// ─── Category scraper ─────────────────────────────────────────────────────────

async function scrapeCategory(categoryUrl) {
  const allSlugs = new Set();
  let page = 1;
  let totalPages = 1;
  const maxPages = parseInt(process.env.MAX_LISTING_PAGES || '5', 10);

  do {
    const pageUrl = page === 1 ? categoryUrl : `${categoryUrl}&page=${page}`;
    try {
      const html = await fetchHtml(pageUrl);
      const { jobs, totalPages: tp } = extractListingData(html);

      if (jobs.length === 0) break;

      // Check if all slugs on this page have already been seen
      let allSeen = true;
      let addedThisPage = 0;
      for (const card of jobs) {
        // PRE-FILTER: skip non-tech titles immediately to protect network & time
        if (!isTechField({ title: card.title })) {
          continue;
        }

        const url = `${BASE_URL}/jobs/${card.slug}`;
        const id = makeId(url);
        if (!hasSeen(id)) {
          allSeen = false;
        }
        allSlugs.add(card.slug);
        addedThisPage++;
      }

      if (page === 1) totalPages = tp;

      const cat = categoryUrl.split('=').pop();
      logger.dim(`  [Ethiojobs] ${cat} — page ${page}/${totalPages} | +${addedThisPage} tech slugs (total: ${allSlugs.size})`);

      if (allSeen && addedThisPage > 0) {
        logger.ok(`  [Ethiojobs] ${cat} — stopping listing pagination early: all tech jobs on page ${page} have already been seen.`);
        break;
      }

    } catch (err) {
      logger.warn(`[Ethiojobs] Listing page ${page} failed: ${err.message}`);
      break;
    }

    page++;
    await delay(800);
  } while (page <= totalPages && page <= maxPages);

  return [...allSlugs];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function scrapeEthioJobs() {
  logger.step('🌐', `Scraping ${SOURCE_NAME} (${CATEGORY_URLS.length} categories)...`);

  // Step 1: Collect all unique slugs
  const allSlugs = new Set();
  for (const catUrl of CATEGORY_URLS) {
    const slugs = await scrapeCategory(catUrl);
    slugs.forEach(s => allSlugs.add(s));
  }

  const slugList = [...allSlugs];
  logger.ok(`[Ethiojobs] ${slugList.length} unique slugs found — filtering out already seen/processed...`);

  // Pre-filter slugList to skip already seen ones before fetching details
  const newSlugs = [];
  for (const slug of slugList) {
    const url = `${BASE_URL}/jobs/${slug}`;
    const id = makeId(url);
    if (!hasSeen(id)) {
      newSlugs.push(slug);
    }
  }

  logger.ok(`[Ethiojobs] ${newSlugs.length}/${slugList.length} slugs are new — fetching detail pages...`);

  const maxJobs = parseInt(process.env.MAX_JOBS_PER_PORTAL || '50', 10);

  // Step 2: Fetch detail pages
  const jobs = [];
  for (let i = 0; i < newSlugs.length; i++) {
    if (jobs.length >= maxJobs) {
      logger.ok(`[Ethiojobs] Reached limit of ${maxJobs} jobs — stopping detail page fetches.`);
      break;
    }

    const job = await scrapeDetailPage(newSlugs[i]);
    if (job) {
      jobs.push(job);
      logger.dim(`  [Ethiojobs] ✓ ${jobs.length}/${newSlugs.length} — ${job.title.slice(0, 60)}`);
    }
    await delay(DELAY_MS);
  }

  logger.ok(`[Ethiojobs] Scraped ${jobs.length} new jobs from ${newSlugs.length} new slugs`);
  return jobs;
}

module.exports = { scrape: scrapeEthioJobs, scrapeEthioJobs, SOURCE_NAME };
