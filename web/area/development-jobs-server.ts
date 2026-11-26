import { createHash, randomUUID } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { launchCodingAgent } from './development-agent.mts';
import { developmentPrompt, parseDevelopmentRequest, type DevelopmentJob, type DevelopmentRequest } from './src/area/development-request.mts';

const exec = promisify(execFile);
const logLimit = 96_000;
const patchLimit = 1_000_000;
const jobLimit = 8;
const timeoutMs = 30 * 60_000;
const projectRoots = new Set(['cli', 'web', 'spec', 'research', 'revit-addin', 'scripts', 'sample_data',
  '.github', 'agent-skill', 'agent-skill-zh', 'assets', 'doc']);
const rootFiles = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', 'README.zh-CN.md', 'LICENSE',
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'package.json', '.gitignore']);
const excludedFile = /(?:^|\/)(?:\.env[^/]*|credentials?[^/]*|secrets?[^/]*|bimdown\.txt|node_modules|\.data|\.git|SourceRevitModels)(?:\/|$)|\.(?:rvt|rfa|rte|ifc|bimdown|zip|rar|pdf|docx?|xlsx?|pem|key|p12)$/i;
const sourceFile = /\.(?:tsx?|mts|mjs|jsx?|css|json|ya?ml|cs|csproj|sln|addin|xml|md|csv|geojson|ps1|py|html|glb|png)$/i;

type Launcher = (cwd: string, capture: boolean) => ChildProcess;
type Job = DevelopmentJob & { baseline?: Map<string, string> };

function projectPath(path: string) {
  const parts = path.split('/');
  return !path.includes('\\') && parts.every(part => part && part !== '.' && part !== '..') &&
    !excludedFile.test(path) && (rootFiles.has(path) || (projectRoots.has(parts[0]) && sourceFile.test(path)));
}

