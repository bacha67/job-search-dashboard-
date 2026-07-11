'use strict';

const axios             = require('axios');
const { XMLParser }     = require('fast-xml-parser');
const cheerio           = require('cheerio');
const crypto            = require('crypto');
const logger            = require('../utils/logger');

// ─── RSS / Sitemap Feed Scraper ──────────────────────────────────────────────
//
// REALITY CHECK (probed 2026-07-11):
//   - ethiojobs.net/rss, etcareers.com/feed, myjobsinethiopia.com → all 404/ENOTFOUND
//   - No Ethiopian job site currently exposes a real RSS/Atom feed
//   - etcareers.com/sitemap.xml → ✅ live, 468 job URLs + lastmod timestamps
//
// Strategy: treat the etcareers sitemap as a lightweight "feed" —
//   • Parse it with fast-xml-parser (same API as RSS)
//   • Filter to URLs modified in the last N days
//   • Fetch each job detail page with cheerio to extract rawText
//   • Return flat array matching the same shape as other scrapers
//
// If more RSS/Atom feeds become available in future, add them to RSS_FEEDS.

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_AGE_DAYS  = 3;    // keep jobs modified within last 3 days
const MAX_JOBS      = parseInt(process.env.MAX_JOBS_PER_PORTAL || '30', 10);
const DETAIL_DELAY  = 1500; // ms between detail page fetches
const FEED_DELAY    = 2000; // ms between feed fetches

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control'  : 'no-cache',
};

// Real RSS/Atom feeds — add URLs here when they become available
const RSS_FEEDS = [
  // currently none confirmed live for Ethiopian job sites
];

