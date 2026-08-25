import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import {
  unlinkSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  openSync,
  closeSync,
  writeSync,
  constants,
} from 'node:fs';
import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, downloadImageToFile, downloadAllImagesToFiles, extractText, extractFirstImageUrl, extractAllImageItems, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { routeAthenaMessage, isLikelyAthenaCommand, shouldRouteScreenshotError, routeScreenshotError, routeMultiScreenshotError, shouldRouteChapterPractice, extractChapterFromCaption, preflightChapterPractice, routeChapterPractice, saveChapterPracticePending, routeChapterPracticePending, preflightScreenshot, savePendingPlainFromImage, applyPlainQuestionAfterParse } from './athena-router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { TurnRouter } from './claude/turn-router.js';
import { filterToolNoise } from './claude/tool-noise-filter.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';
import { loadPendingQueue, savePendingQueue, appendPending, type PendingItem } from './pending-queue.js';
import {
  COALESCE_WINDOW_MS,
  decideCoalesce,
  mergeMessages,
} from './inbound-coalescer.js';
import {
  markSeqSeenCrossProcess,
  clearAccountDedupMarkers,
  clearLegacySeqMarkers,
} from './msg-dedup.js';
import { clearSyncBuf } from './wechat/sync-buf.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;

// Extensions eligible for auto-push when detected in Claude's response
const AUTO_PUSH_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md',
  '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
]);

/** Extract local file paths from Claude's response text. */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths: string[] = [];
  // Match absolute paths (macOS/Linux), tilde paths, and Windows paths with a file extension
  const regex = /(?:\/(?:Users|home|tmp|var|etc)\/[^\s`'"()\[\]{}|<>]+\.\w+|~\/[^\s`'"()\[\]{}|<>]+\.\w+|[A-Za-z]:[\\\/][^\s`'"()\[\]{}|<>]+\.\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const resolved = raw.startsWith('~')
      ? raw.replace(/^~/, homedir())
      : raw;
    paths.push(resolved);
  }
  return paths;
}

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/** Find a safe split point that won't break markdown formatting. */
function findSafeSplitPoint(text: string, maxLen: number): number {
  // Try newline first (preserves list items, paragraphs)
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Try sentence-ending punctuation
  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  // Try space (won't split mid-word or mid-markdown)
  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Last resort: hard cut
  return maxLen;
}

