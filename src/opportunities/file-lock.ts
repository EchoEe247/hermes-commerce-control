import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  readonly timeoutMs?: number | undefined;
  readonly staleMs?: number | undefined;
  readonly pollMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 120_000;
const DEFAULT_POLL_MS = 25;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.trunc(value));
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function removeIfOwned(lockPath: string, token: string): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
    if (raw.token === token) await unlink(lockPath);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

async function removeIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= staleMs) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }
}

/**
 * Serialize read/repair/write sequences across independent Node processes.
 *
 * The lock is a sibling file created with O_EXCL (`wx`). A bounded stale-lock
 * recovery window prevents a crashed process from blocking the store forever.
 * The ownership token prevents an old owner from deleting a replacement lock.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const staleMs = boundedPositive(options.staleMs, DEFAULT_STALE_MS);
  const pollMs = boundedPositive(options.pollMs, DEFAULT_POLL_MS);
  const lockPath = `${targetPath}.lock`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();

  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      if (await removeIfStale(lockPath, staleMs)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out acquiring file lock for ${targetPath}`);
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    await removeIfOwned(lockPath, token);
  }
}
