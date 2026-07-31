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
}

interface GradeReviewResult {
  status: string;
  correct: boolean;
  error_id: number;
  next_error_id: number | null;
  done?: boolean;
  text: string;
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
  /^复习错题$/,
  /^今日复习错题$/,
  /^今天错题复习$/,
  /^今日错题复习$/,
  /^今天复习什么$/,
  /^\/review$/,
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
const MULTI_ANSWER_PATTERN = /^[A-Ea-e]{2,5}$/;
const DAILY_ANSWER_PATTERN = /^[A-Ea-e]{1,5}$/;

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
  if (REVIEW_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (WEAKNESS_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (FREQUENT_ERROR_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (DAILY_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (RANDOM_DAILY_TRIGGERS.some((re) => re.test(trimmed))) return true;
  if (REDO_DAILY_PREFIX.test(trimmed) || REDO_DAILY_SUFFIX.test(trimmed)) return true;
  if (isPracticeSummaryQuery(trimmed)) return true;
  if (looksLikeDailyDate(trimmed)) return true;
  return false;
}

function runPythonScript(
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
    timeout: 120_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function runStudyAdvisor(config: Config, args: string[]) {
  return runPythonScript(config, 'study_advisor.py', args);
}

function runDailyPractice(config: Config, args: string[]) {
  return runPythonScript(config, 'daily_practice.py', args);
}

function runPracticeSummary(config: Config, text: string): AthenaRouteResult {
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
      },
    },
  };
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

  // 章节练习：先发统计图、后补章节名
  const pendingChapter = extractChapterFromCaption(trimmed);
  if (pendingChapter && !shouldRouteScreenshotError(trimmed, false)) {
    const pendingResult = routeChapterPracticePending(pendingChapter, config);
    if (pendingResult.handled) {
      return pendingResult;
    }
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

  // 月度 / 备考刷题汇总
  if (isPracticeSummaryQuery(trimmed)) {
    logger.info('Athena hard route: practice summary', { text: trimmed });
    return runPracticeSummary(config, trimmed);
  }

  // 每日一练判卷：会话态 daily，或 Python 文件态仍有进行中的练习
  if (ANSWER_PATTERN.test(trimmed) || DAILY_ANSWER_PATTERN.test(trimmed)) {
    if (session.athena?.mode === 'daily' || hasActiveDailyPractice(config)) {
      return gradeDailyAnswer(config, session, trimmed);
    }
  }

  // 复习模式下的单字母判卷
  if (
    session.athena?.mode === 'review' &&
    session.athena.currentErrorId &&
    ANSWER_PATTERN.test(trimmed)
  ) {
    return gradeReviewAnswer(config, session, trimmed);
  }

  // 日期选择模式（菜单后回复日期）
  if (session.athena?.mode === 'daily_select' && looksLikeDailyDate(trimmed)) {
    return resolveAndStartDaily(config, trimmed);
  }

  // 启动复习
  if (REVIEW_TRIGGERS.some((re) => re.test(trimmed))) {
    return startReview(config);
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
