# 🤖 Ethiopian Entry-Level Tech Job Bot

An automated pipeline that scrapes **Ethiojobs**, **HahuJobs**, and **Kebenajob** every 6 hours, filters for fresh-graduate / entry-level CS/IT/SE/Mathematics roles, scores each opportunity on 4 metrics, and broadcasts formatted alerts to your Telegram channel — completely free.

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
│   ├── ai/
│   │   ├── gemini.js         ← Gemini AI: extracts degree, experience, score, summary
│   │   └── groq.js           ← Groq fallback AI processor
│   ├── filter/
│   │   └── sanitizer.js      ← Stage 03: Field + seniority + experience + dedup filter
│   ├── scoring/
│   │   └── engine.js         ← Stage 04: Heuristic scoring (free, no API)
│   ├── output/
│   │   └── jsonEgress.js     ← Stage 05a: Writes scored jobs to data/jobs.json
│   ├── telegram/
│   │   └── router.js         ← Stage 05b: Telegram broadcast
│   ├── db/
│   │   └── store.js          ← SQLite KV dedup store
│   └── utils/
│       └── logger.js         ← Colored timestamped logger
├── data/
│   └── jobs.json             ← Dashboard data feed (auto-generated)
├── .env.example              ← Copy to .env and fill in
├── package.json
└── README.md
```

---

## Setup

### 1. Install Dependencies
```bash
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
GEMINI_API_KEY=your_gemini_api_key   # optional — enables AI field extraction
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
⚡️ የሥራ ዕድል | Job Alert

━━━━━━━━━━━━━━━━━━━━━
🏢 Gebeya Inc.
💼 Junior Software Developer
📍 Addis Ababa
🎓 Degree: BSc in Computer Science   |   📅 Experience: 0 years
⏰ Deadline: July 30, 2025
━━━━━━━━━━━━━━━━━━━━━

📋 About the Role:
Build and maintain web application features using the React/Node.js stack.

✅ Responsibilities:
▪️ Develop new features for the web platform
▪️ Write unit tests and participate in code reviews
▪️ Collaborate with the design team on UI components
▪️ Fix bugs and maintain existing modules

📌 Requirements:
▪️ BSc in Computer Science or related field
▪️ Knowledge of React and Node.js
▪️ Good communication skills

━━━━━━━━━━━━━━━━━━━━━
🔗 👉 Apply Here / ለማመልከት ይጫኑ
🌐 View Full Post | ሙሉ ማስታወቂያ
━━━━━━━━━━━━━━━━━━━━━

📢 ለተጨማሪ የሥራ ዕድሎች ቻናሉን ይቀላቀሉ!
👇 @Ethio_Fresh_Jobs
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
| `GEMINI_API_KEY` | *(optional)* | Enables AI-powered field extraction (degree, experience, summary) |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model to use |
| `SCRAPE_CRON` | `0 */6 * * *` | Cron schedule (every 6 hours) |
| `MAX_JOBS_PER_PORTAL` | `20` | Max jobs processed per source per run |
| `REQUEST_TIMEOUT_MS` | `15000` | HTTP request timeout in milliseconds |
| `REQUEST_DELAY_MS` | `2000` | Delay between requests (be polite to servers) |

---

## How the Filter Works

A job must pass **all 5 gates** to be sent:

| Gate | Rule |
|---|---|
| **Gate 0 — Hard Reject** | Instantly discard if title contains senior/lead/director keywords, or description requires 3+ years experience |
| **Gate 1 — Field Check** | Title must match CS / IT / SE / CE / Sysadmin / MIS **or** Mathematics / Statistics / Actuarial keywords |
| **Gate 2 — Entry Level** | Must contain signals like `fresh graduate`, `0 years`, `entry level`, `intern`, `trainee`, or `junior` |
| **Gate 3 — Experience** | Discard if description explicitly requires 2+ years (junior exception applies) |
| **Gate 4 — Dedup** | Job ID and title+company must not already exist in the SQLite database |

> **With Gemini API key set**, Gates 2 & 3 are handled by AI (`isFreshGradOk` flag) which is far more accurate for multi-role job posts.

---

## How Scoring Works

| Metric | Method |
|---|---|
| **Salary [1–10]** | Company name matched against 5 tiers: UN agencies → INGOs → banks/telecom → local startups → SMEs. Boosted if explicit ETB salary stated. |
| **Future Upgrade [1–10]** | Job title matched against role-type tiers: DevOps/Cloud → SWE → ML → Data/Network → IT Officer → Helpdesk → Hardware |
| **Skills Gained [1–10]** | Named technologies extracted from description and weighted (e.g., Docker=2.2, React=2.0, MS Office=0.3), normalized to 10 |
| **Reputation [1–10]** | Company brand recognition scored separately from salary (UN=10, INGO=9, bank=8, local corp=7, SME=5) |

Jobs are broadcast in **descending order of combined score** so the best opportunity always appears first in your channel.

---

## Job Fields Extracted

Each job alert and the JSON data feed (`data/jobs.json`) includes:

| Field | Source | Description |
|---|---|---|
| `title` | Scraper / AI | Job title |
| `company` | Scraper / AI | Employer name |
| `location` | Scraper / AI | City in Ethiopia |
| `degree_required` | AI (`education`) | e.g. `BSc in Computer Science` |
| `experience` | AI (`experience`) | e.g. `0 years` / `Fresh graduate` |
| `deadline` | Scraper / AI | Application deadline |
| `responsibilities` | AI (predicted if missing) | Up to 4 key responsibilities |
| `requirements` | Scraper / AI | Up to 4 requirements |
| `extracted_skills` | Scoring engine | Named tech stack detected |
| `metrics` | Scoring engine | salary / upgrade / skills / reputation / overall |
| `snapshot` | Scoring engine | 2-line summary for dashboard cards |

---

## Notes

- The SQLite file (`seen_jobs.sqlite`) keeps a permanent record of all sent jobs — delete it to reset and re-send all jobs.
- Ethiojobs scraping is highly reliable (reads embedded JSON). HahuJobs and Kebenajob use HTML parsing which may need selector updates if those sites redesign.
- When `GEMINI_API_KEY` is set, the AI layer extracts structured fields (degree, experience, responsibilities) and scores each job — this is more accurate than regex-only mode.
- Without a Gemini key, all scoring is pure heuristic logic running locally (no API costs).
