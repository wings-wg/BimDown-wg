import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { createDevelopmentHandler, createDevelopmentJobs } from './development-jobs-server.ts';
import { parseDevelopmentRequest } from './src/area/development-request.mts';

const task = parseDevelopmentRequest({ format: 'bimdown.development-request', version: 1, module: 'area',
  title: 'Show the selected room', current: 'Open a plan.', desired: 'Display its room.', acceptance: 'Run the room test.', constraints: '' });
const temporary = new Set<string>();
const outputPath = 'web/area/example.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bimdown-dev-suite-'));
  temporary.add(root);
  await mkdir(join(root, 'web/area'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# Repository');
  await writeFile(join(root, 'web/area/setup.mjs'), '');
  await writeFile(join(root, outputPath), 'export const room = "old";\n');
  await writeFile(join(root, 'bimdown.txt'), 'private local settings');
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '.']);
  await writeFile(join(root, outputPath), 'export const room = "current";\n');
  return root;
}

function fakeAgent(cwd: string) {
  return spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    let input = '';
    process.stdin.setEncoding('utf8').on('data', s => input += s).on('end', () => {
      assert.match(input, /Show the selected room/);
      assert.equal(fs.existsSync('bimdown.txt'), false);
      const path = '${outputPath}';
      assert.match(fs.readFileSync(path, 'utf8'), /current/);
      fs.writeFileSync(path, 'export const room = "reviewed";\\n');
      console.log('Synthetic room test passed');
    });
  `], { cwd, stdio: 'pipe' });
}

async function awaitReview(jobs: ReturnType<typeof createDevelopmentJobs>, id: string) {
  await expect.poll(() => jobs.get(id)?.status, { timeout: 5000 }).toBe('review');
  return jobs.get(id)!;
}

afterEach(async () => {
  await Promise.all([...temporary].map(root => rm(root, { recursive: true, force: true })));
  temporary.clear();
});

it('runs in a snapshot of current source and applies only a reviewed patch', async () => {
  const root = await fixture();
  const jobs = createDevelopmentJobs(root, fakeAgent);
  const id = jobs.start(task);
  expect(() => jobs.start(task)).toThrow('已有开发任务');
  const review = await awaitReview(jobs, id);
  expect(review.files).toEqual([outputPath]);
  expect(review.patch).toContain('+export const room = "reviewed";');
  expect(review.log).toContain('Synthetic room test passed');
  expect(await readFile(join(root, outputPath), 'utf8')).toContain('current');
  await jobs.apply(id);
  expect(await readFile(join(root, outputPath), 'utf8')).toContain('reviewed');
  expect(jobs.get(id)?.status).toBe('applied');
});

it('preserves a later edit in the live repository', async () => {
  const root = await fixture();
  const jobs = createDevelopmentJobs(root, fakeAgent);
  const id = jobs.start(task);
  await awaitReview(jobs, id);
  await writeFile(join(root, outputPath), 'export const room = "later";\n');
  await expect(jobs.apply(id)).rejects.toThrow('在开发期间已变化');
  expect(await readFile(join(root, outputPath), 'utf8')).toContain('later');
});

it('rejects cross-origin requests and requires explicit confirmation for a start', async () => {
  const root = await fixture();
  const jobs = createDevelopmentJobs(root, fakeAgent);
  const handle = createDevelopmentHandler(jobs);
  async function submit(origin: string, confirmation?: string) {
    const request = Object.assign(Readable.from([JSON.stringify(task)]), {
      url: '/jobs', method: 'POST', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:5174', origin, 'content-type': 'application/json', 'x-bimdown-development': confirmation },
    }) as unknown as IncomingMessage;
    let code = 0;
    let payload: { id?: string } = {};
    const reply = { writeHead: (status: number) => { code = status; },
      end: (body: string) => { payload = JSON.parse(body); } } as unknown as ServerResponse;
    await handle(request, reply);
    return { code, payload };
  }
  expect((await submit('https://other.example', 'confirmed')).code).toBe(403);
  expect((await submit('http://127.0.0.1:5174')).code).toBe(403);
  const accepted = await submit('http://127.0.0.1:5174', 'confirmed');
  expect(accepted.code).toBe(202);
  await awaitReview(jobs, accepted.payload.id!);
});
