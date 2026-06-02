#!/usr/bin/env node
// ─── Lightweight HTTP server for the EthioTechJobs dashboard ─────────────
// Serves dashboard.html + data/jobs.json from the job-search root directory.
// Run: node serve-dashboard.js
// Then open: http://localhost:3001

'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3001;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css' : 'text/css',
  '.js'  : 'application/javascript',
  '.ico' : 'image/x-icon',
  '.png' : 'image/png',
  '.svg' : 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // Default to dashboard.html
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') urlPath = '/dashboard.html';

  const filePath = path.join(ROOT, urlPath);

  // Security: only serve files within ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type'                : MIME[ext] || 'application/octet-stream',
      'Cache-Control'               : 'no-store',
      'Access-Control-Allow-Origin' : '*',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🇪🇹  EthioTechJobs Dashboard');
  console.log('  ─────────────────────────────────────');
  console.log(`  ✅  Running at  →  http://localhost:${PORT}`);
  console.log('  🔄  Auto-reads  →  data/jobs.json');
  console.log('  📡  Bot posting →  @Ethio_Fresh_Jobs');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
