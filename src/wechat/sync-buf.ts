import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadJson, saveJson } from '../store.js';
import { DATA_DIR } from '../constants.js';
import { logger } from '../logger.js';

/** 旧版全局 sync buf（换绑后会污染新 bot 的 poll 状态） */
const LEGACY_SYNC_BUF_PATH = join(DATA_DIR, 'get_updates_buf');

function safeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

function syncBufPath(accountId: string): string {
  return join(DATA_DIR, `get_updates_buf_${safeAccountId(accountId)}`);
}

export function loadSyncBuf(accountId: string): string {
  const path = syncBufPath(accountId);
  const buf = loadJson<string>(path, '');
  if (buf) return buf;

  // 迁移：仅当 legacy 文件内嵌当前 accountId 时才沿用
  if (existsSync(LEGACY_SYNC_BUF_PATH)) {
    try {
      const legacy = loadJson<string>(LEGACY_SYNC_BUF_PATH, '');
      if (legacy && legacy.includes(safeAccountId(accountId))) {
        saveSyncBuf(accountId, legacy);
        return legacy;
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}

export function saveSyncBuf(accountId: string, buf: string): void {
  saveJson(syncBufPath(accountId), buf);
}

/** setup / 换绑 / 切账号时清理 poll 游标，避免跨 bot 串线 */
export function clearSyncBuf(accountId: string): void {
  const path = syncBufPath(accountId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
      logger.info('Cleared get_updates_buf for account', { accountId });
    } catch {
      /* ignore */
    }
  }
  if (existsSync(LEGACY_SYNC_BUF_PATH)) {
    try {
      unlinkSync(LEGACY_SYNC_BUF_PATH);
      logger.info('Removed legacy global get_updates_buf');
    } catch {
      /* ignore */
    }
  }
}
