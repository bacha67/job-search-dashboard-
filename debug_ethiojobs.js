// Debug script for Ethiojobs structure
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function debug() {
  console.log('--- Fetching listing page ---');
  const listResp = await axios.get(
    'https://ethiojobs.net/jobs?category=Information+Technology',
    { headers: HEADERS, timeout: 25000 }
  );
  const html   = listResp.data;
  const load$  = cheerio.load(html);
  const ndTag  = load$('script').filter((_, el) => {
    const id = load$(el).attr('id');
    return id === '__NEXT_DATA__';
  }).html();

  if (!ndTag) {
    console.log('NO __NEXT_DATA__ found. HTML snippet:', html.slice(0, 300));
    return;
  }

  const nd     = JSON.parse(ndTag);
  const pp     = nd?.props?.pageProps || {};
  const jobs   = pp.jobs || {};

  console.log('pageProps.jobs type:', typeof jobs, Array.isArray(jobs) ? 'ARRAY' : 'OBJECT');
  console.log('pageProps.jobs keys:', Object.keys(jobs).join(', '));
  console.log('current_page:', jobs.current_page);
  console.log('last_page:', jobs.last_page);
  console.log('meta:', JSON.stringify(jobs.meta));
  console.log('data length:', (jobs.data || []).length);

  console.log('\n--- Jobs on Page 1 ---');
  for (const j of jobs.data || []) {
    console.log(`- Title: "${j.title}" | Slug: "${j.slug}"`);
  }

  const firstSlug = (jobs.data || [])[0]?.slug;
  if (!firstSlug) return console.log('No slug found');

  console.log('\n--- Fetching detail page for slug:', firstSlug, '---');
  const detResp = await axios.get(
    'https://ethiojobs.net/jobs/' + firstSlug,
    { headers: HEADERS, timeout: 25000 }
  );
  const detHtml   = detResp.data;
  const det$      = cheerio.load(detHtml);
  const bodyText  = det$('body').text().replace(/\s+/g, ' ').trim();
  console.log('body text length:', bodyText.length);
  console.log('body snippet:', bodyText.slice(0, 300));

  // Also check __NEXT_DATA__ on detail page
  const detNdTag = det$('script').filter((_, el) => {
    return det$(el).attr('id') === '__NEXT_DATA__';
  }).html();
  if (detNdTag) {
    const detNd = JSON.parse(detNdTag);
    const detPp = detNd?.props?.pageProps || {};
    console.log('\nDetail __NEXT_DATA__ keys:', Object.keys(detPp).join(', '));
    if (detPp.job) {
      const j = detPp.job;
      console.log('Job title:', j.title);
      console.log('Job description (first 200):', String(j.description || '').replace(/<[^>]+>/g, ' ').slice(0, 200));
    }
  }
}

debug().catch(e => console.error('Error:', e.message));
