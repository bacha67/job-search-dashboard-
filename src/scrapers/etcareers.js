'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── ETcareers Scraper ────────────────────────────────────────────────────
// etcareers.com is a Rails/Jobboardly-based job board focused on Ethiopian jobs.
// It renders server-side HTML — fully scrapable with standard cheerio parsing.
// Category IDs confirmed from page source:
//   5283 = IT & Software Development Jobs in Ethiopia
//   5279 = Fresh Graduate Jobs in Ethiopia

const SOURCE_NAME = 'ETcareers';
const BASE_URL    = 'https://etcareers.com';

const LISTING_URLS = [
  `${BASE_URL}/jobs?category_id=5283`,          // IT & Software Development
  `${BASE_URL}/jobs?category_id=5283&page=2`,   // IT page 2
  `${BASE_URL}/jobs?category_id=5279`,          // Fresh Graduate (any field — filtered downstream)
  `${BASE_URL}/jobs?q=developer`,               // Keyword search: developer
  `${BASE_URL}/jobs?q=software+engineer`,       // Keyword search: software engineer
];

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer'        : 'https://etcareers.com/jobs',
  'Cache-Control'  : 'no-cache',
};

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

/**
 * Parse the listing page HTML.
 * Job cards: <a class="block rounded-xl border" href="/jobs/slug">
 *   Title: <h3 class="text-lg font-medium">
 *   Company: <p class="text-sm truncate"> (first p after h3)
 *   Job type: <p class="inline-flex ... rounded-md ..."> badge
 */
function parseListingPage(html) {
  const $    = cheerio.load(html);
  const jobs = [];

  // Each job is wrapped in an <a> block card
  $('a.block.rounded-xl').each((_, el) => {
    const $el = $(el);

    const title = $el.find('h3').first().text().trim();
    if (!title || title.length < 3) return;

    let href = $el.attr('href') || '';
    if (href && !href.startsWith('http')) href = BASE_URL + href;
    if (!href || href.includes('/jobs/new')) return;

    const company = $el.find('p.text-sm.truncate').first().text().trim() ||
                    $el.find('p').first().text().trim();

    // Job type badge — the small pill labels
    const jobType = $el.find('p.inline-flex, span.inline-flex').filter((_, e) =>
      /full.time|part.time|contract|internship|temporary|volunteer/i.test($(e).text())
    ).first().text().trim();

    // Location from SVG-preceded text
    const location = $el.find('span.truncate').filter((_, e) => {
      const t = $(e).text().trim();
      return t.length > 2 && !/full.time|part.time|contract|internship/i.test(t);
    }).first().text().trim() || 'Ethiopia';

    // Date posted — last text segment near the card bottom
    const dateText = $el.find('p').last().text().trim();

    jobs.push({ title, url: href, company, jobType, location, dateText });
  });

  return jobs;
}

/**
 * Fetch job detail page and extract description.
 * ETcareers uses Rails with rich-text stored in [itemprop="description"] or .rich-text
 */
async function fetchJobDetail(url) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
    const $    = cheerio.load(resp.data);

    // Remove nav/header/footer/scripts
    $('script, style, nav, footer, header, .boards-jobs-filters').remove();

    const desc = $('[itemprop="description"], .rich-text, .job-description, .prose').text()
      .replace(/\s+/g, ' ').trim();

    // Also grab any listed requirements or qualifications sections
    const extra = $('h2, h3').filter((_, e) =>
      /requirement|qualification|skill|about/i.test($(e).text())
    ).map((_, e) => {
      const section = $(e).next('ul, ol, p, div').text().trim();
      return section;
    }).get().join(' ');

    return ((desc + ' ' + extra).trim()).slice(0, 4000);
  } catch (err) {
    logger.warn(`[ETcareers] Detail fetch failed for ${url}: ${err.message}`);
    return '';
  }
}

function normalizeJob(card, detail) {
  const jobId = 'etc_' + Buffer.from(card.url).toString('base64').slice(0, 20);
  const isInternship = /internship/i.test(card.jobType);
  const isFreshGrad  = /fresh|graduate|entry/i.test(card.jobType + ' ' + detail.slice(0, 200));

  return {
    id         : jobId,
    source     : SOURCE_NAME,
    sourceUrl  : card.url,
    title      : card.title,
    company    : card.company || 'ETcareers Employer',
    companySlug: '',
    careerLevel: isInternship ? 'Entry Level (Intern)'
                : isFreshGrad  ? 'Entry Level (Fresh Graduate)'
                : '',
    workExpName: '',
    description: (detail + (isInternship ? ' internship entry level fresh graduate.' : '')).trim(),
    descHtml   : '',
    categories : ['Information Technology', 'Software Development'],
    salary     : null,
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
      logger.error(`[ETcareers] Failed listing ${url}: ${err.message}`);
    }

    if (jobs.length >= max) break;
    await new Promise(r => setTimeout(r, delay));
  }

  logger.ok(`[ETcareers] Scraped ${jobs.length} jobs total`);
  return jobs;
}

module.exports = { scrape, SOURCE_NAME };
