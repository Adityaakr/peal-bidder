/**
 * One agent process per agent folder.
 *
 * Two processes sharing the receipts log and the nonce store would each
 * rebuild the ledger from the same receipts and could each spend what is left
 * of the budget, and their receipts would fork the hash chain. Every command
 * that writes (receive, run, serve, claim) takes this lock first.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export class LockHeld extends Error {
  override name = "LockHeld";
  constructor(
    readonly pid: number,
    path: string,
  ) {
    super(`another agent process (pid ${pid}) holds ${path}; stop it first`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the lock at `path`; returns the function that releases it. A lock left by a dead process is taken over. */
export function acquireLock(path: string, pid: number = process.pid): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${pid}\n${new Date().toISOString()}\n`);
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (Number(readFileSync(path, "utf8").split("\n")[0]) === pid) unlinkSync(path);
        } catch {
          // already gone
        }
      };
      process.once("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(readFileSync(path, "utf8").split("\n")[0]);
      if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) throw new LockHeld(holder, path);
      unlinkSync(path); // stale: the holder is gone
    }
  }
  throw new Error(`could not take ${path}`);
}
