'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

// ─── Groq AI Job Processor ─────────────────────────────────────────────────────
// Uses Groq API (free, fast LLaMA inference) to process raw job data.
// Extracts structured fields, scores, and filters isIT + isFreshGradOk.
// Reuses GEMINI_API_KEY secret name to avoid GitHub Secrets changes.

const GROQ_API_KEY = process.env.GEMINI_API_KEY; // reusing same secret name
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_RAW_TEXT = 4000; // truncate to control token usage

async function processJobWithAI(rawJob) {
  if (!GROQ_API_KEY) {
    throw new Error('GEMINI_API_KEY (Groq key) is not set — skipping AI processing');
  }

  const rawText = (rawJob.rawText || rawJob.description || '')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_RAW_TEXT);

  const prompt = `
You are an Ethiopian job assistant helping fresh CS/IT graduates find jobs.
Analyze this job posting and return ONLY a valid JSON object, no markdown, no explanation, no backticks.

JOB DATA:
Title: ${rawJob.title}
Company: ${rawJob.company}
Location: ${rawJob.location}
URL: ${rawJob.url || rawJob.sourceUrl}
Full Text: ${rawText}

Return exactly this JSON structure:
{
  "title": "job title",
  "company": "company name",
  "location": "city, Ethiopia",
  "deadline": "deadline date or Not specified",
  "education": "degree required or Not specified",
  "experience": "0 if fresh graduate or not mentioned, otherwise number",
  "isFreshGradOk": true or false,
  "isITJob": true or false,
  "salary": "amount in ETB or Not disclosed",
  "description": "2-3 sentence summary of what this job is about",
  "responsibilities": ["responsibility 1", "responsibility 2", "responsibility 3", "responsibility 4"],
  "requirements": ["requirement 1", "requirement 2", "requirement 3"],
  "howToApply": "email, URL, or physical address",
  "applyUrl": "direct application URL or null",
  "score": {
    "salary": 0-4,
    "skills": 0-3,
    "growth": 0-2,
    "reputation": 0-1,
    "total": 0-10,
    "reason": "one sentence explaining the score"
  }
}

Scoring rules:
- salary: 4=above 15000ETB mentioned, 2=8000-15000ETB, 1=not mentioned
- skills: 3=teaches React/Node/Python/AI/cloud/Docker, 2=general IT skills, 1=basic admin
- growth: 2=large or well-known company, 1=mid-size company, 0.5=unknown
- reputation: 1=well known Ethiopian or international company, 0.5=unknown
- total = sum of all four scores

For responsibilities: if not mentioned in job text, PREDICT 4 realistic ones based on the job title.
isFreshGradOk = true if experience is 0, "entry level", "junior", "fresh graduate", or "1 year".
isITJob = true only if this is software/IT/computer science/tech related.
`;

  const response = await axios.post(GROQ_URL, {
    model      : 'llama-3.3-70b-versatile',
    messages   : [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens : 1000,
  }, {
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type' : 'application/json',
    },
    timeout: 30000,
  });

  const text = response.data.choices[0].message.content;

  // Strip markdown code fences if the model wraps the JSON
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Find the JSON object in the response (handles leading/trailing text)
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Groq response contained no valid JSON object');

  return JSON.parse(jsonMatch[0]);
}

async function processAllJobs(rawJobs) {
  if (!GROQ_API_KEY) {
    logger.warn('[Groq] GEMINI_API_KEY (Groq key) not set — AI processing skipped');
    return [];
  }

  logger.step('🤖', `Processing ${rawJobs.length} jobs through Groq AI (LLaMA 3.3 70B)...`);
  const results = [];

  for (const job of rawJobs) {
    try {
      logger.dim(`  [Groq] Analyzing: "${job.title}" @ ${job.company}`);
      const processed = await processJobWithAI(job);

      if (processed.isITJob && processed.isFreshGradOk) {
        results.push({
          ...processed,
          // Preserve pipeline-required fields
          id        : job.id,
          url       : job.url || job.sourceUrl,
          sourceUrl : job.sourceUrl || job.url,
          source    : job.source,
          published : job.published,
          applyEmail: job.applyEmail,
          // Map AI scores to pipeline scores shape
          scores: {
            salary    : processed.score?.salary     ?? 1,
            skills    : processed.score?.skills     ?? 1,
            upgrade   : processed.score?.growth     ?? 1,
            reputation: processed.score?.reputation ?? 0.5,
            total     : processed.score?.total      ?? 5,
          },
        });
        logger.ok(`  [Groq] ✅ Qualified: "${processed.title}" (score: ${processed.score?.total}/10)`);
      } else {
        logger.dim(`  [Groq] ✗ Filtered: isIT=${processed.isITJob} freshOk=${processed.isFreshGradOk}`);
      }

      // 1.5s delay between calls (Groq free tier: 30 req/min)
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      logger.warn(`[Groq] Failed for "${job.title}": ${err.message}`);
    }
  }

  logger.ok(`[Groq] AI complete: ${rawJobs.length} input → ${results.length} qualified`);
  return results;
}

module.exports = { processAllJobs, processJobWithAI };
