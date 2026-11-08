/**
 * hbook — local webhook receiver used by scripts/e2e.mjs.
 *
 * Verifies the X-HBook-Signature header against the shared secret passed
 * via WEBHOOK_SECRET env:  v1 = HMAC_SHA256(secret, "<t>.<rawBody>")
 *
 * Endpoints:
 *   POST /hook            → records the event (must be the configured path)
 *   GET  /received        → JSON list of recorded events
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4919);
const PATH = '/hooks/hbook';
const SECRET = process.env.WEBHOOK_SECRET || '';

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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/received') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(received));
    return;
  }
  if (req.method === 'POST' && (req.url === PATH || req.url.startsWith(PATH))) {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
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
        verified: check.verified,
        reason: check.reason,
        body: parsed,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[webhook-receiver] listening on http://127.0.0.1:${PORT}${PATH}`);
});
