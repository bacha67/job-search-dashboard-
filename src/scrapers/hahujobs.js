'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── Jiji Ethiopia Scraper (replaces defunct HahuJobs) ────────────────────
// jiji.com.et has a dedicated Jobs section with IT-related listings including
// internship postings. The site uses Nuxt.js SSR — static HTML with job data
// embedded in the page. Cards use class .b-advert-title-inner.
// Direct URL for IT/tech jobs: /bole/it-jobs or search-based URLs.

const SOURCE_NAME = 'Jiji';
const BASE_URL    = 'https://jiji.com.et';

// Direct IT job search URLs on Jiji — using the Jobs section only
// /jobs path restricts to job ads, not product listings
const LISTING_URLS = [
  `${BASE_URL}/jobs?query=software+developer+ethiopia`,
  `${BASE_URL}/jobs?query=IT+officer+ethiopia`,
  `${BASE_URL}/jobs?query=junior+developer+ethiopia`,
  `${BASE_URL}/jobs?query=intern+developer+ethiopia`,
  `${BASE_URL}/jobs?query=web+developer+ethiopia`,
];

// Titles that indicate product/service listings, not job vacancies — skip these
const PRODUCT_AD_PATTERNS = [
  /\blaptop\b/i, /\bcomputer\b/i, /\bphone\b/i, /\bsoftware subscription\b/i,
  /\bide subscription\b/i, /\bai ide\b/i, /cursor ai ide\b/i, /\bworkstation\b/i,
  /\bsetup service\b/i, /\bconfiguration service\b/i, /\bcopilot.*setup\b/i,
  /\bproject tracker toolkit\b/i, /\bos complete\b/i, /\bssd \d+gb\b/i,
  /\bram \d+gb\b/i, /intel core/i, /\bzbook\b/i, /\bthinkpad\b/i,
];

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer'        : 'https://jiji.com.et/jobs',
  'Cache-Control'  : 'no-cache',
};

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

/**
 * Parse Jiji's SSR HTML to extract job listings.
 * Key selectors found from page inspection:
 *  - .b-advert-title-inner.qa-advert-title  → job title
 *  - .b-list-advert__region__text           → location
 *  - .qa-advert-price                       → salary range
 *  - .b-list-advert-base__item-attr         → job type (Full-Time, Internship, etc.)
 *  - a.qa-advert-list-item[href]            → job URL
 */
function parseListingPage(html) {
  const $    = cheerio.load(html);
  const jobs = [];

  // Each job is wrapped in <a class="b-list-advert-base qa-advert-list-item">
  $('a.qa-advert-list-item').each((_, el) => {
    const $el = $(el);

    const title = $el.find('.b-advert-title-inner.qa-advert-title, .b-advert-title-inner').first().text().trim();
    if (!title || title.length < 3) return;

    // Skip product/service listings that are not actual job vacancies
    if (PRODUCT_AD_PATTERNS.some(rx => rx.test(title))) return;

    // Build full URL from href
    let href = $el.attr('href') || '';
    if (href && !href.startsWith('http')) href = BASE_URL + href;
    if (!href) return;

    const salary  = $el.find('.qa-advert-price').first().text().trim();
    const location = $el.find('.b-list-advert__region__text').first().text().trim() || 'Ethiopia';
    const jobType  = $el.find('.b-list-advert-base__item-attr').first().text().trim();
    const snippet  = $el.find('.b-list-advert-base__description-text').first().text().trim();

    jobs.push({ title, url: href, salary, location, jobType, snippet });
  });

  return jobs;
}

/**
 * Fetch a Jiji job detail page and return full text content.
 */
async function fetchJobDetail(url) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
    const $    = cheerio.load(resp.data);
    $('script, style, nav, footer, header').remove();

    // Jiji detail: description in .b-advert-description or .qa-advert-description
    const body = $(
      '.b-advert-description, .qa-advert-description, .b-advert__description, main article'
    ).text().replace(/\s+/g, ' ').trim();

    return body || $('main').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
  } catch (err) {
    logger.warn(`[Jiji] Detail fetch failed for ${url}: ${err.message}`);
    return '';
  }
}

function normalizeJob(card, detail) {
  const jobId = 'jiji_' + Buffer.from(card.url).toString('base64').slice(0, 20);
  const isInternship = /internship/i.test(card.jobType);

  return {
    id         : jobId,
    source     : SOURCE_NAME,
    sourceUrl  : card.url,
    title      : card.title,
    company    : 'Via Jiji Ethiopia',
    companySlug: '',
    // Set careerLevel to 'Intern' if job type is Internship — helps the filter
    careerLevel: isInternship ? 'Entry Level (Intern)' : '',
    workExpName: '',
    description: (card.snippet + ' ' + detail +
      (card.salary ? ` Salary: ${card.salary}.` : '') +
      (isInternship ? ' internship entry level.' : '')).trim(),
    descHtml   : '',
    categories : ['Information Technology'],
    salary     : card.salary || null,
    location   : card.location,
    deadline   : null,
    published  : null,
    applyMethod: 'URL',
    applyEmail : null,
  };
}

async function scrape() {
  logger.step('🌐', `Scraping ${SOURCE_NAME}...`);

  const seen  = new Set();
  const jobs  = [];
  const max   = parseInt(process.env.MAX_JOBS_PER_PORTAL || '50', 10);
  const delay = parseInt(process.env.REQUEST_DELAY_MS    || '2000', 10);

  for (const url of LISTING_URLS) {
    try {
      logger.dim(`  Fetching: ${url}`);
      const resp  = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
      const cards = parseListingPage(resp.data);
      logger.dim(`  Found ${cards.length} job cards at ${url}`);

      for (const card of cards) {
        if (!card.url || seen.has(card.url)) continue;
        seen.add(card.url);

        const detail = await fetchJobDetail(card.url);
        await new Promise(r => setTimeout(r, delay));

        jobs.push(normalizeJob(card, detail));
        if (jobs.length >= max) break;
      }
    } catch (err) {
      logger.error(`[Jiji] Failed listing ${url}: ${err.message}`);
    }

    if (jobs.length >= max) break;
    await new Promise(r => setTimeout(r, delay));
  }

  logger.ok(`[Jiji] Scraped ${jobs.length} jobs total`);
  return jobs;
}

module.exports = { scrape, SOURCE_NAME };
