import Head       from 'next/head';
import { useState, useEffect, useMemo } from 'react';

// ─── Dashboard index page ─────────────────────────────────────────────────

const SOURCE_COLORS = {
  Ethiojobs: '#ff8a65',
  ETcareers : '#448aff',
  Kebenajob : '#26c6da',
  Jiji      : '#ffca28',
  Afriwork  : '#ce93d8',
  GeezJobs  : '#a5d6a7',
};

function timeAgo(iso) {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getInitial(company = '') {
  return company.replace(/via\s+/i, '').trim().charAt(0).toUpperCase() || '?';
}

function ScoreBar({ label, value, cls }) {
  return (
    <div className="score-row">
      <span className="score-label">{label}</span>
      <div className="score-bar-wrap">
        <div
          className={`score-bar score-bar-${cls}`}
          style={{ width: `${(value / 10) * 100}%` }}
        />
      </div>
      <span className={`score-num score-num-${cls}`}>{value}</span>
    </div>
  );
}

function JobCard({ job }) {
  const avg = job.metrics?.overall_average || 0;
  const avgClass = avg >= 8.5 ? 'overall-hi' : avg >= 6 ? 'overall-mid' : 'overall-lo';
  const sourceClass = `source-${job.source?.replace(/\s+/g, '')}`;

  // Clean snapshot text (remove markdown symbols)
  const cleanSnap = (s) => (s || '')
    .replace(/🔧 \*Tools & Stack:\* /,'')
    .replace(/📋 \*Primary Tasks:\* /,'')
    .replace(/[*_]/g, '');

  return (
    <div className={`job-card${job.is_top_rated ? ' top-rated' : ''}`}>
      {job.is_top_rated && <span className="top-rated-badge">⭐ Top Rated</span>}

      {/* Header */}
      <div className="card-header">
        <div className="company-avatar">{getInitial(job.company)}</div>
        <div className="card-title-block">
          <div className="card-title">{job.title}</div>
          <div className="card-company">{job.company}</div>
          {job.location && <div className="card-location">📍 {job.location}</div>}
          <span className={`source-badge ${sourceClass}`}>
            {job.source}
          </span>
        </div>
      </div>

      {/* Score meters */}
      <div className="scores-section">
        <ScoreBar label="Salary"   value={job.metrics?.salary  || 0} cls="salary"  />
        <ScoreBar label="Growth"   value={job.metrics?.upgrade || 0} cls="upgrade" />
        <ScoreBar label="Skills"   value={job.metrics?.skills  || 0} cls="skills"  />
        <div className="overall-score">
          <span className="overall-label">OVERALL SCORE</span>
          <span className={`overall-value ${avgClass}`}>{avg}/10</span>
        </div>
      </div>

      {/* Snapshot */}
      {job.snapshot && job.snapshot.length > 0 && (
        <div className="snapshot-section">
          {job.snapshot.map((s, i) => (
            <div key={i} className="snapshot-item">
              {cleanSnap(s)}
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {job.extracted_skills?.length > 0 && (
        <div className="skills-wrap">
          {job.extracted_skills.map((sk) => (
            <span key={sk} className="skill-tag">{sk}</span>
          ))}
        </div>
      )}

      {/* Apply button */}
      <a
        href={job.link}
        target="_blank"
        rel="noopener noreferrer"
        className={`apply-btn${job.is_top_rated ? ' top' : ''}`}
      >
        Apply Now →
      </a>
    </div>
  );
}

export default function Dashboard() {
  const [jobs, setJobs]         = useState([]);
  const [meta, setMeta]         = useState({ total: 0, topRated: 0, sources: [], lastUpdated: null });
  const [loading, setLoading]   = useState(true);
  const [sourceFilter, setSrc]  = useState('All');
  const [topOnly, setTopOnly]   = useState(false);
  const [sortBy, setSortBy]     = useState('newest');

  // Fetch jobs — reads from /data/jobs.json (public folder, works on Vercel + locally)
  const fetchJobs = async () => {
    try {
      const r = await fetch('/data/jobs.json?t=' + Date.now());
      if (!r.ok) throw new Error('Not found');
      const jobs = await r.json();
      // Sort newest first
      jobs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      setJobs(jobs);
      setMeta({
        total      : jobs.length,
        topRated   : jobs.filter(j => j.is_top_rated).length,
        sources    : [...new Set(jobs.map(j => j.source))],
        lastUpdated: jobs[0]?.timestamp || null,
      });
    } catch (e) {
      console.error('Failed to load jobs:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    // Auto-refresh every 2 minutes
    const iv = setInterval(fetchJobs, 2 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // Filter + sort
  const displayed = useMemo(() => {
    let list = [...jobs];
    if (sourceFilter !== 'All') list = list.filter(j => j.source === sourceFilter);
    if (topOnly) list = list.filter(j => j.is_top_rated);
    switch (sortBy) {
      case 'score':   list.sort((a,b) => (b.metrics?.overall_average||0) - (a.metrics?.overall_average||0)); break;
      case 'salary':  list.sort((a,b) => (b.metrics?.salary||0) - (a.metrics?.salary||0)); break;
      case 'growth':  list.sort((a,b) => (b.metrics?.upgrade||0) - (a.metrics?.upgrade||0)); break;
      default:        list.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
    return list;
  }, [jobs, sourceFilter, topOnly, sortBy]);

  const allSources = useMemo(() => {
    return ['All', ...new Set(jobs.map(j => j.source))];
  }, [jobs]);

  return (
    <>
      <Head>
        <title>🇪🇹 Ethiopian Tech Jobs — Live Dashboard</title>
        <meta name="description" content="Real-time dashboard for entry-level tech and fresh graduate jobs in Ethiopia, curated by AI." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🇪🇹</text></svg>" />
      </Head>

      {/* ─ Header ─ */}
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <div className="logo-icon">🇪🇹</div>
            <div>
              <div className="logo-text">EthioTechJobs</div>
              <div className="logo-sub">Live AI Job Dashboard</div>
            </div>
          </div>
          <div className="live-badge">
            <span className="live-dot" />
            BOT LIVE
          </div>
        </div>
      </header>

      <main>
        {/* ─ Hero + Stats ─ */}
        <section className="hero container">
          <h1 className="hero-title">Entry-Level Tech Jobs in Ethiopia</h1>
          <p className="hero-sub">Auto-scraped from 6 portals · AI-filtered · Fresh graduate & internship only · Updated every 6 hours</p>

          <div className="stats-grid">
            <div className="stat-card stat-blue">
              <div className="stat-label">Total Jobs</div>
              <div className="stat-value">{loading ? '—' : meta.total}</div>
              <div className="stat-sub">In the database</div>
            </div>
            <div className="stat-card stat-green">
              <div className="stat-label">Top Rated</div>
              <div className="stat-value">{loading ? '—' : meta.topRated}</div>
              <div className="stat-sub">Score ≥ 8.5/10</div>
            </div>
            <div className="stat-card stat-purple">
              <div className="stat-label">Portals Active</div>
              <div className="stat-value">{loading ? '—' : (meta.sources?.length || 0)}</div>
              <div className="stat-sub">Data sources live</div>
            </div>
            <div className="stat-card stat-amber">
              <div className="stat-label">Last Updated</div>
              <div className="stat-value" style={{fontSize:'20px',paddingTop:'6px'}}>
                {loading ? '—' : timeAgo(meta.lastUpdated)}
              </div>
              <div className="stat-sub">Auto-refreshes every 6h</div>
            </div>
          </div>
        </section>

        {/* ─ Filters ─ */}
        <div className="filters-bar container">
          <button
            id="filter-top-rated"
            className={`filter-btn${topOnly ? ' active-green' : ''}`}
            onClick={() => setTopOnly(p => !p)}
          >
            ⭐ Top Rated Only
          </button>

          {allSources.map(src => (
            <button
              key={src}
              id={`filter-src-${src}`}
              className={`filter-btn${sourceFilter === src ? ' active' : ''}`}
              onClick={() => setSrc(src)}
            >
              {src}
            </button>
          ))}

          <select
            id="sort-select"
            className="sort-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="newest">Sort: Newest</option>
            <option value="score">Sort: Overall Score</option>
            <option value="salary">Sort: Salary Score</option>
            <option value="growth">Sort: Growth Score</option>
          </select>
        </div>

        {/* ─ Job Cards ─ */}
        <div className="jobs-grid container">
          {loading ? (
            <div className="empty-state">
              <div className="empty-icon">⏳</div>
              <div className="empty-title">Loading jobs...</div>
            </div>
          ) : displayed.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🔍</div>
              <div className="empty-title">No jobs found</div>
              <div className="empty-text">
                {jobs.length === 0
                  ? 'The bot hasn\'t run yet or no jobs passed the filter. Check back after the next 6-hour cycle.'
                  : 'Try changing the filter — no jobs match your current selection.'}
              </div>
            </div>
          ) : (
            displayed.map(job => <JobCard key={job.job_id} job={job} />)
          )}
        </div>
      </main>

      <footer className="footer">
        <p>
          🤖 Powered by <strong>EthioTechJobs Bot</strong> ·
          Data from Ethiojobs, ETcareers, Kebenajob, Jiji &amp; more ·
          <a href="https://t.me/Ethio_Fresh_Jobs" target="_blank" rel="noopener noreferrer">
            &nbsp;Join @Ethio_Fresh_Jobs on Telegram
          </a>
        </p>
      </footer>
    </>
  );
}
