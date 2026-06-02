'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── GeezJobs Scraper ─────────────────────────────────────────────────────
// GeezJobs is an Ethiopian job aggregator. Main site returns 403.
// Strategy: Try RSS feed, sitemap, and alternate URLs before giving up.

const SOURCE_NAME = 'GeezJobs';
const BASE_URL    = 'https://geezjobs.com';

const ATTEMPT_URLS = [
  `${BASE_URL}/feed`,
  `${BASE_URL}/jobs/feed`,
  `${BASE_URL}/jobs.rss`,
  `${BASE_URL}/sitemap.xml`,
  `${BASE_URL}/job-listings`,
  `${BASE_URL}/vacancies`,
  `${BASE_URL}/jobs/?category=it`,
  `${BASE_URL}/jobs/?category=software`,
];

// Very aggressive browser simulation — GeezJobs returns 403 to bots
const HEADERS = {
  'User-Agent'                : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept'                    : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language'           : 'en-US,en;q=0.9',
  'Accept-Encoding'           : 'gzip, deflate, br',
  'Connection'                : 'keep-alive',
  'Upgrade-Insecure-Requests' : '1',
  'Sec-Fetch-Dest'            : 'document',
  'Sec-Fetch-Mode'            : 'navigate',
  'Sec-Fetch-Site'            : 'none',
  'Cache-Control'             : 'max-age=0',
  'Cookie'                    : '',
};

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

/**
 * Try to parse an RSS/Atom feed for job listings.
 */
function parseRssFeed(xml) {
  const $    = cheerio.load(xml, { xmlMode: true });
  const jobs = [];

  $('item, entry').each((_, el) => {
    const $el = $(el);
    const title = ($el.find('title').first().text() || '').trim();
    if (!title || title.length < 3) return;

    const url = ($el.find('link').first().text() ||
                 $el.find('link').first().attr('href') || '').trim();
    if (!url) return;

    const company  = ($el.find('category, dc\\:creator').first().text() || 'GeezJobs').trim();
    const snippet  = ($el.find('description, summary, content').first().text() || '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

    jobs.push({ title, url, company, jobType: '', location: 'Ethiopia', snippet });
  });

  return jobs;
}

/**
 * Parse HTML job listings — try common WordPress/custom job board selectors.
 */
function parseHtmlPage(html) {
  const $    = cheerio.load(html);
  const jobs = [];

  const selectors = [
    '.job_listing', '.job-listing', '.wpjb-job-list-row',
    '.job-card', '.vacancy', 'article.job', '.job_summary',
    'a[href*="/jobs/"]', 'a[href*="/vacancy/"]',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h2, h3, h4, .job-title, .position').first().text() ||
                     $el.attr('title') || '').trim();
      if (!title || title.length < 3) return;

      let href = ($el.is('a') ? $el.attr('href') : $el.find('a').first().attr('href')) || '';
      if (href && !href.startsWith('http')) href = BASE_URL + href;
      if (!href) return;

      const company  = $el.find('.company, .employer').first().text().trim() || 'GeezJobs';
      const location = $el.find('.location, .city').first().text().trim() || 'Ethiopia';

      jobs.push({ title, url: href, company, jobType: '', location, snippet: '' });
    });
    if (jobs.length > 0) break;
  }

  return jobs;
}

function normalizeJob(card) {
  const jobId = 'gzj_' + Buffer.from(card.url).toString('base64').slice(0, 20);
  return {
    id         : jobId,
    source     : SOURCE_NAME,
    sourceUrl  : card.url,
    title      : card.title,
    company    : card.company,
    companySlug: '',
    careerLevel: '',
    workExpName: '',
    description: card.snippet || '',
    descHtml   : '',
    categories : ['Information Technology'],
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

  const seen = new Set();
  const jobs = [];

  for (const url of ATTEMPT_URLS) {
    try {
      logger.dim(`  Trying: ${url}`);
      const resp = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
      const ct   = resp.headers['content-type'] || '';

      let cards = [];
      if (ct.includes('xml') || ct.includes('rss') || url.includes('feed') || url.includes('.rss')) {
        cards = parseRssFeed(resp.data);
      } else if (ct.includes('html')) {
        cards = parseHtmlPage(resp.data);
      }

      if (cards.length > 0) {
        logger.dim(`  Found ${cards.length} jobs at ${url}`);
        for (const card of cards) {
          if (!card.url || seen.has(card.url)) continue;
          seen.add(card.url);
          jobs.push(normalizeJob(card));
        }
        break; // stop at first working URL
      }
    } catch (err) {
      // Silently skip blocked endpoints
    }

    await new Promise(r => setTimeout(r, 500));
  }

  if (jobs.length === 0) {
    logger.warn(`[GeezJobs] All endpoints blocked or returned no jobs — skipping`);
  }

  logger.ok(`[GeezJobs] Scraped ${jobs.length} jobs total`);
  return jobs;
}

module.exports = { scrape, SOURCE_NAME };
