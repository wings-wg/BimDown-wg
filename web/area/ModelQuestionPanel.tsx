import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDataSource, useEditorDispatch, useEditorState, useSelectionState } from 'bimdown-editor';
import { collectModelEvidence, collectToolMeasurements } from './model-qa-evidence.js';
import { ModelQuestionSettings } from './ModelQuestionSettings.tsx';
import { MAX_QUESTION_LENGTH, MODEL_QA_PATH, MODEL_QA_SESSION_HEADER, type ModelEvidence, type ModelQaConnection, type ModelQaInfo } from './model-qa-types.js';
import type { calculateProjectAreasFromText } from './core/project-input.js';
import { TOOL_PROFILES } from '../check/core/tool-recipes.js';
import { MAX_CLAUSE_TEXT_LENGTH } from '../check/check-import.js';
import { compilePalIntent } from './pal-client.js';
import type { PalIntent } from './pal-intent.js';
import './model-qa.css';

type Turn = {
  question: string;
  level: string;
  evidence: ModelEvidence[];
  answer?: string;
  model?: string;
  error?: string;
  plan?: PalIntent;
};
const storageKey = 'bimdown-model-qa-session';

function restoreSession() {
  try { return window.sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; }
}

function formatFact(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === null) return '待核对';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function ModelQuestionPanel({ report, areaDraft, onConnectionChange, openCheck, toolDrafted }: {
  report?: ReturnType<typeof calculateProjectAreasFromText>;
  areaDraft: string;
  onConnectionChange?: (connection: ModelQaConnection) => void;
  openCheck: (text?: string) => void;
  toolDrafted: () => void;
}) {
  const ds = useDataSource();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const { selectedIds } = useSelectionState();
  const [sessionId, setSessionId] = useState(restoreSession);
  const [configuration, setConfiguration] = useState<ModelQaInfo>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [question, setQuestion] = useState('');
  const [turn, setTurn] = useState<Turn>();
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const activeSession = useRef(sessionId);
  const provider = configuration?.model && configuration.host ? configuration : undefined;

  useEffect(() => {
    onConnectionChange?.({ sessionId, configuration });
  }, [sessionId, configuration, onConnectionChange]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(MODEL_QA_PATH, { signal: controller.signal,
      headers: sessionId ? { [MODEL_QA_SESSION_HEADER]: sessionId } : {} }).then(async response => {
      if (!response.ok) return;
      const status = await response.json() as ModelQaInfo;
      if (!controller.signal.aborted && activeSession.current === sessionId) setConfiguration(status);
    }).catch(() => { /* A standalone or offline app can still show local evidence. */ });
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    setQuestion('');
    setTurn(undefined);
    setExpanded(false);
    setPending(false);
    return () => request.current?.abort();
  }, [ds]);

  function applySettings(id: string, status: ModelQaInfo) {
    try {
      if (id) window.sessionStorage.setItem(storageKey, id);
      else window.sessionStorage.removeItem(storageKey);
    } catch { /* Settings still apply in this tab if browser storage is unavailable. */ }
    activeSession.current = id;
    setSessionId(id);
    setConfiguration(status);
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = question.trim();
    if (pending || !prompt) return;
    const controller = new AbortController();
    request.current = controller;
    const previousQuestion = turn?.level === state.currentLevel && /它|这个|这些|刚才|上述/.test(prompt)
      ? turn.question : undefined;
    const result: Turn = { question: prompt, level: state.currentLevel, evidence: [] };
    setPending(true);
    setExpanded(true);
    setTurn(undefined);
    try {
      let compilation: Awaited<ReturnType<typeof compilePalIntent>> | undefined;
      if (provider) {
        try {
          compilation = await compilePalIntent('question', prompt, sessionId, controller.signal, previousQuestion);
          if (controller.signal.aborted) return;
          result.plan = compilation.plan;
          if (result.plan.action === 'tool.draft') toolDrafted();
        } catch (error) {
          if (controller.signal.aborted) return;
          result.error = `PAL 计划生成失败，已切换为本地证据查询。 ${error instanceof Error ? error.message : ''}`;
        }
      }
      const plan = result.plan;
      if (plan && plan.action !== 'model.query' && plan.action !== 'tool.measure') return;
      if (plan?.action === 'tool.measure') {
        const tool = compilation?.tool;
        if (!tool || tool.id !== plan.toolId) throw new Error('PAL 未返回可核验的量测工具。');
        result.evidence = await collectToolMeasurements(state, selectedIds, ds, tool, plan.scope, prompt, previousQuestion);
      } else {
        result.evidence = await collectModelEvidence(state, selectedIds, ds, prompt, previousQuestion, report, areaDraft, plan?.scope);
      }
      if (controller.signal.aborted) return;
      if (provider && plan && result.evidence.length) {
        const response = await fetch(MODEL_QA_PATH, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(sessionId && { [MODEL_QA_SESSION_HEADER]: sessionId }) },
          body: JSON.stringify({ question: prompt, previousQuestion, evidence: result.evidence }),
        });
        const payload = await response.json() as { answer?: unknown; model?: string; error?: string };
        if (response.status === 409) setConfiguration({ expired: true });
        if (!response.ok || typeof payload.answer !== 'string') throw new Error(payload.error ?? '语言模型回答暂不可用。');
        result.answer = payload.answer;
        result.model = payload.model;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : '查询暂不可用。';
    } finally {
      if (!controller.signal.aborted) {
        setTurn(result);
        setPending(false);
      }
    }
  }

  function locate(target: NonNullable<ModelEvidence['target']>) {
    if (target.level !== state.currentLevel) dispatch({ type: 'SET_LEVEL', levelId: target.level });
    dispatch({ type: 'SELECT', ids: [`${target.level}:${target.elementId}`], exact: true });
  }

  const floor = state.project?.levels.find(level => level.id === state.currentLevel);
  return <section className="model-qa" aria-label="模型问答">
    {settingsOpen && <ModelQuestionSettings sessionId={sessionId} active={configuration}
      pending={settingsPending} setPending={setSettingsPending} onChange={applySettings} />}
    {expanded && !settingsOpen && <div className="model-qa-result" id="model-qa-result" aria-live="polite">
      {pending && <p role="status">{provider ? '正在读取模型证据并生成回答…' : '正在读取模型证据…'}</p>}
      {turn && <>
        <div className="model-qa-question">{turn.question}</div>
        {turn.error && <p role="alert" className="model-qa-error">{turn.error}</p>}
        {turn.plan?.action === 'blocked' && <p role="status">
          {turn.plan.gap === 'missing-tool' ? '缺少工具' : '需要澄清'} · {turn.plan.reason}
        </p>}
        {turn.plan?.action === 'tool.draft' && <p>
          已保存候选工具「{TOOL_PROFILES[turn.plan.recipe.concept].title}」。启用后可再次提问。
          {' '}<button type="button" onClick={() => openCheck()}>审核 PAL 工具</button>
        </p>}
        {turn.plan?.action === 'check.clause' && <p>{turn.question.length <= MAX_CLAUSE_TEXT_LENGTH
          ? <button type="button" onClick={() => openCheck(turn.question)}>将原文交给模型核查</button>
          : '请将要求拆成 800 字以内的独立条款，再到模型核查编译。'}</p>}
        {turn.answer ? <>
          <p className="model-qa-model">{turn.model ?? '语言模型'}</p>
          <div className="model-qa-answer">{turn.answer}</div>
        </> : (!turn.plan || turn.plan.action === 'model.query' || turn.plan.action === 'tool.measure') &&
          <p className="model-qa-model">{turn.evidence.length ? '本地查询结果' : '当前没有可用的模型证据。'}</p>}
        {turn.evidence.length > 0 && <details open={!turn.answer || turn.evidence.some(item => 'BIMDown导出文件' in item.facts)}>
          <summary>模型证据（{turn.evidence.length}）</summary>
          <ol className="model-qa-sources">
            {turn.evidence.map((evidence, index) => <li key={`${index}-${evidence.source}`}>
              <div className="model-qa-source-heading">
                <strong>[E{index + 1}] {evidence.label}</strong>
                {evidence.target && <button type="button" onClick={() => locate(evidence.target!)}>定位</button>}
              </div>
              <small>{evidence.source}</small>
              <dl>
                {Object.entries(evidence.facts).filter(([, value]) => value !== undefined).map(([key, value]) =>
                  <div key={key}><dt>{key}</dt><dd>{formatFact(value)}</dd></div>)}
              </dl>
            </li>)}
          </ol>
        </details>}
      </>}
    </div>}
    <form className="model-qa-form" onSubmit={event => void ask(event)}>
      <label htmlFor="model-qa-question">模型问答</label>
      <input id="model-qa-question" value={question} maxLength={MAX_QUESTION_LENGTH} autoComplete="off"
        placeholder="例如 F1-room3 的面积和归属是什么？" onChange={event => setQuestion(event.target.value)} />
      <button type="submit" className="model-qa-submit" disabled={!question.trim() || pending || settingsOpen || !state.project}>
        {pending ? '查询中…' : '提问'}
      </button>
      {(turn || pending) && !settingsOpen && <button type="button" aria-expanded={expanded} aria-controls="model-qa-result"
        onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开'}</button>}
      <button type="button" disabled={pending || settingsPending} aria-expanded={settingsOpen} aria-controls="model-qa-settings"
        onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? '关闭设置' : '模型设置'}</button>
    </form>
    <p className="model-qa-status">
      {floor && <span>当前楼层 {floor.name || floor.id}　</span>}
      {provider ? `提问时发送问题和匹配的证据到 ${provider.host}（${provider.model}）` :
        configuration?.expired ? '云端配置已失效，可在模型设置中重新启用' : '未配置语言模型，可查询本地模型证据'}
    </p>
  </section>;
}
