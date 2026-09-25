// Manual read-only probe AFTER booking deployment. Does not create a booking.
import assert from 'node:assert/strict';
const response = await fetch('https://booking.lares.is/walkthrough', { method: 'HEAD', redirect: 'manual' });
assert.equal(response.status, 200);
const policy = response.headers.get('content-security-policy') ?? '';
assert.match(policy, /frame-ancestors 'self' https:\/\/lares\.is https:\/\/www\.lares\.is;/);
assert.ok(!policy.includes('*'));
console.log('Lares appointment responds and allows only Lares embedding. Calendar binding and actual booking still need their own checks.');
