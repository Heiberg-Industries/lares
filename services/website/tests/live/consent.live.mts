// Read-only deployment gate: no consent records or analytics events are sent.
// Verified current service /api/init shape on 2026-09-25 with the existing
// Heiberg origin. Lares origins must pass after the consent tenant is deployed.
import assert from 'node:assert/strict';
const base = 'https://consent.heiberg.co/api';
for (const origin of ['https://lares.is', 'https://www.lares.is']) {
  const preflight = await fetch(`${base}/subjects`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin, `Consent tenant not enabled for ${origin}`);
  const response = await fetch(`${base}/init`, { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const data = await response.json();
  assert.equal(data.jurisdiction, 'GDPR', 'Consent must remain opt-in');
  console.log(`${origin}: CORS and opt-in initialization pass`);
}
