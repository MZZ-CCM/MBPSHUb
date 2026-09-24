// ════════════════════════════════════════════════════════════════════
// MBPS shared workspace connection (Supabase, London region)
// The anon key is designed to be public: on its own it can only
// call the validated intake functions. All CRM data requires a signed-in,
// active team member, and permissions are enforced in the database.
// ════════════════════════════════════════════════════════════════════
window.MBPS_CLOUD = {
  url: 'https://ufuxrfqazxjrmvxvyflp.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVmdXhyZnFhenhqcm12eHZ5ZmxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxOTYwNTYsImV4cCI6MjEwNTc3MjA1Nn0.-NKNOiJ5jgUVfbjzEaEfxHlfIyAni2sp7n6FVbW_wT4'
};

// Call a public database function with a deadline. Resolves with the
// function's result; rejects with a human-readable Error.
window.mbpsRpc = async function (fn, args, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 12000);
  try {
    const res = await fetch(MBPS_CLOUD.url + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: MBPS_CLOUD.key, Authorization: 'Bearer ' + MBPS_CLOUD.key },
      body: JSON.stringify(args || {}),
      signal: ctrl.signal
    });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!res.ok) throw new Error((body && body.message) || 'Something went wrong — please call 07447 394 309.');
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The connection timed out — please try again, or call 07447 394 309.');
    if (e instanceof TypeError) throw new Error('We couldn’t reach our system — please check your connection or call 07447 394 309.');
    throw e;
  } finally { clearTimeout(timer); }
};