function git(cwd: string, ...args: string[]) {
  return exec('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function splitPaths(text: string) {
  return [...new Set(text.split('\0').filter(Boolean))];
}

async function fileDigest(root: string, name: string) {
  const path = join(root, name);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || await realpath(path) !== path) throw new Error(`请检查文件路径或链接 ${name}。`);
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    return `${stat.mode & 0o111}:${hash}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function createSnapshot(root: string, workspace: string) {
  const { stdout: top } = await git(root, 'rev-parse', '--show-toplevel');
  if (await realpath(top.trim()) !== root ||
      !(await fileDigest(root, 'AGENTS.md')) || !(await fileDigest(root, 'web/area/setup.mjs')))
    throw new Error('无法定位当前 BIMDown 源码仓库。');
  const [tracked, added] = await Promise.all([
    git(root, 'ls-files', '-z', '--cached'),
    git(root, 'ls-files', '-z', '--others', '--exclude-standard'),
  ]);
  const files = new Set([...splitPaths(tracked.stdout),
    ...splitPaths(added.stdout).filter(path => !path.startsWith('sample_data/') && !/\.(?:csv|geojson|glb|png)$/i.test(path))]);
  const baseline = new Map<string, string>();
  for (const name of [...files].filter(projectPath)) {
    const hash = await fileDigest(root, name);
    if (!hash) continue;
    const path = join(workspace, name);
    await mkdir(dirname(path), { recursive: true });
    await cp(join(root, name), path, { mode: constants.COPYFILE_FICLONE });
    if (await fileDigest(workspace, name) !== hash) throw new Error(`准备副本时文件发生变化，请重试 ${name}。`);
    baseline.set(name, hash);
  }
  await git(workspace, 'init', '-q');
  await git(workspace, 'add', '-f', '--', ...baseline.keys());
  const { stdout: tree } = await git(workspace, 'write-tree');
  return { baseline, tree: tree.trim() };
}

async function prepareWebDependencies(root: string, workspace: string) {
  const editor = '.bimeditor-local';
  const installed = await lstat(join(root, editor, '.git')).catch(() => undefined);
  if (installed?.isDirectory() || installed?.isFile()) {
    const { stdout: revision } = await git(join(root, editor), 'rev-parse', 'HEAD');
    await git(workspace, 'clone', '-q', '--no-local', '--no-checkout', join(root, editor), editor);
    await git(join(workspace, editor), 'checkout', '-q', '--detach', revision.trim());
    await git(join(workspace, editor), 'remote', 'remove', 'origin');
  }
  const modules = ['node_modules', 'cli/node_modules', `${editor}/node_modules`,
    `${editor}/app/node_modules`, `${editor}/editor/node_modules`];
  await Promise.all(modules.map(async name => {
    const source = join(root, name);
    const stat = await lstat(source).catch(() => undefined);
    if (stat?.isDirectory() && await realpath(source) === source) {
      await mkdir(dirname(join(workspace, name)), { recursive: true });
      await cp(source, join(workspace, name), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
        filter: path => !/(?:^|\/)(?:\.vite[^/]*|\.cache|\.env[^/]*)$/.test(path) });
    }
  }));
}

function runAgent(launch: Launcher, workspace: string, task: DevelopmentRequest, append: (text: string) => void) {
  return new Promise<number | null>((resolveRun, reject) => {
    const process = launch(workspace, true);
    let force: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      append('\n已达到开发任务执行时限。\n');
      process.kill('SIGTERM');
      force = setTimeout(() => process.kill('SIGKILL'), 10_000);
    }, timeoutMs);
    const clear = () => { clearTimeout(timer); clearTimeout(force); };
    process.on('close', code => { clear(); resolveRun(code); });
    process.on('error', error => { clear(); reject(new Error(`无法启动本机 Codex：${error.message}`)); });
    process.stdout?.setEncoding('utf8').on('data', append);
    process.stderr?.setEncoding('utf8').on('data', append);
    process.stdin?.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') append(error.message); });
    process.stdin?.end(developmentPrompt(task));
  });
}

export function createDevelopmentJobs(repository: string, launch: Launcher = launchCodingAgent) {
  const jobs = new Map<string, Job>();
  let active = false;

  async function run(job: Job, task: DevelopmentRequest) {
    const append = (text: string) => {
      job.log = (job.log + text.replace(/\u001b\[[0-9;]*m/g, '')).slice(-logLimit);
    };
    let workspace: string | undefined;
    let status: 'review' | 'failed' = 'failed';
    try {
      const root = await realpath(repository);
      workspace = await realpath(await mkdtemp(join(tmpdir(), 'bimdown-coding-')));
      const { baseline, tree } = await createSnapshot(root, workspace);
      await prepareWebDependencies(root, workspace);
      job.status = 'running';
      append('隔离副本已准备，正在运行本机 Codex。\n');
      const code = await runAgent(launch, workspace, task, append);
      append(`\nCodex 退出状态 ${code ?? '已中止'}。\n`);
      const { stdout: untracked } = await git(workspace, 'ls-files', '-z', '--others', '--exclude-standard');
      const outside = splitPaths(untracked).filter(path => !projectPath(path));
      if (outside.length) throw new Error(`任务生成了范围外文件 ${outside.slice(0, 8).join('、')}。`);
      await git(workspace, 'add', '-A');
      const { stdout: names } = await git(workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', tree);
      const files = splitPaths(names);
      for (const file of files) {
        if (!projectPath(file)) throw new Error(`任务修改了范围外文件 ${file}。`);
        await fileDigest(workspace, file); // Reject symlinks and other non-file results.
      }
      const { stdout: patch } = await git(workspace, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', tree);
      if (Buffer.byteLength(patch) > patchLimit) throw new Error('改动超过网页支持的差异大小，请缩小单次任务范围。');
      Object.assign(job, { baseline, files, patch });
      if (code === 0) status = 'review';
      if (code !== 0) job.error = 'Codex 执行未成功结束。请查看日志中实际运行的命令和结果。';
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(error => append(`\n临时副本清理失败：${error.message}`));
      active = false;
      job.status = status;
    }
  }

  return {
    start(task: DevelopmentRequest) {
      if (active) throw new Error('已有开发任务正在执行。');
      while (jobs.size >= jobLimit) jobs.delete(jobs.keys().next().value!);
      const job: Job = { id: randomUUID(), status: 'preparing', title: task.title, log: '', files: [], patch: '' };
      jobs.set(job.id, job);
      active = true;
      void run(job, task);
      return job.id;
    },
    get(id: string): DevelopmentJob | undefined {
      const job = jobs.get(id);
      if (!job) return undefined;
      const { baseline: _baseline, ...result } = job;
      return result;
    },
    async apply(id: string) {
      const job = jobs.get(id);
      if (!job || job.status !== 'review' || !job.patch || !job.baseline) throw new Error('当前任务没有可应用的差异。');
      if (active) throw new Error('请等待当前开发任务完成后再应用差异。');
      active = true;
      let temp: string | undefined;
      try {
        const root = await realpath(repository);
        for (const path of job.files) if (await fileDigest(root, path) !== job.baseline.get(path))
          throw new Error(`源码 ${path} 在开发期间已变化，请下载差异并审查，或基于新版本重新运行。`);
        temp = await mkdtemp(join(tmpdir(), 'bimdown-patch-'));
        const path = join(temp, 'review.patch');
        await writeFile(path, job.patch, { mode: 0o600 });
        await git(root, 'apply', '--check', '--', path);
        await git(root, 'apply', '--', path);
        job.status = 'applied';
      } finally {
        if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
        active = false;
      }
    },
  };
}

function json(res: ServerResponse, status: number, payload: object) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readTask(req: IncomingMessage) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('请提交 JSON 开发任务。');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const data of req) {
    const chunk = Buffer.from(data);
    length += chunk.length;
    if (length > 64 * 1024) throw new Error('开发任务过长。');
    chunks.push(chunk);
  }
  return parseDevelopmentRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export function createDevelopmentHandler(jobs: ReturnType<typeof createDevelopmentJobs>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? '';
    const address = req.socket.remoteAddress ?? '';
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) ||
        (req.headers.origin && ![`http://${host}`, `https://${host}`].includes(req.headers.origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.method === 'POST' && (!req.headers.origin || req.headers['x-bimdown-development'] !== 'confirmed')))
      return json(res, 403, { error: '请在本机 BIMDown 页面确认开发操作。' });

    const pathname = req.url?.split('?', 1)[0] ?? '/';
    try {
      if (pathname === '/jobs' && req.method === 'POST') {
        const task = await readTask(req);
        return json(res, 202, { id: jobs.start(task) });
      }
      const match = /^\/jobs\/([a-f0-9-]{36})(\/apply)?$/.exec(pathname);
      if (match && (match[2] ? req.method === 'POST' : req.method === 'GET')) {
        const job = jobs.get(match[1]);
        if (!job) return json(res, 404, { error: '找不到任务。服务重启后可重新提交开发任务。' });
        if (match[2]) await jobs.apply(job.id);
        return json(res, 200, jobs.get(job.id)!);
      }
      return json(res, 404, { error: '未知开发任务地址。' });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
