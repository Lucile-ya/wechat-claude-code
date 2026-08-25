#!/usr/bin/env node
/**
 * Cross-platform daemon entry: Windows → daemon.ps1, macOS/Linux → daemon.sh
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const command = process.argv[2] || 'start';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'win32') {
  const ps1 = join(root, 'scripts', 'daemon.ps1');
  const r = spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', ps1, command],
    { stdio: 'inherit', shell: true },
  );
  process.exit(r.status ?? 1);
}

const sh = join(root, 'scripts', 'daemon.sh');
const r = spawnSync('bash', [sh, command], { stdio: 'inherit' });
process.exit(r.status ?? 1);
