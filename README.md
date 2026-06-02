# 🤖 Ethiopian Entry-Level Tech Job Bot

An automated pipeline that scrapes **Ethiojobs**, **HahuJobs**, and **Kebenajob** every 6 hours, filters for fresh-graduate / entry-level CS/IT/SE roles, scores each opportunity on 3 metrics, and broadcasts formatted alerts to your Telegram channel — completely free.

---

## Project Structure

```
job-search/
├── src/
│   ├── scheduler.js          ← Entry point (Stage 01: Cron trigger)
│   ├── ingestion/
│   │   └── index.js          ← Stage 02: Aggregates all scrapers
│   ├── scrapers/
│   │   ├── ethiojobs.js      ← Parses __NEXT_DATA__ JSON directly
│   │   ├── hahujobs.js       ← Cheerio HTML scraper
│   │   └── kebenajob.js      ← Cheerio + domain probing
│   ├── filter/
│   │   └── sanitizer.js      ← Stage 03: Field + experience + dedup filter
│   ├── scoring/
│   │   └── engine.js         ← Stage 04: Heuristic scoring (free, no API)
│   ├── telegram/
│   │   └── router.js         ← Stage 05: Telegram broadcast
│   ├── db/
│   │   └── store.js          ← SQLite KV dedup store
│   └── utils/
│       └── logger.js         ← Colored timestamped logger
├── .env.example              ← Copy to .env and fill in
├── package.json
└── README.md
```

---

## Setup

### 1. Install Dependencies
```bash
cd /Users/shadow/Desktop/job-search
npm install
```

### 2. Create Your Telegram Bot
1. Open Telegram and message **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the **Bot Token** you receive

### 3. Add Your Bot to a Channel
1. Create a new Telegram channel (or use an existing one)
2. Add your bot as an **Administrator** (must have "Post Messages" permission)
3. Get your channel's chat ID:
   - For public channels: it's just `@your_channel_name`
   - For private channels: forward a message to **@userinfobot** to get the numeric ID

### 4. Configure Environment
```bash
cp .env.example .env
```
Edit `.env`:
```
TELEGRAM_BOT_TOKEN=1234567890:ABCDEFGHijklmnopqrstuvwxyz
TELEGRAM_CHAT_ID=@your_channel_name
```

### 5. Run a Dry Run First (Recommended)
```bash
npm run dry-run
```
This runs the full pipeline and **prints messages to the console** without sending to Telegram. Use this to confirm jobs are being found and scored correctly.

### 6. Start the Bot
```bash
npm start
```
The bot will:
- Run one full cycle **immediately** on startup
- Then run every **6 hours** automatically (configurable via `SCRAPE_CRON` in `.env`)

---

## Sample Telegram Output

```
🏷️ JOB HEADER
• Position: Junior Software Developer
• Company: Gebeya Inc.
• Source & Link: Ethiojobs → ethiojobs.net/jobs/...

📝 OPERATIONAL SNAPSHOT
• 🔧 Tools & Stack: React, Node.js, MongoDB, Git
• 📋 Primary Tasks: Build and maintain web application features using the React/Node stack under senior developer supervision.

📊 METRIC SCORE ANALYSIS
• Salary Score [7/10]: Large local tech startup — compensation above local SME average with structured growth bands.
• Future Upgrade [9/10]: Production software engineering roles offer a direct path to Senior/Lead Engineer within 2–3 years.
• Skills Gained [8/10]: Rich multi-stack exposure: React, Node.js, MongoDB, Git — this breadth significantly accelerates a graduate's market value.
---
```

---

## CLI Commands

| Command | Description |
|---|---|
| `npm start` | Start the bot with 6-hour cron schedule |
| `npm run dry-run` | Run pipeline once, print to console (no Telegram) |
| `npm run once` | Run pipeline once and exit (sends to Telegram) |

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(required)* | Your bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | *(required)* | Channel ID or `@channelname` |
| `SCRAPE_CRON` | `0 */6 * * *` | Cron schedule (every 6 hours) |
| `MAX_JOBS_PER_PORTAL` | `20` | Max jobs processed per source per run |
| `REQUEST_TIMEOUT_MS` | `15000` | HTTP request timeout in milliseconds |
| `REQUEST_DELAY_MS` | `2000` | Delay between requests (be polite to servers) |

---

## How the Filter Works

A job must pass **all 4 gates** to be sent:

1. **Tech Field Gate** — Title/categories must match CS/IT/SE/CE keywords
2. **Entry Level Gate** — Description must contain signals like: `fresh graduate`, `0 years`, `entry level`, `intern`, `trainee`, `junior`
3. **Experience Disqualifier** — Hard-discard if description contains `N+ years experience` (N ≥ 1)
4. **Dedup Gate** — Job ID must not exist in the local SQLite database

---

## How Scoring Works

| Metric | Method |
|---|---|
| **Salary [1–10]** | Company name matched against 5 tiers: UN agencies → INGOs → banks/telecom → local startups → SMEs |
| **Future Upgrade [1–10]** | Job title matched against role-type tiers: DevOps/Cloud → SWE → ML → Data/Network → IT Officer → Helpdesk → Hardware |
| **Skills Gained [1–10]** | Named technologies extracted from description and weighted (e.g., Docker=2.2, React=2.0, MS Office=0.3), normalized to 10 |

Jobs are broadcast in **descending order of combined score** so the best opportunity always appears first in your channel.

---

## Notes

- The SQLite file (`seen_jobs.sqlite`) keeps a permanent record of all sent jobs — delete it to reset and re-send all jobs.
- Ethiojobs scraping is highly reliable (reads embedded JSON). HahuJobs and Kebenajob use HTML parsing which may need selector updates if those sites redesign.
- No external AI API is used — all scoring is pure heuristic logic running locally.
