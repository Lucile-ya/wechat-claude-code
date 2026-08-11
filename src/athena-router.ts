/**
 * PMP Athena 硬路由 — 绕过 LLM，直接执行 Python CLI。
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { logger } from './logger.js';
import type { Config } from './config.js';
import type { Session } from './session.js';

export interface AthenaRouteResult {
  handled: boolean;
  reply?: string;
  sessionPatch?: Partial<Session>;
}

interface ReviewNextResult {
  status: string;
  error_id: number | null;
  text: string;
  is_high_frequency?: boolean;
}

interface GradeReviewResult {
  status: string;
  correct: boolean;
  error_id: number;
  next_error_id: number | null;
  done?: boolean;
  text: string;
  /** 高频错题变式触发 */
  is_high_frequency?: boolean;
  variant_ids?: number[];
  variant_index?: number;
  variant_correct?: number;
  variant_total?: number;
}

interface DailyMenuResult {
  status: string;
  text: string;
  incomplete?: string[];
}

interface DailyStartResult {
  status: string;
  text: string;
  question_index?: number;
  total?: number;
  mode?: string;
  date?: string | null;
}

interface DailyGradeResult {
  status: string;
  text: string;
  correct?: boolean;
  done?: boolean;
  question_index?: number;
  total?: number;
}

interface DailyResolveResult {
  status: string;
  text: string;
  date?: string | null;
}

interface ScreenshotLogResult {
  success: boolean;
  is_correct?: boolean | null;
  auto_action?: string;
  human_confirm?: boolean;
  needs_user_confirm?: boolean;
  error_log_record_id?: number;
  question_bank_record_id?: number;
  extracted?: {
    question?: string;
    my_answer?: string;
    correct_answer?: string;
    knowledge_area?: string;
    explanation?: string;
  };
  error?: string;
}

/** 发图配文触发录入错题（与 OCR 识别 error_result 并列） */
const SCREENSHOT_ERROR_TRIGGERS = [
  /录入错题/,
  /录错题/,
  /错题录入/,
  /截图录入/,
  /选错了/,
  /这题错了/,
  /这题(?:做)?错了/,
  /(?:我)?(?:这题)?答错了/,
  /我的答案[是为：:\s]*[A-Ea-e].{0,40}?正确(?:答案)?[是为：:\s]*[A-Ea-e]/i,
  /正确(?:答案)?[是为：:\s]*[A-Ea-e]/i,
];

/** PMP 知识领域（章节练习截图配文识别） */
const KNOWLEDGE_AREA_NAMES = [
  '整合管理', '范围管理', '进度管理', '成本管理', '质量管理',
  '资源管理', '沟通管理', '风险管理', '采购管理', '干系人管理',
  '敏捷/混合方法', '商业环境', '领导力/人员',
];

const CHAPTER_AREA_ALIASES: Record<string, string> = {
  项目整合管理: '整合管理',
  项目范围管理: '范围管理',
  项目进度管理: '进度管理',
  项目成本管理: '成本管理',
  项目质量管理: '质量管理',
  项目资源管理: '资源管理',
  项目沟通管理: '沟通管理',
  项目风险管理: '风险管理',
  项目采购管理: '采购管理',
  项目干系人管理: '干系人管理',
  整合: '整合管理',
  范围: '范围管理',
  进度: '进度管理',
  成本: '成本管理',
  质量: '质量管理',
  资源: '资源管理',
  沟通: '沟通管理',
  风险: '风险管理',
  采购: '采购管理',
  干系人: '干系人管理',
  敏捷: '敏捷/混合方法',
  商业: '商业环境',
};

const CHAPTER_PRACTICE_TRIGGERS = [
  /章节练习/,
  /练习统计/,
  /录入章节/,
  /章节刷题/,
];

const REVIEW_TRIGGERS = [
  /复习错题/,
  /今日复习错题/,
  /今天错题复习/,
  /今日错题复习/,
  /今天复习什么/,
  /回顾错题/,
  /错题回顾/,
  /错题复习/,
  /^\/review$/,
  /开始复习/,
];

const MOCK_EXAM_TRIGGERS = [
  /^模考$/,
  /^开始模考/,
  /^随机模考$/,
  /^继续模考$/,
  /^模考状态$/,
  /^模考清单$/,
  /^模考看板$/,
  /^模考进度$/,
];

const WEAKNESS_TRIGGERS = [
  /^薄弱点$/,
  /^薄弱领域$/,
  /^弱点分析$/,
  /^我的弱点$/,
  /^分析薄弱$/,
  /^诊断报告$/,
];

const FREQUENT_ERROR_TRIGGERS = [
  /^高频错题$/,
  /^常错题$/,
  /^反复错的题$/,
  /^错题高频$/,
  /^高频错误$/,
];

/** 知识点速查：X知识点 / 知识点 X / 总结X / X速查 / 考点 X 等 */
function isKnowledgeSummaryQuery(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (/^知识点\s*.+/.test(t)) return true;
  if (/知识点$/.test(t)) return true;
  if (/^详细知识点\s*.+/.test(t)) return true;
  if (/^总结.{2,}$/.test(t)) return true;
  if (/.{2,}总结$/.test(t)) return true;
  if (/^考点\s*.+/.test(t)) return true;
  if (/考点$/.test(t)) return true;
  if (/有哪些考点$/.test(t)) return true;
  if (/有哪些要点$/.test(t)) return true;
  if (/速查$/.test(t)) return true;
  return false;
}

const DAILY_TRIGGERS = [
  /^每日一练$/,
  /^来一套每日一练$/,
  /^做每日一练$/,
];

const RANDOM_DAILY_TRIGGERS = [
  /^随机每日一练$/,
];

const DAILY_DATE_START = /^做\s*(\d{1,2})月(\d{1,2})(?:日|号)?\s*每日一练$/;

/** 日期格式：7月30日 / 7月30 / 7月30号 / 7-30 / 7.30 / 730 / 30 */
const DATE_WITH_DAILY = /^(\d{1,2})月(\d{1,2})(?:日|号)?\s*每日一练$/;
const DAY_NUM_DAILY = /^(\d{1,2})号\s*每日一练$/;
const STANDALONE_MD = /^(\d{1,2})月(\d{1,2})(?:日|号)?$/;
const STANDALONE_SEP = /^(\d{1,2})[-.](\d{1,2})$/;
const STANDALONE_COMPACT = /^\d{1,4}$/;

const PREP_SUMMARY_TRIGGERS = [
  /^备考(?:刷题)?总结$/,
  /^刷题总结$/,
  /^做题总结$/,
  /^刷题总览$/,
  /^总结(?:一下)?(?:我的)?(?:做题|刷题)(?:情况)?$/,
  /^(?:总结|汇总)(?:一下)?(?:我)?(?:这几个月)?(?:的)?备考(?:刷题)?(?:情况)?$/,
  /^备考(?:刷题)?情况$/,
  // 新增: 做题汇总 / 做题数据 / 整体情况 / 我的进度 等短指令
  /^做题汇总$/,
  /^做题数据$/,
  /^整体情况$/,
  /^我的进度$/,
  /^做题总览$/,
  /^做题情况$/,
  /^今日状态$/,
  /^今天进度$/,
  /^汇总$/,
  /^所有做题记录$/,
  /^近两个月$/,
  /^\\d{1,2}月\\d{1,2}月做题$/,
];

/** 7月做题情况 / 7月刷题统计 — 非日期选题 */
const MONTH_PRACTICE_RE =
  /^(\d{1,2})月(?:份)?(?:(?:刷题|做题)(?:情况|统计|汇总|总结)?|(?:情况|统计|汇总|总结)(?:刷题|做题)?)$/;

function isPracticeSummaryQuery(text: string): boolean {
  const t = text.trim().replace(/[\u200b\uFEFF]/g, '');
  if (PREP_SUMMARY_TRIGGERS.some((re) => re.test(t))) return true;
  if (MONTH_PRACTICE_RE.test(t)) return true;
  if (/\d{1,2}\s*月/.test(t) && /(做题|刷题)/.test(t) && /(情况|统计|汇总|总结)/.test(t)) {
    return true;
  }
  return false;
}

const REDO_DAILY_PREFIX = /^(?:再刷|重做)\s*(.+)$/;
const REDO_DAILY_SUFFIX = /^(.+?)(?:再刷|重做)$/;

const ANSWER_PATTERN = /^[A-Da-d]$/;
const MULTI_ANSWER_PATTERN = /^[A-Ea-e]{2,10}$/;
const DAILY_ANSWER_PATTERN = /^[A-Ea-e]{1,10}$/;

/** 从长文本提取「我的答案是A / 我的答案是：ACCAB」（不匹配逐题「答案：C」） */
const EMBEDDED_ANSWER_RES: RegExp[] = [
  /(?:我的答案(?:是)?|我选(?:了)?)[：:\s]*([A-Ea-e]{1,10})\s*$/im,
];

export function extractEmbeddedDailyAnswer(text: string): string | null {
  const trimmed = text.trim().replace(/[\u200b\uFEFF]/g, '');
  for (const re of EMBEDDED_ANSWER_RES) {
    const m = trimmed.match(re);
    if (m?.[1] && /^[A-Ea-e]+$/i.test(m[1])) {
      return m[1].toUpperCase();
    }
  }
  return null;
}

