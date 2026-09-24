import { expect, it } from 'vitest';
import { CAPABILITY_DOCS, hostsFor } from '../src/persona/capability-docs.js';
it('every adapter declares fixed hosts or its actual configured endpoint', () => {
  for (const doc of Object.values(CAPABILITY_DOCS)) {
    if (doc.kind === 'adapter') expect((doc.hosts?.length ?? 0) + (doc.endpoint ? 1 : 0), doc.capability).toBeGreaterThan(0);
  }
  expect(CAPABILITY_DOCS.read_url.endpoint).toBe('READABILITY_URL');
  expect(CAPABILITY_DOCS.twenty.endpoint).toBe('TWENTY_BASE_URL');
  expect(CAPABILITY_DOCS.orakel.endpoint).toBe('ORAKEL_URL');
});
it('keeps Google breadth and real vendor hosts without granting replica or local stores internet', () => {
  expect(hostsFor('gmail')).toEqual(['.googleapis.com']);
  expect(hostsFor('calendar')).toEqual(['.googleapis.com']);
  expect(hostsFor('currency')).toEqual(['api.frankfurter.dev']);
  expect(hostsFor('notion')).toEqual(['api.notion.com']);
  for (const c of ['network','vault','signals','read_url','voice']) expect(hostsFor(c)).toEqual([]);
  expect(() => hostsFor('missing')).toThrow();
});
