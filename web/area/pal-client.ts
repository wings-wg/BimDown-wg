import type { PalClause, PalResult } from '../check/pal-plan.js';
import type { ToolEntry } from '../check/core/tool-recipes.js';
import { MODEL_PAL_INTENT_PATH, MODEL_PAL_PATH, MODEL_QA_SESSION_HEADER } from './model-qa-types.js';
import { parsePalIntent, type PalChannel } from './pal-intent.js';

async function postPal<T>(url: string, body: object, sessionId?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(sessionId && { [MODEL_QA_SESSION_HEADER]: sessionId }) },
    body: JSON.stringify(body) });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !payload) throw new Error(payload?.error ?? 'PAL 编译服务暂不可用。');
  return payload;
}

export async function compilePalIntent(channel: PalChannel, text: string, sessionId?: string, signal?: AbortSignal,
  previousQuestion?: string) {
  const payload = await postPal<{ plan: unknown; tool?: ToolEntry }>(MODEL_PAL_INTENT_PATH,
    { channel, text, previousQuestion }, sessionId, signal);
  const plan = parsePalIntent(payload.plan, channel);
  if (!plan) throw new Error('PAL 返回的计划无法绑定到当前入口。');
  return { plan, tool: payload.tool };
}

export async function compilePalClauses(clauses: PalClause[], sessionId?: string, signal?: AbortSignal) {
  const payload = await postPal<{ results: PalResult[]; model: string; tools: ToolEntry[] }>(
    MODEL_PAL_PATH, { clauses }, sessionId, signal);
  if (!Array.isArray(payload.results) || typeof payload.model !== 'string' || !Array.isArray(payload.tools))
    throw new Error('PAL 未返回可用的条款编译结果。');
  return payload;
}
