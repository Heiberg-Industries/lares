import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { z } from 'zod';
import { INTEGRATION_SECRET_FILES } from './runtime-bindings.js';

/** Internal custody boundary only. No path or revision name is accepted by a socket action.
 * Candidates and rollback are root-only. Only later activation may grant runtime readability.
 */
export class CredentialFiles {
  readonly activePath: string;
  // Same injectable ownership convention as the socket server; production defaults are root.
  constructor(private root: string, private ownership = { uid: 0, gid: 0 }) {
    this.activePath = join(root, INTEGRATION_SECRET_FILES.NOTION_TOKEN_FILE);
  }
  verifyRoot(): void {
    if (!isAbsolute(this.root) || normalize(this.root) !== this.root) throw new Error('Credential storage unavailable');
    let part = parse(this.root).root;
    for (const name of this.root.slice(part.length).split('/')) {
      if (!name) continue;
      part = join(part, name);
      const st = lstatSync(part);
      if (!st.isDirectory() || st.isSymbolicLink() || ![0, this.ownership.uid].includes(st.uid) ||
        (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) throw new Error('Credential storage unavailable');
    }
    const st = lstatSync(this.root);
    if (st.uid !== this.ownership.uid || (st.mode & 0o777) !== 0o700) throw new Error('Credential storage unavailable');
    accessSync(this.root, constants.R_OK | constants.W_OK | constants.X_OK);
  }
  private path(revision: string, kind: 'candidate' | 'rollback', partial = false): string {
    return join(this.root, `.notion-${z.uuid().parse(revision)}.${kind}${partial ? '.partial' : ''}`);
  }
  private read(path: string, active = false): string | null {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const st = fstatSync(fd), mode = st.mode & 0o777;
      if (!st.isFile() || st.nlink !== 1 || st.uid !== this.ownership.uid || st.size < 1 || st.size > 8192 ||
        !(mode === 0o600 && st.gid === this.ownership.gid || active && mode === 0o440 && st.gid === 10001))
        throw new Error('Credential file unavailable');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  }
  activeExists(): boolean { this.verifyRoot(); return this.read(this.activePath, true) !== null; }
  candidateExists(revision: string): boolean { this.verifyRoot(); return this.read(this.path(revision, 'candidate')) !== null; }
  rollbackExists(revision: string): boolean { this.verifyRoot(); return this.read(this.path(revision, 'rollback')) !== null; }
  readCandidate(revision: string): string {
    this.verifyRoot();
    const value = this.read(this.path(revision, 'candidate'));
    if (value === null) throw new Error('Credential candidate unavailable');
    return value;
  }
  private syncRoot(): void {
    const fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private create(revision: string, kind: 'candidate' | 'rollback', value: string): void {
    this.verifyRoot();
    if (readdirSync(this.root).some(name => name.startsWith('.notion-') && (name.endsWith(`.${kind}`) || name.endsWith(`.${kind}.partial`))))
      throw new Error('Credential custody retention limit reached');
    const path = this.path(revision, kind), temp = this.path(revision, kind, true);
    // Never overwrite previous custody, even if a journal was damaged.
    try { lstatSync(path); throw new Error('Credential file already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchownSync(fd, this.ownership.uid, this.ownership.gid);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, value);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, path);
    this.syncRoot();
  }
  stage(revision: string, value: string): void { this.create(revision, 'candidate', value); }
  /** For the later apply journal, before publication. This never changes the active file. */
  preserveActive(revision: string): void {
    this.verifyRoot();
    const value = this.read(this.activePath, true);
    if (value === null) throw new Error('Active credential unavailable');
    this.create(revision, 'rollback', value);
  }
  removeCandidate(revision: string): void {
    this.verifyRoot();
    for (const partial of [false, true]) {
      const path = this.path(revision, 'candidate', partial);
      // Validate link count/ownership without ever following a link. Empty partials can be
      // left by a crash before write; they still must be keeper-owned single-link files.
      let st;
      try { st = lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== this.ownership.uid || st.gid !== this.ownership.gid || (st.mode & 0o777) !== 0o600)
        throw new Error('Credential file unavailable');
      unlinkSync(path);
    }
    this.syncRoot();
  }
  /** Unjournaled files are never silently adopted or removed. They require host inspection. */
  unexpectedFiles(candidate: string | null, rollback: string | null, interrupted = false): boolean {
    this.verifyRoot();
    const permitted = new Set([
      ...(candidate ? [this.path(candidate, 'candidate'), ...(interrupted ? [this.path(candidate, 'candidate', true)] : [])] : []),
      ...(rollback ? [this.path(rollback, 'rollback')] : []),
    ]);
    return readdirSync(this.root).some(name => name.startsWith('.notion-') && !permitted.has(join(this.root, name)));
  }
}
// Names are keeper-generated once, recorded before file creation; no fingerprints of values.
export const newCredentialRevision = (): string => randomUUID();
