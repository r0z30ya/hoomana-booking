/**
 * hbook — local webhook receiver used by the test suites.
 *
 * Verifies the X-HBook-Signature header against the shared secret passed
 * via WEBHOOK_SECRET env:  v1 = HMAC_SHA256(secret, "<t>.<rawBody>")
 *
 * Endpoints:
 *   POST /hooks/hbook            → records the event (main target)
 *   POST /hooks/flaky            → fails N times (RECEIVER_FAIL_FIRST), then 200
 *   POST /redirect               → 307 → /hooks/hbook (redirect following)
 *   POST /redirect-private       → 307 → http://127.0.0.1:1/ (must be BLOCKED by engine)
 *   GET  /received               → JSON list of recorded events
 *   POST /reset                  → clears the list
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4919);
const PATH = '/hooks/hbook';
const SECRET = process.env.WEBHOOK_SECRET || '';
const FAIL_FIRST = Number(process.env.RECEIVER_FAIL_FIRST || 0);
let flakyFails = FAIL_FIRST;

const received = [];

function verifySignature(rawBody, header) {
  if (!header || !SECRET) return { verified: false, reason: 'missing header or secret' };
  const parts = {};
  for (const chunk of String(header).split(',')) {
    const [k, v] = chunk.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  if (!parts.t || !parts.v1) return { verified: false, reason: 'malformed header' };
  const expected = crypto.createHmac('sha256', SECRET).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(parts.v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  const verified = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { verified, reason: verified ? 'ok' : 'signature mismatch' };
}

function record(req, res, raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep raw */
  }
  const check = verifySignature(raw, req.headers['x-hbook-signature']);
  received.push({
    at: new Date().toISOString(),
    event: req.headers['x-hbook-event'] || parsed?.event || 'unknown',
    eventId: req.headers['x-hbook-event-id'] || parsed?.id || null,
    deliveryId: req.headers['x-hbook-delivery-id'] || null,
    verified: check.verified,
    reason: check.reason,
    body: parsed,
  });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

const server = http.createServer((req, res) => {
  const url = req.url || '';

  if (req.method === 'GET' && url === '/received') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(received));
    return;
  }
  if (req.method === 'POST' && url === '/reset') {
    received.length = 0;
    flakyFails = FAIL_FIRST;
    res.writeHead(200).end('{"ok":true}');
    return;
  }
  if (req.method === 'POST' && (url === PATH || url.startsWith(PATH))) {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => record(req, res, raw));
    return;
  }
  if (req.method === 'POST' && url.startsWith('/hooks/flaky')) {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (flakyFails > 0) {
        flakyFails -= 1;
        res.writeHead(500).end('{"ok":false,"flaky":true}');
        return;
      }
      record(req, res, raw);
    });
    return;
  }
  if (req.method === 'POST' && url.startsWith('/redirect')) {
    // both redirect flavors rely on the Location header
    const target = url.startsWith('/redirect-private') ? 'http://127.0.0.1:1/nothing' : `http://127.0.0.1:${PORT}${PATH}`;
    res.writeHead(307, { location: target });
    res.end();
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[webhook-receiver] listening on http://127.0.0.1:${PORT}${PATH}`);
});
