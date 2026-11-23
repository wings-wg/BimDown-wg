import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createModelQaHandler } from './model-qa-server.ts';
import { MODEL_QA_SESSION_HEADER } from './src/area/model-qa-types.ts';

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