/** Fallback: split a single oversized block at safe boundaries. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

/**
 * Card-aware message splitter.
 * Splits at paragraph boundaries (double newlines) to keep cards intact,
 * falls back to newline-based splitting for oversized single blocks.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Can this block fit into the current chunk?
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      current += '\n\n' + block;
    } else {
      // Current chunk is complete, start a new one
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Send reply; on WeChat rate-limit park to pending queue instead of silently dropping. */
async function sendReplyOrQueue(
  accountId: string,
  toUserId: string,
  contextToken: string,
  sender: ReturnType<typeof createSender>,
  text: string,
): Promise<'sent' | 'queued'> {
  try {
    for (const chunk of splitMessage(text)) {
      await sender.sendText(toUserId, contextToken, chunk);
    }
    return 'sent';
  } catch (err) {
    appendPending(accountId, { text, role: 'final', queuedAt: Date.now() });
    logger.warn('Reply queued after send failure', {
      accountId,
      textLength: text.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'queued';
  }
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入工作目录', join(homedir(), 'Documents', 'ClaudeCode'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  const account = loadLatestAccount();
  if (account) {
    clearLegacySeqMarkers();
    clearAccountDedupMarkers(account.accountId);
    clearSyncBuf(account.accountId);
    console.log(`已清理消息去重 + poll 缓存。当前 bot：${account.accountId}`);
    console.log('⚠️ 请在微信里找到【本次扫码对应的新对话】发消息，不要沿用旧对话。');
  }

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Singleton lock (prevent duplicate bridge → double replies)
// ---------------------------------------------------------------------------

const BRIDGE_LOCK_FILE = join(DATA_DIR, 'bridge.pid');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryCreateBridgeLockFile(): boolean {
  try {
    const fd = openSync(
      BRIDGE_LOCK_FILE,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    );
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function acquireBridgeSingletonLock(): void {
  mkdirSync(DATA_DIR, { recursive: true });

  if (!tryCreateBridgeLockFile()) {
    const raw = existsSync(BRIDGE_LOCK_FILE)
      ? readFileSync(BRIDGE_LOCK_FILE, 'utf8').trim()
      : '';
    const oldPid = Number.parseInt(raw, 10);
    if (oldPid && oldPid !== process.pid && isProcessAlive(oldPid)) {
      console.error(
        `已有微信桥接在运行 (PID ${oldPid})，请先停止旧进程或使用 watchdog 单实例模式。`,
      );
      process.exit(1);
    }
    try {
      unlinkSync(BRIDGE_LOCK_FILE);
    } catch {
      /* ignore */
    }
    if (!tryCreateBridgeLockFile()) {
      console.error('无法获取桥接单例锁，可能已有实例正在启动。');
      process.exit(1);
    }
  }
  const release = () => {
    try {
      if (existsSync(BRIDGE_LOCK_FILE)) {
        const current = readFileSync(BRIDGE_LOCK_FILE, 'utf8').trim();
        if (current === String(process.pid)) unlinkSync(BRIDGE_LOCK_FILE);
      }
    } catch {
      /* ignore */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

// ── 全局错误兜底：防止未捕获异常直接杀死进程 ──────────────────────────
let _crashCount = 0;
let _crashWindowStart = 0;
const CRASH_WINDOW_MS = 60_000;       // 1 分钟窗口
const CRASH_THRESHOLD = 5;            // 窗口内崩溃 ≥ 5 次 → 主动退出让 daemon.sh 重启
const CRASH_COOLDOWN_MS = 30_000;     // 连续崩溃间的静默期
let _lastCrashTime = 0;

function _recordCrash(): boolean {
  const now = Date.now();
  if (now - _lastCrashTime < CRASH_COOLDOWN_MS) {
    // 距离上次崩溃太近 — 可能是同一个错误反复触发，不重复计数但仍检查阈值
  }
  _lastCrashTime = now;
  if (now - _crashWindowStart > CRASH_WINDOW_MS) {
    _crashCount = 0;
    _crashWindowStart = now;
  }
  _crashCount++;
  logger.error(`Crash #${_crashCount} in current window (threshold: ${CRASH_THRESHOLD})`);
  if (_crashCount >= CRASH_THRESHOLD) {
    logger.error('Crash threshold exceeded — exiting to let daemon restart loop recover');
    return true; // caller should exit
  }
  return false;
}

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack?.slice(0, 500) });
  if (_recordCrash()) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack?.slice(0, 500) : undefined;
  logger.error('Unhandled rejection', { reason: msg, stack });
  if (_recordCrash()) {
    process.exit(1);
  }
});

async function runDaemon(): Promise<void> {
  acquireBridgeSingletonLock();
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  // 换绑/重启后清理旧版 seq-only 去重标记（曾导致新 bot seq 从 1 重计被误杀）
  const legacyCleared = clearLegacySeqMarkers();
  if (legacyCleared > 0) {
    logger.info('Cleared legacy msg-dedup markers on startup', { count: legacyCleared });
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();

  // -- Dedup by seq number (safe, small integers). message_id is a 64-bit int
  //    that loses precision in JS; we track seq instead.
  const processedSeqs = new Set<number>();

  // -- Message queue for serial processing --
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;
  let lastUserText = '';  // 上一条用户文字，用于「先文后图」时给图片补配文
  let lastUserTextAt = 0; // 上一条文字的时间戳（只关联 30 秒内的相邻文字）

  // 短消息合并缓冲（对齐上游「消息队列优化」：连发 A/B/C/D 或拆词指令合并后再入队）
  let coalesceBuffer: WeixinMessage[] = [];
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  function flushCoalesceToQueue(): void {
    if (coalesceBuffer.length === 0) return;
    const merged = mergeMessages(coalesceBuffer);
    coalesceBuffer = [];
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    messageQueue.push(merged);
    void drainQueue();
  }

  function enqueueIncoming(msg: WeixinMessage): void {
    if (decideCoalesce(msg).defer) {
      coalesceBuffer.push(msg);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(() => flushCoalesceToQueue(), COALESCE_WINDOW_MS);
      return;
    }
    flushCoalesceToQueue();
    messageQueue.push(msg);
    void drainQueue();
  }

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      try {
        // 只把「30 秒内」的上一条文字作为配文，避免关联到太久之前的旧文字
        const recentCaption = Date.now() - lastUserTextAt < 30_000 ? lastUserText : '';
        await handleMessage(msg, account!, session, sessionStore, sender, config, sharedCtx, activeControllers, messageQueue, processedSeqs, recentCaption);
        const curText = extractTextFromItems(msg.item_list || []).trim();
        if (curText) { lastUserText = curText; lastUserTextAt = Date.now(); }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
        logger.error('Unhandled error in message handler', { error: errorMsg, stack });
        // Reset session state so future messages can still be processed
        try {
          session.state = 'idle';
          sessionStore.save(account!.accountId, session);
        } catch { /* ignore */ }
      }
    }
    processingQueue = false;
  }

  // -- Wire the monitor callbacks --

  /** Handle priority commands (/stop, /clear) immediately, bypassing the serial queue. */
  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const text = extractTextFromItems(msg.item_list);
    if (!text.startsWith('/stop') && !text.startsWith('/clear')) return false;
    if (session.state !== 'processing') return false;

    const ctrl = activeControllers.get(account!.accountId);
    if (ctrl) { ctrl.abort(); activeControllers.delete(account!.accountId); }
    session.state = 'idle';
    sessionStore.save(account!.accountId, session);

    if (text.startsWith('/stop')) {
      messageQueue.length = 0;
      coalesceBuffer.length = 0;
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    }
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;
      enqueueIncoming(msg);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, account.accountId, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  messageQueue: WeixinMessage[],
  processedSeqs: Set<number>,
  lastCaption?: string,
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  if (account.userId && msg.from_user_id !== account.userId) return;

  // Dedup by seq number: seq is a small integer (no 64-bit precision issues).
  // The monitor's recentMsgIds should already catch most duplicates, but this
  // is a belt-and-suspenders check at the handler level.
  if (msg.seq !== undefined) {
    if (processedSeqs.has(msg.seq)) {
      logger.debug('Dropping duplicate message', { seq: msg.seq });
      return;
    }
    if (!markSeqSeenCrossProcess(account.accountId, msg.seq)) {
      logger.warn('Dropping cross-process duplicate message', { seq: msg.seq, accountId: account.accountId });
      return;
    }
    processedSeqs.add(msg.seq);
    if (processedSeqs.size > 500) {
      const iter = processedSeqs.values();
      const toDelete: number[] = [];
      for (let i = 0; i < 250; i++) {
        const { value } = iter.next();
        if (value !== undefined) toDelete.push(value);
      }
      for (const id of toDelete) processedSeqs.delete(id);
    }
  }

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // State lock: set processing BEFORE any async work to prevent race conditions.
  // drainQueue serializes, but handlePriorityCommand can preempt, so we double-lock.
  if (session.state === 'processing') {
    // Re-queue at front — drainQueue popped this message before calling us.
    // Next drainQueue iteration will retry it.
    messageQueue.unshift(msg);
    logger.debug('Re-queued message — already processing', { seq: msg.seq });
    return;
  }
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  try {
    // Flush any pending messages from prior rate-limit windows. User's new
  // message brings a fresh context_token, which resets the iLink 11-msg quota.
  await flushPending(account.accountId, fromUserId, contextToken, sender);

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItems = extractAllImageItems(msg.item_list);
  const imageItem = imageItems[0];
  const fileItem = extractFirstFileItem(msg.item_list);
  // 「先文后图」：微信常把图+文拆成两条消息，图片消息无文字时用上一条文字作配文
  const effectiveText = userText.trim() || (imageItems.length > 0 ? (lastCaption || '') : '');

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      return;
    }

    if (result.handled && result.claudePrompt) {
      await sendToClaude(
        result.claudePrompt, imageItem, fileItem, fromUserId, contextToken,
        account, session, sessionStore, sender, config, activeControllers,
      );
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      return;
    }

    // Not handled, treat as normal message (fall through)
  }

  // -- PMP Athena 截图录入错题（作答结果 OCR / 配文触发 / 多图关联）--

  if (imageItems.length > 0) {
    const imagePaths = await downloadAllImagesToFiles(imageItems);
    if (imagePaths.length >= 2) {
      const shotResult = routeMultiScreenshotError(imagePaths, config, effectiveText);
      if (shotResult.handled && shotResult.reply) {
        sessionStore.addChatMessage(session, 'user', userText || `(图片×${imagePaths.length}-录入错题)`);
        sessionStore.addChatMessage(session, 'assistant', shotResult.reply);
        const status = await sendReplyOrQueue(
          account.accountId, fromUserId, contextToken, sender, shotResult.reply,
        );
        if (status === 'queued') {
          await sendReplyOrQueue(
            account.accountId,
            fromUserId,
            contextToken,
            sender,
            '⏳ 录入成功，回复因微信限流暂存，稍后会自动补发（或再发任意消息触发补发）。',
          );
        }
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
        return;
      }
    } else if (imagePaths.length === 1) {
      const imagePath = imagePaths[0];
      const explicitErrorLog = shouldRouteScreenshotError(effectiveText, true);
      const preflight = preflightScreenshot(imagePath, config);
      const isErrorResult = preflight?.screenshotType === 'error_result';

      if (explicitErrorLog || isErrorResult) {
        const shotResult = routeScreenshotError(imagePath, config, effectiveText);
        if (shotResult.handled && shotResult.reply) {
          sessionStore.addChatMessage(session, 'user', userText || '(图片-录入错题)');
          sessionStore.addChatMessage(session, 'assistant', shotResult.reply);
          const status = await sendReplyOrQueue(
            account.accountId, fromUserId, contextToken, sender, shotResult.reply,
          );
          if (status === 'queued') {
            await sendReplyOrQueue(
              account.accountId,
              fromUserId,
              contextToken,
              sender,
              '⏳ 录入成功，回复因微信限流暂存，稍后会自动补发（或再发任意消息触发补发）。',
            );
          }
          session.state = 'idle';
          sessionStore.save(account.accountId, session);
          return;
        }
      }

      // 章节练习统计截图（配文带章节名，或 OCR 自动识别统计页）
      const chapterFromCaption = extractChapterFromCaption(effectiveText);
      const cpPreflight = preflightChapterPractice(imagePath, config);
      const tryChapterPractice =
        shouldRouteChapterPractice(effectiveText, true)
        || (cpPreflight?.isStats && !!(chapterFromCaption || cpPreflight.chapter));

      if (tryChapterPractice) {
        const chapter = chapterFromCaption || cpPreflight?.chapter;
        if (chapter) {
          logger.info('Athena route: chapter practice', { chapter, fromOcr: !chapterFromCaption });
          const cpResult = routeChapterPractice(imagePath, config, chapter, effectiveText);
          if (cpResult.handled && cpResult.reply) {
            sessionStore.addChatMessage(session, 'user', userText || `(图片-章节练习-${chapter})`);
            sessionStore.addChatMessage(session, 'assistant', cpResult.reply);
            await sendReplyOrQueue(
              account.accountId, fromUserId, contextToken, sender, cpResult.reply,
            );
            session.state = 'idle';
            sessionStore.save(account.accountId, session);
            return;
          }
        } else if (cpPreflight?.isStats) {
          saveChapterPracticePending(imagePath, config);
          await sender.sendText(
            fromUserId,
            contextToken,
            '📊 已识别章节练习统计页。\n请回复章节名，如：范围管理',
          );
          session.state = 'idle';
          sessionStore.save(account.accountId, session);
          return;
        }
      }

      if (preflight?.screenshotType === 'plain_question' && !explicitErrorLog) {
        const plainSaved = savePendingPlainFromImage(imagePath, config, effectiveText);
        if (plainSaved.saved) {
          sessionStore.addChatMessage(session, 'user', userText || '(图片-题干截图)');
          const plainReply =
            '📌 题干已收录。\n请发「我的答案是X，正确答案是Y」完成判卷；或先发你选了哪个选项。';
          sessionStore.addChatMessage(session, 'assistant', plainReply);
          await sendReplyOrQueue(
            account.accountId, fromUserId, contextToken, sender, plainReply,
          );
          session.state = 'idle';
          sessionStore.save(account.accountId, session);
          return;
        }
      }

      // OCR 预处理失败（image_processor.py 崩溃/未安装 OCR）：提示手动录入，而非静默落到 Claude 菜单
      if (preflight === null) {
        logger.warn('Athena screenshot preflight failed, prompt manual entry', { imagePath });
        await sender.sendText(
          fromUserId,
          contextToken,
          '⚠️ 截图识别失败，无法自动提取题目信息。\n请手动发送：我的答案 X，正确答案 Y\n（或附上更清晰的截图）',
        );
        session.state = 'idle';
        sessionStore.save(account.accountId, session);
        return;
      }
    }
  }

  // -- PMP Athena hard routing (before Claude) --

  if (userText && !userText.startsWith('/')) {
    // 硬路由 Athena 指令时中止进行中的 Claude，避免额外回复「👀」等
    if (isLikelyAthenaCommand(userText)) {
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) {
        ctrl.abort();
        activeControllers.delete(account.accountId);
      }
    }

    // 从磁盘同步 athena 状态（/clear 后或重启后仍可按文件态判卷）
    const diskSession = sessionStore.load(account.accountId);
    session.athena = diskSession.athena;

    const athenaResult = routeAthenaMessage(userText, session, config);
    if (athenaResult.handled) {
      if (athenaResult.sessionPatch) {
        if ('athena' in athenaResult.sessionPatch && athenaResult.sessionPatch.athena === undefined) {
          delete session.athena;
        } else {
          Object.assign(session, athenaResult.sessionPatch);
          if (athenaResult.sessionPatch.athena) {
            session.athena = { ...session.athena, ...athenaResult.sessionPatch.athena };
          }
        }
      }
      if (athenaResult.reply) {
        sessionStore.addChatMessage(session, 'user', userText);
        sessionStore.addChatMessage(session, 'assistant', athenaResult.reply);
        const chunks = splitMessage(athenaResult.reply);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      return;
    }

    // 像 Athena 指令但未硬路由成功 → 勿交给 Claude 重复/乱答
    if (isLikelyAthenaCommand(userText)) {
      logger.warn('Athena-like command not handled by hard route', { userText });
      await sender.sendText(
        fromUserId,
        contextToken,
        '⚠️ 指令处理异常，请重发一次；仍失败请发 `/clear` 后重试。',
      );
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      return;
    }
  }

  // -- Normal message -> Claude --

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToClaude(
    userText, imageItem, fileItem, fromUserId, contextToken,
    account, session, sessionStore, sender, config, activeControllers,
  );
  } finally {
    // Always reset session state, even on unexpected errors
    session.state = 'idle';
    sessionStore.save(account!.accountId, session);
  }
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

/**
 * Drain the pending message queue (messages that couldn't be delivered in a
 * prior rate-limit window). Called whenever a fresh user message arrives with
 * a new context_token. Each flush attempt stops at the first failure —
 * remaining items stay queued for the next user message.
 */
async function flushPending(
  accountId: string,
  toUserId: string,
  contextToken: string,
  sender: ReturnType<typeof createSender>,
): Promise<void> {
  const queue = loadPendingQueue(accountId);
  if (queue.length === 0) return;

  logger.info('Flushing pending queue', { accountId, pending: queue.length });
  const stillPending: PendingItem[] = [];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      const chunks = splitMessage(item.text);
      for (const chunk of chunks) {
        await sender.sendText(toUserId, contextToken, chunk);
      }
    } catch (err) {
      logger.warn('Flush stopped at rate-limit, keeping remaining items queued', {
        accountId,
        failedAt: i,
        remaining: queue.length - i,
        error: err instanceof Error ? err.message : String(err),
      });
      stillPending.push(...queue.slice(i));
      break;
    }
  }

  savePendingQueue(accountId, stillPending);

  if (stillPending.length > 0 && stillPending.length === queue.length) {
    // Nothing got flushed this round — nudge the user.
    await sender
      .sendText(toUserId, contextToken, `⏳ 还有 ${stillPending.length} 条暂存消息未能推送，再发任意消息我会继续补发。`)
      .catch(() => {});
  }
}

