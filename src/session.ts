import { loadJson, saveJson, validateAccountId } from './store.js';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { DATA_DIR, DEFAULT_WORKING_DIR } from './constants.js';
import { join } from 'node:path';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

/** Read workingDirectory from config.json, or fall back to hardcoded default */
function getWorkingDirFromConfig(): string {
  try {
    if (existsSync(CONFIG_PATH)) {
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (config.workingDirectory) return config.workingDirectory;
    }
  } catch (e) {
    logger.warn('Failed to read workingDirectory from config.json, using default', { error: String(e) });
  }
  return DEFAULT_WORKING_DIR;
}

export type SessionState = 'idle' | 'processing';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  sdkSessionId?: string;
  previousSdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
  /** PMP Athena 硬路由会话状态 */
  athena?: {
    mode: 'review' | 'daily' | 'daily_select' | 'variant_review';
    currentErrorId?: number;
    reviewCorrect?: number;
    reviewTotal?: number;
    dailyQuestionIndex?: number;
    dailyTotal?: number;
    dailyCorrect?: number;
    /** 高频错题变式巩固 */
    isHighFrequency?: boolean;
    variantIds?: number[];
    variantIndex?: number;
    variantCorrect?: number;
    variantTotal?: number;
    highFrequencyErrorId?: number;
    /** 选项缺失时：当前题是否等待知识回顾判定（已掌握/未掌握） */
    isKnowledgeReview?: boolean;
  };
}

const DEFAULT_MAX_HISTORY = 100;

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    validateAccountId(accountId);
    const session = loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: getWorkingDirFromConfig(),
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
    });

    // Backward compatibility: ensure chatHistory exists
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    if (!session.maxHistoryLength) {
      session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    }

    return session;
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });

    // Trim chat history if it exceeds max length before saving
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }

    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      sdkSessionId: undefined,          // explicitly clear so Object.assign removes it
      previousSdkSessionId: undefined,
      workingDirectory: currentSession?.workingDirectory ?? getWorkingDirFromConfig(),
      model: currentSession?.model,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
    };
    save(accountId, session);
    return session;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'Claude';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  return { load, save, clear, addChatMessage, getChatHistoryText };
}
