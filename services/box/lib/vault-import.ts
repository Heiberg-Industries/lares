/** Bring an existing folder of notes into the managed Vault: scan it, decide where each file goes,
 * show the plan, and (only for an exact plan the owner confirmed) write it through the guarded
 * bulk path. Create-only: a note already in the Vault is never overwritten. Each chunk of files
 * is committed together with its own small ledger file, so a re-run knows what it brought in and
 * what the owner has changed or deleted since. The source folder is only ever read. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import type { Pool } from 'pg';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { GuardedVaultFiles, stampImportedNote, type VaultFilesBackings, type VaultFilesContext } from '@lares/agent-kit/vault-files';
import { readOriginFrontmatter, type Origin } from '@lares/vault-format/origin';
import { loadVaultStorageInventory, verifyVaultStorage, verifyVaultStorageFiles, VAULT_STORAGE_PENDING, type ManagedVaultArea, type VaultStorageFiles, type VaultStorageInventory } from './vault-storage.js';

export type ImportArea = 'private' | 'shared';
export interface MapRule { match: string; area?: ImportArea; strip?: string; skip?: boolean }
export interface ImportMap { default?: ImportArea; rules?: MapRule[] }
export interface ImportOptions {
    label: string; map: ImportMap; shared: string[]; private: string[]; skip: string[];
    origin: 'owner' | 'agent' | 'synced'; includeConversations: boolean;
}
export class VaultImportError extends Error {
    constructor(message: string) { super(message); this.name = 'VaultImportError'; }
}
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENTS_TOTAL_MAX_BYTES = 500 * 1024 * 1024;
export const CHUNK_FILES = 500;
export const CHUNK_BYTES = 20 * 1024 * 1024;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new VaultImportError(message); };

/* ---------- the map ---------- */
export function parseImportMap(value: unknown): ImportMap {
    const bad = (why: string) => fail(`the map file is not valid: ${why}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('it must be a JSON object');
    const v = value as Record<string, unknown>;
    for (const key of Object.keys(v)) if (key !== 'default' && key !== 'rules') bad(`unknown key "${key}"`);
    const areaOf = (x: unknown, where: string): ImportArea => x === 'private' || x === 'shared' ? x : bad(`${where} must be "private" or "shared"`);
    const map: ImportMap = {};
    if (v.default !== undefined) map.default = areaOf(v.default, 'default');
    if (v.rules !== undefined) {
        if (!Array.isArray(v.rules)) bad('"rules" must be a list');
        map.rules = (v.rules as unknown[]).map((r, i) => {
            if (!r || typeof r !== 'object' || Array.isArray(r)) return bad(`rule ${i + 1} must be an object`);
            const o = r as Record<string, unknown>;
            for (const key of Object.keys(o)) if (!['match', 'area', 'strip', 'skip'].includes(key)) bad(`rule ${i + 1} has an unknown key "${key}"`);
            if (typeof o.match !== 'string' || !o.match) bad(`rule ${i + 1} needs a "match" pattern`);
            const rule: MapRule = { match: o.match as string };
            if (o.skip !== undefined) { if (o.skip !== true) bad(`rule ${i + 1}: "skip" can only be true`); rule.skip = true; }
            if (o.area !== undefined) rule.area = areaOf(o.area, `rule ${i + 1} area`);
            if (o.strip !== undefined) { if (typeof o.strip !== 'string') bad(`rule ${i + 1}: "strip" must be text`); rule.strip = o.strip as string; }
            if (!rule.skip && !rule.area) bad(`rule ${i + 1} needs an "area" or "skip"`);
            return rule;
        });
    }
    return map;
}
function globRegex(glob: string): RegExp {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === '*') {
            if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; } else out += '[^/]*';
        } else if (c === '?') out += '[^/]';
        else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}
/** A pattern matches a path when it matches the path itself or any folder above it. */
function matches(glob: string, path: string): boolean {
    const re = globRegex(glob.normalize('NFC').replace(/\/+$/, ''));
    const parts = path.split('/');
    for (let n = 1; n <= parts.length; n++) if (re.test(parts.slice(0, n).join('/'))) return true;
    return false;
}

/* ---------- scanning the source ---------- */
export interface SourceFile { path: string; abs: string; size: number }
export interface Scan {
    files: SourceFile[]; hidden: number; symlinks: number; hardLinks: number; nestedRepos: number; unsafeNames: number; head: string | null;
}
function countFiles(abs: string): number {
    let n = 0;
    try {
        for (const e of readdirSync(abs, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(abs, e.name)) : 1;
    } catch { /* unreadable: counted as nothing */ }
    return n || 1;
}
function sourceHead(root: string): string | null {
    try {
        const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
        if (/^[0-9a-f]{40}$/.test(head)) return head;
        const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1];
        if (!ref || ref.includes('..')) return null;
        try { return readFileSync(join(root, '.git', ref), 'utf8').trim().slice(0, 40) || null; } catch { /* packed */ }
        const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8').split('\n').find(l => l.endsWith(' ' + ref));
        return packed ? packed.slice(0, 40) : null;
    } catch { return null; }
}
export function scanSource(root: string): Scan {
    const scan: Scan = { files: [], hidden: 0, symlinks: 0, hardLinks: 0, nestedRepos: 0, unsafeNames: 0, head: sourceHead(root) };
    const walk = (abs: string, rel: string): void => {
        for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const childAbs = join(abs, e.name), childRel = rel ? `${rel}/${e.name}` : e.name;
            if (!rel && e.name === '.lares-import.json') continue;
            if (e.name.startsWith('.') || e.name === 'node_modules') { scan.hidden += e.isDirectory() ? countFiles(childAbs) : 1; continue; }
            if (e.isSymbolicLink()) { scan.symlinks++; continue; }
            if (e.isDirectory()) {
                if (existsSync(join(childAbs, '.git'))) { scan.nestedRepos++; continue; }
                walk(childAbs, childRel);
                continue;
            }
            if (!e.isFile()) { scan.hidden++; continue; }
            const st = lstatSync(childAbs);
            if (st.nlink > 1) { scan.hardLinks++; continue; }
            const path = childRel.normalize('NFC');
            if (path.length > 512 || /[\x00-\x1f\x7f]/.test(path)) { scan.unsafeNames++; continue; }
            scan.files.push({ path, abs: childAbs, size: st.size });
        }
    };
    walk(root, '');
    return scan;
}

/* ---------- deciding where each note goes ---------- */
interface Decision { area: ImportArea; target: string; strip: string; skip?: string }
const isMd = (path: string) => /\.md$/i.test(path);
function frontmatterScope(text: string): 'org' | 'private' | undefined {
    const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    const value = block && /^scope:[ \t]*["']?([A-Za-z]+)/m.exec(block)?.[1]?.toLowerCase();
    return value === 'org' ? 'org' : value === 'private' || value === 'participants' ? 'private' : undefined;
}
function decide(path: string, text: string | null, options: ImportOptions): Decision {
    const same = (area: ImportArea): Decision => ({ area, target: path, strip: '' });
    if (options.skip.some(g => matches(g, path))) return { ...same('private'), skip: 'skipped on request' };
    const top = path.split('/')[0]!;
    if (top === 'taste') return { ...same('private'), skip: 'taste (adopted in a separate step)' };
    if (top === '_meta') {
        if (/^_meta\/dream\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) return same('private');
        if (options.includeConversations && path.startsWith('_meta/conversations/') && isMd(path)) return same('private');
        return { ...same('private'), skip: path.startsWith('_meta/conversations/') ? 'conversation logs' : 'other _meta files' };
    }
    if (top === '_inbox') return same('private');
    const rules: MapRule[] = [
        ...options.shared.map<MapRule>(f => ({ match: f, area: 'shared' })),
        ...options.private.map<MapRule>(f => ({ match: f, area: 'private' })),
        ...(options.map.rules ?? []),
    ];
    for (const rule of rules) {
        if (!matches(rule.match, path)) continue;
        if (rule.skip) return { ...same('private'), skip: 'skipped by the map' };
        const strip = rule.strip && path.startsWith(rule.strip) ? rule.strip : '';
        return { area: rule.area!, target: path.slice(strip.length), strip, ...(strip && !path.slice(strip.length) ? { skip: 'nothing left after stripping' } : {}) };
    }
    const scope = text === null ? undefined : frontmatterScope(text);
    if (scope === 'org') return same('shared');
    if (scope === 'private') return same('private');
    return same(options.map.default ?? 'private');
}

/* ---------- attachments a note refers to ---------- */
function referencesOf(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/!?\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g)) out.push(m[1]!.trim());
    for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        let url = m[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) continue;
        url = url.split(/[?#]/)[0]!;
        try { url = decodeURIComponent(url); } catch { /* keep as written */ }
        if (url) out.push(url);
    }
    return out.filter(r => /\.[A-Za-z0-9]{1,8}$/.test(r) && !isMd(r));
}

/* ---------- the plan ---------- */
export type ItemStatus = 'add' | 'same' | 'sourceNewer' | 'conflict' | 'deleted' | 'duplicate';
export interface PlanItem {
    area: ImportArea; target: string; source: string; abs: string; kind: 'note' | 'attachment'; size: number;
    srcSha: string; importedSha: string; status: ItemStatus; narrowed: boolean; folder: string; conflict?: string;
}
export interface LeftBehind {
    hidden: number; symlinks: number; hardLinks: number; nestedRepos: number; unsafeNames: number; notUtf8: number; dotTargets: number;
    taste: number; meta: number; conversations: number; skipped: number; unreferencedAttachments: number; oversizedAttachments: number;
}
export interface Plan {
    planId: string; sourceId: string; label: string; head: string | null; origin: ImportOptions['origin'];
    items: PlanItem[]; blocked: string[]; left: LeftBehind; notes: number; attachments: number; bytes: number;
}
interface LedgerEntry { srcSha: string; importedSha: string }
export const ledgerDir = (sourceId: string) => `_meta/import/${sourceId}`;
export const sourceIdOf = (label: string) => sha(`lares-import\0${label}`).slice(0, 16);
function readLedger(root: string, sourceId: string): { entries: Map<string, LedgerEntry>; fingerprint: string } {
    const entries = new Map<string, LedgerEntry>(), dir = join(root, ledgerDir(sourceId)), hash = createHash('sha256');
    if (!existsSync(dir)) return { entries, fingerprint: '' };
    for (const name of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
        const abs = join(dir, name), st = lstatSync(abs);
        if (!st.isFile() || st.isSymbolicLink()) fail('an import ledger file is not a plain file; look at it before importing again');
        const bytes = readFileSync(abs);
        hash.update(name).update(bytes);
        let parsed: { files?: Record<string, LedgerEntry> };
        try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return fail(`the import ledger ${name} is damaged; look at it before importing again`); }
        for (const [path, entry] of Object.entries(parsed.files ?? {})) entries.set(path, entry);
    }
    return { entries, fingerprint: hash.digest('hex') };
}
function fileSha(root: string, target: string): string | null | 'unreadable' {
    const abs = join(root, target);
    try {
        const st = lstatSync(abs);
        return st.isFile() && !st.isSymbolicLink() ? sha(readFileSync(abs)) : 'unreadable';
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'; }
}
function areaNoteShas(root: string): Set<string> {
    const out = new Set<string>();
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_meta') continue;
            const abs = join(dir, e.name);
            if (e.isDirectory()) walk(abs);
            else if (e.isFile() && isMd(e.name)) out.add(sha(readFileSync(abs)));
        }
    };
    walk(root);
    return out;
}

export function buildPlan(sourceDir: string, options: ImportOptions, roots: Record<ImportArea, string>): Plan {
    const scan = scanSource(sourceDir), sourceId = sourceIdOf(options.label), blocked: string[] = [];
    const left: LeftBehind = { hidden: scan.hidden, symlinks: scan.symlinks, hardLinks: scan.hardLinks, nestedRepos: scan.nestedRepos,
        unsafeNames: scan.unsafeNames, notUtf8: 0, dotTargets: 0, taste: 0, meta: 0, conversations: 0, skipped: 0, unreferencedAttachments: 0, oversizedAttachments: 0 };
    const ledgers = { private: readLedger(roots.private, sourceId), shared: readLedger(roots.shared, sourceId) };
    const others = new Map(scan.files.filter(f => !isMd(f.path)).map(f => [f.path, f]));
    const byBase = new Map<string, SourceFile[]>();
    for (const f of others.values()) byBase.set(posix.basename(f.path).toLowerCase(), [...(byBase.get(posix.basename(f.path).toLowerCase()) ?? []), f]);
    const top = (path: string) => path.includes('/') ? path.split('/')[0]! : '(top level)';
    const wanted = new Map<string, PlanItem & { origins: string[] }>();
    const attachWanted = new Map<string, { file: SourceFile; area: ImportArea; strip: string; from: string }>();
    const skipCount = (reason: string) => {
        if (reason.startsWith('taste')) left.taste++; else if (reason === 'conversation logs') left.conversations++;
        else if (reason.startsWith('other _meta')) left.meta++; else left.skipped++;
    };
    for (const f of scan.files.filter(f => isMd(f.path))) {
        const bytes = readFileSync(f.abs);
        const text = bytes.toString('utf8');
        const d = decide(f.path, text, options);
        if (d.skip) { skipCount(d.skip); continue; }
        if (!Buffer.from(text, 'utf8').equals(bytes)) { left.notUtf8++; continue; }
        const scope = frontmatterScope(text);
        if (d.area === 'shared' && scope === 'private') blocked.push(`scope conflict: ${f.path} says it is private (or for named people) but the plan puts it in the shared area; map it to private or change the note`);
        if (d.target.split('/').some(s => s.startsWith('.'))) { left.dotTargets++; continue; }
        if (/^(_meta|taste)\//.test(d.target) && !/^_meta\/dream\/\d{4}-\d{2}-\d{2}\.md$/.test(d.target) && !(options.includeConversations && d.target.startsWith('_meta/conversations/'))) {
            blocked.push(`reserved folder: ${f.path} would land in ${d.target}`);
            continue;
        }
        const stamped = stampImportedNote(f.path, text, options.origin), before = readOriginFrontmatter(text);
        const narrowed = before !== undefined && before !== readOriginFrontmatter(stamped);
        const key = `${d.area}:${d.target.toLowerCase()}`;
        const item = { area: d.area, target: d.target, source: f.path, abs: f.abs, kind: 'note' as const, size: f.size, srcSha: sha(bytes), importedSha: sha(stamped),
            status: 'add' as ItemStatus, narrowed, folder: top(f.path), origins: [f.path] };
        const prior = wanted.get(key);
        if (prior) {
            blocked.push(prior.target === d.target
                ? `two sources, one target: ${prior.source} and ${f.path} would both become ${d.area}/${d.target}`
                : `names differ only by capitals: ${prior.source} and ${f.path} (${d.area}/${prior.target} and ${d.target})`);
            continue;
        }
        wanted.set(key, item);
        for (const ref of referencesOf(text)) {
            const norm = (p: string) => posix.normalize(p).normalize('NFC');
            const candidates = [norm(posix.join(posix.dirname(f.path), ref)), norm(ref)];
            let hit = candidates.map(c => others.get(c)).find(Boolean);
            if (!hit && !ref.includes('/')) { const same = byBase.get(ref.toLowerCase()) ?? []; if (same.length === 1) hit = same[0]; }
            if (hit && !hit.path.startsWith('../') && !attachWanted.has(`${d.area}:${hit.path}`)) attachWanted.set(`${d.area}:${hit.path}`, { file: hit, area: d.area, strip: d.strip, from: f.path });
        }
    }
    let attachmentBytes = 0;
    const referenced = new Set<string>();
    for (const { file, area, strip, from } of attachWanted.values()) {
        referenced.add(file.path);
        if (options.skip.some(g => matches(g, file.path)) || /^(taste|_meta)\//.test(file.path)) { left.skipped++; continue; }
        if (file.size > ATTACHMENT_MAX_BYTES) { left.oversizedAttachments++; continue; }
        const target = strip && file.path.startsWith(strip) ? file.path.slice(strip.length) : file.path;
        if (!target || target.split('/').some(s => s.startsWith('.'))) { left.dotTargets++; continue; }
        const key = `${area}:${target.toLowerCase()}`, prior = wanted.get(key);
        if (prior) {
            if (prior.source !== file.path) blocked.push(`two sources, one target: ${prior.source} and ${file.path} would both become ${area}/${target}`);
            continue;
        }
        const bytes = readFileSync(file.abs), digest = sha(bytes);
        attachmentBytes += file.size;
        wanted.set(key, { area, target, source: file.path, abs: file.abs, kind: 'attachment', size: file.size, srcSha: digest, importedSha: digest, status: 'add', narrowed: false, folder: top(file.path), origins: [from] });
    }
    left.unreferencedAttachments = [...others.keys()].filter(p => !referenced.has(p) && !options.skip.some(g => matches(g, p)) && !/^(taste|_meta)\//.test(p)).length;
    if (attachmentBytes > ATTACHMENTS_TOTAL_MAX_BYTES) blocked.push(`the attachments add up to ${Math.round(attachmentBytes / 1048576)} MB; the limit is ${ATTACHMENTS_TOTAL_MAX_BYTES / 1048576} MB. Use --skip for the largest folders`);

    // Compare with what the Vault holds now, and with what an earlier run brought in.
    const noteShas: Partial<Record<ImportArea, Set<string>>> = {};
    const items = [...wanted.values()].sort((a, b) => a.area < b.area ? -1 : a.area > b.area ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
    for (const item of items) {
        const entry = ledgers[item.area].entries.get(item.target), present = fileSha(roots[item.area], item.target);
        if (present === null) item.status = entry ? 'deleted' : 'add';
        else if (present === 'unreadable') { item.status = 'conflict'; item.conflict = 'something that is not a plain file is in the way'; }
        else if (entry) {
            if (present !== entry.importedSha) { item.status = 'conflict'; item.conflict = 'edited since it was imported'; }
            else item.status = entry.srcSha === item.srcSha ? 'same' : 'sourceNewer';
        } else if (present === item.importedSha) item.status = 'same';
        else { item.status = 'conflict'; item.conflict = 'a different note is already at this path'; }
        if (item.status === 'add' && item.kind === 'note') {
            const set = noteShas[item.area] ??= areaNoteShas(roots[item.area]);
            if (set.has(item.srcSha) || set.has(item.importedSha)) item.status = 'duplicate';
        }
    }
    const out = items.map(({ origins: _origins, ...rest }) => rest as PlanItem);
    const planId = sha(JSON.stringify({
        v: 1, sourceId, origin: options.origin, conv: options.includeConversations, shared: options.shared, private: options.private, skip: options.skip, map: options.map,
        files: scan.files.map(f => [f.path, f.size]), items: out.map(i => [i.area, i.target, i.source, i.srcSha, i.importedSha, i.status]), blocked, left,
        ledgers: [ledgers.private.fingerprint, ledgers.shared.fingerprint],
    }));
    return { planId, sourceId, label: options.label, head: scan.head, origin: options.origin, items: out, blocked,
        left, notes: out.filter(i => i.kind === 'note').length, attachments: out.filter(i => i.kind === 'attachment').length, bytes: out.reduce((n, i) => n + i.size, 0) };
}

const mb = (n: number) => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
export function renderPlan(plan: Plan, apply = false): string {
    const lines: string[] = [];
    const count = (s: ItemStatus) => plan.items.filter(i => i.status === s).length;
    lines.push(`Import plan for "${plan.label}": ${plan.notes} notes and ${plan.attachments} attachments (${mb(plan.bytes)}) found${plan.head ? `, source at commit ${plan.head.slice(0, 12)}` : ''}.`);
    const rows = new Map<string, { notes: number; attachments: number; bytes: number }>();
    for (const i of plan.items) {
        const key = `${i.folder}\0${i.area}`, row = rows.get(key) ?? { notes: 0, attachments: 0, bytes: 0 };
        if (i.kind === 'note') row.notes++; else row.attachments++;
        row.bytes += i.size; rows.set(key, row);
    }
    lines.push('', 'Top-level folder'.padEnd(30) + 'goes to'.padEnd(10) + 'notes'.padStart(7) + 'attach.'.padStart(9) + 'size'.padStart(12));
    for (const [key, row] of [...rows].sort()) {
        const [folder, area] = key.split('\0');
        lines.push(folder!.padEnd(30) + (area === 'shared' ? 'shared' : 'private').padEnd(10) + String(row.notes).padStart(7) + String(row.attachments).padStart(9) + mb(row.bytes).padStart(12));
    }
    lines.push('', `Notes without a stamp get lares_origin: ${plan.origin}; ${plan.items.filter(i => i.narrowed && i.status === 'add').length} carry a wider stamp that would be narrowed to ${plan.origin} (a stamp is never widened).`);
    lines.push(`This run: ${count('add')} to add, ${count('same')} already in the Vault, ${count('sourceNewer')} where the source is newer (left alone; --update does not exist yet), `
        + `${count('conflict')} conflicts (left alone), ${count('deleted')} you deleted after an earlier import (not brought back), ${count('duplicate')} probable duplicates (skipped).`);
    for (const i of plan.items.filter(i => i.status === 'conflict').slice(0, 10)) lines.push(`  conflict: ${i.area}/${i.target} (${i.conflict})`);
    const l = plan.left, parts = [[l.hidden, 'hidden files and folders (.obsidian, .trash, .git and the like)'], [l.symlinks, 'links'], [l.hardLinks, 'hard-linked files'], [l.nestedRepos, 'folders that are their own repository'],
        [l.unsafeNames, 'files with unusable names'], [l.notUtf8, 'notes that are not valid UTF-8 text'], [l.dotTargets, 'files that would land on a hidden path'], [l.taste, 'taste files (adopted separately)'],
        [l.meta, 'other _meta files'], [l.conversations, 'conversation logs (--include-conversations brings them)'], [l.skipped, 'skipped on request'],
        [l.unreferencedAttachments, 'attachments no imported note refers to'], [l.oversizedAttachments, `attachments over ${ATTACHMENT_MAX_BYTES / 1048576} MB`]] as const;
    const shown = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
    lines.push(shown.length ? `Stays behind by design: ${shown.join('; ')}.` : 'Nothing stays behind.');
    if (plan.blocked.length) {
        lines.push('', `THIS PLAN IS BLOCKED (${plan.blocked.length}). Nothing can be applied until these are fixed:`);
        for (const b of plan.blocked.slice(0, 20)) lines.push(`  - ${b}`);
        if (plan.blocked.length > 20) lines.push(`  ... and ${plan.blocked.length - 20} more`);
    } else if (!apply) lines.push('', `plan-id: ${plan.planId}`);
    return lines.join('\n');
}

/* ---------- opening the Vault ---------- */
export interface OpenVault {
    inv: VaultStorageInventory; files: GuardedVaultFiles; owner: string; areas: Record<ImportArea, ManagedVaultArea>; roots: Record<ImportArea, string>;
    withContext<T>(area: ImportArea, fn: (ctx: VaultFilesContext) => Promise<T>): Promise<T>;
}
const physical = (path: string, options: VaultStorageFiles) => join(options.prefix ? resolve(options.prefix) : '/', path);
export async function openVault(pool: Pool, options: VaultStorageFiles): Promise<OpenVault> {
    if (existsSync(physical(VAULT_STORAGE_PENDING, options))) fail('the Vault storage setup is not finished (a pending plan exists); finish or repair it first');
    let inv: VaultStorageInventory;
    try { inv = loadVaultStorageInventory(options); } catch { return fail('this installation has no Vault yet; finish the install first'); }
    await verifyVaultStorage(pool, options);
    const priv = inv.areas.find(a => a.kind === 'private'), shared = inv.areas.find(a => a.kind === 'shared');
    if (!priv || !shared || priv.owner.id !== inv.provisionerMemberId) return fail('the Vault does not have the expected owner private area and shared area');
    const store = new PgVaultStore();
    const backings: VaultFilesBackings = new Map([[inv.backing.id, { kind: 'git' as const, root: physical('/srv', options),
        areas: new Map(inv.areas.map(a => [a.areaId, { origin: physical(a.origin, options) }])) }]]);
    const areas = { private: priv, shared }, owner = inv.provisionerMemberId;
    return {
        inv, files: new GuardedVaultFiles(store, backings), owner, areas,
        roots: { private: physical('/srv/' + priv.relativePath, options), shared: physical('/srv/' + shared.relativePath, options) },
        async withContext(area, fn) {
            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                const row = (await db.query('SELECT revision FROM vault_areas WHERE id=$1', [areas[area].areaId])).rows[0];
                const result = await fn({ memberId: owner, areaId: areas[area].areaId, expectedRevision: Number(row.revision), db });
                await db.query('COMMIT');
                return result;
            } catch (error) {
                await db.query('ROLLBACK').catch(() => undefined);
                throw error;
            } finally { db.release(); }
        },
    };
}

/* ---------- applying ---------- */
export interface ApplySummary {
    written: number; exists: number; refused: number; narrowed: number; chunks: number; commits: number; seconds: number;
    byArea: Record<ImportArea, { before: number; listed: number; expected: number; sample: string | null; sampleFound: boolean | null; clean: boolean; synced: boolean }>;
    healthy: boolean;
}
const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
function git(root: string, ...args: string[]): string {
    return execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export async function applyPlan(vault: OpenVault, plan: Plan, options: ImportOptions, storage: VaultStorageFiles, runStamp = stampNow()): Promise<ApplySummary> {
    const started = Date.now();
    const summary: ApplySummary = { written: 0, exists: 0, refused: 0, narrowed: 0, chunks: 0, commits: 0, seconds: 0, healthy: true,
        byArea: { private: { before: 0, listed: 0, expected: 0, sample: null, sampleFound: null, clean: true, synced: true }, shared: { before: 0, listed: 0, expected: 0, sample: null, sampleFound: null, clean: true, synced: true } } };
    const writtenNotes: Record<ImportArea, string[]> = { private: [], shared: [] };
    for (const area of ['private', 'shared'] as const) {
        summary.byArea[area].before = (await vault.withContext(area, ctx => vault.files.list(ctx))).files;
        const todo = plan.items.filter(i => i.area === area && i.status === 'add');
        const chunks: PlanItem[][] = [];
        let current: PlanItem[] = [], bytes = 0;
        for (const item of todo) {
            if (current.length && (current.length >= CHUNK_FILES || bytes + item.size > CHUNK_BYTES)) { chunks.push(current); current = []; bytes = 0; }
            current.push(item); bytes += item.size;
        }
        if (current.length) chunks.push(current);
        for (const [n, chunk] of chunks.entries()) {
            const files = chunk.map(item => {
                const content = readFileSync(item.abs);
                if (sha(content) !== item.srcSha) fail(`${item.source} changed while the import was running; nothing further was written. Preview again`);
                return { path: item.target, content };
            });
            const ledger = { version: 1, sourceId: plan.sourceId, label: plan.label, run: runStamp, origin: plan.origin, sourceHead: plan.head,
                files: Object.fromEntries(chunk.map(i => [i.target, { srcSha: i.srcSha, importedSha: i.importedSha }])) };
            const ledgerPath = `${ledgerDir(plan.sourceId)}/${runStamp}-${String(n + 1).padStart(4, '0')}.json`;
            const message = `import ${plan.sourceId}: ${chunk.filter(i => i.kind === 'note').length} notes from ${plan.label.replace(/[\r\n]/g, ' ').slice(0, 80)} (${n + 1}/${chunks.length})`;
            const done = await vault.withContext(area, ctx => vault.files.importBatch(ctx, {
                binding: { areaId: vault.areas[area].areaId, accessRevision: ctx.expectedRevision, approvedOrigin: plan.origin as Origin,
                    authority: { origin: 'human', agentId: 'vault-import', turnId: `import-${plan.sourceId}`, sessionId: `import-${runStamp}`, placeId: 'import',
                        audience: { placeId: 'import', revision: 1, participants: [{ kind: 'member', memberId: vault.owner }] }, policyRevision: 1,
                        actingMemberId: vault.owner, spokenByMemberId: vault.owner } },
                files: [...files, { path: ledgerPath, content: JSON.stringify(ledger, null, 1) + '\n' }], message, chunkSize: CHUNK_FILES + 1,
            }));
            summary.chunks++; summary.commits += done.commits.length;
            const wrote = new Set(done.results.filter(r => r.outcome === 'written').map(r => r.path));
            for (const r of done.results) if (r.path !== ledgerPath) summary[r.outcome]++;
            summary.narrowed += done.narrowed.filter(p => wrote.has(p)).length;
            writtenNotes[area].push(...chunk.filter(i => i.kind === 'note' && wrote.has(i.target)).map(i => i.target));
        }
    }
    // Health check: what is on disk is what the Vault can list and search, committed and pushed.
    for (const area of ['private', 'shared'] as const) {
        const h = summary.byArea[area], listable = writtenNotes[area].filter(p => !p.startsWith('_meta/'));
        h.expected = h.before + listable.length;
        h.listed = (await vault.withContext(area, ctx => vault.files.list(ctx))).files;
        const sampleTarget = listable[0];
        if (sampleTarget) {
            const text = readFileSync(join(vault.roots[area], sampleTarget), 'utf8');
            h.sample = /^title:[ \t]*["']?(.+?)["']?[ \t]*$/m.exec(text)?.[1] ?? /^#[ \t]+(.+)$/m.exec(text)?.[1]?.trim() ?? posix.basename(sampleTarget, '.md');
            const sample = h.sample;
            h.sampleFound = (await vault.withContext(area, ctx => vault.files.search(ctx, sample))).hits.includes(sampleTarget);
        }
        const work = vault.roots[area], bare = physical(vault.areas[area].origin, storage);
        h.clean = git(work, 'status', '--porcelain', '--untracked-files=all') === '';
        h.synced = git(work, 'rev-parse', 'HEAD') === git(bare, 'rev-parse', 'refs/heads/main');
        if (h.listed !== h.expected || h.sampleFound === false || !h.clean || !h.synced) summary.healthy = false;
    }
    try { verifyVaultStorageFiles(vault.inv, storage); } catch { summary.healthy = false; }
    summary.seconds = (Date.now() - started) / 1000;
    return summary;
}
export function renderApply(s: ApplySummary): string {
    const lines = [`Import finished in ${s.seconds.toFixed(1)} s: ${s.written} written in ${s.chunks} commits (${s.narrowed} stamps narrowed), ${s.exists} already there, ${s.refused} refused.`];
    for (const area of ['private', 'shared'] as const) {
        const h = s.byArea[area];
        lines.push(`Health check, ${area}: listed ${h.listed} of ${h.expected} expected notes${h.listed === h.expected ? '' : ' (MISMATCH)'}; search `
            + `${h.sample === null ? 'not needed (nothing new)' : h.sampleFound ? 'found a sample note' : 'did NOT find a sample note'}; working copy ${h.clean ? 'clean' : 'NOT clean'}; backup repository ${h.synced ? 'up to date' : 'BEHIND'}.`);
    }
    lines.push(s.healthy ? 'All checks passed.' : 'A check failed: the notes are written, but do not rely on them until `lares doctor` and the lines above are understood.');
    return lines.join('\n');
}

/* ---------- the two commands ---------- */
export interface ImportRequest { mode: 'preview' | 'apply'; source: string; options: ImportOptions; confirm?: string }
export async function runVaultImport(pool: Pool, request: ImportRequest, storage: VaultStorageFiles, out: (line: string) => void): Promise<number> {
    const vault = await openVault(pool, storage);
    const plan = buildPlan(request.source, request.options, vault.roots);
    if (request.mode === 'preview') {
        out(renderPlan(plan));
        if (!plan.blocked.length) out(`\nTo apply exactly this plan: lares vault import <folder> ... --apply --confirm ${plan.planId}`);
        return 0;
    }
    if (plan.blocked.length) { out(renderPlan(plan, true)); return 78; }
    if (request.confirm !== plan.planId) {
        out(`The plan changed since it was previewed (the source folder, the Vault or the options moved).\nPreview again and confirm the new plan-id: ${plan.planId}`);
        return 78;
    }
    const summary = await applyPlan(vault, plan, request.options, storage);
    out(renderApply(summary));
    return summary.healthy ? 0 : 1;
}
