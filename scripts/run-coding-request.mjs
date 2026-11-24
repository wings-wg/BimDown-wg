import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { developmentPrompt, parseDevelopmentRequest } from '../web/area/development-request.mts';

const usage = '用法：node scripts/run-coding-request.mjs <开发任务.json> --preview\n' +
  '或：node scripts/run-coding-request.mjs <开发任务.json> --run <干净的 BIMDown 工作目录>';

try {
  const [file, mode, workspace, ...extra] = process.argv.slice(2);
  if (!file || extra.length || !(mode === '--preview' && !workspace || mode === '--run' && workspace))
    throw new Error(usage);
  if (!statSync(file).isFile() || statSync(file).size > 256 * 1024) throw new Error('请选择有效的开发任务文件。');
  const prompt = developmentPrompt(parseDevelopmentRequest(JSON.parse(readFileSync(file, 'utf8'))));
  if (mode === '--preview') {
    process.stdout.write(prompt + '\n');
  } else {
    const cwd = realpathSync(resolve(workspace));
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    if (!existsSync(join(cwd, 'AGENTS.md')) || !existsSync(join(cwd, 'web', 'area', 'setup.mjs')) ||
        realpathSync(git('rev-parse', '--show-toplevel')) !== cwd)
      throw new Error('请指定 BIMDown 仓库的工作目录。');
    if (git('status', '--porcelain', '--untracked-files=normal'))
      throw new Error('工作目录有未提交的改动。请指定一个干净的 BIMDown 工作目录。');
    const agent = spawn('codex', ['--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write', '-C', cwd, '-'],
      { cwd, stdio: ['pipe', 'inherit', 'inherit'] });
    agent.on('error', error => {
      process.stderr.write(`无法启动 Codex：${error.message}\n`);
      process.exitCode = 1;
    });
    agent.on('close', code => { process.exitCode = code ?? 1; });
    agent.stdin.on('error', error => {
      if (error.code !== 'EPIPE') {
        process.stderr.write(error.message + '\n');
        process.exitCode = 1;
      }
    });
    agent.stdin.end(prompt);
  }
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
