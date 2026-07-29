import { spawn, type ChildProcess, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when an assistant turn ends, with its stop_reason
   *  ('tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | ...).
   *  Use to decide whether the turn's text is interstitial or final answer. */
  onTurnEnd?: (stopReason: string) => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = join(tmpdir(), 'wechat-claude-code');

function saveImageTemp(images: NonNullable<QueryOptions['images']>): string[] {
  mkdirSync(TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.source.media_type.split('/')[1] || 'png';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Image preprocessing (Python bridge)
// ---------------------------------------------------------------------------

const IMAGE_PROCESSOR_SCRIPT = (() => {
  // Try project-local path first, then a few fallbacks
  const candidates = [
    join(process.cwd(), 'pmp_athena', 'image_processor.py'),
    'D:/pmp-athena/pmp_athena/image_processor.py',
  ];
  // Also check env var
  if (process.env.PMP_IMAGE_PROCESSOR) {
    candidates.unshift(process.env.PMP_IMAGE_PROCESSOR);
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];  // best-effort
})();

const PYTHON_BIN = process.env.PYTHON_BIN || (() => {
  try { return loadConfig().pythonBin || 'python'; } catch { return 'python'; }
})();

interface ImagePreprocessResult {
  processedPath: string;
  ocrText: string | null;
  originalPath: string;
  answerValidation?: {
    is_correct: boolean | null;
    confidence: number;
    primary_signal: string;
    auto_action: 'log_error' | 'log_mastered' | 'none';
    extracted?: {
      question?: string;
      my_answer?: string;
      correct_answer?: string;
      knowledge_area?: string;
      explanation?: string;
    };
  };
  error?: string;
}

function preprocessImage(imagePath: string): ImagePreprocessResult | null {
  if (!existsSync(IMAGE_PROCESSOR_SCRIPT)) {
    logger.debug('Image processor script not found, skipping', { path: IMAGE_PROCESSOR_SCRIPT });
    return null;
  }

  try {
    const result = spawnSync(PYTHON_BIN, [
      IMAGE_PROCESSOR_SCRIPT,
      imagePath,
      '--json',
    ], {
      timeout: 60000,      // 60s timeout for OCR
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,  // 1 MB stdout
    });

    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      logger.warn('Image processor failed', { imagePath, stderr: stderr.slice(0, 200) });
      return null;
    }

    const output = JSON.parse(result.stdout);
    if (!output.success) {
      logger.warn('Image processor reported failure', { imagePath, error: output.error });
      return null;
    }

    logger.info('Image preprocessed', {
      original: `${output.original_size?.[0]}x${output.original_size?.[1]} (${(output.original_bytes / 1024).toFixed(0)}KB)`,
      processed: `${output.processed_size?.[0]}x${output.processed_size?.[1]} (${(output.processed_bytes / 1024).toFixed(0)}KB)`,
      hasOcr: !!output.ocr_text,
      ocrLen: output.ocr_text?.length ?? 0,
      hasValidation: !!output.answer_validation,
      isCorrect: output.answer_validation?.is_correct,
    });

    const answerValidation = output.answer_validation ?? undefined;

    return {
      processedPath: output.processed_path,
      ocrText: output.ocr_text || null,
      originalPath: output.original_path,
      answerValidation,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Image preprocessing failed', { imagePath, error: msg });
    return null;
  }
}

function preprocessImages(imagePaths: string[]): {
  finalPaths: string[];
  ocrTexts: string[];
  validationResults: Array<ImagePreprocessResult['answerValidation']>;
  processedPathsToCleanup: string[];
} {
  const finalPaths: string[] = [];
  const ocrTexts: string[] = [];
  const validationResults: Array<ImagePreprocessResult['answerValidation']> = [];
  const processedPathsToCleanup: string[] = [];

  for (const imagePath of imagePaths) {
    const result = preprocessImage(imagePath);
    if (result) {
      finalPaths.push(result.processedPath);
      processedPathsToCleanup.push(result.processedPath);
      if (result.ocrText) {
        ocrTexts.push(result.ocrText);
      }
      if (result.answerValidation) {
        validationResults.push(result.answerValidation);
      }
    } else {
      finalPaths.push(imagePath);
    }
  }

  return { finalPaths, ocrTexts, validationResults, processedPathsToCleanup };
}

// ---------------------------------------------------------------------------
// Stream parser (extracted for testability)
// ---------------------------------------------------------------------------

export interface StreamParserState {
  sessionId: string;
  textParts: string[];
  errorMessage?: string;
  trackingSkill: boolean;
  skillInputAccum: string;
}

export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onTurnEnd?: (stopReason: string) => void;
}

export function handleStreamLine(
  line: string,
  state: StreamParserState,
  callbacks: StreamParserCallbacks,
): void {
  if (!line.trim()) return;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  switch (obj.type) {
    case 'system': {
      if (obj.subtype === 'init' && obj.session_id) {
        state.sessionId = obj.session_id;
      }
      break;
    }
    case 'assistant': {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text ?? '')
          .join('');
        if (text) state.textParts.push(text);
      }
      break;
    }
    case 'stream_event': {
      const evt = obj.event;
      if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        if (evt.content_block.name === 'Skill') {
          state.trackingSkill = true;
          state.skillInputAccum = '';
        }
      } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        const delta: string = evt.delta.text;
        if (delta && callbacks.onText) {
          Promise.resolve(callbacks.onText(delta)).catch(() => {});
        }
      } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && state.trackingSkill) {
        state.skillInputAccum += evt.delta.partial_json ?? '';
        try {
          const parsed = JSON.parse(state.skillInputAccum);
          if (parsed.skill) {
            const msg = `\n正在调用 ${parsed.skill} 技能\n\n`;
            if (callbacks.onText) Promise.resolve(callbacks.onText(msg)).catch(() => {});
            state.trackingSkill = false;
          }
        } catch {
          // JSON not complete yet
        }
      } else if (evt?.type === 'content_block_stop') {
        state.trackingSkill = false;
      } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
        if (callbacks.onTurnEnd) Promise.resolve(callbacks.onTurnEnd(evt.delta.stop_reason)).catch(() => {});
      }
      break;
    }
    case 'result': {
      if (obj.result && typeof obj.result === 'string') {
        const combined = state.textParts.join('');
        if (!combined.includes(obj.result)) {
          state.textParts.push(obj.result);
        }
      }
      if (obj.subtype === 'error' || (obj.errors && obj.errors.length > 0)) {
        const errors = obj.errors ?? [obj.error_message ?? 'Unknown error'];
        state.errorMessage = Array.isArray(errors) ? errors.join('; ') : String(errors);
        logger.error('CLI returned error result', { errors });
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    images,
    onText,
    onTurnEnd,
    abortController,
  } = options;

  logger.info("Starting Claude CLI query", {
    cwd,
    model,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // Build CLI arguments
  const args: string[] = [
    '-p', '-',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  // NOTE: systemPrompt is intentionally NOT passed via --append-system-prompt
  // to avoid hitting the Windows cmd.exe 8191-char command-line limit.
  // Instead, the project's CLAUDE.md (copied from system_prompt.txt) is
  // auto-loaded by Claude CLI from the working directory.

  // Handle images: save to temp files, preprocess, and append paths to prompt
  const tempImagePaths = images?.length ? saveImageTemp(images) : [];
  const processedCleanupPaths: string[] = [];
  let finalImagePaths: string[] = tempImagePaths;
  let fullPrompt = prompt;
  if (tempImagePaths.length > 0) {
    // Preprocess images through Python: compress + OCR + answer validation
    const { finalPaths, ocrTexts, validationResults, processedPathsToCleanup } = preprocessImages(tempImagePaths);
    finalImagePaths = finalPaths;
    processedPathsToCleanup.forEach(p => processedCleanupPaths.push(p));

    // Build the prepended prompt block: OCR text + answer validation verdict
    let prependBlock = '';

    if (ocrTexts.length > 0) {
      prependBlock += '[图片OCR文字]\n' + ocrTexts.join('\n---\n') + '\n[/图片OCR文字]\n\n';
    }

    // Inject answer validation verdict so Claude knows immediately
    for (const v of (validationResults || [])) {
      if (!v) continue;
      prependBlock += '[答题判定]\n';
      if (v.is_correct === true) {
        prependBlock += `状态: ✅ 答对了 (置信度 ${(v.confidence * 100).toFixed(0)}%)\n`;
        prependBlock += `依据: ${v.primary_signal}\n`;
        prependBlock += `操作: 不需要记录错题，告知用户正确即可。\n`;
      } else if (v.is_correct === false) {
        prependBlock += `状态: ❌ 答错了 (置信度 ${(v.confidence * 100).toFixed(0)}%)\n`;
        prependBlock += `依据: ${v.primary_signal}\n`;
        const ext = v.extracted || {};
        if (ext.my_answer && ext.correct_answer) {
          prependBlock += `用户答案: ${ext.my_answer} | 正确答案: ${ext.correct_answer}\n`;
        }
        if (ext.knowledge_area) {
          prependBlock += `知识领域: ${ext.knowledge_area}\n`;
        }
        if (ext.question) {
          prependBlock += `题目: ${ext.question}\n`;
        }
        if (ext.explanation) {
          prependBlock += `解析: ${ext.explanation}\n`;
        }
        prependBlock += '操作: 请先解析这道题，然后自动调用 error_logger 记录错题！命令：\n';
        if (ext.my_answer && ext.correct_answer) {
          prependBlock += `python pmp_athena/error_logger.py add --question "${ext.question || ''}" --my-answer "${ext.my_answer}" --correct-answer "${ext.correct_answer}" --knowledge-area "${ext.knowledge_area || '未分类'}" --explanation "<你的解析>"\n`;
        }
      } else {
        prependBlock += `状态: ⚠️ 无法自动判断对错 (置信度 ${(v.confidence * 100).toFixed(0)}%)\n`;
        prependBlock += `依据: ${v.primary_signal}\n`;
        prependBlock += `操作: 请根据图片内容手动判断对错。如果答错，调用 error_logger 记录。\n`;
      }
      prependBlock += '[/答题判定]\n\n';
    }

    fullPrompt = prependBlock + fullPrompt;

    const imageLines = finalImagePaths.map(p => `\n![image](file://${p})`).join('');
    fullPrompt += imageLines;
  }

  // Accumulators
  let child: ChildProcess | undefined;
  let settled = false;

  const QUERY_TIMEOUT_MS = 60 * 60 * 1000;

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      cleanupTempFiles(tempImagePaths);
      cleanupTempFiles(processedCleanupPaths);
      resolve(result);
    };

    // On Windows, 'claude' resolves to a .ps1/.cmd wrapper that Node's
    // spawn cannot execute directly — use cmd /c as the shell launcher.
    // Ref: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
    const isWindows = process.platform === 'win32';

    try {
      if (isWindows) {
        child = spawn('cmd', ['/d', '/s', '/c', 'cc-resilient', '--', ...args], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
          windowsVerbatimArguments: true,
        });
      } else {
        child = spawn('cc-resilient', ['--', ...args], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn claude: ${msg}` });
      return;
    }

    // Write prompt to stdin and close
    child.stdin!.write(fullPrompt);
    child.stdin!.end();

    // Timeout
    const timeoutId = setTimeout(() => {
      logger.warn('Claude CLI query timed out, killing process');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId: parserState.sessionId,
        error: partialText ? undefined : 'Claude query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    // Abort handling
    const onAbort = () => {
      logger.info('Claude CLI query aborted');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({ text: partialText, sessionId: parserState.sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    // Collect stderr
    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    // Parse NDJSON from stdout (logic in handleStreamLine for testability)
    const parserState: StreamParserState = {
      sessionId: '',
      textParts: [],
      trackingSkill: false,
      skillInputAccum: '',
    };
    const parserCallbacks: StreamParserCallbacks = { onText, onTurnEnd };

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      handleStreamLine(line, parserState, parserCallbacks);
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);

      if (code !== 0 && code !== null && !parserState.textParts.length && !parserState.errorMessage) {
        const stderr = stderrParts.join('').trim();
        parserState.errorMessage = stderr || `claude exited with code ${code}`;
        logger.error('Claude CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = parserState.textParts.join('\n').trim();

      if (!fullText && !parserState.errorMessage) {
        parserState.errorMessage = 'Claude returned an empty response.';
      }

      logger.info("Claude CLI query completed", {
        sessionId: parserState.sessionId,
        textLength: fullText.length,
        hasError: !!parserState.errorMessage,
      });

      finish({
        text: fullText,
        sessionId: parserState.sessionId,
        error: parserState.errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId: parserState.sessionId, error: `Failed to spawn claude: ${err.message}` });
    });
  });
}
