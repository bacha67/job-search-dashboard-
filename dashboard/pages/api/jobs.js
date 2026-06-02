import path from 'path';
import fs   from 'fs';

// ─── API Route: GET /api/jobs ─────────────────────────────────────────────
// Reads the bot-generated data/jobs.json and returns it as JSON.
// The bot writes to ../../data/jobs.json (one level up from dashboard/).

const DATA_FILE = path.join(process.cwd(), '..', 'data', 'jobs.json');

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (!fs.existsSync(DATA_FILE)) {
      return res.status(200).json({ jobs: [], meta: { total: 0, lastUpdated: null } });
    }

    const raw  = fs.readFileSync(DATA_FILE, 'utf8').trim();
    const jobs = raw ? JSON.parse(raw) : [];

    // Sort newest first (already done by bot, but ensure it)
    jobs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const meta = {
      total      : jobs.length,
      topRated   : jobs.filter(j => j.is_top_rated).length,
      sources    : [...new Set(jobs.map(j => j.source))],
      lastUpdated: jobs[0]?.timestamp || null,
    };

    return res.status(200).json({ jobs, meta });
  } catch (err) {
    console.error('[API /jobs] Error:', err.message);
    return res.status(500).json({ error: 'Failed to load jobs data', jobs: [], meta: { total: 0 } });
  }
}
