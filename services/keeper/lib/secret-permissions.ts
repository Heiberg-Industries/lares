import { openSync, closeSync, fstatSync, fchownSync, fchmodSync, constants, lstatSync } from 'node:fs';
/** File-backed compose secrets preserve HOST ownership. Directory stays root-only; only
 * explicitly mounted files become readable by runtime GID10001. Never chmod the directory. */
export function runtimeSecret(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size === 0 || st.nlink !== 1)
            throw new Error('Invalid runtime secret');
        // Installer-owned platform secrets are already root:runtime 0440 and mounted into the
        // keeper read-only. Verification must succeed without attempting a metadata write on that
        // mount; keeper-created secrets still take the mutation path below exactly once.
        if (st.uid === 0 && st.gid === 10001 && (st.mode & 0o777) === 0o440)
            return;
        fchownSync(fd, 0, 10001);
        fchmodSync(fd, 0o440);
    }
    finally {
        closeSync(fd);
    }
}
export function verifySecretRoot(path: string): void { const st = lstatSync(path); if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o077) !== 0)
    throw new Error('Secrets directory must be root-owned and keeper-only'); }