// Sitemap-based feeds (job URLs with lastmod dates — treated as a feed)
const SITEMAP_FEEDS = [
  { url: 'https://etcareers.com/sitemap.xml', source: 'ETCareers', pathPattern: /\/jobs\// },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Returns true if date string is within MAX_AGE_DAYS */
function isRecent(dateStr) {
  if (!dateStr) return true; // RSS items without dates: include them
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= MAX_AGE_DAYS;
}

/** pubDate + 30 days as estimated deadline string */
function estimateDeadline(pubDateStr) {
  if (!pubDateStr) return 'Not specified';
  const d = new Date(pubDateStr);
  if (isNaN(d.getTime())) return 'Not specified';
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Try to extract company from text */
function extractCompany(text) {
  const m = text.match(/(?:company|employer|organization|organisation|by)\s*[:\-]\s*(.+)/i);
  if (m) return m[1].split('\n')[0].trim().slice(0, 150);
  return 'Unknown';
}

// ─── RSS/Atom feed parser ─────────────────────────────────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * Fetch and parse a true RSS/Atom feed URL.
 * Returns array of normalized job objects.
 */
async function parseRSSFeed({ url, source }) {
  const jobs = [];
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const parsed = xmlParser.parse(resp.data);

    // Support both RSS 2.0 (rss.channel.item) and Atom (feed.entry)
    const items =
      parsed?.rss?.channel?.item   ||
      parsed?.feed?.entry          ||
      [];

    const itemArr = Array.isArray(items) ? items : [items];

    for (const item of itemArr) {
      const pubDate = item.pubDate || item.updated || item.published || '';
      if (!isRecent(pubDate)) continue;

      const link     = item.link?.['#text'] || item.link || item.guid || '';
      const title    = stripHtml(item.title || '').slice(0, 200);
      const rawText  = stripHtml(item.description || item.summary || item.content || '');
      const author   = item['dc:creator'] || item.author?.name || item.author || '';

      if (!title && !rawText) continue;

      jobs.push({
        id      : makeId(link || title),
        title   : title || rawText.slice(0, 80),
        company : String(author || extractCompany(rawText)).slice(0, 150),
        location: 'Ethiopia',
        deadline: estimateDeadline(pubDate),
        rawText : rawText.slice(0, 8000),
        url     : link,
        sourceUrl: link,
        source,
      });
    }

    logger.ok(`[RSSFeeds] ${source} RSS → ${jobs.length} recent item(s)`);
  } catch (err) {
    logger.warn(`[RSSFeeds] Failed to fetch RSS ${url}: ${err.message}`);
  }
  return jobs;
}

// ─── Sitemap-based feed ───────────────────────────────────────────────────────

/**
 * Parse a sitemap XML, filter job URLs by lastmod age, then fetch each
 * detail page to extract rawText + structured fields via cheerio.
 */
async function parseSitemapFeed({ url, source, pathPattern }) {
  const jobs = [];
  const seen = new Set();

  try {
    const resp   = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const parsed = xmlParser.parse(resp.data);

    // urlset.url[] or sitemapindex.sitemap[] (we only handle urlset here)
    const urlEntries = parsed?.urlset?.url || [];
    const arr = Array.isArray(urlEntries) ? urlEntries : [urlEntries];

    // Filter to job-path URLs modified recently
    const candidates = arr.filter(entry => {
      const loc     = String(entry.loc || '');
      const lastmod = String(entry.lastmod || '');
      return pathPattern.test(loc) && isRecent(lastmod) && !seen.has(loc);
    }).slice(0, MAX_JOBS);

    logger.ok(`[RSSFeeds] ${source} sitemap → ${candidates.length} recent job URL(s) to fetch`);

    for (let i = 0; i < candidates.length; i++) {
      const loc = String(candidates[i].loc);
      seen.add(loc);

      try {
        const r  = await axios.get(loc, { headers: HEADERS, timeout: 15000 });
        const $  = cheerio.load(r.data);
        $('script, style, noscript, nav, footer, header').remove();

        const rawText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
        if (rawText.length < 80) { await delay(DETAIL_DELAY); continue; }

        const title    = $('h1').first().text().trim().slice(0, 200) ||
                         loc.split('/').pop().replace(/-[a-f0-9]{6,}$/, '').replace(/-/g, ' ').slice(0, 200);
        const company  = $('[class*="company"],[class*="employer"],[class*="organisation"]').first().text().trim().slice(0, 150) ||
                         extractCompany(rawText);
        const location = $('[class*="location"],[class*="place"],[class*="city"]').first().text().trim().slice(0, 150) || 'Ethiopia';
        const deadline = $('[class*="deadline"],[class*="expire"],[class*="closing"]').first().text().trim().slice(0, 100) ||
                         estimateDeadline(candidates[i].lastmod);

        jobs.push({
          id      : makeId(loc),
          title,
          company,
          location,
          deadline,
          rawText,
          url     : loc,
          sourceUrl: loc,
          source,
        });

        logger.dim(`  [RSSFeeds] ${source} ✓ ${jobs.length}/${candidates.length} — ${title.slice(0, 60)}`);
      } catch (err) {
        logger.warn(`[RSSFeeds] Detail fetch failed: ${loc} — ${err.message}`);
      }

      if (i < candidates.length - 1) await delay(DETAIL_DELAY);
    }

    logger.ok(`[RSSFeeds] ${source} → ${jobs.length} jobs scraped`);
  } catch (err) {
    logger.warn(`[RSSFeeds] Sitemap fetch failed for ${source}: ${err.message}`);
  }

  return jobs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeRSSFeeds() {
  const total  = RSS_FEEDS.length + SITEMAP_FEEDS.length;
  logger.step('📰', `Scraping ${total} RSS/sitemap feed(s)…`);

  const allJobs = [];
  const seenUrls = new Set();

  // ── True RSS/Atom feeds ──────────────────────────────────────────────────
  for (let i = 0; i < RSS_FEEDS.length; i++) {
    const jobs = await parseRSSFeed(RSS_FEEDS[i]);
    for (const j of jobs) {
      if (!seenUrls.has(j.url)) { seenUrls.add(j.url); allJobs.push(j); }
    }
    if (i < RSS_FEEDS.length - 1) await delay(FEED_DELAY);
  }

  // ── Sitemap-based feeds ──────────────────────────────────────────────────
  for (let i = 0; i < SITEMAP_FEEDS.length; i++) {
    const jobs = await parseSitemapFeed(SITEMAP_FEEDS[i]);
    for (const j of jobs) {
      if (!seenUrls.has(j.url)) { seenUrls.add(j.url); allJobs.push(j); }
    }
    if (i < SITEMAP_FEEDS.length - 1) await delay(FEED_DELAY);
  }

  logger.ok(`[RSSFeeds] Total: ${allJobs.length} unique jobs across ${total} feed(s)`);
  return allJobs;
}

module.exports = { scrapeRSSFeeds };
