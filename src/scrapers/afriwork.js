'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── Afriwork Scraper ─────────────────────────────────────────────────────
// Afriwork (afriwork.com) is Ethiopia's largest freelance/employment platform.
// Their main site uses a JS SPA that blocks server-side scraping.
// Strategy: Try their potential RSS feed and JSON API endpoint first.
// If those fail, fall back to scraping their public job feed page.

const SOURCE_NAME = 'Afriwork';
const BASE_URL    = 'https://www.afriwork.com';

// Afriwork public-facing URL patterns to attempt (in order of preference)
const ATTEMPT_URLS = [
  `${BASE_URL}/jobs.json`,                         // JSON API (some platforms expose this)
  `${BASE_URL}/api/jobs?category=it&type=job`,     // REST API attempt
  `${BASE_URL}/api/v1/jobs?q=developer`,           // Versioned API attempt
  `${BASE_URL}/feed/jobs.rss`,                     // RSS feed attempt
];

// Fallback: scrape the search page with aggressive browser simulation
const SEARCH_URLS = [
  `${BASE_URL}/search?q=software+developer&type=job`,
  `${BASE_URL}/search?q=it+officer&type=job`,
  `${BASE_URL}/search?q=web+developer&type=job`,
];

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer'        : 'https://www.google.com/',
  'Cache-Control'  : 'no-cache',
  'Pragma'         : 'no-cache',
  'sec-ch-ua'      : '"Google Chrome";v="125", "Not;A=Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest' : 'document',
  'Sec-Fetch-Mode' : 'navigate',
  'Sec-Fetch-Site' : 'cross-site',
  'Connection'     : 'keep-alive',
};

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

/**
 * Try to parse Afriwork JSON API response (if available).
 */
function parseJsonResponse(data) {
  const jobs = [];
  const items = Array.isArray(data) ? data : (data.jobs || data.data || data.results || []);
  for (const item of items.slice(0, 20)) {
    const title = item.title || item.name || item.job_title || '';
    if (!title) continue;
    const url = item.url || item.link || item.apply_url || `${BASE_URL}/jobs/${item.id || item.slug}`;
    jobs.push({
      title,
      url,
      company : item.company || item.employer || item.company_name || 'Afriwork Employer',
      jobType : item.type || item.employment_type || '',
      location: item.location || 'Addis Ababa, Ethiopia',
      snippet : item.description || item.summary || '',
    });
  }
  return jobs;
}

/**
 * Parse HTML search results page from Afriwork.
 */
function parseHtmlPage(html) {
  const $    = cheerio.load(html);
  const jobs = [];

  // Afriwork uses various selectors — try common job listing patterns
  const selectors = [
    '.job-card', '.job-item', '.vacancy-item', '.listing-item',
    '[data-job-id]', '[data-vacancy]', 'article.job', '.gig-card',
    'a[href*="/jobs/"]', 'a[href*="/vacancies/"]',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h2, h3, h4, .title, .job-title').first().text() ||
                     $el.attr('title') || '').trim();
      if (!title || title.length < 3) return;

      let href = ($el.is('a') ? $el.attr('href') : $el.find('a').first().attr('href')) || '';
      if (href && !href.startsWith('http')) href = BASE_URL + href;
      if (!href) return;

      const company = $el.find('.company, .employer, .company-name').first().text().trim();
      const location = $el.find('.location, .city').first().text().trim() || 'Ethiopia';

      jobs.push({ title, url: href, company: company || 'Afriwork Employer', jobType: '', location, snippet: '' });
    });

    if (jobs.length > 0) break; // stop at first working selector
  }

  return jobs;
}

function normalizeJob(card) {
  const jobId = 'afw_' + Buffer.from(card.url).toString('base64').slice(0, 20);
  return {
    id         : jobId,
    source     : SOURCE_NAME,
    sourceUrl  : card.url,
    title      : card.title,
    company    : card.company,
    companySlug: '',
    careerLevel: /internship/i.test(card.jobType) ? 'Entry Level (Intern)' : '',
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

  const seen  = new Set();
  const jobs  = [];
  const delay = parseInt(process.env.REQUEST_DELAY_MS || '2000', 10);

  // 1. Try JSON API endpoints first
  for (const url of ATTEMPT_URLS) {
    try {
      logger.dim(`  Trying API: ${url}`);
      const resp = await axios.get(url, {
        headers: { ...HEADERS, 'Accept': 'application/json' },
        timeout: TIMEOUT,
      });
      if (resp.status === 200 && typeof resp.data === 'object') {
        const cards = parseJsonResponse(resp.data);
        if (cards.length > 0) {
          logger.dim(`  Found ${cards.length} jobs via JSON API at ${url}`);
          for (const card of cards) {
            if (!card.url || seen.has(card.url)) continue;
            seen.add(card.url);
            jobs.push(normalizeJob(card));
          }
          break;
        }
      }
    } catch (err) {
      // API endpoint doesn't exist — try next
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 2. Fallback: HTML scraping
  if (jobs.length === 0) {
    for (const url of SEARCH_URLS) {
      try {
        logger.dim(`  Trying HTML: ${url}`);
        const resp  = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
        const cards = parseHtmlPage(resp.data);
        logger.dim(`  Found ${cards.length} job cards at ${url}`);

        for (const card of cards) {
          if (!card.url || seen.has(card.url)) continue;
          seen.add(card.url);
          jobs.push(normalizeJob(card));
        }
      } catch (err) {
        logger.warn(`[Afriwork] ${url} blocked: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, delay));
    }
  }

  logger.ok(`[Afriwork] Scraped ${jobs.length} jobs total`);
  return jobs;
}

module.exports = { scrape, SOURCE_NAME };
