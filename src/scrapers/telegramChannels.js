'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const crypto  = require('crypto');
const logger  = require('../utils/logger');

// ─── Telegram Public Channel Scraper ────────────────────────────────────────
//
// Reads public Ethiopian job channels via t.me/s/<channel> (last ~20 posts).
// No bot token needed — this is the public web preview.
//
// Returns raw job objects with rawText for downstream AI processing.

const CHANNELS = [
  'ethiojobs',
  'ethiopiajobs',
  'addisababajobs',
  'vacancy_ethiopia',
  'ethiopian_job_vacancy',
];

const DELAY_MS  = 2000;  // 2 s between channel fetches
const MAX_AGE_H = 24;    // only keep posts from the last 24 hours

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control'  : 'no-cache',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

/** Is a datetime string within the last MAX_AGE_H hours? */
function isRecent(datetimeAttr) {
  if (!datetimeAttr) return false;
  const posted = new Date(datetimeAttr);
  if (isNaN(posted.getTime())) return false;
  const ageHours = (Date.now() - posted.getTime()) / (1000 * 60 * 60);
  return ageHours <= MAX_AGE_H;
}

/**
 * Try to extract a company name from message text.
 * Looks for patterns like "Company: Foo" / "Employer: Foo" / "Organization: Foo".
 * Falls back to "Unknown".
 */
function extractCompany(text) {
  const m = text.match(/(?:company|employer|organization|organisation)\s*[:\-]\s*(.+)/i);
  if (m) return m[1].split('\n')[0].trim().slice(0, 150);
  return 'Unknown';
}

/**
 * Try to extract a deadline from message text.
 * Looks for "deadline", "closing date", "apply by/before", etc.
 */
function extractDeadline(text) {
  const m = text.match(
    /(?:deadline|closing\s+date|apply\s+(?:by|before)|last\s+date)\s*[:\-]?\s*(.{5,40})/i
  );
  if (m) return m[1].split('\n')[0].trim().slice(0, 80);
  return 'Not specified';
}

// ─── Per-channel scraper ──────────────────────────────────────────────────────

async function scrapeChannel(channelName) {
  const url = `https://t.me/s/${channelName}`;
  const jobs = [];

  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const $    = cheerio.load(resp.data);

    // Each post wrapper
    $('.tgme_widget_message_wrap').each((_, wrap) => {
      const $wrap = $(wrap);

      // ── Date filter ──────────────────────────────────────────────────────
      const datetimeAttr = $wrap.find('time[datetime]').attr('datetime');
      if (!isRecent(datetimeAttr)) return; // skip posts older than 24 h

      // ── Message text ─────────────────────────────────────────────────────
      const $textEl  = $wrap.find('.tgme_widget_message_text');
      if (!$textEl.length) return; // skip posts with no text (photos only, etc.)

      const rawText = $textEl.text().replace(/\s+/g, ' ').trim();
      if (rawText.length < 30) return; // skip trivially short messages

      // ── Message link ─────────────────────────────────────────────────────
      // The permalink is on the message date/time anchor or a dedicated link
      const msgUrl =
        $wrap.find('.tgme_widget_message_date').attr('href') ||
        $wrap.find('a.tgme_widget_message_date').attr('href') ||
        `${url}`;

      // ── Field extraction ─────────────────────────────────────────────────
      const lines   = rawText.split(/\n/).map(l => l.trim()).filter(Boolean);
      const title   = lines[0].slice(0, 200);
      const company = extractCompany(rawText);
      const deadline = extractDeadline(rawText);

      jobs.push({
        id      : makeId(msgUrl || rawText.slice(0, 80)),
        title,
        company,
        location: 'Ethiopia',
        deadline,
        rawText : rawText.slice(0, 8000),
        url     : msgUrl || url,
        sourceUrl: msgUrl || url,
        source  : `Telegram: @${channelName}`,
      });
    });

    logger.ok(`[TelegramChannels] @${channelName} → ${jobs.length} recent post(s)`);
  } catch (err) {
    logger.warn(`[TelegramChannels] Failed to fetch @${channelName}: ${err.message}`);
  }

  return jobs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeTelegramChannels() {
  logger.step('📡', `Scraping ${CHANNELS.length} public Telegram channels (last ${MAX_AGE_H}h)…`);

  const allJobs = [];

  for (let i = 0; i < CHANNELS.length; i++) {
    const jobs = await scrapeChannel(CHANNELS[i]);
    allJobs.push(...jobs);
    if (i < CHANNELS.length - 1) await delay(DELAY_MS);
  }

  logger.ok(`[TelegramChannels] Total: ${allJobs.length} recent posts across ${CHANNELS.length} channels`);
  return allJobs;
}

module.exports = { scrapeTelegramChannels };
