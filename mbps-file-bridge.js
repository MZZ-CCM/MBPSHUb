/**
 * MBPS File Bridge
 * ────────────────
 * Tiny local server (localhost:4848) — no Notion token needed.
 * Receives CRM data from MBPS-CRM.html and saves it to
 * crm-sync-data.json in this folder.
 *
 * A Cowork scheduled task reads that file every 5 minutes
 * and pushes changes to Notion using the existing connection.
 *
 * Uses only Node.js built-in modules — no npm install required.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = 4848;
const DATA_FILE = path.join(__dirname, 'crm-sync-data.json');
const LOG_FILE  = path.join(__dirname, 'crm-bridge-log.txt');

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health ping from the CRM
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bridge: 'MBPS File Bridge', port: PORT }));
    return;
  }

  // Receive full CRM dataset and write to file
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // Stamp the save time so the scheduled task knows when to sync
        data._savedAt = new Date().toISOString();
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        log(`Saved — ${data.clients?.length || 0} clients · ${data.deals?.length || 0} deals · ${data.documents?.length || 0} docs`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log(`Error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║     MBPS File Bridge  ·  Running             ║');
  console.log(`║     Listening → localhost:${PORT}                 ║`);
  console.log('║     Saves → crm-sync-data.json               ║');
  console.log('║     Cowork syncs to Notion every 5 min       ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
  console.log('  Keep this window open while using MBPS-CRM.html\n');
});