async function sendToClaude(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Flush timer for streaming text to WeChat during query (declared here for finally cleanup)
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  // Start typing indicator (keepalive until stopTyping is called)
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    // Download file if present
    let prompt = userText || '请分析这张图片';
    if (fileItem) {
      const filePath = await downloadFile(fileItem);
      if (filePath) {
        const fileName = fileItem.file_item?.file_name || basename(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请先读取这个文件再回答。`
          : `用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请读取这个文件并总结其内容。`;
      }
    }

    let anySent = false;
    let lastSentTime = Date.now();
    let pendingRetry: { text: string; role: 'interstitial' | 'final' } | null = null;

    // Serial promise chain — each emit appends to the chain, no flags needed
    let flushChain: Promise<void> = Promise.resolve();

    function emitText(text: string, role: 'interstitial' | 'final'): void {
      if (!text.trim()) return;

      // 若上一次发送失败留下了 pendingRetry，先用它原本的 role 单独补发，
      // 不要和当前 role 的文本合并（避免 interstitial 内容混进 final 答案）。
      if (pendingRetry) {
        const stuck = pendingRetry;
        pendingRetry = null;
        scheduleSend(stuck.text, stuck.role);
      }

      scheduleSend(text, role);
    }

    function scheduleSend(text: string, role: 'interstitial' | 'final'): void {
      if (!text.trim()) return;
      flushChain = flushChain.then(async () => {
        const chunks = splitMessage(text);
        for (let i = 0; i < chunks.length; i++) {
          try {
            await sender.sendText(fromUserId, contextToken, chunks[i]);
          } catch (err) {
            pendingRetry = { text: chunks.slice(i).join('\n\n'), role };
            logger.warn('emitText send failed, content retained for retry', {
              role,
              error: err instanceof Error ? err.message : String(err),
              retainedChunks: chunks.length - i,
            });
            return;
          }
        }
        anySent = true;
        lastSentTime = Date.now();
      });
    }

    const router = new TurnRouter((msg) => emitText(filterToolNoise(msg.text), msg.role));

    // Safety net: send ONE keepalive if nothing was sent for 5 minutes, then stay silent
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    let silenceWarned = false;
    flushTimer = setInterval(() => {
      if (!silenceWarned && Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        silenceWarned = true;
        sender.sendText(fromUserId, contextToken, '还在处理中，请稍等…').catch(() => {});
      }
    }, 10000);

    const queryOptions: QueryOptions = {
      prompt,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: [
        '你正在通过微信与用户对话，不是在终端里。不要让用户去终端操作。如果用户需要文件，直接输出文件地址就行，会自动识别解析推送文件到用户的微信中。',
        config.systemPrompt,
      ].filter(Boolean).join('\n'),
      abortController,
      images,
      onText: (delta: string) => {
        router.onText(delta);
      },
      onTurnEnd: (stopReason: string) => {
        router.onTurnEnd(stopReason);
      },
    };

    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, session);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    // Stop periodic flush, drain router (final 先于 interstitial), wait for queued sends
    clearInterval(flushTimer);
    router.drain();
    await flushChain;

    // 兜底重试：drain() 的最后一次发送若失败，pendingRetry 会卡住没有下一个 emit 接力。
    // 这里做有上限的终态重试，避免静默丢内容（commit d6d7d62 的 "never silently drop" 保证）。
    const MAX_TERMINAL_ATTEMPTS = 3;
    let terminalAttempt = 0;
    while (pendingRetry && terminalAttempt < MAX_TERMINAL_ATTEMPTS) {
      const stuck: { text: string; role: 'interstitial' | 'final' } = pendingRetry;
      pendingRetry = null;
      terminalAttempt++;
      const delayMs = terminalAttempt * 5_000;  // 5s, 10s, 15s
      logger.warn(`terminal retry ${terminalAttempt}/${MAX_TERMINAL_ATTEMPTS} for stranded content`, {
        role: stuck.role,
        delayMs,
        textLength: stuck.text.length,
      });
      await new Promise(r => setTimeout(r, delayMs));

      const chunks = splitMessage(stuck.text);
      let failed = false;
      for (let i = 0; i < chunks.length; i++) {
        try {
          await sender.sendText(fromUserId, contextToken, chunks[i]);
          anySent = true;
          lastSentTime = Date.now();
        } catch (err) {
          pendingRetry = { text: chunks.slice(i).join('\n\n'), role: stuck.role };
          logger.warn('terminal retry failed', {
            attempt: terminalAttempt,
            error: err instanceof Error ? err.message : String(err),
          });
          failed = true;
          break;
        }
      }
      if (!failed) break;
    }

    if (pendingRetry) {
      // Park the stranded content to the pending queue. It will be flushed
      // automatically when the user's next message brings a fresh context_token
      // (which resets the iLink 11-msg quota).
      const queue = loadPendingQueue(account.accountId);
      queue.push({
        text: pendingRetry.text,
        role: pendingRetry.role,
        queuedAt: Date.now(),
      });
      savePendingQueue(account.accountId, queue);
      logger.warn('content parked to pending queue', {
        role: pendingRetry.role,
        textLength: pendingRetry.text.length,
        queueSize: queue.length,
      });
      await sender
        .sendText(fromUserId, contextToken, '⏳ 部分内容因微信单次推送上限暂存，下次你回复任意消息时自动补发。')
        .catch(() => {});
      pendingRetry = null;
    }

    // Send result back to WeChat
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      // If nothing was streamed at all (e.g. streaming not supported), send full text now
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }

      // 纯题干：用户已报选错 + Claude 已给答案 → 自动入库
      const plainLogReply = applyPlainQuestionAfterParse(result.text, config);
      if (plainLogReply) {
        sessionStore.addChatMessage(session, 'assistant', plainLogReply);
        const logChunks = splitMessage(plainLogReply);
        for (const chunk of logChunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Claude query error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, 'Claude 处理请求时出错，请稍后重试。');
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'Claude 无返回内容（可能因权限被拒而终止）');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);

    // Auto-push deliverable files mentioned in Claude's response
    if (result.text) {
      const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
      const detectedPaths = extractFilePathsFromText(result.text, cwd);
      const { existsSync } = await import('node:fs');
      const { extname } = await import('node:path');
      const pushable = detectedPaths.filter(f => {
        const ext = extname(f).toLowerCase();
        return AUTO_PUSH_EXTENSIONS.has(ext) && existsSync(f);
      });
      if (pushable.length > 0) {
        const failedFiles: string[] = [];
        for (const filePath of pushable) {
          try {
            await sender.sendFile(fromUserId, contextToken, filePath);
          } catch {
            failedFiles.push(filePath);
          }
        }
        if (failedFiles.length > 0) {
          // Server-side rate limit requires longer cooldown (observed ret:-2 even after 9s backoff)
          for (let attempt = 0; attempt < 3; attempt++) {
            const delay = (attempt + 1) * 15_000;
            logger.warn(`Rate-limited, retrying ${failedFiles.length} file(s) in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, delay));
            const stillFailed: string[] = [];
            for (const filePath of failedFiles) {
              try {
                await sender.sendFile(fromUserId, contextToken, filePath);
              } catch {
                stillFailed.push(filePath);
              }
            }
            if (stillFailed.length === 0) break;
            failedFiles.length = 0;
            failedFiles.push(...stillFailed);
          }
          if (failedFiles.length > 0) {
            logger.error('File delivery failed after all retries', { files: failedFiles });
            await sender.sendText(fromUserId, contextToken, `文件推送失败（服务端限频），请稍后重试。`).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — exit silently
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    clearInterval(flushTimer);
    stopTyping();
    // Clean up the abort controller if it's still ours
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
