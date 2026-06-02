'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('../utils/logger');

// ─── Kebenajob Scraper ─────────────────────────────────────────────────────
// kebenajobs.com is a WordPress blog where each post = one company's vacancy.
// The main listing is at /job-list/ (paginated WordPress archive).
// Individual job posts are at /job/SLUG/ or /SLUG/.
// Since posts are company-level (not per-role), we scrape the detail page
// and extract all IT-related positions mentioned in the post body.

const SOURCE_NAME = 'Kebenajob';
const BASE_URL    = 'https://kebenajobs.com';

const LISTING_URLS = [
  `${BASE_URL}/job-list/`,
  `${BASE_URL}/`,           // homepage also shows job posts
];

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control'  : 'no-cache',
};

const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10);

/**
 * Parse the WordPress job-list page and extract post links.
 * Posts are structured as <h2><a href="/SLUG/">Company Name</a></h2> + <p> snippet
 */
function parseListingPage(html) {
  const $     = cheerio.load(html);
  const posts = [];

  // WordPress posts in the main loop — each is an <article> or <h2>+<a> pair
  $('article, .entry-content > h2, h2.entry-title').each((_, el) => {
    const $el = $(el);

    // Try article format first
    let href = $el.find('a').first().attr('href') || '';
    let title = $el.find('h2, h1, .entry-title').first().text().trim()
             || $el.find('a').first().text().trim();

    if (!title || !href) return;
    if (!href.startsWith('http')) href = BASE_URL + href;

    const snippet = $el.find('p, .entry-summary, .entry-content').first().text()
      .replace(/\s+/g, ' ').trim().slice(0, 500);

    posts.push({ company: title, url: href, snippet });
  });

  // Fallback: look for all h2 > a patterns in page body
  if (posts.length === 0) {
    $('h2 a[href*="kebenajobs.com"]').each((_, el) => {
      const $el  = $(el);
      const href = $el.attr('href') || '';
      const title = $el.text().trim();
      if (title && href) posts.push({ company: title, url: href, snippet: '' });
    });
  }

  return posts;
}

/**
 * Fetch a Kebenajob detail post and extract ALL job positions listed in it.
 * Each post typically has multiple job titles as <strong> or list items.
 */
async function fetchJobDetail(url) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: TIMEOUT });
    const $    = cheerio.load(resp.data);
    $('script, style, nav, footer, header, .sidebar').remove();

    const company = $('h1.entry-title, h1').first().text().trim();
    const body    = $('.entry-content').text().replace(/\s+/g, ' ').trim();

    return { company, body, url };
  } catch (err) {
    logger.warn(`[Kebenajob] Detail fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * From a post's full text body, extract individual job positions.
 * Looks for patterns like "Job Title:" or "Position:" or list items.
 */
function extractPositions(detail, postCard) {
  if (!detail) return [];

  const { company, body, url } = detail;
  const positions = [];

  // Look for "Position – X" or "Job Title: X" or "Position: X" patterns
  const posPatterns = [
    /Position(?:\s*Title)?\s*[-–:]\s*([^\n\r.]+)/gi,
    /Job\s*Title\s*[-–:]\s*([^\n\r.]+)/gi,
    /Vacancy\s*Title\s*[-–:]\s*([^\n\r.]+)/gi,
  ];

  const found = new Set();
  for (const rx of posPatterns) {
    let m;
    while ((m = rx.exec(body)) !== null) {
      const pos = m[1].trim().replace(/\s+/g, ' ');
      if (pos.length > 3 && pos.length < 120) found.add(pos);
    }
  }

  // If no structured pattern found, treat the whole post as one job
  if (found.size === 0) {
    positions.push({
      id         : 'kebenajob_' + Buffer.from(url).toString('base64').slice(0, 20),
      source     : SOURCE_NAME,
      sourceUrl  : url,
      title      : company,
      company    : company,
      companySlug: '',
      careerLevel: '',
      workExpName: '',
      description: (postCard.snippet + ' ' + body).trim().slice(0, 3000),
      descHtml   : '',
      categories : [],
      salary     : null,
      location   : 'Addis Ababa, Ethiopia',
      deadline   : null,
      published  : null,
      applyMethod: 'URL',
      applyEmail : null,
    });
  } else {
    for (const pos of found) {
      positions.push({
        id         : 'kebenajob_' + Buffer.from(url + pos).toString('base64').slice(0, 24),
        source     : SOURCE_NAME,
        sourceUrl  : url,
        title      : pos,
        company    : detail.company || postCard.company,
        companySlug: '',
        careerLevel: '',
        workExpName: '',
        description: (pos + ' ' + body).trim().slice(0, 3000),
        descHtml   : '',
        categories : [],
        salary     : null,
        location   : 'Addis Ababa, Ethiopia',
        deadline   : null,
        published  : null,
        applyMethod: 'URL',
        applyEmail : null,
      });
    }
  }

  return positions;
}

async function scrape() {
  logger.step('🌐', `Scraping ${SOURCE_NAME}...`);

  const seen  = new Set();
  const jobs  = [];
  const max   = parseInt(process.env.MAX_JOBS_PER_PORTAL || '50', 10);
  const delay = parseInt(process.env.REQUEST_DELAY_MS    || '2000', 10);

  for (const listUrl of LISTING_URLS) {
    try {
      logger.dim(`  Fetching: ${listUrl}`);
      const resp  = await axios.get(listUrl, { headers: HEADERS, timeout: TIMEOUT });
      const posts = parseListingPage(resp.data);
      logger.dim(`  Found ${posts.length} posts at ${listUrl}`);

      for (const post of posts) {
        if (!post.url || seen.has(post.url)) continue;
        seen.add(post.url);

        const detail    = await fetchJobDetail(post.url);
        const positions = extractPositions(detail, post);
        await new Promise(r => setTimeout(r, delay));

        jobs.push(...positions);
        if (jobs.length >= max) break;
      }
    } catch (err) {
      logger.error(`[Kebenajob] Failed listing ${listUrl}: ${err.message}`);
    }

    if (jobs.length >= max) break;
    await new Promise(r => setTimeout(r, delay));
  }

  logger.ok(`[Kebenajob] Scraped ${jobs.length} job positions total`);
  return jobs;
}

module.exports = { scrape, SOURCE_NAME };
