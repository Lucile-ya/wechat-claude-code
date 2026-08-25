/**
 * 合并微信连发的短消息，避免拆成多条独立回合导致回复串线。
 * 对齐上游 README「消息队列优化」方向。
 */

import { MessageItemType, MessageType, type WeixinMessage, type MessageItem } from './wechat/types.js';
import { extractText } from './wechat/media.js';

/** 短消息合并等待窗口（毫秒） */
export const COALESCE_WINDOW_MS = 700;

const MAX_FRAGMENT_LEN = 20;
const IMMEDIATE_MIN_LEN = 45;

export interface CoalesceDecision {
  defer: boolean;
}

export function hasNonTextMedia(msg: WeixinMessage): boolean {
  if (!msg.item_list?.length) return false;
  return msg.item_list.some((item) => item.type !== MessageItemType.TEXT);
}

export function extractMessageText(msg: WeixinMessage): string {
  if (!msg.item_list) return '';
  return msg.item_list.map((item) => extractText(item)).filter(Boolean).join('\n').trim();
}

export function isMergeableFragment(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_FRAGMENT_LEN) return false;
  if (t.startsWith('/')) return false;
  if (/^[A-Za-z]{1,15}$/.test(t)) return true;
  // 仅合并 1–3 字中文碎片（如「复习」+「错题」），完整指令（≥4 字）不合并
  if (/^[\u4e00-\u9fff]{1,3}$/.test(t)) return true;
  if (/每日一练答案[：:]?\s*$/.test(t)) return true;
  if (/我的答案是[：:]?\s*$/.test(t)) return true;
  return false;
}

/** 常见 Athena / 桥接指令：即使较短也立即处理 */
const IMMEDIATE_COMMAND_RE =
  /^(菜单|帮助|模考|倒计时|继续|暂停|薄弱点|每日一练|做题汇总|做题总览|今日状态|复习错题|分析趋势|睡前复习|开始模考|随机模考)/;

export function shouldProcessImmediately(text: string, hasMedia: boolean): boolean {
  if (hasMedia) return true;
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('/')) return true;
  if (IMMEDIATE_COMMAND_RE.test(t)) return true;
  if (t.length >= IMMEDIATE_MIN_LEN) return true;
  if (/每日一练答案[：:]\s*[A-Za-z]{3,}/.test(t)) return true;
  if (/我的答案是\s*[A-Za-z]/.test(t)) return true;
  return !isMergeableFragment(t);
}

export function decideCoalesce(msg: WeixinMessage): CoalesceDecision {
  if (msg.message_type !== MessageType.USER) return { defer: false };
  const text = extractMessageText(msg);
  const hasMedia = hasNonTextMedia(msg);
  if (shouldProcessImmediately(text, hasMedia)) return { defer: false };
  return { defer: true };
}

export function mergeMessages(messages: WeixinMessage[]): WeixinMessage {
  if (messages.length === 1) return messages[0];

  const texts = messages.map((m) => extractMessageText(m)).filter(Boolean);
  const mergedText = mergeTextFragments(texts);
  const last = messages[messages.length - 1];

  const itemList: MessageItem[] = [
    {
      type: MessageItemType.TEXT,
      text_item: { text: mergedText },
    },
  ];

  return {
    ...last,
    item_list: itemList,
  };
}

export function mergeTextFragments(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];

  let result = parts[0].trim();
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1].trim();
    const cur = parts[i].trim();
    if (!cur) continue;

    const prevLetters = /^[A-Za-z]{1,15}$/.test(prev);
    const curLetters = /^[A-Za-z]{1,15}$/.test(cur);
    const prevPrefix = /(?:每日一练答案|我的答案是)[：:]?\s*$/.test(prev);
    const prevShortCn = /^[\u4e00-\u9fff]{1,8}$/.test(prev);
    const curShortCn = /^[\u4e00-\u9fff]{1,8}$/.test(cur);

    if (prevLetters && curLetters) {
      result += cur;
    } else if (prevPrefix && curLetters) {
      result += cur;
    } else if (prevShortCn && curShortCn) {
      result += cur;
    } else if (prev.endsWith('：') || prev.endsWith(':')) {
      result += cur;
    } else {
      result += '\n' + cur;
    }
  }
  return result;
}
