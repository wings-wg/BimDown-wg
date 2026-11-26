import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

function codexExecutable() {
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'codex'));
  if (process.platform === 'darwin') {
    const entry = 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    candidates.push(join('/Applications', 'ChatGPT.app', entry));
    if (process.env.HOME) candidates.push(join(process.env.HOME, 'Applications', 'ChatGPT.app', entry));
  }
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); return file; } catch { /* Try the next installed CLI. */ }
  }
  return 'codex';
}

/** Use the local Codex configuration and limit writes to the task workspace. */
export function launchCodingAgent(cwd: string, capture = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BIMDOWN_QA_')) delete env[key];
  return spawn(codexExecutable(), ['--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write', '-C', cwd, '-'],
    { cwd, stdio: ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'], env });
}
