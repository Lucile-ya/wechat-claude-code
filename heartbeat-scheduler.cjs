/**
 * Heartbeat Scheduler — persistent timer that reads heartbeat-config.json
 * and fires Claude-powered push notifications to WeChat at scheduled times.
 *
 * Runs alongside the wechat-claude-code daemon. Spawns Claude Code CLI with
 * full filesystem access so system_prompt.txt rules execute correctly (reading
 * JSON data files, running Python scripts, etc.).
 *
 * Start:  node heartbeat-scheduler.cjs
 * Stop:   kill the process (or use the daemon manager)
 */

const { spawn } = require('child_process');
const { createInterface } = require('readline');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config paths ──────────────────────────────────────────────────────────
const WECHAT_DIR = path.join(os.homedir(), '.wechat-claude-code');
const ACCOUNTS_DIR = path.join(WECHAT_DIR, 'accounts');
const HEARTBEAT_CONFIG = path.join(os.homedir(), '.claude', 'channels', 'wechat', 'heartbeat-config.json');
const PMP_PROJECT = 'D:\\pmp-athena';
const SYSTEM_PROMPT_PATH = path.join(PMP_PROJECT, 'system_prompt.txt');

// ── Runtime state ─────────────────────────────────────────────────────────
const firedToday = new Set();   // "label-HH:MM" keys to prevent duplicate fires
let lastDate = '';

// ── Helpers ────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[heartbeat ${ts}] ${msg}\n`);
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const req = https.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Config loaders ────────────────────────────────────────────────────────
function loadHeartbeatConfig() {
  if (!fs.existsSync(HEARTBEAT_CONFIG)) {
    log('WARN: heartbeat-config.json not found');
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(HEARTBEAT_CONFIG, 'utf-8'));
  return (raw.fixed || []).map((e) => ({ hour: e.hour, minute: e.minute, label: e.label }));
}

function loadSystemPrompt() {
  if (!fs.existsSync(SYSTEM_PROMPT_PATH)) {
    log('WARN: system_prompt.txt not found');
    return '';
  }
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
}

function loadAccount() {
  const files = fs.readdirSync(ACCOUNTS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error('No WeChat account found');
  return JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, files[0]), 'utf-8'));
}

// ── Claude Code CLI ───────────────────────────────────────────────────────
// Spawn claude CLI with full filesystem access so system_prompt.txt rules
// (reading data files, running Python scripts, etc.) execute correctly.
function callClaudeCLI(systemPrompt, userMessage) {
  return new Promise((resolve) => {
    const args = [
      '-p', '-',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];

    // NOTE: system prompt is NOT passed via --append-system-prompt.
    // The project's CLAUDE.md (synced from system_prompt.txt) is auto-loaded
    // by Claude CLI from the working directory.

    const isWindows = process.platform === 'win32';
    let child;

    try {
      if (isWindows) {
        child = spawn('cmd', ['/d', '/s', '/c', 'claude', '--', ...args], {
          cwd: PMP_PROJECT,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } else {
        child = spawn('claude', args, {
          cwd: PMP_PROJECT,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      }
    } catch (err) {
      log(`Failed to spawn claude: ${err.message}`);
      resolve(null);
      return;
    }

    // Write prompt to stdin
    child.stdin.write(userMessage);
    child.stdin.end();

    // Timeout after 10 minutes
    const timeout = setTimeout(() => {
      log('Claude CLI timed out');
      child.kill();
      resolve(null);
    }, 10 * 60 * 1000);

    // Parse NDJSON from stdout
    const textParts = [];
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
          const text = ev.event?.delta?.text;
          if (text) textParts.push(text);
        }
      } catch { /* skip malformed lines */ }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', () => {
      clearTimeout(timeout);
      const text = textParts.join('').trim();
      if (text) {
        log(`Claude response: ${text.length} chars`);
        resolve(text);
      } else if (stderr) {
        log(`Claude stderr: ${stderr.slice(0, 200)}`);
        resolve(null);
      } else {
        log('Claude returned empty response');
        resolve(null);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      log(`Claude process error: ${err.message}`);
      resolve(null);
    });
  });
}

// ── WeChat send ───────────────────────────────────────────────────────────
async function sendToWeChat(account, text) {
  if (!text) return;
  const body = {
    touser: account.userId,
    msgtype: 'text',
    text: { content: text },
  };
  const url = `${account.baseUrl}/ilink/bot/sendmessage?token=${account.botToken}`;
  const res = await httpPost(url, {}, body);
  if (res.status === 200 && res.body?.ret === 0) {
    log(`Sent to WeChat (${text.length} chars)`);
  } else {
    log(`WeChat send failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}

// ── Split long messages for WeChat (max ~2000 chars) ──────────────────────
function splitForWeChat(text) {
  const MAX = 1800;
  if (text.length <= MAX) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut < MAX / 2) cut = MAX;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// ── Main heartbeat handler ────────────────────────────────────────────────
async function fireHeartbeat(label) {
  log(`Firing: ${label}`);

  // Sync system_prompt.txt → CLAUDE.md so Claude CLI picks it up automatically
  try {
    const sp = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
    fs.writeFileSync(path.join(PMP_PROJECT, 'CLAUDE.md'), sp, 'utf-8');
  } catch (e) {
    log(`WARN: Failed to sync CLAUDE.md: ${e.message}`);
  }
  const account = loadAccount();
  const userMessage = `[heartbeat: ${label}]`;

  const response = await callClaudeCLI(systemPrompt, userMessage);
  if (!response) {
    log(`No response from Claude for ${label}`);
    return;
  }

  const parts = splitForWeChat(response);
  for (let i = 0; i < parts.length; i++) {
    await sendToWeChat(account, parts[i]);
    if (parts.length > 1) await new Promise((r) => setTimeout(r, 1500));
  }
}

// ── Scheduler loop ────────────────────────────────────────────────────────
function tick() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  // Reset fired-today set at midnight
  if (dateStr !== lastDate) {
    firedToday.clear();
    lastDate = dateStr;
  }

  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  const config = loadHeartbeatConfig();
  for (const entry of config) {
    if (entry.hour === currentHour && entry.minute === currentMinute) {
      const key = `${entry.label}-${String(entry.hour).padStart(2, '0')}:${String(entry.minute).padStart(2, '0')}`;
      if (!firedToday.has(key)) {
        firedToday.add(key);
        fireHeartbeat(entry.label).catch((err) => log(`Error firing ${entry.label}: ${err.message}`));
      }
    }
  }
}

// ── Startup ────────────────────────────────────────────────────────────────
log('Heartbeat scheduler starting...');
log(`Config: ${HEARTBEAT_CONFIG}`);
log(`Schedule: ${JSON.stringify(loadHeartbeatConfig())}`);

setInterval(tick, 30_000);
tick(); // immediate check on startup

log('Scheduler running. Press Ctrl+C to stop.');
