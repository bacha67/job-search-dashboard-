'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

// ─── Gemini AI Job Processor ───────────────────────────────────────────────
// Uses Google Gemini Flash to extract structured fields, predict missing info,
// score the job, and determine IT/fresh-grad eligibility — all from rawText.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Truncate rawText to avoid sending huge payloads (Gemini charges per token)
const MAX_RAW_TEXT_CHARS = 4000;

async function processJobWithAI(rawJob) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set — skipping AI processing');
  }

  // Trim rawText to stay within reasonable token usage
  const rawText = (rawJob.rawText || rawJob.description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RAW_TEXT_CHARS);

  const prompt = `
You are an Ethiopian job assistant helping fresh CS/IT graduates and BSc Mathematics graduates find jobs.

Analyze this job posting and return a JSON object only (no markdown, no explanation):

JOB DATA:
Title: ${rawJob.title}
Company: ${rawJob.company}
Location: ${rawJob.location}
URL: ${rawJob.url || rawJob.sourceUrl}
Full Text: ${rawText}

Return this exact JSON structure:
{
  "title": "job title",
  "company": "company name",
  "location": "city, Ethiopia",
  "deadline": "date or Not specified",
  "education": "degree required",
  "experience": "years required - write 0 if fresh graduate or not mentioned",
  "isFreshGradOk": true or false,
  "isITJob": true or false,
  "isMathJob": true or false,
  "salary": "amount in ETB or Not disclosed",
  "description": "2-3 sentence summary of what this job is about",
  "responsibilities": ["responsibility 1", "responsibility 2", "responsibility 3", "responsibility 4"],
  "requirements": ["requirement 1", "requirement 2", "requirement 3"],
  "howToApply": "email, URL, or physical address",
  "applyUrl": "direct URL if available or null",
  "score": {
    "salary": 0-4,
    "skills": 0-3,
    "growth": 0-2,
    "reputation": 0-1,
    "total": 0-10,
    "reason": "one sentence why you gave this score"
  },
  "predictedRoles": ["predicted role 1", "predicted role 2"]
}

Scoring rules:
- salary: 4=above 15000ETB mentioned, 2=8000-15000ETB, 1=not mentioned
- skills: 3=teaches React/Node/Python/AI/cloud/statistics/data modelling, 2=general IT or quantitative role, 1=basic admin
- growth: 2=large/known company, 1=mid company, 0.5=unknown
- reputation: 1=well known Ethiopian or international company, 0.5=unknown

For responsibilities: if not mentioned in the job text, PREDICT realistic ones based on the job title.
For isFreshGradOk: true if experience is 0, 1 year, entry level, junior, or fresh graduate.
For isITJob: true only if this is a software/IT/computer science/tech related job.
For isMathJob: true if this is a mathematics, statistics, actuarial, quantitative analysis, operations research, data science, financial analysis, economics, or similar analytical/mathematical field job that a BSc Mathematics graduate could apply to.
`;

  const response = await axios.post(GEMINI_URL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
  }, { timeout: 30000 });

  const rawResponse = response.data.candidates[0].content.parts[0].text;

  // Strip markdown code fences if Gemini wraps the JSON
  const cleaned = rawResponse
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Find the JSON object in the response (handles leading/trailing text)
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini response contained no valid JSON object');

  return JSON.parse(jsonMatch[0]);
}

async function processAllJobs(rawJobs) {
  if (!GEMINI_API_KEY) {
    logger.warn('[Gemini] GEMINI_API_KEY not set — AI processing skipped, returning empty array');
    return [];
  }

  logger.step('🤖', `Processing ${rawJobs.length} jobs through Gemini AI...`);
  const results = [];

  for (const job of rawJobs) {
    try {
      logger.dim(`  [Gemini] Analyzing: "${job.title}" @ ${job.company}`);
      const processed = await processJobWithAI(job);

      // Accept both IT jobs AND mathematics/statistics jobs
      if ((processed.isITJob || processed.isMathJob) && processed.isFreshGradOk) {
        results.push({
          ...processed,
          // Preserve pipeline-required fields
          id        : job.id,
          url       : job.url || job.sourceUrl,
          sourceUrl : job.sourceUrl || job.url,
          source    : job.source,
          published : job.published,
          applyEmail: job.applyEmail,
          // Map AI score back to our pipeline scores shape
          scores: {
            salary    : Math.round((processed.score?.salary     || 1) / 4 * 10),
            skills    : Math.round((processed.score?.skills     || 1) / 3 * 10),
            upgrade   : Math.round((processed.score?.growth     || 1) / 2 * 10),
            reputation: Math.round((processed.score?.reputation || 0.5) * 10),
            total     : processed.score?.total || 5,
          },
          snapshot: [
            processed.description || '',
            (processed.responsibilities || []).slice(0, 2).join('. '),
          ],
        });
        const tag = processed.isMathJob && !processed.isITJob ? '📐 Math' : '💻 IT';
        logger.ok(`  [Gemini] ✅ Qualified [${tag}]: "${processed.title}" (score: ${processed.score?.total}/10)`);
      } else {
        logger.dim(`  [Gemini] ✗ Filtered out: isIT=${processed.isITJob} isMath=${processed.isMathJob} freshOk=${processed.isFreshGradOk}`);
      }

      // 1 second delay between Gemini API calls (rate limit: 15 req/min on free tier)
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      logger.warn(`[Gemini] Processing failed for "${job.title}": ${err.message}`);
    }
  }

  logger.ok(`[Gemini] AI processing complete: ${results.length}/${rawJobs.length} jobs qualified`);
  return results;
}

module.exports = { processAllJobs, processJobWithAI };
