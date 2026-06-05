'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const crypto  = require('crypto');
const logger  = require('../utils/logger');

// ─── Ethiojobs Scraper ──────────────────────────────────────────────────────
//
// LISTING PAGES: Ethiojobs is a Next.js app. Listing pages inject content
// client-side (cheerio finds 0 job cards). We use cheerio to extract the
// __NEXT_DATA__ <script> tag which contains all job slugs as server-side JSON.
//
// DETAIL PAGES: Fully server-side rendered for SEO. Cheerio works perfectly.
// We extract the complete rawText so Groq AI can parse all structured fields.

const SOURCE_NAME = 'EthioJobs';
const BASE_URL    = 'https://ethiojobs.net';
const DELAY_MS    = 1500; // 1.5s between detail page requests

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

async function fetchHtml(url) {
  const resp = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  return resp.data;
}

/**
 * Extract job slugs and pagination info from a listing page via __NEXT_DATA__.
 * Returns { slugs: string[], totalPages: number }
 */
function extractListingData(html) {
  const $ = cheerio.load(html);
  const scriptTag = $('script[id=__NEXT_DATA__]').html();
  if (!scriptTag) return { slugs: [], totalPages: 1 };

  try {
    const nextData   = JSON.parse(scriptTag);
    const pageProps  = nextData?.props?.pageProps ?? {};

    // Structure: pageProps.jobs.data[] + pageProps.jobs.meta.last_page
    const jobsObj    = pageProps.jobs ?? {};
    const jobs       = jobsObj.data ?? pageProps.data?.jobs ?? [];
    const totalPages = jobsObj.meta?.last_page
                    ?? pageProps.totalPages
                    ?? 1;

    const slugs = jobs
      .map(j => j.slug || j.jobSlug || '')
      .filter(Boolean);

    return { slugs, totalPages: Number(totalPages) || 1 };
  } catch {
    return { slugs: [], totalPages: 1 };
  }
}


/**
 * Fetch a single job detail page and extract raw text + basic fields.
 * Returns null on failure (never throws).
 */
async function scrapeDetailPage(slug, categoryHint = '') {
  const url = `${BASE_URL}/jobs/${slug}`;
  try {
    const html = await fetchHtml(url);
    const $    = cheerio.load(html);

    // Remove noise elements
    $('script, style, noscript, nav, footer, header, .cookie-banner, iframe').remove();

    // Raw text — full page body for AI processing
    const rawText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);

    // Try to extract basic structured fields for the filter stage
    const title    = $('h1').first().text().trim()
                  || $('[class*="title"]').first().text().trim()
                  || slug.replace(/-/g, ' ');
    const company  = $('[class*="company"]').first().text().trim()
                  || $('[class*="employer"]').first().text().trim()
                  || '';
    const location = $('[class*="location"]').first().text().trim()
                  || $('[class*="place"]').first().text().trim()
                  || 'Addis Ababa, Ethiopia';
    const deadline = $('[class*="deadline"]').first().text().trim()
                  || $('[class*="expire"]').first().text().trim()
                  || 'Not specified';

    if (!rawText || rawText.length < 50) {
      console.warn(`[Ethiojobs] Skipping thin page: ${url}`);
      return null;
    }

    return {
      id      : makeId(url),
      title   : title.slice(0, 200),
      company : company.slice(0, 200),
      location: location.slice(0, 200),
      deadline: deadline.slice(0, 100),
      rawText,
      url,
      sourceUrl: url,
      source  : SOURCE_NAME,
    };
  } catch (err) {
    console.warn(`[Ethiojobs] Detail fetch failed for ${slug}: ${err.message}`);
    return null;
  }
}

/**
 * Scrape one category URL — paginate through ALL pages, collect slugs.
 */
async function scrapeCategory(categoryUrl) {
  const slugs = new Set();
  let page = 1;
  let totalPages = 1;

  do {
    const pageUrl = page === 1 ? categoryUrl : `${categoryUrl}&page=${page}`;
    try {
      const html = await fetchHtml(pageUrl);
      const data  = extractListingData(html);

      if (data.slugs.length === 0) {
        break; // No jobs found on this page — stop paginating
      }

      data.slugs.forEach(s => slugs.add(s));
      totalPages = data.totalPages;
      logger.dim(`  [Ethiojobs] ${categoryUrl.split('=').pop()} — page ${page}/${totalPages} | +${data.slugs.length} slugs`);

    } catch (err) {
      logger.warn(`[Ethiojobs] Listing failed (page ${page}): ${err.message}`);
      break;
    }

    page++;
    await delay(800); // small delay between listing pages
  } while (page <= totalPages);

  return [...slugs];
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Scrape all 4 Ethiojobs IT categories, fetch full detail pages.
 * Returns array of raw job objects with rawText for AI processing.
 */
async function scrapeEthioJobs() {
  logger.step('🌐', `Scraping ${SOURCE_NAME} (${CATEGORY_URLS.length} categories)...`);

  // Step 1: Collect all unique slugs across all categories
  const allSlugs = new Set();
  for (const catUrl of CATEGORY_URLS) {
    const categorySlugs = await scrapeCategory(catUrl);
    categorySlugs.forEach(s => allSlugs.add(s));
  }

  logger.ok(`[Ethiojobs] Found ${allSlugs.size} unique job slugs — fetching detail pages...`);

  // Step 2: Fetch detail pages for each unique slug
  const jobs = [];
  const slugList = [...allSlugs];

  for (let i = 0; i < slugList.length; i++) {
    const slug = slugList[i];
    const job  = await scrapeDetailPage(slug);
    if (job) {
      jobs.push(job);
      logger.dim(`  [Ethiojobs] ✓ ${i + 1}/${slugList.length} — ${job.title.slice(0, 60)}`);
    }
    await delay(DELAY_MS);
  }

  logger.ok(`[Ethiojobs] Scraped ${jobs.length} jobs from ${allSlugs.size} slugs`);
  return jobs;
}

module.exports = { scrapeEthioJobs };
