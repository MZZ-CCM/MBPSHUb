/**
 * MBPS Notion Sync Bridge
 * ──────────────────────
 * Local HTTP server (localhost:4949) that receives CRM data
 * from MBPS-CRM.html and pushes it to your Notion databases.
 *
 * No npm install needed — uses only Node.js built-in modules.
 *
 * HOW TO SET YOUR TOKEN:
 *   Run Setup-Notion-Token.bat  (one-time setup)
 *   OR set the NOTION_TOKEN environment variable
 *   OR replace YOUR_NOTION_TOKEN_HERE below directly
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT  = 4949;
const TOKEN = process.env.NOTION_TOKEN || 'YOUR_NOTION_TOKEN_HERE';

// Notion database IDs (from your workspace)
const DB = {
  clients:   'dd631255498a429aa559edb795c1a624',
  // Deals DB needs these extra properties for Notion to track investor
  // decisions/reservations as the source of truth (add them once in Notion):
  // Investor Decision (select: Accepted/Declined), Decision Date (date),
  // Reserved (checkbox), Reservation Amount (number), Reservation Date (date).
  deals:     'ae6e014075514d6ebcb03d550580d972',
  documents: '9a818557cd9f4a9c8d30a897d2fba54b',
  // Create a "Tasks" database in Notion with these properties, then paste
  // its ID here: Task Name (title), Status (select), Priority (select),
  // Due Date (date), Reminder 1 (date), Reminder 2 (date), Notes (text).
  // See the "Reminders" note near syncAll() below — Notion's API can set
  // these dates, but turning on the actual notification is a one-time
  // manual toggle inside Notion on the Reminder 1 / Reminder 2 columns.
  tasks:     process.env.NOTION_TASKS_DB || 'YOUR_TASKS_DATABASE_ID_HERE',
};

// File that maps local CRM IDs → Notion page IDs (auto-managed)
const MAP_FILE = path.join(__dirname, 'mbps-notion-map.json');

// ─── ID map helpers ─────────────────────────────────────────────────────────
function loadMap() {
  try {
    const m = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    m.tasks = m.tasks || {};
    return m;
  }
  catch { return { clients: {}, deals: {}, documents: {}, tasks: {} }; }
}
function saveMap(map) {
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
}

// ─── Notion API helper ───────────────────────────────────────────────────────
function notionRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      path: '/v1/' + endpoint,
      method,
      headers: {
        'Authorization':  'Bearer ' + TOKEN,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ error: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Property builders ───────────────────────────────────────────────────────

function text(val) {
  return { rich_text: [{ text: { content: String(val || '') } }] };
}
function title(val) {
  return { title: [{ text: { content: String(val || '') } }] };
}
function select(val) {
  return val ? { select: { name: val } } : { select: null };
}
function num(val) {
  return (val !== null && val !== undefined) ? { number: Number(val) } : { number: null };
}
function checkbox(val) {
  return { checkbox: !!val };
}
function date(val) {
  return val ? { date: { start: val } } : { date: null };
}
function email(val) {
  return { email: val || null };
}
function phone(val) {
  return { phone_number: val || null };
}
function url(val) {
  return { url: val || null };
}
function relation(notionId) {
  return notionId ? { relation: [{ id: notionId }] } : { relation: [] };
}

// Notion's PATCH only touches properties present in the request — any key
// left out of `properties` is untouched server-side. That makes "only send
// the keys whose source value is actually defined" the safe way to do
// partial updates (e.g. client-property.html pushing just a decision/
// reservation) without nulling out everything else already in Notion.
// `undefined` means "don't know, leave it alone"; `null`/''/0/false are
// real values and still get sent.
function setIf(p, key, val, builder) {
  if (val !== undefined) p[key] = builder(val);
}

// Build Notion properties for a CLIENT record
function buildClientProps(c) {
  const p = { 'Client Name': title(c.name) };
  setIf(p, 'Client Type',      c.type,              select);
  setIf(p, 'Status',           c.status,            select);
  setIf(p, 'Email',            c.email,             email);
  setIf(p, 'Phone',            c.phone,             phone);
  setIf(p, 'Company',          c.company,           text);
  setIf(p, 'Investment Budget',c.budget,             num);
  // Notion percent format: stores as decimal. 8% → 0.08
  setIf(p, 'Min Yield %',      c.yield != null ? c.yield / 100 : c.yield, num);
  setIf(p, 'Target Locations', c.locations,          text);
  setIf(p, 'Agreement Signed', c.agreementSigned,    checkbox);
  setIf(p, 'Deposit Paid',     c.depositPaid,        checkbox);
  setIf(p, 'Notes',            c.notes,              text);
  return p;
}

// Build Notion properties for a DEAL record
function buildDealProps(d, clientNotionId) {
  const p = { 'Deal Name': title(d.name) };
  setIf(p, 'Stage',             d.stage,            select);
  setIf(p, 'Priority',          d.priority,         select);
  setIf(p, 'Property Address',  d.address,          text);
  setIf(p, 'Property Type',     d.proptype,         select);
  setIf(p, 'Asking Price',      d.price,            num);
  setIf(p, 'Monthly Rent',      d.rent,             num);
  setIf(p, 'Sourcing Fee',      d.fee,              num);
  setIf(p, 'Deposit Received',  d.depositReceived,  checkbox);
  setIf(p, 'Target Completion', d.completion,       date);
  setIf(p, 'Notes',             d.notes,            text);
  // Investor decision + exclusive reservation — kept in Notion so any
  // device (CRM or an investor's own phone) sees the live, canonical state
  // instead of whatever was frozen into a share link at send time.
  if (d.investorDecision !== undefined) {
    p['Investor Decision'] = select(d.investorDecision ? (d.investorDecision.status === 'accepted' ? 'Accepted' : 'Declined') : null);
    p['Decision Date']     = date(d.investorDecision ? d.investorDecision.at : null);
  }
  if (d.reserved !== undefined) {
    p['Reserved']            = checkbox(!!d.reserved);
    p['Reservation Amount']  = num(d.reserved ? d.reserved.amount : null);
    p['Reservation Date']    = date(d.reserved ? d.reserved.at : null);
  }
  if (clientNotionId !== undefined) p['Client'] = relation(clientNotionId);
  return p;
}

// Build Notion properties for a DOCUMENT record
function buildDocProps(doc, clientNotionId, dealNotionId) {
  const p = { 'Document Name': title(doc.name) };
  setIf(p, 'Document Type', doc.type,   select);
  setIf(p, 'Status',        doc.status, select);
  setIf(p, 'Document Date', doc.date,   date);
  setIf(p, 'Amount',        doc.amount, num);
  setIf(p, 'File URL',      doc.fileUrl,url);
  setIf(p, 'Notes',         doc.notes,  text);
  if (clientNotionId !== undefined) p['Client'] = relation(clientNotionId);
  if (dealNotionId   !== undefined) p['Deal']   = relation(dealNotionId);
  return p;
}

// Add `days` days to an ISO date string (YYYY-MM-DD or full ISO), returned
// as YYYY-MM-DD. Used to build the "day after" reminder.
function addDays(isoDate, days) {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Build Notion properties for a TASK record.
// Reminder 1 = due date itself, Reminder 2 = the day after — matching
// "notify me the same day and the next day" from the CRM. Notion's API can
// set these dates, but actually pinging you requires turning on "Remind me"
// on the Reminder 1 / Reminder 2 date properties inside Notion once — the
// API has no endpoint for personal notification preferences.
function buildTaskProps(t, dealNotionId) {
  const p = { 'Task Name': title(t.title) };
  setIf(p, 'Priority', t.priority, select);
  if (t.done !== undefined) p['Status'] = select(t.done ? 'Done' : 'Open');
  if (t.due !== undefined) {
    p['Due Date']   = date(t.due);
    p['Reminder 1'] = date(t.due);
    p['Reminder 2'] = date(t.due ? addDays(t.due, 1) : null);
  }
  setIf(p, 'Notes', t.notes, text);
  if (dealNotionId !== undefined) p['Deal'] = relation(dealNotionId);
  return p;
}

// ─── Reading back from Notion (Notion → CRM JSON) ────────────────────────────
// Makes Notion the source of truth: any device — the CRM or an investor's own
// phone opening a property link — can pull the live record instead of
// trusting a snapshot frozen into a share link or a per-browser localStorage
// copy. Only the fields Notion actually has properties for round-trip here;
// CRM-only fields (bedrooms, images, strategyInputs, etc.) aren't in the
// Notion schema yet, so a pull merges just the known fields rather than
// overwriting the local record wholesale.

function readText(prop)   { return prop?.rich_text?.map(t => t.plain_text).join('') || ''; }
function readTitle(prop)  { return prop?.title?.map(t => t.plain_text).join('') || ''; }
function readSelect(prop) { return prop?.select?.name || null; }
function readNum(prop)    { return prop?.number != null ? prop.number : null; }
function readCheckbox(prop){ return !!prop?.checkbox; }
function readDate(prop)   { return prop?.date?.start || null; }
function readRelationFirst(prop) { return prop?.relation?.[0]?.id || null; }

// Every map is localId -> notionId. Flip it so a Notion relation/page id can
// be resolved back to the local CRM id it was created from.
function invertMap(half) {
  const out = {};
  for (const [localId, notionId] of Object.entries(half)) out[notionId] = localId;
  return out;
}

// A page Notion knows about that the CRM has never seen (created directly
// in Notion) has no local id yet — mint a stable one and register it in the
// map so future pulls/pushes keep referring to the same record.
function localIdFor(map, collection, notionId) {
  for (const [localId, nid] of Object.entries(map[collection])) {
    if (nid === notionId) return localId;
  }
  const localId = 'ntn_' + notionId.replace(/-/g, '');
  map[collection][localId] = notionId;
  return localId;
}

async function notionQueryAll(dbId) {
  let results = [], cursor = undefined;
  do {
    const res = await notionRequest('POST', `databases/${dbId}/query`, cursor ? { start_cursor: cursor } : {});
    if (!res.results) break;
    results = results.concat(res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return results;
}

function pageToClient(page, map) {
  const p = page.properties;
  return {
    id: localIdFor(map, 'clients', page.id),
    name: readTitle(p['Client Name']),
    type: readSelect(p['Client Type']),
    status: readSelect(p['Status']),
    email: p['Email']?.email || '',
    phone: p['Phone']?.phone_number || '',
    company: readText(p['Company']),
    budget: readNum(p['Investment Budget']),
    yield: readNum(p['Min Yield %']) != null ? readNum(p['Min Yield %']) * 100 : null,
    locations: readText(p['Target Locations']),
    agreementSigned: readCheckbox(p['Agreement Signed']),
    depositPaid: readCheckbox(p['Deposit Paid']),
    notes: readText(p['Notes']),
  };
}

function pageToDeal(page, map, revClients) {
  const p = page.properties;
  const clientNotionId = readRelationFirst(p['Client']);
  const decisionSel = readSelect(p['Investor Decision']);
  const decisionAt = readDate(p['Decision Date']);
  const reserved = readCheckbox(p['Reserved']);
  return {
    id: localIdFor(map, 'deals', page.id),
    name: readTitle(p['Deal Name']),
    stage: readSelect(p['Stage']),
    priority: readSelect(p['Priority']),
    address: readText(p['Property Address']),
    proptype: readSelect(p['Property Type']),
    price: readNum(p['Asking Price']),
    rent: readNum(p['Monthly Rent']),
    fee: readNum(p['Sourcing Fee']),
    depositReceived: readCheckbox(p['Deposit Received']),
    completion: readDate(p['Target Completion']),
    notes: readText(p['Notes']),
    clientId: clientNotionId ? (revClients[clientNotionId] || null) : null,
    investorDecision: decisionSel ? { status: decisionSel === 'Accepted' ? 'accepted' : 'declined', at: decisionAt } : null,
    reserved: reserved ? { amount: readNum(p['Reservation Amount']), at: readDate(p['Reservation Date']) } : null,
  };
}

function pageToDoc(page, map, revClients, revDeals) {
  const p = page.properties;
  const clientNotionId = readRelationFirst(p['Client']);
  const dealNotionId   = readRelationFirst(p['Deal']);
  return {
    id: localIdFor(map, 'documents', page.id),
    name: readTitle(p['Document Name']),
    type: readSelect(p['Document Type']),
    status: readSelect(p['Status']),
    date: readDate(p['Document Date']),
    amount: readNum(p['Amount']),
    fileUrl: p['File URL']?.url || '',
    notes: readText(p['Notes']),
    clientId: clientNotionId ? (revClients[clientNotionId] || null) : null,
    dealId: dealNotionId ? (revDeals[dealNotionId] || null) : null,
  };
}

function pageToTask(page, map, revDeals) {
  const p = page.properties;
  const dealNotionId = readRelationFirst(p['Deal']);
  return {
    id: localIdFor(map, 'tasks', page.id),
    title: readTitle(p['Task Name']),
    priority: readSelect(p['Priority']),
    done: readSelect(p['Status']) === 'Done',
    due: readDate(p['Due Date']),
    notes: readText(p['Notes']),
    acquisitionId: dealNotionId ? (revDeals[dealNotionId] || null) : null,
  };
}

// Pull everything Notion has and reshape it into the CRM's collection names.
async function pullAll() {
  const map = loadMap();
  const [clientPages, dealPages, docPages, taskPages] = await Promise.all([
    notionQueryAll(DB.clients),
    notionQueryAll(DB.deals),
    notionQueryAll(DB.documents),
    DB.tasks !== 'YOUR_TASKS_DATABASE_ID_HERE' ? notionQueryAll(DB.tasks) : Promise.resolve([]),
  ]);
  const clients = clientPages.map(pg => pageToClient(pg, map));
  const revClients = invertMap(map.clients);
  const deals = dealPages.map(pg => pageToDeal(pg, map, revClients));
  const revDeals = invertMap(map.deals);
  const documents = docPages.map(pg => pageToDoc(pg, map, revClients, revDeals));
  const tasks = taskPages.map(pg => pageToTask(pg, map, revDeals));
  saveMap(map);
  return { clients, deals, documents, tasks, _pulledAt: new Date().toISOString() };
}

// Pull a single deal by its local CRM id — used by client-property.html for
// a cheap "does anyone else hold this reservation right now?" check without
// pulling the whole workspace.
async function pullOneDeal(localId) {
  const map = loadMap();
  const notionId = map.deals[localId];
  if (!notionId) return null;
  const page = await notionRequest('GET', `pages/${notionId}`);
  if (page.object !== 'page') return null;
  const revClients = invertMap(map.clients);
  return pageToDeal(page, map, revClients);
}

// ─── Core sync logic ─────────────────────────────────────────────────────────
async function syncAll(data) {
  const map = loadMap();
  const log = [];

  // Helper: create or update a Notion page
  async function upsert(collection, localId, dbId, props, label) {
    try {
      if (map[collection][localId]) {
        // UPDATE existing Notion page
        const res = await notionRequest('PATCH', `pages/${map[collection][localId]}`, {
          properties: props,
        });
        if (res.object === 'page') {
          log.push(`✓ Updated  [${collection}] ${label}`);
        } else {
          log.push(`✗ Update failed [${collection}] ${label}: ${res.message || JSON.stringify(res).slice(0, 80)}`);
        }
      } else {
        // CREATE new Notion page
        const res = await notionRequest('POST', 'pages', {
          parent: { database_id: dbId },
          properties: props,
        });
        if (res.id) {
          map[collection][localId] = res.id;
          log.push(`✓ Created  [${collection}] ${label}`);
        } else {
          log.push(`✗ Create failed [${collection}] ${label}: ${res.message || JSON.stringify(res).slice(0, 80)}`);
        }
      }
    } catch (err) {
      log.push(`✗ Error    [${collection}] ${label}: ${err.message}`);
    }
  }

  // ── 1. Sync clients first (deals/docs depend on their Notion IDs)
  for (const c of (data.clients || [])) {
    await upsert('clients', c.id, DB.clients, buildClientProps(c), c.name);
  }

  // ── 2. Sync deals
  for (const d of (data.deals || [])) {
    const clientNotionId = d.clientId ? map.clients[d.clientId] : null;
    await upsert('deals', d.id, DB.deals, buildDealProps(d, clientNotionId), d.name);
  }

  // ── 3. Sync documents
  for (const doc of (data.documents || [])) {
    const clientNotionId = doc.clientId ? map.clients[doc.clientId] : null;
    const dealNotionId   = doc.dealId   ? map.deals[doc.dealId]     : null;
    await upsert('documents', doc.id, DB.documents, buildDocProps(doc, clientNotionId, dealNotionId), doc.name);
  }

  // ── 4. Sync tasks — every task noted in the CRM gets pushed, with a
  // same-day and next-day reminder date set on it (see buildTaskProps).
  for (const t of (data.tasks || [])) {
    const dealNotionId = t.acquisitionId ? map.deals[t.acquisitionId] : null;
    await upsert('tasks', t.id, DB.tasks, buildTaskProps(t, dealNotionId), t.title);
  }

  saveMap(map);
  return log;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS — allow the local HTML file to call us
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /health — quick ping from the CRM to check if bridge is alive
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bridge: 'MBPS Notion Sync', port: PORT }));
    return;
  }

  // GET /data — pull the full canonical dataset from Notion. The CRM calls
  // this on load (and on demand) so Notion, not localStorage, is the source
  // of truth for whatever fields Notion tracks.
  if (req.method === 'GET' && req.url === '/data') {
    try {
      const data = await pullAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...data }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // GET /deal/:localId — single-record pull, used by client-property.html
  // to check the live decision/reservation state before an investor acts,
  // without pulling the whole workspace over the wire.
  if (req.method === 'GET' && req.url.startsWith('/deal/')) {
    const localId = decodeURIComponent(req.url.slice('/deal/'.length));
    try {
      const deal = await pullOneDeal(localId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deal }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // POST /sync — receive full (or partial) CRM payload and push to Notion.
  // Partial payloads are safe: buildXProps() only includes a Notion property
  // key when the matching source field is actually present (see setIf), so
  // omitted fields are left untouched in Notion rather than nulled out.
  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const ts = new Date().toLocaleTimeString();
        console.log(`\n[${ts}] Sync received — ${data.clients?.length || 0} clients · ${data.deals?.length || 0} deals · ${data.documents?.length || 0} docs · ${data.tasks?.length || 0} tasks`);
        const log = await syncAll(data);
        log.forEach(l => console.log('  ' + l));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, synced: log.length, log }));
      } catch (err) {
        console.error('  ✗ Sync error:', err.message);
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
  console.log('║     MBPS Notion Sync Bridge  ·  Active       ║');
  console.log(`║     Listening → localhost:${PORT}               ║`);
  console.log('╚═══════════════════════════════════════════════╝\n');

  if (!TOKEN || TOKEN === 'YOUR_NOTION_TOKEN_HERE') {
    console.log('  ⚠  No Notion token found!');
    console.log('  ⚠  Run Setup-Notion-Token.bat to add your token.');
    console.log('  ⚠  Or set the NOTION_TOKEN environment variable.\n');
  } else {
    console.log('  ✓  Notion token loaded');
    console.log('  ✓  Databases: Clients · Deals · Documents' + (DB.tasks !== 'YOUR_TASKS_DATABASE_ID_HERE' ? ' · Tasks' : ''));
    if (DB.tasks === 'YOUR_TASKS_DATABASE_ID_HERE') {
      console.log('  ⚠  Tasks database not set — create a "Tasks" DB in Notion and set NOTION_TASKS_DB (see top of file) to push tasks + reminders.');
    } else {
      console.log('  ℹ  Tasks sync sets Reminder 1 (due date) and Reminder 2 (due date + 1 day).');
      console.log('  ℹ  One-time step in Notion: open the Tasks database, click a date in Reminder 1, choose "Remind me", repeat for Reminder 2 — Notion can\'t enable that via API.');
    }
    console.log('  ✓  Ready — save anything in MBPS CRM to trigger sync\n');
  }
});
