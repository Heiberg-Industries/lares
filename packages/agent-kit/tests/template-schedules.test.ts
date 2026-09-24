import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { parseDefinition } from '../src/definition.js';
for (const role of ['chief-of-staff', 'travel', 'creative'])
    it(`${role} builder offers every shipped schedule`, () => {
        const d = parseDefinition(JSON.parse(readFileSync(resolve('templates', role, 'definition.json'), 'utf8')));
        const dir = resolve('../../services', role, 'agent/schedules');
        const slugs = (existsSync(dir) ? readdirSync(dir) : []).filter(f => f.endsWith('.ts')).map(f => f.slice(0, -3)).sort();
        expect(Object.keys(d.schedules).sort()).toEqual(slugs);
        expect(d.role).toBe(role);
        expect(d.gender).toBeUndefined();
        expect(d.language).toBeUndefined();
    });
