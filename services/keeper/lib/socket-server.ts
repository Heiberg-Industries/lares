import { createConnection, createServer, type Socket } from "node:net";
import { chmod, chown, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { runAction, refuse, KeeperRefusedError, type ActionContext } from "./actions.js";
import { auditor } from "./audit.js";
import { keeperPool, loadKeeperConfig } from "./config.js";
export const MAX_REQUEST_BYTES = 256 * 1024;
const requestSchema = z.object({ action: z.string().min(1).max(100), input: z.unknown().optional(), actor: z.unknown().optional() }).strict();
export interface ServeOptions {
  socket: string;
  host: boolean;
  context?: ActionContext;
  /** Production defaults require root; tests use their own UID/GID. */
  ownership?: {
    uid: number;
    gid: number;
  };
}
/** Recover only a socket owned by this keeper whose listener is definitely gone.
 * The parent directory is already restricted before this check. Never unlink regular files,
 * symlinks, live listeners, foreign-owned sockets, or a replacement inode.
 */
async function removeStaleSocket(path: string, uid: number): Promise<void> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("keeper: socket inspection failed");
  }
  if (!before.isSocket() || before.uid !== uid) throw new Error("keeper: socket path unavailable");
  const stale = await new Promise<boolean>((resolve) => {
    const probe = createConnection(path);
    probe.setTimeout(1000, () => { probe.destroy(); resolve(false); });
    probe.once("connect", () => { probe.destroy(); resolve(false); });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      resolve(error.code === "ECONNREFUSED");
    });
  });
  if (!stale) throw new Error("keeper: socket already active");
  const current = await lstat(path);
  if (!current.isSocket() || current.ino !== before.ino || current.dev !== before.dev || current.uid !== uid) {
    throw new Error("keeper: socket path changed");
  }
  await unlink(path);
}
/** Sequential, bounded newline framing; crash recovery never removes a live socket. */
export async function serve(opts: ServeOptions): Promise<() => Promise<void>> {
  const pool = opts.context ? undefined : keeperPool(loadKeeperConfig().db);
  const context = opts.context ?? { actor: "host", audit: auditor(pool!) };
  const clients = new Set<Socket>();
  const work = new Set<Promise<void>>();
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => {
    ready = resolve;
  });
  const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, socket => {
    void readiness.then(() => {
      if (!terminal) socket.resume();
    });
    clients.add(socket);
    socket.on("error", () => { });
    socket.on("close", () => clients.delete(socket));
    // Stop slow/incomplete clients without keeping shutdown open forever.
    socket.setTimeout(30000, () => {
      ended = true;
      schedule();
    });
    let buffer = Buffer.alloc(0);
    let processing = false;
    let ended = false;
    let terminal = false;
    const reject = async (detail: string) => {
      // End the request side before awaiting audit: no queued or later frame can run.
      terminal = true;
      buffer = Buffer.alloc(0);
      socket.pause();
      socket.setTimeout(0);
      try {
        await refuse({ ...context, actor: opts.host ? "host" : "unverified" }, "protocol", detail);
      }
      catch (e) {
        socket.end(JSON.stringify({ ok: false, error: (e as Error).message }) + "\n", () => socket.destroy());
      }
    };
    const process = async () => {
      if (processing || terminal)
        return;
      processing = true;
      socket.pause();
      try {
        while (!socket.destroyed && !terminal) {
          const end = buffer.indexOf(10);
          if (end < 0) {
            if (buffer.length > MAX_REQUEST_BYTES) {
              buffer = Buffer.alloc(0);
              await reject("request too large");
            }
            else if (ended && buffer.length) {
              buffer = Buffer.alloc(0);
              await reject("incomplete request");
            }
            break;
          }
          if (end > MAX_REQUEST_BYTES) {
            buffer = Buffer.alloc(0);
            await reject("request too large");
            break;
          }
          const line = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          let req: z.infer<typeof requestSchema>;
          try {
            req = requestSchema.parse(JSON.parse(line.toString("utf8")));
            if (!opts.host)
              req.actor = z.string().email().max(254).parse(req.actor);
          }
          catch {
            buffer = Buffer.alloc(0);
            await reject("invalid request");
            break;
          }
          let result: unknown;
          try {
            result = await runAction(req.action, req.input ?? {}, { ...context, actor: opts.host ? "host" : req.actor as string }, { host: opts.host });
          }
          catch (e) {
            socket.write(JSON.stringify({ ok: false, error: (e as Error).message, ...(e instanceof KeeperRefusedError ? { findings: e.findings } : {}) }) + "\n");
            continue;
          }
          try {
            socket.write(JSON.stringify({ ok: true, result: result ?? null }) + "\n");
          } catch {
            socket.write(JSON.stringify({ ok: false, error: "keeper: response serialization failed; action may have completed" }) + "\n");
          }
        }
        if (ended && !terminal)
          socket.end();
      }
      finally {
        processing = false;
        if (!ended && !terminal)
          socket.resume();
      }
    };
    const schedule = () => {
      if (terminal) return;
      const p = process();
      work.add(p);
      void p.finally(() => work.delete(p)).catch(() => socket.destroy());
    };
    socket.on("data", chunk => {
      if (terminal) return;
      buffer = Buffer.concat([buffer, chunk]);
      schedule();
    });
    socket.on("end", () => {
      if (terminal) return;
      ended = true;
      schedule();
    });
  });
  // Allow a response to an incomplete half-closed request.
  try {
    await mkdir(dirname(opts.socket), { recursive: true, mode: opts.host ? 0o700 : 0o750 });
    // Console UID 10001 must be able to traverse its directory. The host directory is root-only.
    await chown(dirname(opts.socket), opts.ownership?.uid ?? 0, opts.ownership?.gid ?? (opts.host ? 0 : 10001));
    await chmod(dirname(opts.socket), opts.host ? 0o700 : 0o750);
    await removeStaleSocket(opts.socket, opts.ownership?.uid ?? 0);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Prevent any request execution during ownership setup.
    await chown(opts.socket, opts.ownership?.uid ?? 0, opts.ownership?.gid ?? 10001);
    await chmod(opts.socket, 0o660);
    ready();
  }
  catch {
    for (const client of clients)
      client.destroy();
    if (server.listening)
      await new Promise<void>(resolve => server.close(() => resolve()));
    await pool?.end();
    throw new Error("keeper: socket startup failed");
  }
  const owned = await lstat(opts.socket);
  return async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const client of clients)
      client.destroy();
    await Promise.allSettled([...work]);
    await closed;
    // net.Server generally unlinks its socket; never remove another process's replacement.
    try {
      const current = await lstat(opts.socket);
      if (current.ino === owned.ino)
        await unlink(opts.socket);
    }
    catch { }
    await pool?.end();
  };
}
