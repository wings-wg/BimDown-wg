import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createModelQaHandler } from './model-qa-server.ts';
import { MODEL_QA_SESSION_HEADER } from './src/area/model-qa-types.ts';
import { createPalLibrary } from './pal-library-server.ts';

const configured = {
  BIMDOWN_QA_MODEL: 'test-bim-model',
  BIMDOWN_QA_URL: 'http://127.0.0.1:11439/v1/chat/completions',
  BIMDOWN_QA_API_KEY: 'synthetic-token',
};

async function invoke(handler: ReturnType<typeof createModelQaHandler>, method: string, body?: object,
  headers: Record<string, string> = {}, url = '/') {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, url, headers: { 'content-type': 'application/json', host: 'localhost:5174', ...headers },
  }) as unknown as IncomingMessage;
  let code = 0;
  let data = {};
  const response = {
    writeHead(value: number) { code = value; },
    end(value: string) { data = JSON.parse(value); },
  } as unknown as ServerResponse;
  await handler(req, response);
  return { code, data };
}

describe('model question gateway', () => {
  it('compiles area requests without forwarding project data and rejects actions from another entrance', async () => {
    const complete = (plan: object) => Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] });
    const provider = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(complete({ action: 'area.outlines', scope: 'level' }))
      .mockResolvedValueOnce(complete({ action: 'area.allocate' }))
      .mockResolvedValueOnce(complete({ action: 'area.allocate', factors: [1] }));
    const handler = createModelQaHandler(configured, provider);
    const text = '给当前层生成测算轮廓';
    expect(await invoke(handler, 'POST', { channel: 'area', text, evidence: ['geometry'] }, {}, '/pal/intent'))
      .toEqual({ code: 200, data: { plan: { action: 'area.outlines', scope: 'level' } } });
    const messages = JSON.parse(String(provider.mock.calls[0][1]?.body)).messages;
    expect(JSON.parse(messages[1].content)).toEqual({ text });
    expect((await invoke(handler, 'POST', { channel: 'question', text }, {}, '/pal/intent')).code).toBe(502);
    expect((await invoke(handler, 'POST', { channel: 'area', text }, {}, '/pal/intent')).code).toBe(502);
  });

  it('stores a question tool draft and only resolves it as a measurement after approval', async () => {
    const concept = 'door.effective-clear-width';
    const toolId = `pal.${concept}.read@1`;
    let proposal: object = { action: 'tool.draft', recipe: { concept, operation: 'read', inputs: [concept] } };
    const provider = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    const handler = createModelQaHandler(configured, provider);
    const body = { channel: 'question', text: '量一下我选中的门开启后有效通行净宽' };
    expect(await invoke(handler, 'POST', body, {}, '/pal/intent')).toMatchObject({ code: 200, data: {
      plan: { action: 'tool.draft' }, tool: { id: toolId, status: 'draft' },
    } });
    proposal = { action: 'tool.measure', toolId, scope: 'selection' };
    expect((await invoke(handler, 'POST', body, {}, '/pal/intent')).code).toBe(502);
    await invoke(handler, 'POST', { toolId, reviewed: true }, {}, '/pal/library/approve');
    expect(await invoke(handler, 'POST', body, {}, '/pal/intent')).toMatchObject({ code: 200, data: {
      plan: proposal, tool: { id: toolId, status: 'active' },
    } });
  });

  it('compiles a grounded PAL plan and forwards only named clause fields to the model', async () => {
    const proposal = { id: 'NEW', kind: 'scalar', scope: 'project-storeys', concept: 'storey.architectural-height',
      operator: '>=', threshold: '3100 mm' };
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ message: { content: JSON.stringify({ rules: [proposal] }) } }],
    }));
    const handler = createModelQaHandler(configured, provider);
    const clause = { id: 'NEW', target: '楼层', attribute: '建筑层高', condition: '住宅楼层的建筑层高不得小于 3100 mm。',
      limit: '', reference: '', applicability: '项目住宅楼层', note: '' };
    const body = { clauses: [{ ...clause, path: '/private/path' }], evidence: ['private geometry'] };
    const response = await invoke(handler, 'POST', body, {}, '/pal');
    expect(response).toMatchObject({ code: 200, data: { model: configured.BIMDOWN_QA_MODEL, results: [
      { id: 'NEW', plan: { kind: 'scalar', threshold: 3.1, quote: '3100 mm' } },
    ] } });
    expect(JSON.parse(JSON.parse(String(provider.mock.calls[0][1]?.body)).messages[1].content)).toMatchObject({
      clauses: [clause], activeTools: [], profiles: expect.any(Object),
    });
    expect(String(provider.mock.calls[0][1]?.body)).not.toMatch(/private geometry|private\/path/);
    expect((await invoke(handler, 'POST', { clauses: [clause, clause] }, {}, '/pal')).code).toBe(400);
    expect((await invoke(createModelQaHandler({}, provider), 'POST', body, {}, '/pal')).code).toBe(503);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('validates and stores a draft, requires approval, and offers the active tool after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bimdown-pal-library-'));
    const file = join(dir, 'library.json');
    const concept = 'slab.cast-in-place-solid-structural-thickness';
    const draft = { id: 'SLAB-1', kind: 'tool-draft', recipe: { concept, operation: 'read', inputs: [concept] },
      operator: '>=', threshold: '100 mm' };
    const provider = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify({ rules: [draft] }) } }] }));
    const row = { id: 'SLAB-1', target: '现浇实心楼板', attribute: '结构层厚', condition: '厚度不得小于 100 mm。',
      limit: '', reference: '', applicability: '已核实为现浇实心楼板', note: '' };
    try {
      const first = createModelQaHandler(configured, provider, createPalLibrary(file));
      const candidate = await invoke(first, 'POST', { clauses: [row] }, {}, '/pal');
      expect(candidate.data).toMatchObject({ results: [{ plan: { kind: 'tool-draft' } }], tools: [{ status: 'draft' }] });
      const readyId = `pal.${concept}.read@1`;
      expect((await invoke(first, 'POST', { toolId: readyId }, {}, '/pal/library/approve')).code).toBe(400);
      expect((await invoke(first, 'POST', { toolId: readyId, reviewed: true }, {}, '/pal/library/approve')).data)
        .toMatchObject({ tool: { status: 'active', verification: expect.arrayContaining(['单位换算', '证据缺失']) } });
      const second = createModelQaHandler(configured, provider, createPalLibrary(file));
      const reused = await invoke(second, 'POST', { clauses: [row] }, {}, '/pal');
      expect(reused.data).toMatchObject({ results: [{ plan: { kind: 'registered-tool', toolId: readyId } }],
        tools: [{ id: readyId, status: 'active' }] });
      expect(JSON.parse(JSON.parse(String(provider.mock.calls[1][1]?.body)).messages[1].content)).toMatchObject({
        activeTools: [{ id: readyId }],
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('sends only numbered evidence to the fixed endpoint and keeps the token server-side', async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ message: { content: '该房间面积为 80 m² [E1]。' } }],
    }));
    const handler = createModelQaHandler(configured, provider);
    const status = await invoke(handler, 'GET');
    expect(status.data).toEqual({ model: 'test-bim-model', host: '127.0.0.1:11439' });

    const response = await invoke(handler, 'POST', {
      question: '这个房间多大？',
      evidence: [{ label: '合成房间', source: 'lv-1/space.geojson', facts: { area: 80 },
        target: { level: 'lv-1', elementId: 'sp-1' } }],
      upstream: 'https://unused.invalid/',
    }, { origin: 'http://localhost:5174' });
    expect(response).toEqual({ code: 200, data: { answer: '该房间面积为 80 m² [E1]。', model: 'test-bim-model' } });
    const [url, init] = provider.mock.calls[0];
    expect(String(url)).toBe(configured.BIMDOWN_QA_URL);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
    const body = JSON.parse(String(init?.body));
    expect(body.messages[0].role).toBe('system');
    expect(JSON.parse(body.messages[1].content).evidence).toEqual([
      { id: 'E1', label: '合成房间', source: 'lv-1/space.geojson', facts: { area: 80 } },
    ]);
  });

  it('rejects cross-origin or oversized requests and stays offline without a provider', async () => {
    const provider = vi.fn<typeof fetch>();
    const handler = createModelQaHandler(configured, provider);
    const question = { question: '楼层数是多少？', evidence: [] };
    expect((await invoke(handler, 'POST', question, { origin: 'https://other.invalid' })).code).toBe(403);
    expect((await invoke(handler, 'POST', { question: 'x'.repeat(1201), evidence: [] })).code).toBe(400);
    expect((await invoke(createModelQaHandler({}, provider), 'POST', question)).code).toBe(503);
    expect(provider).not.toHaveBeenCalled();
  });

  it('checks cloud connectivity with a fixed message and leaves existing settings active', async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: 'OK' } }] }));
    const handler = createModelQaHandler(configured, provider);
    const result = await invoke(handler, 'POST', {
      cloudProvider: 'deepseek', model: 'deepseek-flash', apiKey: 'synthetic-cloud-key', endpoint: 'http://127.0.0.1',
      evidence: [{ facts: { private: 'never-forwarded-by-test' } }],
    }, {}, '/settings/test');
    expect(result).toEqual({ code: 200, data: { ok: true } });
    const [endpoint, init] = provider.mock.calls[0];
    expect(String(endpoint)).toBe('https://api.deepseek.com/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-cloud-key' });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'deepseek-flash', stream: false, thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: '连接测试，请只回复 OK。' }],
    });
    expect((await invoke(handler, 'GET')).data).toMatchObject({ model: configured.BIMDOWN_QA_MODEL });
  });

  it('uses per-tab cloud credentials, replaces the session and restores the default when cleared', async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: '测试答复' } }] }));
    const handler = createModelQaHandler(configured, provider);
    const saved = await invoke(handler, 'POST', {
      cloudProvider: 'openai', model: 'gpt-4.1-mini', apiKey: 'synthetic-openai-key',
    }, {}, '/settings');
    expect(saved.code).toBe(200);
    expect(JSON.stringify(saved.data)).not.toContain('synthetic-openai-key');
    const { sessionId } = saved.data as { sessionId: string };
    const first = { [MODEL_QA_SESSION_HEADER]: sessionId };
    expect((await invoke(handler, 'GET', undefined, first)).data).toEqual({
      cloudProvider: 'openai', host: 'api.openai.com', model: 'gpt-4.1-mini',
    });
    expect((await invoke(handler, 'GET')).data).toMatchObject({ model: configured.BIMDOWN_QA_MODEL });
    expect(provider).not.toHaveBeenCalled();

    const updated = await invoke(handler, 'POST', {
      cloudProvider: 'openai', model: 'another-model', apiKey: '',
    }, first, '/settings');
    const second = { [MODEL_QA_SESSION_HEADER]: (updated.data as { sessionId: string }).sessionId };
    const question = { question: '房间多大？', evidence: [] };
    expect((await invoke(handler, 'POST', question, first)).code).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    expect((await invoke(handler, 'POST', question, second)).data).toEqual({ model: 'another-model', answer: '测试答复' });
    expect(provider.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer synthetic-openai-key' });
    expect((await invoke(handler, 'DELETE', undefined, second, '/settings')).data).toMatchObject({
      model: configured.BIMDOWN_QA_MODEL,
    });
    expect((await invoke(handler, 'GET', undefined, second)).data).toEqual({ expired: true });
  });

  it('validates cloud provider and credentials and sanitizes upstream authentication errors', async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response('private gateway error', { status: 401 }));
    const handler = createModelQaHandler({}, provider);
    expect((await invoke(handler, 'POST', { cloudProvider: '__proto__', model: 'test', apiKey: 'key' }, {}, '/settings')).code)
      .toBe(400);
    expect((await invoke(handler, 'POST', { cloudProvider: 'dashscope', model: 'qwen-plus' }, {}, '/settings')).code).toBe(400);
    expect(provider).not.toHaveBeenCalled();
    const denied = await invoke(handler, 'POST', {
      cloudProvider: 'dashscope', model: 'qwen-plus', apiKey: 'synthetic-denied-key',
    }, {}, '/settings/test');
    expect(denied.code).toBe(502);
    expect(JSON.stringify(denied.data)).toContain('HTTP 401');
    expect(JSON.stringify(denied.data)).not.toContain('private gateway error');
  });
});
