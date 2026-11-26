import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createModelQaHandler } from './model-qa-server.ts';
import { MODEL_QA_SESSION_HEADER } from './src/area/model-qa-types.ts';
import { createPalLibrary } from './pal-library-server.ts';
import { parsePalIntent } from './src/area/pal-intent.ts';
import { editorCommands, editorIntentHasGroundedTarget, localEditorIntent, matchEditorLevel, resolveDeleteIds } from './src/area/editor-commands.ts';
import { localDevelopmentDraft, parseDevelopmentRequest } from './src/area/development-request.mts';
import { readCandidatePackage } from './src/check/pal-candidate-package.ts';
import { toolId, verifyToolRecipe, type ToolRecipe } from './src/check/core/tool-recipes.ts';

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
  it('matches explicit deletion only and never maps a foreign scoped short ID onto the current floor', () => {
    expect(localEditorIntent('请删除本层的所有门！')).toEqual({ action: 'editor.delete', target: 'table:door' });
    expect(localEditorIntent('删除构件编号 D-1')).toEqual({ action: 'editor.delete', target: 'id:d-1' });
    expect(localEditorIntent('删除所有楼层的门')).toBeUndefined();
    expect(editorIntentHasGroundedTarget({ action: 'editor.delete', target: 'id:d-1' }, '怎么删除 d-1？')).toBe(false);
    const elements = new Map([['d-1', { tableName: 'door' }], ['w-1', { tableName: 'wall' }]]);
    expect(resolveDeleteIds('selected', 'lv-1', elements, new Set(['lv-2:d-1']))).toEqual([]);
    expect(resolveDeleteIds('selected', 'lv-1', elements, new Set(['lv-1:d-1']))).toEqual(['d-1']);
    expect(resolveDeleteIds('table:door', 'lv-1', elements, new Set())).toEqual(['d-1']);
  });

  it('binds candidate packages to source rows, verifies atomically and refreshes the same service without re-adding tools', async () => {
    const recipe: ToolRecipe = { concept: 'slab.cast-in-place-solid-structural-thickness', operation: 'read',
      inputs: ['slab.cast-in-place-solid-structural-thickness'] };
    const clause = { id: 'JG-03', target: '现浇实心楼板', attribute: '有效结构层厚',
      condition: '结构层厚度低于 100mm 判FAIL', limit: '', reference: '', applicability: '非悬挑板', note: '' };
    const source = { document: '合成工作簿', locator: '规则!第2行', text: clause.condition };
    const input = [{ id: clause.id, clause, source }];
    const proposal = { id: clause.id, kind: 'tool-draft', recipe, operator: '>=', threshold: '100mm' };
    const entry = { clause, source, proposal, verification: verifyToolRecipe(recipe) };
    const pack = { version: 1, origin: 'Codex', entries: [entry] };
    const handler = createModelQaHandler({}, vi.fn<typeof fetch>());
    const route = '/pal/library/import';
    const library = () => invoke(handler, 'GET', undefined, {}, '/pal/library');
    expect(readCandidatePackage(pack, input).entries).toHaveLength(1);
    expect(() => readCandidatePackage({ ...pack, entries: [{ ...entry, source: { ...entry.source, locator: 'wrong row' } }] },
      input)).toThrow(/不匹配/);
    expect((await invoke(handler, 'POST', { ...pack, entries: [{ ...entry, verification: [] }] }, {}, route)).code).toBe(400);
    expect((await library()).data).toEqual({ tools: [] });
    expect((await invoke(handler, 'POST', pack, {}, route)).data).toMatchObject({ tools: [{ status: 'draft' }] });
    expect((await invoke(handler, 'POST', pack, {}, route)).code).toBe(200);
    expect((await library()).data).toMatchObject({ tools: [{ status: 'draft' }] });
    expect((await invoke(handler, 'POST', { toolId: toolId(recipe), reviewed: true }, {}, '/pal/library/approve')).code).toBe(200);
    expect((await invoke(handler, 'POST', pack, {}, route)).data).toMatchObject({ tools: [{ status: 'active' }] });
  });

  it('recognizes explicit view and room commands locally but leaves how-to questions and scope changes alone', () => {
    expect(localEditorIntent('请帮我切换到 ３Ｄ 视图！')).toEqual({ action: 'editor.set-view', mode: '3d' });
    expect(localEditorIntent('把这个模型的显示方式改为三维视图')).toEqual({ action: 'editor.set-view', mode: '3d' });
    expect(localEditorIntent('返回平面图')).toEqual({ action: 'editor.set-view', mode: '2d' });
    expect(localEditorIntent('在所有楼层自动创建房间')).toEqual({ action: 'editor.preview-rooms', scope: 'project' });
    expect(localEditorIntent('生成当前楼层的房间')).toEqual({ action: 'editor.preview-rooms', scope: 'level' });
    expect(localEditorIntent('怎样切换到3D视图？')).toBeUndefined();
    expect(localEditorIntent('在所有楼层自动创建房间，但是跳过二层')).toBeUndefined();
    expect(localEditorIntent('自动创建房间')).toBeUndefined();
    expect(parsePalIntent({ action: 'editor.preview-rooms', scope: 'project', confirmed: true }, 'question')).toBeUndefined();
    expect(parsePalIntent({ action: 'editor.set-view', mode: '3d' }, 'area')).toBeUndefined();
  });

  it('recognizes a requested level plan as one operation and validates both the action and the level', () => {
    const plan = { action: 'editor.show-level-plan', target: 'f1' };
    expect(localEditorIntent('显示F1的2D视图')).toEqual(plan);
    expect(localEditorIntent('请打开楼层 F1 的二维视图')).toEqual(plan);
    expect(localEditorIntent('显示二层平面图')).toEqual({ ...plan, target: '二层' });
    expect(localEditorIntent('显示模型的2D视图')).toEqual({ action: 'editor.set-view', mode: '2d' });
    expect(localEditorIntent('如何显示F1的2D视图？')).toBeUndefined();
    expect(parsePalIntent({ ...plan, target: '' }, 'question')).toBeUndefined();
  });

  it('accepts semantic intents for phrasing the offline catalog does not recognize', async () => {
    const scenarios = [
      ['能不能把 F1 给我平面铺开看一下？', { action: 'editor.show-level-plan', target: 'F1' }],
      ['我想从立体角度看看模型', { action: 'editor.set-view', mode: '3d' }],
      ['模型离我有点远，拉近一些', { action: 'editor.zoom-view', direction: 'in' }],
      ['把这个画面往远拉一点', { action: 'editor.zoom-view', direction: 'out' }],
      ['从底到顶每一层都识别一下房间', { action: 'editor.preview-rooms', scope: 'project' }],
      ['能把左下角的小地图收起来么？', { action: 'editor.display', option: 'minimap-off' }],
      ['把已确认的条款过一遍看看结果', { action: 'editor.run-check' }],
      ['F1 有多少房间？', { action: 'model.query', scope: 'question' }],
      ['怎样切换到3D视图？', { action: 'model.query', scope: 'question' }],
      ['所有楼层都找出房间，但跳过二层', { action: 'blocked', gap: 'clarification', reason: '请确认需要预览的楼层范围。' }],
    ] as const;
    const provider = vi.fn<typeof fetch>();
    for (const [, plan] of scenarios)
      provider.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
    const handler = createModelQaHandler(configured, provider);
    for (const [text, plan] of scenarios) {
      expect(localEditorIntent(text), text).toBeUndefined();
      expect(await invoke(handler, 'POST', { channel: 'question', text }, {}, '/pal/intent'))
        .toEqual({ code: 200, data: { plan } });
    }
    const messages = JSON.parse(String(provider.mock.calls[0][1]?.body)).messages;
    expect(messages[0].content).toContain('不要求使用固定命令');
    expect(JSON.parse(messages[1].content).text).toBe(scenarios[0][0]);
  });

  it('lets the model interpret even registered phrases and rejects unsupported plan parameters', async () => {
    let proposal: object = { action: 'editor.preview-rooms', scope: 'project' };
    const provider = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    const handler = createModelQaHandler(configured, provider);
    const submit = (text: string) => invoke(handler, 'POST', { channel: 'question', text }, {}, '/pal/intent');
    expect(await submit('在所有楼层自动创建房间')).toEqual({ code: 200, data: { plan: proposal } });
    proposal = { action: 'editor.preview-rooms', scope: 'project', confirmed: true };
    expect((await submit('在所有楼层自动创建房间')).code).toBe(502);
    proposal = { action: 'editor.replace-rooms', scope: 'project' };
    expect((await submit('把所有楼层的房间替换掉')).code).toBe(502);
  });

  it('asks for the floor when the model invents a reference or reads part of one', async () => {
    let proposal: object = { action: 'editor.show-level-plan', target: 'F1' };
    const provider = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    const handler = createModelQaHandler(configured, provider);
    const submit = (text: string) => invoke(handler, 'POST', { channel: 'question', text }, {}, '/pal/intent');
    const clarification = { code: 200, data: { plan: { action: 'blocked', gap: 'clarification' } } };
    expect(await submit('切换到F2')).toMatchObject(clarification);
    expect(await submit('显示F10的2D视图')).toMatchObject(clarification);
    expect(await submit('Show F1 as a floor plan')).toEqual({ code: 200, data: { plan: proposal } });
    proposal = { action: 'editor.go-level', target: '二层' };
    expect(await submit('带我去十二层')).toMatchObject(clarification);
    expect(await submit('带我去地下二层')).toMatchObject(clarification);
  });

  it('round-trips the shared command catalog and leaves model questions on the evidence route', () => {
    for (const [action, definition] of Object.entries(editorCommands)) {
      for (const example of definition.examples) {
        const plan = localEditorIntent(example);
        expect(plan, example).toMatchObject({ action });
        expect(parsePalIntent(plan, 'question')).toEqual(plan);
        expect(parsePalIntent(plan, 'area')).toEqual(action === 'editor.property-area' ? plan : undefined);
      }
    }
    for (const question of ['F2 有多少房间？', '概况包括哪些楼层', '如何运行模型核查', '切换到哪一层', '显示所有楼层的面积'])
      expect(localEditorIntent(question), question).toBeUndefined();
    expect(parsePalIntent({ action: 'editor.go-level', target: 'F2', command: 'delete' }, 'question')).toBeUndefined();
    const transfer = { action: 'editor.transfer-floor-assignment', source: 'F2', target: 'F3' } as const;
    expect(parsePalIntent(transfer, 'question')).toEqual(transfer);
    expect(localEditorIntent('按F2相同的位置对F3进行归户')).toEqual({ ...transfer, source: 'f2', target: 'f3' });
    expect(editorIntentHasGroundedTarget(transfer, '参照F2的分户，把F3也按门位置归一遍')).toBe(true);
    expect(editorIntentHasGroundedTarget(transfer, '参照F2的分户，把F4也按门位置归一遍')).toBe(false);
    expect(editorIntentHasGroundedTarget({ ...transfer, source: 'F3', target: 'F2' }, '按F2相同的位置对F3进行归户')).toBe(false);
    expect(parsePalIntent({ ...transfer, target: ' f2 ' }, 'question')).toBeUndefined();
    const task = { format: 'bimdown.development-request', version: 1, module: 'area', title: '显示门编号',
      current: '打开归户预览。', desired: '显示门编号。', acceptance: '在预览中核对编号。', constraints: '' };
    expect(parsePalIntent({ action: 'development.draft', task }, 'question')).toEqual({ action: 'development.draft', task });
    expect(parsePalIntent({ action: 'development.draft', task, run: true }, 'question')).toBeUndefined();
    expect(parsePalIntent({ action: 'development.draft', task: { ...task, command: 'unexpected' } }, 'question')).toBeUndefined();
    expect(parsePalIntent({ action: 'development.draft', task }, 'development')).toEqual({ action: 'development.draft', task });
    expect(parsePalIntent({ action: 'model.query', scope: 'question' }, 'development')).toBeUndefined();
    const desired = '本层批量分户中，预览本层分户，应将分户后不同户及公共区域以不同颜色显示。';
    expect(parseDevelopmentRequest(localDevelopmentDraft(`**系统改进：${desired}**`)).desired).toBe(desired);
    expect(parseDevelopmentRequest(localDevelopmentDraft(`**系统改进：**${desired}`)).desired).toBe(desired);
    expect(parsePalIntent({ action: 'editor.zoom-view', direction: 'out', factor: 20 }, 'question')).toBeUndefined();
  });

  it('resolves levels using labels, scoped IDs and elevation without picking between duplicate names', () => {
    const levels = [
      { id: 'lv-2', number: '2', name: 'F2', elevation: 3 },
      { id: 'lv-1', number: '1', name: 'F1', elevation: 0 },
      { id: 'lv-3', number: '3', name: '设备层', elevation: 6 },
    ];
    expect(matchEditorLevel(levels, 'lv-1', '二层').level?.id).toBe('lv-2');
    expect(matchEditorLevel(levels, 'lv-1', '上层').level?.id).toBe('lv-2');
    expect(matchEditorLevel(levels, 'lv-1', '上一层').level?.id).toBe('lv-2');
    expect(matchEditorLevel(levels, 'lv-1', '下层').level).toBeUndefined();
    expect(matchEditorLevel(levels, 'lv-1', 'LV-3').level?.id).toBe('lv-3');
    expect(matchEditorLevel(levels, 'lv-2', 'F1').level?.id).toBe('lv-1');
    expect(matchEditorLevel(levels, 'lv-2', 'F9').level).toBeUndefined();
    const duplicate = [...levels, { ...levels[2], id: 'lv-4' }];
    expect(matchEditorLevel(duplicate, 'lv-1', '设备层')).toEqual({ ambiguous: true });
    expect(matchEditorLevel(duplicate, 'lv-1', '顶层')).toEqual({ ambiguous: true });
  });

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

  it('routes the Shanghai property workflow from both entrances without authorizing calculation or forwarding evidence', async () => {
    let proposal: object = { action: 'editor.property-area', task: 'allocate' };
    const provider = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    const handler = createModelQaHandler(configured, provider);
    const text = '准备按上海2022版复算整幢住宅的房产面积';
    for (const channel of ['area', 'question']) {
      expect(await invoke(handler, 'POST', { channel, text, evidence: ['model geometry'], confirmed: true }, {}, '/pal/intent'))
        .toEqual({ code: 200, data: { plan: proposal } });
    }
    const messages = JSON.parse(String(provider.mock.calls[0][1]?.body)).messages;
    expect(messages[0].content).toContain('先检查复核证据，再由用户审核后运行');
    expect(JSON.parse(messages[1].content)).toEqual({ text });
    proposal = { action: 'editor.property-area', task: 'allocate', confirmed: true };
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
