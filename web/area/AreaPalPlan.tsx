import { useEffect, useRef, useState } from 'react';
import { useDataSource } from 'bimdown-editor';
import { MAX_CLAUSE_TEXT_LENGTH } from '../check/check-import.js';
import { compilePalIntent } from './pal-client.js';
import { PAL_INTENT_LIMIT, type PalIntent } from './pal-intent.js';
import type { PropertyAreaIntent } from './editor-commands.js';
import type { ModelQaConnection } from './model-qa-types.js';

export function AreaPalPlan({ connection, floor, busy, canCalculate, canOutline, calculate, outline, openCheck, property }: {
  connection?: ModelQaConnection;
  floor: { id: string; name?: string };
  busy: boolean;
  canCalculate: boolean;
  canOutline: boolean;
  calculate: () => void;
  outline: (scope: 'level' | 'project') => void;
  openCheck: (text: string) => void;
  property: (plan: PropertyAreaIntent) => void;
}) {
  const ds = useDataSource();
  const request = useRef<AbortController | undefined>(undefined);
  const [text, setText] = useState('');
  const [candidate, setCandidate] = useState<{ plan: PalIntent; floor: typeof floor }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const host = connection?.configuration?.host;
  useEffect(() => {
    setCandidate(undefined);
    setError('');
    setPending(false);
    return () => request.current?.abort();
  }, [ds, host, connection?.sessionId, connection?.configuration?.model]);

  async function generate() {
    if (!host || !text.trim() || pending) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    setCandidate(undefined);
    try {
      const { plan } = await compilePalIntent('area', text.trim(), connection?.sessionId, controller.signal);
      if (!controller.signal.aborted) setCandidate({ plan, floor });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法制定测算计划。');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const plan = candidate?.plan;
  const floorChanged = plan?.action === 'area.outlines' && plan.scope === 'level' && candidate?.floor.id !== floor.id;
  return <details>
    <summary>用自然语言制定测算计划</summary>
    <form onSubmit={event => { event.preventDefault(); void generate(); }}>
      <label>测算要求<textarea rows={2} maxLength={PAL_INTENT_LIMIT} value={text} disabled={pending}
        placeholder="例如 按现有配置测算全项目面积并分摊"
        onChange={event => { setText(event.target.value); setCandidate(undefined); setError(''); }} /></label>
      <small>{host ? `制定计划时向 ${host} 发送要求文本。` : '请先在页面底部配置 PAL 语言模型。'}</small>
      <p><button type="submit" disabled={!host || !text.trim() || pending}>
        {pending ? '正在制定计划…' : '生成 PAL 测算计划'}
      </button></p>
    </form>
    {error && <p className="area-error" role="alert">{error}</p>}
    {plan?.action === 'blocked' && <p role="status">
      {plan.gap === 'missing-tool' ? '缺少工具' : '需要澄清'} · {plan.reason}
    </p>}
    {plan?.action === 'check.clause' && (text.trim().length <= MAX_CLAUSE_TEXT_LENGTH
      ? <button type="button" onClick={() => openCheck(text.trim())}>将原文交给模型核查</button>
      : <p>请将要求拆成不超过 {MAX_CLAUSE_TEXT_LENGTH} 字的独立条款，再到模型核查编译。</p>)}
    {plan?.action === 'area.allocate' && <>
      <p>计划按当前配置测算全项目并执行分摊。</p>
      {!canCalculate && <small>请先在下方核对测算配置、规则来源并确认审核。</small>}
      <p><button type="button" disabled={busy || !canCalculate} onClick={calculate}>执行 PAL 测算计划</button></p>
    </>}
    {plan?.action === 'editor.property-area' && <>
      <p>{plan.task === 'inspect' ? '计划读取当前项目的房产面积候选证据。' : '计划先检查上海 2022 版整幢住宅复算所需证据。通过预检后，请在专项面板审核并运行。'}</p>
      <button type="button" disabled={busy} onClick={() => property(plan)}>
        {plan.task === 'inspect' ? '提取房产面积候选证据' : '打开专项并检查复算条件'}
      </button>
    </>}
    {candidate && plan?.action === 'area.outlines' && <>
      <p>计划为{plan.scope === 'project' ? '全部楼层' : candidate.floor.name ?? candidate.floor.id}生成并保存测算轮廓。</p>
      {floorChanged && <small>当前楼层已切换，请重新生成计划。</small>}
      <button type="button" disabled={busy || !canOutline || floorChanged}
        onClick={() => outline(plan.scope)}>确认范围并生成轮廓</button>
    </>}
  </details>;
}