function extractMyAnswerOnly(text: string): string | null {
  const trimmed = text.trim().replace(/[\u200b\uFEFF]/g, '');
  const embedded = extractEmbeddedDailyAnswer(trimmed);
  if (embedded) return embedded;
  if (/^[A-Ea-e]$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

function resolveDailyAnswer(text: string): string | null {
  const trimmed = text.trim().replace(/[\u200b\uFEFF]/g, '');
  if (ANSWER_PATTERN.test(trimmed) || DAILY_ANSWER_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return extractEmbeddedDailyAnswer(trimmed);
}

/** 文件态：Python 侧 daily_practice_state.json 仍有进行中的练习 */
function hasActiveDailyPractice(config: Config): boolean {
  const statePath = join(
    config.workingDirectory,
    'pmp_notes',
    'daily_practice_state.json',
  );
  if (!existsSync(statePath)) return false;
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf8')) as {
      questions?: unknown[];
      current_index?: number;
    };
    const questions = data.questions ?? [];
    const idx = data.current_index ?? 0;
    return questions.length > 0 && idx < questions.length;
  } catch {
    return false;
  }
}

function readMockExamState(config: Config): {
  status?: string;
  elapsed_seconds?: number;
  current_batch?: number;
  total_questions?: number;
} | null {
  const statePath = join(
    config.workingDirectory,
    'pmp_notes',
    'mock_exam_state.json',
  );
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/** 读取新版 mock_exam_engine.json */
function readMockEngineState(config: Config): {
  status?: string;
  paper?: string;
  current_index?: number;
  total?: number;
  answered?: number;
  paused_accumulated?: number;
} | null {
  const statePath = join(
    config.workingDirectory,
    'pmp_notes',
    'mock_exam_engine.json',
  );
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/** 调用 mock_exam_engine.py */
function runMockExamEngine(
  config: Config,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  return runModuleScript(config, 'mock_exam_engine.py', args);
}

/** 调用 pmp_athena/ 下的 Python 脚本 */
function runModuleScript(
  config: Config,
  scriptName: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const pythonBin = config.pythonBin || 'python';
  const cwd = config.workingDirectory;
  const script = join(cwd, 'pmp_athena', scriptName);

  const result = spawnSync(pythonBin, [script, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 180_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function looksLikeDailyDate(text: string): boolean {
  return (
    STANDALONE_MD.test(text) ||
    STANDALONE_SEP.test(text) ||
    STANDALONE_COMPACT.test(text) ||
    DATE_WITH_DAILY.test(text) ||
    DAY_NUM_DAILY.test(text) ||
    DAILY_DATE_START.test(text) ||
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(text)
  );
}

/** 供 main.ts 拦截：像 Athena 指令但未硬路由成功时，勿交给 Claude 乱答 */
export function isLikelyAthenaCommand(text: string): boolean {
  const trimmed = text.trim().replace(/[\u200b\uFEFF]/g, '');
  if (!trimmed || trimmed.startsWith('/')) return false;
  if (ANSWER_PATTERN.test(trimmed) || MULTI_ANSWER_PATTERN.test(trimmed)) return true;
  if (extractEmbeddedDailyAnswer(trimmed)) return true;
  if (BATCH_UPDATE_TRIGGER.test(trimmed) && /正确答案/i.test(trimmed)) return true;
  if (isInlineGradeText(trimmed)) return true;
  if (isExplainRequest(trimmed)) return true;
  if (isBreakfastPracticeInput(trimmed)) return true;
  if (isBatchPracticeInput(trimmed)) return true;
  if (extractMyAnswerOnly(trimmed) && !/(?:^|\n)\d+[\.．、]/m.test(trimmed)) return true;
  if (REVIEW_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (WEAKNESS_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (FREQUENT_ERROR_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (DAILY_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (RANDOM_DAILY_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (REDO_DAILY_PREFIX.test(trimmed) || REDO_DAILY_SUFFIX.test(trimmed)) return true;
  if (isPracticeSummaryQuery(trimmed)) return true;
  if (isKnowledgeSummaryQuery(trimmed)) return true;
  if (/^(详细|展开|套路|情景|关联)\s*/.test(trimmed)) return true;
  if (looksLikeDailyDate(trimmed)) return true;
  return false;
}

function runPythonScript(
  config: Config,
  scriptName: string,
  args: string[],
  stdin?: string,
): { ok: boolean; stdout: string; stderr: string } {
  const pythonBin = config.pythonBin || 'python';
  const cwd = config.workingDirectory;
  const script = join(cwd, 'pmp_athena', scriptName);

  const result = spawnSync(pythonBin, [script, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    input: stdin,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/** App 刷题：1、/41. 题干 + 选项（≥1 题） */
function isAppQuestionFormat(text: string): boolean {
  const trimmed = text.trim();
  return /(?:^|\n)\d+[\.．、]\s*\S/m.test(trimmed) && /(?:^|\n)[A-D][、\.．:：]/im.test(trimmed);
}

/** App 刷题：多题 + 我的答案是 */
function isBatchPracticeInput(text: string): boolean {
  const trimmed = text.trim();
  if (!isAppQuestionFormat(trimmed)) return false;
  const blocks = trimmed.match(/(?:^|\n)\d+[\.．、]\s*/gm);
  if (!blocks || blocks.length < 1) return false;
  if (extractEmbeddedDailyAnswer(trimmed)) return true;
  // 仅题干+选项（待跟答）
  return blocks.length >= 1 && /(?:^|\n)[A-D][、\.．:：]/im.test(trimmed);
}

/** 早餐题：逐题含 答案：X 或 【解析】 */
function isBreakfastPracticeInput(text: string): boolean {
  const trimmed = text.replace(/^(?:早餐题|早题)[：:\s]*/i, '').trim();
  const qBlocks = trimmed.match(/(?:^|\n)\d+[\.．、]\s*/gm);
  const ansBlocks = trimmed.match(/(?:^|\n)(?:\d+[、.]?\s*)?答案[：:\s]*[A-E]\s*$/gim);
  const explBlocks = trimmed.match(/【解析】/g);
  return (
    (qBlocks?.length ?? 0) >= 1 &&
    ((ansBlocks?.length ?? 0) >= 1 || (explBlocks?.length ?? 0) >= 1)
  );
}

function hasPendingBatchQuestions(config: Config): boolean {
  const statePath = join(config.workingDirectory, 'pmp_notes', 'batch_practice_state.json');
  if (!existsSync(statePath)) return false;
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf8')) as {
      pending_questions?: unknown[];
      by_num?: Record<string, { correct_answer?: string; pending?: boolean; bank_id?: number | null; my_answer?: string; question?: string }>;
    };
    if ((data.pending_questions?.length ?? 0) >= 1) return true;
    const waiting = Object.values(data.by_num ?? {}).filter(
      (v) => v.question && (!v.correct_answer || (v.my_answer && v.pending && !v.bank_id)),
    );
    return waiting.length >= 1;
  } catch {
    return false;
  }
}

function isBatchAnswerFollowup(text: string, config: Config): boolean {
  const trimmed = text.trim();
  if (!extractMyAnswerOnly(trimmed)) return false;
  if (/(?:^|\n)\d+[\.．、]/m.test(trimmed)) return false;
  if (/(?:^|\n)[A-D][、\.．:：]/im.test(trimmed)) return false;
  return hasPendingBatchQuestions(config);
}

const BATCH_UPDATE_TRIGGER = /更新\s*#?\d+\s*题/i;

const EXPLAIN_REQUEST = /^(?:给我|帮我)?(?:解析|解释|讲解)(?:一下|下|这题|这道题)?[。.!！?？]*$/i;

function isInlineGradeText(text: string): boolean {
  const t = text.trim();
  return /我的答案|我选/i.test(t) && /正确(?:答案)?[是为：:\s]*[A-Ea-e]/i.test(t);
}

function isExplainRequest(text: string): boolean {
  return EXPLAIN_REQUEST.test(text.trim());
}

function routeBatchExplain(config: Config): AthenaRouteResult {
  const { ok, stdout, stderr } = runPythonScript(config, 'daily_practice.py', [
    'batch-explain',
    '--json',
  ]);
  if (!ok) {
    return { handled: true, reply: `⚠️ 解析失败\n${stderr || stdout}` };
  }
  try {
    const data = JSON.parse(stdout) as { status: string; text: string };
    return { handled: true, reply: data.text || stdout };
  } catch {
    return { handled: true, reply: stdout || '⚠️ 解析无输出' };
  }
}

function routeBatchPractice(config: Config, text: string): AthenaRouteResult {
  const { ok, stdout, stderr } = runPythonScript(
    config,
    'daily_practice.py',
    ['batch', '--stdin', '--json'],
    text,
  );
  if (!ok) {
    return { handled: true, reply: `⚠️ 批量收录失败\n${stderr || stdout}` };
  }
  try {
    const data = JSON.parse(stdout) as { status: string; text: string };
    return { handled: true, reply: data.text || stdout };
  } catch {
    return { handled: true, reply: stdout || '⚠️ 批量收录无输出' };
  }
}

function routeBatchUpdateText(config: Config, text: string): AthenaRouteResult {
  const { ok, stdout, stderr } = runPythonScript(
    config,
    'daily_practice.py',
    ['batch-update-text', '--stdin', '--json'],
    text,
  );
  if (!ok) {
    return { handled: true, reply: `⚠️ 补录失败\n${stderr || stdout}` };
  }
  try {
    const data = JSON.parse(stdout) as { status: string; text: string };
    return { handled: true, reply: data.text || stdout };
  } catch {
    return { handled: true, reply: stdout || '⚠️ 补录无输出' };
  }
}

function runDynamicKnowledge(config: Config, text: string): AthenaRouteResult {
  const { ok, stdout, stderr } = runPythonScript(config, 'dynamic_knowledge.py', [
    'message',
    '--text',
    text,
    '--json',
  ]);
  if (!ok) {
    logger.error('dynamic knowledge failed', { stderr });
    return { handled: true, reply: `⚠️ 知识检索失败\n${stderr || stdout}` };
  }
  try {
    const data = JSON.parse(stdout) as { status: string; text?: string };
    if (data.status === 'skip') {
      return { handled: false };
    }
    return { handled: true, reply: data.text || stdout };
  } catch {
    return { handled: false };
  }
}

function runKnowledgeSummary(config: Config, text: string): AthenaRouteResult {
  const { ok, stdout, stderr } = runPythonScript(config, 'knowledge_retriever.py', [
    'retrieve',
    '--text',
    text,
    '--json',
  ]);
  if (!ok) {
    logger.error('knowledge retriever failed', { stderr });
    return { handled: true, reply: `⚠️ 知识点检索失败\n${stderr || stdout}` };
  }
  try {
    const data = JSON.parse(stdout) as { status: string; text: string };
    return { handled: true, reply: data.text || stdout };
  } catch {
    return { handled: true, reply: stdout || '⚠️ 知识点总结无输出' };
  }
}

function runStudyAdvisor(config: Config, args: string[]) {
  return runPythonScript(config, 'study_advisor.py', args);
}

function runDailyPractice(config: Config, args: string[]) {
  return runPythonScript(config, 'daily_practice.py', args);
}

// 直接总览指令（无参数，直接跑 practice_overview_light.py）
const DIRECT_OVERVIEW_TRIGGERS = new Set([
  '做题汇总', '做题数据', '整体情况', '我的进度', '做题总览', '做题情况',
  '今日状态', '今天进度', '汇总', '所有做题记录', '近两个月',
]);

function runPracticeSummary(config: Config, text: string): AthenaRouteResult {
  const trimmed = text.trim().replace(/[​﻿]/g, '');

  // 直接总览：无参数，运行 practice_overview_light.py
  if (DIRECT_OVERVIEW_TRIGGERS.has(trimmed)) {
    const { ok, stdout, stderr } = runPythonScript(config, 'practice_overview_light.py', []);
    if (!ok) {
      logger.error('practice overview failed', { stderr, text });
      return { handled: true, reply: '⚠️ 做题汇总生成失败，请稍后重试。' };
    }
    return { handled: true, reply: stdout || '📊 暂无做题记录。' };
  }

  // 自然语言查询：走 practice_summary.py parse
  const { ok, stdout, stderr } = runPythonScript(config, 'practice_summary.py', [
    'parse', text, '--json',
  ]);

  if (!ok) {
    logger.error('practice summary failed', { stderr, text });
    return { handled: true, reply: '⚠️ 刷题汇总生成失败，请稍后重试。' };
  }

  const data = parseJson<{ status: string; text: string }>(stdout);
  if (!data || data.status === 'error') {
    return {
      handled: true,
      reply: data?.text || '⚠️ 无法识别汇总指令。试试：`7月做题情况` 或 `备考总结`',
    };
  }

  return { handled: true, reply: data.text };
}

function parseJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Python logging 可能污染 stdout，从末尾提取 JSON
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          return JSON.parse(line) as T;
        } catch {
          /* continue */
        }
      }
    }
    const match = trimmed.match(/\{[\s\S]*\}$/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function startReview(config: Config): AthenaRouteResult {
  const { ok, stdout, stderr } = runStudyAdvisor(config, [
    'review-next', '--json', '--header',
  ]);

  if (!ok) {
    logger.error('review-next failed', { stderr });
    return {
      handled: true,
      reply: '⚠️ 复习错题启动失败，请稍后重试。',
    };
  }

  const data = parseJson<ReviewNextResult>(stdout);
  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析复习数据' };
  }

  if (data.status === 'question' && data.error_id != null) {
    return {
      handled: true,
      reply: data.text,
      sessionPatch: {
        athena: {
          mode: 'review',
          currentErrorId: data.error_id,
          reviewCorrect: 0,
          reviewTotal: 0,
          isHighFrequency: data.is_high_frequency ?? false,
        },
      },
    };
  }

  return {
    handled: true,
    reply: data.text,
    sessionPatch: { athena: undefined },
  };
}

function gradeReviewAnswer(
  config: Config,
  session: Session,
  answer: string,
): AthenaRouteResult {
  const errorId = session.athena?.currentErrorId;
  if (!errorId) {
    return { handled: false };
  }

  const { ok, stdout, stderr } = runStudyAdvisor(config, [
    'grade-review', String(errorId), answer.toUpperCase(), '--json',
  ]);

  if (!ok) {
    logger.error('grade-review failed', { stderr, errorId });
    return {
      handled: true,
      reply: '⚠️ 判卷失败，请重试。',
    };
  }

  const data = parseJson<GradeReviewResult>(stdout);
  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析判卷结果' };
  }

  const prev = session.athena ?? {
    mode: 'review' as const,
    currentErrorId: errorId,
    reviewCorrect: 0,
    reviewTotal: 0,
  };
  const reviewCorrect = (prev.reviewCorrect ?? 0) + (data.correct ? 1 : 0);
  const reviewTotal = (prev.reviewTotal ?? 0) + 1;

  // ── 变式子模式触发 ──
  if (data.status === 'graded_variant_pending' && data.variant_ids && data.variant_ids.length > 0) {
    return {
      handled: true,
      reply: data.text,
      sessionPatch: {
        athena: {
          mode: 'variant_review',
          highFrequencyErrorId: data.error_id,
          variantIds: data.variant_ids,
          variantIndex: data.variant_index ?? 0,
          variantCorrect: data.variant_correct ?? 0,
          variantTotal: data.variant_total ?? data.variant_ids.length,
          reviewCorrect,
          reviewTotal,
        },
      },
    };
  }

  if (data.done || data.next_error_id == null) {
    const summary =
      `\n\n📋 复习小结：正确 ${reviewCorrect}/${reviewTotal}`;
    return {
      handled: true,
      reply: data.text + summary,
      sessionPatch: { athena: undefined },
    };
  }

  return {
    handled: true,
    reply: data.text,
    sessionPatch: {
      athena: {
        mode: 'review',
        currentErrorId: data.next_error_id,
        reviewCorrect,
        reviewTotal,
        isHighFrequency: data.is_high_frequency ?? false,
      },
    },
  };
}

function gradeVariantAnswer(
  config: Config,
  session: Session,
  answer: string,
): AthenaRouteResult {
  const a = session.athena;
  if (!a || a.variantIds == null || a.highFrequencyErrorId == null) {
    return { handled: false };
  }

  const errorId = a.highFrequencyErrorId;
  const variantIds = a.variantIds;
  const currentIndex = a.variantIndex ?? 0;
  const currentCorrect = a.variantCorrect ?? 0;

  const { ok, stdout, stderr } = runStudyAdvisor(config, [
    'variant-grade',
    String(errorId),
    String(currentIndex),
    answer.toUpperCase(),
    JSON.stringify(variantIds),
    String(currentCorrect),
    '--json',
  ]);

  if (!ok) {
    logger.error('variant-grade failed', { stderr, errorId });
    return { handled: true, reply: '⚠️ 变式判卷失败，请重试。' };
  }

  const data = parseJson<{
    status: string;
    correct: boolean;
    variant_ids?: number[];
    variant_index?: number;
    variant_correct?: number;
    variant_total?: number;
    passed?: boolean;
    next_error_id?: number | null;
    done?: boolean;
    text: string;
  }>(stdout);

  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析变式判卷结果' };
  }

  const reviewCorrect = a.reviewCorrect ?? 0;
  const reviewTotal = a.reviewTotal ?? 0;

  if (data.status === 'variant_done') {
    // 变式全部完成 → 返回 review next 或结束
    if (data.done || data.next_error_id == null) {
      const summary = `\n\n📋 复习小结：正确 ${reviewCorrect}/${reviewTotal}`;
      return {
        handled: true,
        reply: data.text + summary,
        sessionPatch: { athena: undefined },
      };
    }
    return {
      handled: true,
      reply: data.text,
      sessionPatch: {
        athena: {
          mode: 'review',
          currentErrorId: data.next_error_id,
          reviewCorrect,
          reviewTotal,
        },
      },
    };
  }

  if (data.status === 'variant_question') {
    return {
      handled: true,
      reply: data.text,
      sessionPatch: {
        athena: {
          mode: 'variant_review',
          highFrequencyErrorId: errorId,
          variantIds: variantIds,
          variantIndex: data.variant_index ?? (currentIndex + 1),
          variantCorrect: data.variant_correct ?? currentCorrect,
          variantTotal: data.variant_total ?? variantIds.length,
          reviewCorrect,
          reviewTotal,
        },
      },
    };
  }

  return { handled: true, reply: data.text };
}

function runFrequentErrors(config: Config): AthenaRouteResult {
  const { ok, stdout, stderr } = runStudyAdvisor(config, ['frequent-errors', '--json']);

  if (!ok) {
    logger.error('frequent-errors failed', { stderr });
    return { handled: true, reply: '⚠️ 高频错题生成失败，请稍后重试。' };
  }

  const data = parseJson<{ status: string; text: string }>(stdout);
  return {
    handled: true,
    reply: data?.text || stdout || '⚠️ 暂无高频错题数据',
  };
}

function runWeakness(config: Config): AthenaRouteResult {
  const { ok, stdout, stderr } = runStudyAdvisor(config, ['weakness']);

  if (!ok) {
    logger.error('weakness failed', { stderr });
    return {
      handled: true,
      reply: '⚠️ 薄弱点分析失败，请稍后重试。',
    };
  }

  return { handled: true, reply: stdout };
}

function startDailyMenu(config: Config): AthenaRouteResult {
  const { ok, stdout, stderr } = runDailyPractice(config, ['menu', '--json']);

  if (!ok) {
    logger.error('daily menu failed', { stderr });
    return { handled: true, reply: '⚠️ 每日一练加载失败，请稍后重试。' };
  }

  const data = parseJson<DailyMenuResult>(stdout);
  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析每日一练数据' };
  }

  if (data.status === 'all_done') {
    return startDailyRandom(config, data.text);
  }

  return {
    handled: true,
    reply: data.text,
    sessionPatch: {
      athena: { mode: 'daily_select' },
    },
  };
}

function startDailyByDate(
  config: Config,
  isoDate: string,
  prefix = '',
): AthenaRouteResult {
  const { ok, stdout, stderr } = runDailyPractice(config, [
    'start', '--date', isoDate, '--json',
  ]);

  if (!ok) {
    logger.error('daily start failed', { stderr, isoDate });
    return { handled: true, reply: '⚠️ 每日一练启动失败，请稍后重试。' };
  }

  const data = parseJson<DailyStartResult>(stdout);
  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析每日一练' };
  }

  if (data.status === 'select') {
    return {
      handled: true,
      reply: data.text,
      sessionPatch: { athena: { mode: 'daily_select' } },
    };
  }

  if (data.status !== 'question') {
    return { handled: true, reply: data.text };
  }

  const reply = prefix ? `${prefix}\n\n${data.text}` : data.text;
  return {
    handled: true,
    reply,
    sessionPatch: {
      athena: {
        mode: 'daily',
        dailyQuestionIndex: data.question_index ?? 1,
        dailyTotal: data.total ?? 10,
        dailyCorrect: 0,
      },
    },
  };
}

function startDailyRandom(config: Config, prefix = ''): AthenaRouteResult {
  const { ok, stdout, stderr } = runDailyPractice(config, [
    'start', '--random', '--json',
  ]);

  if (!ok) {
    logger.error('daily random start failed', { stderr });
    return { handled: true, reply: '⚠️ 随机每日一练启动失败，请稍后重试。' };
  }

  const data = parseJson<DailyStartResult>(stdout);
  if (!data || data.status !== 'question') {
    return {
      handled: true,
      reply: data?.text || stdout || '⚠️ 无法开始随机每日一练',
    };
  }

  const reply = prefix ? `${prefix}\n\n${data.text}` : data.text;
  return {
    handled: true,
    reply,
    sessionPatch: {
      athena: {
        mode: 'daily',
        dailyQuestionIndex: data.question_index ?? 1,
        dailyTotal: data.total ?? 10,
        dailyCorrect: 0,
      },
    },
  };
}

function resolveAndStartDaily(
  config: Config,
  text: string,
  redo = false,
): AthenaRouteResult {
  const args = ['resolve-date', text, '--json'];
  if (redo) args.push('--redo');

  const { ok, stdout, stderr } = runDailyPractice(config, args);

  if (!ok) {
    logger.error('daily resolve-date failed', { stderr });
    return { handled: true, reply: '⚠️ 日期解析失败，请重试。' };
  }

  const data = parseJson<DailyResolveResult>(stdout);
  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析日期' };
  }

  if (data.status === 'error' || data.status === 'already_done') {
    return { handled: true, reply: data.text };
  }

  if (data.status === 'ok' && data.date) {
    return startDailyByDate(config, data.date);
  }

  return { handled: true, reply: data.text || '⚠️ 无法识别日期' };
}

function gradeDailyAnswer(
  config: Config,
  session: Session,
  answer: string,
): AthenaRouteResult {
  const { ok, stdout, stderr } = runDailyPractice(config, [
    'grade', answer.toUpperCase(), '--json',
  ]);

  if (!ok) {
    logger.error('daily grade failed', { stderr });
    return { handled: true, reply: '⚠️ 判卷失败，请重试。' };
  }

  const data = parseJson<DailyGradeResult>(stdout);
  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析判卷结果' };
  }

  if (data.status === 'error') {
    const text = data.text.includes('没有进行中')
      ? '📌 本轮每日一练已结束。发送「每日一练」开始新一轮。'
      : data.text;
    return { handled: true, reply: text };
  }

  if (data.done || data.status === 'done') {
    return {
      handled: true,
      reply: data.text,
      sessionPatch: { athena: undefined },
    };
  }

  const prev = session.athena ?? { mode: 'daily' as const };
  const dailyCorrect =
    (prev.dailyCorrect ?? 0) + (data.correct ? 1 : 0);

  return {
    handled: true,
    reply: data.text,
    sessionPatch: {
      athena: {
        mode: 'daily',
        dailyQuestionIndex: data.question_index ?? (prev.dailyQuestionIndex ?? 1) + 1,
        dailyTotal: data.total ?? prev.dailyTotal ?? 10,
        dailyCorrect,
      },
    },
  };
}

/**
 * 尝试硬路由 Athena 指令。handled=true 时直接回复，不调用 Claude。
 */
export function routeAthenaMessage(
  text: string,
  session: Session,
  config: Config,
): AthenaRouteResult {
  const trimmed = text.trim().replace(/[\u200b\uFEFF]/g, '');
  if (!trimmed) return { handled: false };

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // \u6A21\u8003\u5F15\u64CE\u72B6\u6001\u673A \u2014 \u63A5\u7BA1\u6240\u6709\u6D88\u606F
  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  const engState = readMockEngineState(config);

  // \u2500\u2500 \u6A21\u8003 pause-lock \u2500\u2500
  if (engState?.status === 'paused') {
    const RESUME_RE = /^(\u7EE7\u7EED|\u7EE7\u7EED\u6A21\u8003|\u7EE7\u7EED\u8003\u8BD5|\u63A5\u7740\u505A|resume)$/;
    const ABANDON_RE = /^(\u653E\u5F03\u6A21\u8003|\u4E0D\u505A\u4E86|\u53D6\u6D88\u6A21\u8003|abandon)$/;
    if (RESUME_RE.test(trimmed)) {
      // resume will be handled below (trigger check)
    } else if (ABANDON_RE.test(trimmed)) {
      const result = runMockExamEngine(config, ['abandon']);
      const r = parseJson<{ status: string; text: string }>(result.stdout);
      return { handled: true, reply: r?.text || '\uD83D\uDDD1\uFE0F \u6A21\u8003\u5DF2\u653E\u5F03\u3002' };
    } else {
      const answered = engState.answered || 0;
      const total = engState.total || 180;
      const elapsed = engState.paused_accumulated || 0;
      const mins = Math.floor(elapsed / 60);
      return {
        handled: true,
        reply: `\u23F8\uFE0F  \u6A21\u8003\u5DF2\u6682\u505C\uFF08\u5DF2\u7528 ${mins} \u5206\uFF09\n   \u8FDB\u5EA6: ${answered}/${total} \u9898\n   \u5982\u9700\u7EE7\u7EED\u8BF7\u56DE\u590D\u300C\u7EE7\u7EED\u300D\n   \u5982\u9700\u653E\u5F03\u8BF7\u56DE\u590D\u300C\u653E\u5F03\u6A21\u8003\u300D`,
      };
    }
  }

  // \u2500\u2500 \u6A21\u8003 active \u2014 \u53EA\u5904\u7406\u6A21\u8003\u76F8\u5173\u6307\u4EE4 \u2500\u2500
  if (engState?.status === 'active') {
    const ANSWER_RE = /^[A-Ea-e]$/;
    const ANSWER_BATCH_RE = /^[A-Ea-e]{2,15}$/;
    const PAUSE_RE = /^(\u6682\u505C|\u6682\u505C\u6A21\u8003|\u5148\u505C\u4E00\u4E0B|pause)$/;
    const ABANDON_RE = /^(\u653E\u5F03\u6A21\u8003|\u4E0D\u505A\u4E86|\u53D6\u6D88\u6A21\u8003|abandon)$/;
    const STATUS_RE = /^(\u6A21\u8003\u8FDB\u5EA6|\u6A21\u8003\u72B6\u6001|\u6A21\u8003\u5230\u54EA\u4E86|\u8FDB\u5EA6)$/;

    if (ABANDON_RE.test(trimmed)) {
      const result = runMockExamEngine(config, ['abandon']);
      const r = parseJson<{ text: string }>(result.stdout);
      return { handled: true, reply: r?.text || '\uD83D\uDDD1\uFE0F \u6A21\u8003\u5DF2\u653E\u5F03\u3002' };
    }
    if (PAUSE_RE.test(trimmed)) {
      const result = runMockExamEngine(config, ['pause']);
      const r = parseJson<{ status: string; text: string }>(result.stdout);
      return { handled: true, reply: r?.text || '\u23F8\uFE0F \u5DF2\u6682\u505C\u3002' };
    }
    if (STATUS_RE.test(trimmed)) {
      const result = runMockExamEngine(config, ['status']);
      const r = parseJson<{ status: string; text: string }>(result.stdout);
      return { handled: true, reply: r?.text || '\uD83D\uDCED \u72B6\u6001\u672A\u77E5\u3002' };
    }

    // Answer routing: multi-letter (multi-select) or single
    const isMultiLetter = /^[A-Ea-e]{2,8}$/.test(trimmed);
    if (isMultiLetter) {
      // Pass as single answer \u2014 engine handles multi-select normalization
      const result = runMockExamEngine(config, ['answer', trimmed.toUpperCase()]);
      const r = parseJson<{ status: string; text: string; index?: number; total?: number; error?: string }>(result.stdout);
      if (r?.status === 'error') {
        return { handled: true, reply: `\u26A0\uFE0F ${r.error}` };
      }
      if (r?.status === 'done') {
        return { handled: true, reply: r.text };
      }
      return { handled: true, reply: r?.text || '\u26A0\uFE0F \u5F15\u64CE\u65E0\u8FD4\u56DE\u3002' };
    }
    if (ANSWER_RE.test(trimmed)) {
      const result = runMockExamEngine(config, ['answer', trimmed.toUpperCase()]);
      const r = parseJson<{ status: string; text: string }>(result.stdout);
      if (r?.status === 'done') {
        return { handled: true, reply: r.text };
      }
      return { handled: true, reply: r?.text || '\u26A0\uFE0F \u5F15\u64CE\u65E0\u8FD4\u56DE\u3002' };
    }

    // Block everything else during exam
    return {
      handled: true,
      reply: `\uD83D\uDCCC \u6A21\u8003\u8FDB\u884C\u4E2D\uFF08\u7B2C ${(engState.current_index || 0) + 1} \u9898\uFF09\n\uD83D\uDCAC \u8BF7\u8F93\u5165 A/B/C/D \u4F5C\u7B54\uFF0C\u6216\u300C\u6682\u505C\u300D\u300C\u653E\u5F03\u6A21\u8003\u300D\u3002`,
    };
  }

  // \u2500\u2500 \u65E7\u7248 mock_exam_state.json pause-lock\uFF08\u517C\u5BB9\uFF09\u2500\u2500
  const mockState = readMockExamState(config);
  if (mockState?.status === 'paused') {
    const RESUME_TRIGGERS = /^(\u7EE7\u7EED\u6A21\u8003|\u7EE7\u7EED\u8003\u8BD5|\u63A5\u7740\u505A|\u7EE7\u7EED)$/;
    const ABANDON_TRIGGERS = /^(\u653E\u5F03\u6A21\u8003|\u4E0D\u505A\u4E86|\u53D6\u6D88\u6A21\u8003)$/;
    if (RESUME_TRIGGERS.test(trimmed) || ABANDON_TRIGGERS.test(trimmed)) {
      return { handled: false };
    }
    const used = mockState.elapsed_seconds || 0;
    const mins = Math.floor(used / 60);
    const secs = used % 60;
    return {
      handled: true,
      reply: `\u23F8\uFE0F  \u6A21\u8003\u5DF2\u6682\u505C\uFF08\u5DF2\u7528 ${mins} \u5206 ${secs} \u79D2\uFF09\n\u5982\u9700\u7EE7\u7EED\u8BF7\u56DE\u590D\u300C\u7EE7\u7EED\u300D\n\u5982\u9700\u653E\u5F03\u8BF7\u56DE\u590D\u300C\u653E\u5F03\u6A21\u8003\u300D`,
    };
  }

  // 章节练习：先发统计图、后补章节名
  const pendingChapter = extractChapterFromCaption(trimmed);
  if (pendingChapter && !shouldRouteScreenshotError(trimmed, false)) {
    const pendingResult = routeChapterPracticePending(pendingChapter, config);
    if (pendingResult.handled) {
      return pendingResult;
    }
  }

  // 解析请求：给我解析一下
  if (
    isExplainRequest(trimmed) &&
    session.athena?.mode !== 'review' &&
    session.athena?.mode !== 'daily' &&
    !hasActiveDailyPractice(config)
  ) {
    logger.info('Athena hard route: batch explain', { text: trimmed });
    return routeBatchExplain(config);
  }

  // 同时给出我的答案+正确答案（截图跟答 / App 单题判卷）
  if (
    isInlineGradeText(trimmed) &&
    session.athena?.mode !== 'review' &&
    session.athena?.mode !== 'daily' &&
    !hasActiveDailyPractice(config)
  ) {
    if (hasPendingPlainQuestion(config)) {
      const plainResult = routePlainQuestionFollowup(trimmed, config);
      if (plainResult.handled) return plainResult;
    }
    logger.info('Athena hard route: inline grade', { text: trimmed });
    return routeBatchPractice(config, trimmed);
  }

  // 纯题干截图：用户补充「我选 X」（不与每日一练/复习抢答）
  if (
    hasPendingPlainQuestion(config) &&
    session.athena?.mode !== 'review' &&
    session.athena?.mode !== 'daily' &&
    !hasActiveDailyPractice(config) &&
    isPlainFollowupText(trimmed)
  ) {
    return routePlainQuestionFollowup(trimmed, config);
  }

  // 重做/再刷已完成日期：再刷30、重做7月30
  const redoPrefix = trimmed.match(REDO_DAILY_PREFIX);
  const redoSuffix = trimmed.match(REDO_DAILY_SUFFIX);
  const redoText = redoPrefix?.[1]?.trim() || redoSuffix?.[1]?.trim();
  if (redoText) {
    logger.info('Athena hard route: redo daily practice', { text: trimmed, redoText });
    return resolveAndStartDaily(config, redoText, true);
  }

  // ── 帮助/菜单/问候（硬路由，不经 Claude）──
  if (/^(帮助|菜单|功能|怎么用|hello|hi|你好)$/i.test(trimmed)) {
    logger.info('Athena hard route: help menu', { text: trimmed });
    const menu = [
      '🦉 PMP Athena 功能菜单',
      '',
      '📝 刷题：每日一练 | 随机每日一练 | X月X日每日一练答案：XXX',
      '📊 模考：开始模考 | 随机模考 | 模考清单',
      '❌ 错题：复习错题 | 薄弱点 | 高频错题',
      '📚 学习：X知识点 | 学习计划 | 今日状态 | 分析趋势',
      '🌙 其他：睡前复习 | 倒计时',
      '',
      '💬 直接发送以上任一指令即可',
    ].join('\n');
    return { handled: true, reply: menu };
  }

  // ── 倒计时（硬路由，不经 Claude）──
  if (/^(倒计时|countdown|还有多久|考试还有几天)$/.test(trimmed)) {
    logger.info('Athena hard route: countdown');
    const examDate = new Date('2026-09-12T00:00:00+08:00');
    const now = new Date();
    const diff = examDate.getTime() - now.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return {
      handled: true,
      reply: `📅 距离 2026-09-12 PMP 考试还有 ${days} 天 ${hours} 小时 ${minutes} 分钟`,
    };
  }

  // ── 模考启动（开始模考一/二/三 + 随机模考，硬路由，不经 Claude）──
  const startMockMatch = trimmed.match(/^开始模考([一二三四1234])$/);
  const isRandomMock = /^随机模考$/.test(trimmed);
  if (startMockMatch || isRandomMock) {
    let paper = 'random';
    if (startMockMatch) {
      const d = startMockMatch[1];
      paper = (d === '一' || d === '1') ? 'one'
        : (d === '二' || d === '2') ? 'two'
        : (d === '三' || d === '3') ? 'three'
        : 'four';
    }
    logger.info('Athena hard route: start mock exam', { paper });
    const result = runMockExamEngine(config, ['start', '--paper', paper]);
    const r = parseJson<{ status: string; text: string; error?: string }>(result.stdout);
    if (r?.status === 'error') {
      return { handled: true, reply: `⚠️ ${r.error || '启动模考失败'}` };
    }
    if (r?.status === 'question') {
      const hint = '📝 模考已启动（共 175 题）。逐题作答，输入 A/B/C/D 即可。\n   · 回复「暂停」随时暂停\n   · 回复「放弃模考」退出\n\n';
      return { handled: true, reply: hint + r.text };
    }
    return { handled: true, reply: result.stdout || '⚠️ 启动模考无返回。' };
  }

  // ── 模考入口菜单（裸「模考」/「开始模考」硬路由，不经 Claude）──
  if (/^模考$/.test(trimmed) || /^开始模考$/.test(trimmed)) {
    logger.info('Athena hard route: mock exam menu', { text: trimmed });
    const menu = [
      '📋 模考模式',
      '',
      '📝 指定试卷：',
      '  发送「开始模考一」→ 考前冲刺卷1（175题）',
      '  发送「开始模考二」→ 考前冲刺卷2（175题）',
      '  发送「开始模考三」→ 考前冲刺卷3（175题）',
      '  发送「开始模考四」→ 模考卷二（175题）',
      '',
      '🎲 发送「随机模考」→ 全量题库随机 175 题',
      '📊 发送「模考清单」→ 查看完成进度',
      '',
      '💡 请输入完整指令（如「开始模考一」），不要只发数字。',
    ].join('\n');
    return { handled: true, reply: menu };
  }

  // 模考清单 / 模考看板 / 模考进度
  if (/^(模考清单|模考看板|还有哪几套模考|模考进度)$/.test(trimmed)) {
    logger.info('Athena hard route: mock exam kanban', { text: trimmed });
    const { ok, stdout, stderr } = runPythonScript(config, 'mock_exam_kanban.py', ['kanban']);
    if (!ok) {
      logger.error('mock exam kanban failed', { stderr });
      return { handled: true, reply: '⚠️ 模考看板生成失败，请稍后重试。' };
    }
    return { handled: true, reply: stdout };
  }

  // 录入成绩 <模考名> <分数>
  const recordScoreMatch = trimmed.match(/^录入成绩\s+(.+?)\s+(\d{1,3})$/);
  if (recordScoreMatch) {
    const examName = recordScoreMatch[1].trim();
    const score = parseInt(recordScoreMatch[2], 10);
    logger.info('Athena hard route: record mock exam score', { examName, score });
    const { ok, stdout, stderr } = runPythonScript(config, 'mock_exam_kanban.py', [
      'record', examName, String(score),
    ]);
    if (!ok) {
      logger.error('record score failed', { stderr });
      return { handled: true, reply: '⚠️ 成绩录入失败，请稍后重试。' };
    }
    try {
      const data = JSON.parse(stdout) as { status: string; text: string };
      return { handled: true, reply: data.text || stdout };
    } catch {
      return { handled: true, reply: stdout || '⚠️ 成绩录入异常' };
    }
  }

  // 月度 / 备考刷题汇总
  if (isPracticeSummaryQuery(trimmed)) {
    logger.info('Athena hard route: practice summary', { text: trimmed });
    return runPracticeSummary(config, trimmed);
  }

  // ═══════════════════════════════════════════════════════════════
  // 错题复习模式：总闸门 — 所有用户输入优先在复习流内处理
  // 只有「退出复习」「结束」「回到主菜单」「停止」等明确指令才退出
  // ═══════════════════════════════════════════════════════════════
  if (session.athena?.mode === 'review' && session.athena.currentErrorId != null) {
    const rid = session.athena.currentErrorId;
    const prevCorrect = session.athena.reviewCorrect ?? 0;
    const prevTotal = session.athena.reviewTotal ?? 0;
    const isHf = session.athena.isHighFrequency ?? false;

    // ── 退出复习 ──
    if (/^(退出复习|结束复习|返回主菜单|停止|退出|结束)$/.test(trimmed)) {
      logger.info('Athena hard route: exit review', { errorId: rid });
      const summary = `📋 本次复习小结：正确 ${prevCorrect}/${prevTotal}`;
      return { handled: true, reply: `👋 已退出复习。${prevTotal > 0 ? summary : ''}`, sessionPatch: { athena: undefined } };
    }

    // ── 跳过（支持 "跳过"、"跳过。"、"跳过！"）──
    if (/^跳过[。！!]?$/.test(trimmed) || trimmed === '/skip') {
      logger.info('Athena hard route: review skip', { errorId: rid });
      const { ok, stdout, stderr } = runStudyAdvisor(config, ['review-skip', String(rid), '--json']);
      if (!ok) {
        logger.error('review-skip failed', { stderr });
        return { handled: true, reply: '⚠️ 跳过失败，请重试。' };
      }
      const data = parseJson<{ status: string; text: string; next_error_id: number | null; done?: boolean; is_knowledge_review?: boolean }>(stdout);
      if (!data) return { handled: true, reply: stdout || '⚠️ 无法解析结果' };
      if (data.done || data.next_error_id == null) {
        const summary = `\n\n📋 复习小结：正确 ${prevCorrect}/${prevTotal}`;
        return { handled: true, reply: data.text + summary, sessionPatch: { athena: undefined } };
      }
      return {
        handled: true, reply: data.text,
        sessionPatch: {
          athena: { mode: 'review', currentErrorId: data.next_error_id, reviewCorrect: prevCorrect, reviewTotal: prevTotal, isHighFrequency: false, isKnowledgeReview: data.is_knowledge_review ?? false },
        },
      };
    }

    // ── 补录选项（补录 #N）──
    const supplementMatch = trimmed.match(/^补录\s*#?(\d+)/);
    if (supplementMatch) {
      const targetId = parseInt(supplementMatch[1], 10);
      logger.info('Athena hard route: supplement options', { errorId: targetId });
      return {
        handled: true,
        reply: `📝 请发送以下格式补录 #${targetId} 的选项：\n\n第1行: 题干（如已有则留空或确认）\n后续行:\nA. 选项A\nB. 选项B\nC. 选项C\nD. 选项D\n\n或直接发送完整题干+选项文本。`,
        sessionPatch: { athena: { mode: 'review', currentErrorId: rid, reviewCorrect: prevCorrect, reviewTotal: prevTotal, isHighFrequency: isHf } },
      };
    }

    // ── 已掌握 / 未掌握（知识回顾模式）──
    if (/^(已掌握|未掌握)[。！!]?$/.test(trimmed)) {
      logger.info('Athena hard route: knowledge review answer', { errorId: rid, answer: trimmed });
      return gradeReviewAnswer(config, session, trimmed.replace(/[。！!]$/, ''));
    }

    // ── 兜底：所有其他输入 → 尝试判卷（A/B/C/D 或连续字母）──
    // 注意："绕过/补录/跳过"已在上面被拦截，"退出复习"类也已被拦截
    // 不要加任何中间判断——它们会导致 match 失败后穿透到知识查询路由
    if (ANSWER_PATTERN.test(trimmed) || MULTI_ANSWER_PATTERN.test(trimmed)) {
      return gradeReviewAnswer(config, session, trimmed);
    }

    // 不是答案也不是指令 → 提示用户当前在复习中
    return {
      handled: true,
      reply: `📌 当前在复习错题模式中（#${rid}）。\n💬 请输入 A/B/C/D 作答，或回复「跳过」「已掌握」「未掌握」「退出复习」。`,
      sessionPatch: { athena: { mode: 'review', currentErrorId: rid, reviewCorrect: prevCorrect, reviewTotal: prevTotal, isHighFrequency: isHf } },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 变式巩固模式：总闸门（同样拦截所有输入，防穿透）
  // ═══════════════════════════════════════════════════════════════
  if (session.athena?.mode === 'variant_review' && session.athena.variantIds != null) {
    if (/^(退出复习|结束复习|返回主菜单|停止|退出|结束)$/.test(trimmed)) {
      const prevCorrect = session.athena.reviewCorrect ?? 0;
      const prevTotal = session.athena.reviewTotal ?? 0;
      logger.info('Athena hard route: exit variant review', { hfErrorId: session.athena.highFrequencyErrorId });
      const summary = `📋 本次复习小结：正确 ${prevCorrect}/${prevTotal}`;
      return { handled: true, reply: `👋 已退出变式巩固。${prevTotal > 0 ? summary : ''}`, sessionPatch: { athena: undefined } };
    }
    if (ANSWER_PATTERN.test(trimmed) || MULTI_ANSWER_PATTERN.test(trimmed)) {
      return gradeVariantAnswer(config, session, trimmed);
    }
    // 变式模式下所有非答案输入 → 提示
    return {
      handled: true,
      reply: `📌 当前在变式巩固模式中（高频错题巩固）。\n💬 请输入 A/B/C/D 作答，或回复「退出复习」离开。`,
      sessionPatch: { athena: session.athena },
    };
  }

  // ── 启动复习（必须在 review 模式闸门之后，否则永远进不去）──
  if (REVIEW_TRIGGERS.some((re) => re.test(trimmed))) {
    logger.info('Athena hard route: start review', { text: trimmed });
    return startReview(config);
  }

  // ── 错题复习：单字母判卷（已移到 review 模式闸门内，此处仅保底）──
  if (
    session.athena?.mode === 'review' &&
    session.athena.currentErrorId != null &&
    (ANSWER_PATTERN.test(trimmed) || MULTI_ANSWER_PATTERN.test(trimmed))
  ) {
    return gradeReviewAnswer(config, session, trimmed);
  }

  // ═══════════════════════════════════════════════════════
  // 以下路由在 review / variant_review 模式下全部跳过
  // ═══════════════════════════════════════════════════════

  // App 批量题补录标准答案
  if (BATCH_UPDATE_TRIGGER.test(trimmed) && /正确答案/i.test(trimmed)) {
    logger.info('Athena hard route: batch update', { text: trimmed.slice(0, 80) });
    return routeBatchUpdateText(config, trimmed);
  }

  // App 批量题补录标准答案：已有 pending 题目 + 文本含「答案：X」
  // 绕过 daily/active 限制，让 Python batch_ingest 处理（parse_breakfast_questions → _batch_ingest_with_solutions）
  if (
    (isBreakfastPracticeInput(trimmed) || isBatchPracticeInput(trimmed)) &&
    hasPendingBatchQuestions(config) &&
    /答案[：:\s]*[A-E]/i.test(trimmed)
  ) {
    logger.info('Athena hard route: batch practice (pending answer fill, bypass daily check)', { text: trimmed.slice(0, 80) });
    return routeBatchPractice(config, trimmed);
  }

  // App 批量题：早餐题 / 多题+答案串（非每日一练进行中时优先）
  if (
    (isBreakfastPracticeInput(trimmed) || isBatchPracticeInput(trimmed)) &&
    session.athena?.mode !== 'daily' &&
    !hasActiveDailyPractice(config)
  ) {
    logger.info('Athena hard route: batch practice ingest', { text: trimmed.slice(0, 80) });
    return routeBatchPractice(config, trimmed);
  }

  // App 跟答：我的答案是A / 我选B（已有 pending 题目）
  if (
    isBatchAnswerFollowup(trimmed, config) &&
    session.athena?.mode !== 'daily' &&
    !hasActiveDailyPractice(config)
  ) {
    logger.info('Athena hard route: batch answer followup', { text: trimmed });
    return routeBatchPractice(config, trimmed);
  }

  // 每日一练判卷：纯答案、嵌入答案（我的答案是：ACCAB）、或进行中的练习
  const dailyAnswer = resolveDailyAnswer(trimmed);
  if (dailyAnswer) {
    if (session.athena?.mode === 'daily' || hasActiveDailyPractice(config)) {
      return gradeDailyAnswer(config, session, dailyAnswer);
    }
    if (/我的答案|我选/.test(trimmed)) {
      logger.info('Athena hard route: app answer without daily session', { dailyAnswer });
      return routeBatchPractice(config, trimmed);
    }
    logger.info('Athena: embedded daily answer but no active session', { dailyAnswer });
    const hint = isAppQuestionFormat(trimmed)
      ? ''
      : '\n💡 App 刷题：先发题干+选项，再回「我的答案是 A」；或一并发「我的答案是：A」。';
    return {
      handled: true,
      reply:
        `📌 已识别答案 ${dailyAnswer}，但当前没有进行中的每日一练。` +
        hint +
        '\n请先发送「做7月31日每日一练」或「每日一练」开始，再提交答案。',
    };
  }

  // 日期选择模式（菜单后回复日期）
  if (session.athena?.mode === 'daily_select' && looksLikeDailyDate(trimmed)) {
    return resolveAndStartDaily(config, trimmed);
  }

  // 动态知识查询 — 复习/变式模式中跳过，防止"跳过"等指令被误识别
  if (
    session.athena?.mode !== 'review' &&
    session.athena?.mode !== 'variant_review' &&
    (
    /^(详细|展开|套路|情景|关联)\s*/.test(trimmed) ||
    (/^[\u4e00-\u9fffA-Za-z/]{2,16}$/.test(trimmed) &&
      !REVIEW_TRIGGERS.some((re) => re.test(trimmed)) &&
      !WEAKNESS_TRIGGERS.some((re) => re.test(trimmed)) &&
      !DAILY_TRIGGERS.some((re) => re.test(trimmed)) &&
      !MOCK_EXAM_TRIGGERS.some((re) => re.test(trimmed)))
    )
  ) {
    const dk = runDynamicKnowledge(config, trimmed);
    if (dk.handled) {
      logger.info('Athena hard route: dynamic knowledge', { text: trimmed });
      return dk;
    }
  }

  // 知识领域知识点速查（ChromaDB）
  if (isKnowledgeSummaryQuery(trimmed)) {
    logger.info('Athena hard route: knowledge retriever', { text: trimmed });
    return runKnowledgeSummary(config, trimmed);
  }

  // 薄弱点分析
  if (WEAKNESS_TRIGGERS.some((re) => re.test(trimmed))) {
    return runWeakness(config);
  }

  // 高频错题（总结+解答+口诀）
  if (FREQUENT_ERROR_TRIGGERS.some((re) => re.test(trimmed))) {
    logger.info('Athena hard route: frequent errors', { text: trimmed });
    return runFrequentErrors(config);
  }

  // 随机每日一练
  if (RANDOM_DAILY_TRIGGERS.some((re) => re.test(trimmed))) {
    return startDailyRandom(config);
  }

  // 做 X月X日每日一练
  const dateStart = trimmed.match(DAILY_DATE_START);
  if (dateStart) {
    const iso = `2026-${dateStart[1].padStart(2, '0')}-${dateStart[2].padStart(2, '0')}`;
    return startDailyByDate(config, iso);
  }

  // X月X日每日一练 / 30号每日一练（无需「做」前缀）
  if (DATE_WITH_DAILY.test(trimmed) || DAY_NUM_DAILY.test(trimmed)) {
    return resolveAndStartDaily(config, trimmed);
  }

  // 单独发日期：7月30 / 7-30 / 730 / 30 等
  if (
    STANDALONE_MD.test(trimmed) ||
    STANDALONE_SEP.test(trimmed) ||
    STANDALONE_COMPACT.test(trimmed)
  ) {
    return resolveAndStartDaily(config, trimmed);
  }

  // 每日一练菜单
  if (DAILY_TRIGGERS.some((re) => re.test(trimmed))) {
    logger.info('Athena hard route: daily practice menu', { text: trimmed });
    return startDailyMenu(config);
  }

  return { handled: false };
}

/** 是否应走截图录入错题硬路由（配文触发 或 图中 OCR 含作答结果） */
export function shouldRouteScreenshotError(userText: string, hasImage: boolean): boolean {
  if (!hasImage) return false;
  const t = userText.trim().replace(/[\u200b\uFEFF]/g, '');
  if (!t) return false;
  return SCREENSHOT_ERROR_TRIGGERS.some((re) => re.test(t));
}

/** 从配文提取章节/知识领域名 */
export function extractChapterFromCaption(userText: string): string | null {
  const t = userText.trim().replace(/[\u200b\uFEFF]/g, '');
  if (!t) return null;
  const sorted = Object.entries(CHAPTER_AREA_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, area] of sorted) {
    if (t.includes(alias)) return area;
  }
  for (const area of KNOWLEDGE_AREA_NAMES) {
    if (t.includes(area)) return area;
  }
  return null;
}

/** 发章节练习统计截图 + 指定章节名 */
export function shouldRouteChapterPractice(userText: string, hasImage: boolean): boolean {
  if (!hasImage) return false;
  if (shouldRouteScreenshotError(userText, true)) return false;
  const chapter = extractChapterFromCaption(userText);
  if (!chapter) return false;
  const t = userText.trim();
  if (CHAPTER_PRACTICE_TRIGGERS.some((re) => re.test(t))) return true;
  // 配文仅含章节名或很短说明（如「范围管理」）
  const stripped = t.replace(/章节练习|练习统计|录入|截图/g, '').trim();
  return stripped.length <= 20;
}

/** 保存章节练习 pending（缺章节名） */
export function saveChapterPracticePending(
  imagePath: string,
  config: Config,
): void {
  runPythonScript(config, 'chapter_practice_recorder.py', [
    'save-pending', '--image', imagePath, '--json',
  ]);
}

/** 用 pending 截图 + 用户补充的章节名入库 */
export function routeChapterPracticePending(
  chapter: string,
  config: Config,
): AthenaRouteResult {
  const { ok, stdout } = runPythonScript(config, 'chapter_practice_recorder.py', [
    'record-pending', '--chapter', chapter, '--json',
  ]);
  if (!ok) {
    return { handled: true, reply: '⚠️ 章节练习录入失败，请重试。' };
  }
  const data = parseJson<{ success?: boolean; message?: string; error?: string }>(stdout);
  if (data?.success && data.message) {
    return { handled: true, reply: data.message };
  }
  if (data?.error === 'no_pending') {
    return { handled: false };
  }
  return { handled: true, reply: data?.error || '⚠️ 录入未完成' };
}

/** 章节练习统计截图 → exam_records.json */
export function preflightChapterPractice(
  imagePath: string,
  config: Config,
): { isStats: boolean; chapter?: string } | null {
  const { ok, stdout } = runPythonScript(config, 'chapter_practice_recorder.py', [
    'preflight',
    '--image', imagePath,
    '--json',
  ]);
  if (!ok) return null;
  const data = parseJson<{ is_stats?: boolean; chapter?: string | null }>(stdout);
  if (!data) return null;
  return {
    isStats: !!data.is_stats,
    chapter: data.chapter || undefined,
  };
}

/** 章节练习统计截图 → exam_records.json */
export function routeChapterPractice(
  imagePath: string,
  config: Config,
  chapter: string,
  userCaption?: string,
): AthenaRouteResult {
  logger.info('Athena hard route: chapter practice record', { imagePath, chapter });

  const args = [
    'record',
    '--image', imagePath,
    '--chapter', chapter,
    '--json',
  ];
  const cap = (userCaption || '').trim();
  if (cap) args.splice(args.length - 1, 0, '--caption', cap);

  const { ok, stdout, stderr } = runPythonScript(config, 'chapter_practice_recorder.py', args);

  if (!ok) {
    logger.error('chapter practice record failed', { stderr, chapter });
    return {
      handled: true,
      reply: '⚠️ 章节练习录入失败，请稍后重试。',
    };
  }

  const data = parseJson<{
    success?: boolean;
    message?: string;
    error?: string;
    hint?: string;
    ocr_preview?: string;
  }>(stdout);

  if (data?.success && data.message) {
    return { handled: true, reply: data.message };
  }

  const lines = ['⚠️ 章节练习录入未完成。'];
  if (data?.error) lines.push(data.error);
  if (data?.hint) lines.push(data.hint);
  if (data?.ocr_preview) lines.push(`OCR 预览: ${data.ocr_preview.slice(0, 80)}…`);
  return { handled: true, reply: lines.join('\n') };
}

interface PreflightScreenshotResult {
  screenshotType: 'error_result' | 'plain_question' | 'unknown';
  formattedQuestion?: string;
}

interface PlainFollowupResult {
  status: string;
  error_log_id?: number;
  my_answer?: string;
  correct_answer?: string;
  knowledge_area?: string;
  question_preview?: string;
  need?: string;
  error_is_new?: boolean;
  bank_id?: number;
  explain_text?: string;
}

const PLAIN_MY_ANSWER_TRIGGERS = [
  /我[的]?选/,
  /我的答案/,
  /选了\s*[A-Ea-e]/,
  /选错/,
  /[A-Ea-e]\s*错了/,
  /正确(?:答案)?[是为：:\s]*[A-Ea-e]/,
];

/** OCR 预检：区分「作答结果截图」vs「纯题干截图」 */
export function preflightScreenshot(
  imagePath: string,
  config: Config,
): PreflightScreenshotResult | null {
  const { ok, stdout } = runPythonScript(config, 'image_processor.py', [
    imagePath,
    '--json',
    '--no-auto-log',
  ]);

  if (!ok) return null;

  const raw = parseJson<{
    answer_validation?: {
      screenshot_type?: string;
      formatted_question?: string;
    };
  }>(stdout);

  const v = raw?.answer_validation;
  const t = v?.screenshot_type || 'unknown';
  const screenshotType =
    t === 'error_result' || t === 'plain_question' ? t : 'unknown';

  return {
    screenshotType,
    formattedQuestion: v?.formatted_question,
  };
}

function parsePlainMyAnswerHint(text: string): string | undefined {
  const t = text.trim().replace(/[\u200b\uFEFF]/g, '');
  if (!t) return undefined;
  const patterns = [
    /我[的]?选(?:了|错)?[是为：:\s]*([A-Ea-e])/i,
    /我的答案[是为：:\s]*([A-Ea-e])/i,
    /^([A-Ea-e])$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1].toUpperCase();
  }
  return undefined;
}

function isPlainFollowupText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (PLAIN_MY_ANSWER_TRIGGERS.some((re) => re.test(t))) return true;
  return ANSWER_PATTERN.test(t);
}

function formatPlainFollowupReply(data: PlainFollowupResult): string {
  if (data.explain_text) return data.explain_text;
  if (data.status === 'logged' && data.error_log_id) {
    const q = data.question_preview || '（题干）';
    const suffix = q.length >= 60 ? '…' : '';
    return [
      `✅ 已录入错题 #${data.error_log_id} [${data.knowledge_area || '综合'}]`,
      `📝 题干: ${q}${suffix}`,
      `❌ 你的答案: ${data.my_answer || '?'} → ✅ 正确答案: ${data.correct_answer || '?'}`,
      '💾 已同步 question_bank.json + error_review_state.json',
    ].join('\n');
  }
  if (data.status === 'correct') {
    return `✅ 你选的 ${data.my_answer} 正确，无需录入错题。`;
  }
  if (data.status === 'waiting' && data.need === 'correct_answer') {
    return `📌 已记录你的答案 ${data.my_answer}，等我给出解析后会自动入库（若答错）。`;
  }
  if (data.status === 'no_pending') {
    return '';
  }
  return '';
}

/** 是否存在待处理的纯题干截图 */
export function hasPendingPlainQuestion(config: Config): boolean {
  const { ok, stdout } = runPythonScript(config, 'plain_question_store.py', [
    'status',
    '--json',
  ]);
  if (!ok) return false;
  const data = parseJson<{ status?: string }>(stdout);
  return data?.status === 'pending';
}

/** 纯题干截图 OCR 后写入 pending（可选从配文提取 my_answer） */
export function savePendingPlainFromImage(
  imagePath: string,
  config: Config,
  userCaption?: string,
): { saved: boolean; screenshotType?: string } {
  const myHint = parsePlainMyAnswerHint(userCaption || '');
  const args = ['save-from-image', imagePath];
  if (myHint) args.push('--my-answer', myHint);
  args.push('--json');

  const { ok, stdout } = runPythonScript(config, 'plain_question_store.py', args);
  if (!ok) return { saved: false };

  const data = parseJson<{ status?: string; screenshot_type?: string }>(stdout);
  if (data?.status === 'saved') return { saved: true, screenshotType: 'plain_question' };
  if (data?.status === 'not_plain_question') {
    return { saved: false, screenshotType: data.screenshot_type || 'unknown' };
  }
  return { saved: false };
}

/** 用户补充「我选 X」后尝试入库 */
export function routePlainQuestionFollowup(
  text: string,
  config: Config,
): AthenaRouteResult {
  logger.info('Athena hard route: plain question followup', { text });

  const { ok, stdout, stderr } = runPythonScript(config, 'plain_question_store.py', [
    'followup',
    '--text',
    text,
    '--json',
  ]);

  if (!ok) {
    logger.error('plain question followup failed', { stderr });
    return { handled: true, reply: '⚠️ 处理失败，请重试。' };
  }

  const data = parseJson<PlainFollowupResult>(stdout);
  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析结果' };
  }

  if (data.status === 'no_pending') {
    return { handled: false };
  }

  const reply = formatPlainFollowupReply(data);
  if (data.status === 'waiting') {
    return { handled: !!reply, reply: reply || undefined };
  }

  return { handled: true, reply: reply || '✅ 已处理。' };
}

/** Claude 给出解析后提取标准答案，若用户已报选错则自动入库 */
export function applyPlainQuestionAfterParse(
  claudeText: string,
  config: Config,
): string | null {
  const { ok, stdout } = runPythonScript(config, 'plain_question_store.py', [
    'apply-parse',
    '--text',
    claudeText,
    '--json',
  ]);
  if (!ok) return null;

  const data = parseJson<PlainFollowupResult>(stdout);
  if (!data || data.status === 'no_pending' || data.status === 'no_answer_in_text') {
    return null;
  }

  const reply = formatPlainFollowupReply(data);
  return reply || null;
}

function formatScreenshotLogReply(data: ScreenshotLogResult): string {
  const ext = data.extracted || {};
  const qPreview = ext.question
    ? ext.question.length > 60
      ? `${ext.question.slice(0, 60)}…`
      : ext.question
    : '（题干未完整识别）';

  if (data.is_correct === true) {
    return `✅ 识别为答对，无需录入错题。\n📝 ${qPreview}`;
  }

  if (data.is_correct === false && data.error_log_record_id) {
    return [
      `✅ 已录入错题 #${data.error_log_record_id} [${ext.knowledge_area || '未分类'}]`,
      `📝 题干: ${qPreview}`,
      `❌ 你的答案: ${ext.my_answer || '?'} → ✅ 正确答案: ${ext.correct_answer || '?'}`,
      `💾 已同步 question_bank.json + error_review_state.json`,
    ].join('\n');
  }

  if (data.is_correct === false && ext.correct_answer && ext.my_answer && data.human_confirm) {
    return [
      '⚠️ 答案识别置信度不足，未自动入库。',
      `📝 ${qPreview}`,
      `识别结果: 你的答案 ${ext.my_answer} → 正确答案 ${ext.correct_answer}`,
      '请确认截图底部「正确答案/我的答案」是否清晰，或回复：我的答案 X，正确答案 Y',
    ].join('\n');
  }

  if (data.is_correct === false && ext.correct_answer) {
    return [
      '⚠️ 识别为答错，但自动入库未完全成功。',
      `📝 ${qPreview}`,
      `❌ 你的答案: ${ext.my_answer || '未识别'} → ✅ 正确答案: ${ext.correct_answer}`,
      '请补充：我的答案 X，正确答案 Y',
    ].join('\n');
  }

  return [
    '⚠️ 无法从截图自动识别错题信息。',
    data.error ? `原因: ${data.error}` : '请确认截图包含题干、选项和「正确答案/我的答案」区域。',
    '或手动发送：我的答案 X，正确答案 Y',
  ].join('\n');
}

/** 截图 OCR + 自动录入错题（硬路由，不经过 Claude） */
export function routeScreenshotError(
  imagePath: string,
  config: Config,
  userCaption?: string,
): AthenaRouteResult {
  logger.info('Athena hard route: screenshot error log', { imagePath, userCaption });

  const args = [imagePath, '--json'];
  const caption = (userCaption || '').trim().replace(/[\u200b\uFEFF]/g, '');
  if (caption) {
    args.push('--caption', caption);
  }

  const { ok, stdout, stderr } = runPythonScript(config, 'image_processor.py', args);

  if (!ok) {
    logger.error('screenshot error log failed', { stderr, imagePath });
    return {
      handled: true,
      reply: '⚠️ 截图识别失败，请稍后重试或手动发送「我的答案 X，正确答案 Y」。',
    };
  }

  const raw = parseJson<{
    success?: boolean;
    error?: string;
    answer_validation?: ScreenshotLogResult & {
      extracted?: ScreenshotLogResult['extracted'];
    };
  }>(stdout);

  if (!raw?.success) {
    return {
      handled: true,
      reply: `⚠️ 截图处理失败：${raw?.error || stderr || '未知错误'}`,
    };
  }

  const v = raw.answer_validation;
  if (!v) {
    return {
      handled: true,
      reply: '⚠️ 未能从截图识别题目，请换一张更清晰的截图。',
    };
  }

  const data: ScreenshotLogResult = {
    success: true,
    is_correct: v.is_correct,
    auto_action: v.auto_action,
    human_confirm: v.human_confirm,
    needs_user_confirm: v.needs_user_confirm,
    error_log_record_id: v.error_log_record_id,
    question_bank_record_id: v.question_bank_record_id,
    extracted: v.extracted,
  };

  return { handled: true, reply: formatScreenshotLogReply(data) };
}

/** 多图 OCR + 语义合并 + 关联入库 */
export function routeMultiScreenshotError(
  imagePaths: string[],
  config: Config,
  userCaption?: string,
): AthenaRouteResult {
  logger.info('Athena hard route: multi screenshot error log', {
    count: imagePaths.length,
    userCaption,
  });

  const args = [...imagePaths];
  const caption = (userCaption || '').trim().replace(/[\u200b\uFEFF]/g, '');
  if (caption) {
    args.push('--caption', caption);
  }
  args.push('--json');

  const { ok, stdout, stderr } = runPythonScript(
    config,
    'multi_screenshot_merge.py',
    args,
  );

  if (!ok) {
    logger.error('multi screenshot merge failed', { stderr, count: imagePaths.length });
    return {
      handled: true,
      reply: '⚠️ 多图识别失败，请稍后重试，或分条发送「我的答案 X，正确答案 Y」。',
    };
  }

  const data = parseJson<{
    status?: string;
    message?: string;
    error?: string;
  }>(stdout);

  if (!data) {
    return { handled: true, reply: stdout || '⚠️ 无法解析多图处理结果' };
  }

  if (data.message) {
    return { handled: true, reply: data.message };
  }

  return {
    handled: true,
    reply: data.error || '⚠️ 多图处理未完成，请确认题目与解析是否对应同一题。',
  };
}
