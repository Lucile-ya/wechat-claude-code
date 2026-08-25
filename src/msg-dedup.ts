import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

const MSG_DEDUP_DIR = join(DATA_DIR, 'msg-dedup');

function safeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

/** 跨进程去重：按 bot 账号 + seq，避免重新扫码后 seq 从 1 重计被旧 marker 误杀 */
export function markSeqSeenCrossProcess(accountId: string, seq: number): boolean {
  mkdirSync(MSG_DEDUP_DIR, { recursive: true });
  const marker = join(MSG_DEDUP_DIR, `${safeAccountId(accountId)}-${seq}.marker`);
  try {
    const fd = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeSync(fd, String(Date.now()));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    return true;
  }
}

/** setup / 换绑后清理该账号的去重标记 */
export function clearAccountDedupMarkers(accountId: string): number {
  if (!existsSync(MSG_DEDUP_DIR)) return 0;
  const prefix = `${safeAccountId(accountId)}-`;
  let removed = 0;
  for (const name of readdirSync(MSG_DEDUP_DIR)) {
    if (name.startsWith(prefix) && name.endsWith('.marker')) {
      try {
        unlinkSync(join(MSG_DEDUP_DIR, name));
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  if (removed > 0) {
    logger.info('Cleared msg-dedup markers for account', { accountId, removed });
  }
  return removed;
}

/** 兼容旧版仅 seq 的 marker（重新绑定后一次性清理） */
export function clearLegacySeqMarkers(maxSeq = 50): number {
  if (!existsSync(MSG_DEDUP_DIR)) return 0;
  let removed = 0;
  for (let seq = 1; seq <= maxSeq; seq++) {
    const legacy = join(MSG_DEDUP_DIR, `${seq}.marker`);
    if (existsSync(legacy)) {
      try {
        unlinkSync(legacy);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}
