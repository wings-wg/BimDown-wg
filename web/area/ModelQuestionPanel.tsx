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
import { editorCommandExamples, isEditorIntent, localEditorIntent, matchEditorLevel,
  type EditorIntent, type WorkspaceCommandRequest, type WorkspacePanel } from './editor-commands.js';
import { AutomaticRooms } from './AutomaticRooms.tsx';
import './model-qa.css';

type Turn = {
  question: string;
  level: string;
  evidence: ModelEvidence[];
  answer?: string;
  model?: string;
  error?: string;
  plan?: PalIntent;
  operation?: string;
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

export function ModelQuestionPanel({ report, areaDraft, onConnectionChange, openCheck, openPanel, runWorkspaceCommand, toolDrafted }: {
  report?: ReturnType<typeof calculateProjectAreasFromText>;
  areaDraft: string;
  onConnectionChange?: (connection: ModelQaConnection) => void;
  openCheck: (text?: string) => void;
  openPanel: (panel: WorkspacePanel) => void;
  runWorkspaceCommand: (request: WorkspaceCommandRequest) => void;
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
  const activeSource = useRef(ds);
  activeSource.current = ds;
  const activeState = useRef(state);
  activeState.current = state;
  const activeSession = useRef(sessionId);
  const provider = configuration?.model && configuration.host ? configuration : undefined;

  useEffect(() => {
    onConnectionChange?.({ sessionId, configuration });
  }, [sessionId, configuration, onConnectionChange]);

  useEffect(() => {
    const controller = new AbortController();
    function updateConfiguration(status: ModelQaInfo) {
      if (!controller.signal.aborted && activeSession.current === sessionId) setConfiguration(status);
    }
    fetch(MODEL_QA_PATH, { signal: controller.signal,
      headers: sessionId ? { [MODEL_QA_SESSION_HEADER]: sessionId } : {} }).then(async response => {
      updateConfiguration(response.ok ? await response.json() as ModelQaInfo : {});
    }).catch(() => updateConfiguration({}));
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

  function executeEditorCommand(plan: EditorIntent, levelAtRequest: string): string | undefined {
    const current = activeState.current;
    switch (plan.action) {
      case 'editor.set-view':
        dispatch({ type: 'SET_VIEW_MODE', mode: plan.mode });
        return;
      case 'editor.show-floors': {
        dispatch({ type: 'SET_FLOOR_3D_MODE', mode: plan.mode });
        dispatch({ type: 'SET_VIEW_MODE', mode: '3d' });
        const range = { all: '全部楼层', current: '当前楼层', 'current+below': '当前楼层及以下' } as const;
        return `3D 视图已切换为显示${range[plan.mode]}。`;
      }
      case 'editor.show-level-plan':
      case 'editor.go-level': {
        if (/^(?:(?:上|下)一?层|(?:当前|本)(?:楼)?层)$/.test(plan.target.trim()) && levelAtRequest !== current.currentLevel)
          return '当前楼层已变化，请重新发送楼层切换指令。';
        const { level, ambiguous } = matchEditorLevel(current.project?.levels ?? [], current.currentLevel, plan.target);
        if (ambiguous) return '匹配到多个楼层，请指定楼层编号。';
        if (!level) return `当前项目没有匹配的楼层「${plan.target}」。`;
        if (plan.action === 'editor.show-level-plan') {
          if (current.viewMode !== '2d') dispatch({ type: 'SET_VIEW_MODE', mode: '2d' });
          if (level.id !== current.currentLevel) {
            dispatch({ type: 'SET_FLOOR_3D_MODE', mode: 'current' });
            dispatch({ type: 'SET_LEVEL', levelId: level.id });
          }
          return `已显示 ${level.name || level.id} 的 2D 视图。`;
        }
        if (current.viewMode === '2d') dispatch({ type: 'SET_FLOOR_3D_MODE', mode: 'current' });
        dispatch({ type: 'SET_LEVEL', levelId: level.id });
        return `已切换至 ${level.name || level.id}。`;
      }
      case 'editor.clear-selection':
        dispatch({ type: 'CLEAR_SELECTION' });
        return '已取消选择。';
      case 'editor.fit-plan':
        if (current.viewMode !== '2d') return '请先切换到二维视图，再执行全图显示。';
        window.dispatchEvent(new Event('bimdown:zoom-fit'));
        return '已调整二维平面视图。';
      case 'editor.zoom-view': {
        const operation = plan.direction === 'in' ? '放大' : '缩小';
        const event = new CustomEvent('bimdown:zoom-step', { detail: plan.direction, cancelable: true });
        return window.dispatchEvent(event) ? '视图尚未就绪或已达到缩放极限。' : `已${operation}当前视图。`;
      }
      case 'editor.display': {
        if (current.viewMode !== '2d') return '该显示选项用于二维视图。';
        const visible = plan.option.endsWith('-on');
        const display = plan.option.split('-')[0];
        if (display === 'grid' && current.showGrid !== visible) dispatch({ type: 'TOGGLE_GRID' });
        if (display === 'numbers' && current.viewOptions.showElementNumbers !== visible)
          dispatch({ type: 'TOGGLE_VIEW_OPTION', key: 'showElementNumbers' });
        if (display === 'minimap' && current.showMinimap !== visible) dispatch({ type: 'TOGGLE_MINIMAP' });
        return `${visible ? '已显示' : '已隐藏'}${display === 'grid' ? '网格' : display === 'numbers' ? '构件编号' : '小地图'}。`;
      }
      case 'editor.history': {
        const undo = plan.operation === 'undo';
        const verb = undo ? '撤销' : '重做';
        if (current.readonly || current.groupEdit) return `请先打开可编辑的项目并退出组编辑，再${verb}。`;
        if (current.history !== state.history) return `编辑记录已变化，请重新说明要${verb}的操作。`;
        const stack = undo ? current.history.undoStack : current.history.redoStack;
        if (!stack.length) return `当前没有可${verb}的编辑记录。`;
        dispatch({ type: undo ? 'UNDO' : 'REDO' });
        return `已${verb}一次编辑。`;
      }
      case 'editor.open-panel': {
        openPanel(plan.panel);
        const name = { area: '面积测算与分摊', check: '模型核查', feedback: '功能建议' } as const;
        return `已打开${name[plan.panel]}。`;
      }
      case 'editor.run-check':
        runWorkspaceCommand({ plan, level: levelAtRequest });
        return '已将运行请求交给模型核查，状态显示在核查面板。';
      case 'editor.area-workflow':
        runWorkspaceCommand({ plan, level: levelAtRequest });
        return '已打开对应的面积测算操作，状态显示在面积面板。';
      case 'editor.preview-rooms':
      case 'editor.help':
        return;
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = question.trim();
    if (pending || !prompt || !configuration) return;
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
          result.error = `PAL 意图识别暂不可用，已转入模型证据查询。 ${error instanceof Error ? error.message : ''}`;
        }
      } else result.plan = localEditorIntent(prompt);
      const candidate = result.plan;
      if (isEditorIntent(candidate)) {
        if (controller.signal.aborted || activeSource.current !== ds) return;
        result.operation = executeEditorCommand(candidate, result.level);
        return;
      }
      const plan = result.plan;
      if (plan?.action === 'check.clause' || plan?.action === 'tool.draft') return;
      if (plan?.action === 'tool.measure') {
        const tool = compilation?.tool;
        if (!tool || tool.id !== plan.toolId) throw new Error('PAL 未返回可核验的量测工具。');
        result.evidence = await collectToolMeasurements(state, selectedIds, ds, tool, plan.scope, prompt, previousQuestion);
      } else {
        result.evidence = await collectModelEvidence(state, selectedIds, ds, prompt, previousQuestion, report, areaDraft,
          plan?.action === 'model.query' ? plan.scope : undefined);
      }
      if (controller.signal.aborted) return;
      if (provider && result.evidence.length) {
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
      if (!controller.signal.aborted && activeSource.current === ds) {
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
    <div className="model-qa-result" id="model-qa-result" aria-live="polite" hidden={!expanded || settingsOpen}>
      {pending && <p role="status">正在识别请求…</p>}
      {turn && <>
        <div className="model-qa-question">{turn.question}</div>
        {turn.error && <p role="alert" className="model-qa-error">{turn.error}</p>}
        {turn.operation && <p role="status">{turn.operation}</p>}
        {turn.plan?.action === 'editor.help' && <ul className="model-qa-commands">
          {editorCommandExamples.map(example => <li key={example}>
            <button type="button" onClick={() => setQuestion(example)}>{example}</button>
          </li>)}
        </ul>}
        {turn.plan?.action === 'editor.set-view' && <p role="status">
          {state.viewMode === turn.plan.mode ? `当前为 ${turn.plan.mode === '3d' ? '3D' : '2D'} 视图。` : '当前视图已变化。'}
        </p>}
        {turn.plan?.action === 'editor.preview-rooms' &&
          <AutomaticRooms request={{ scope: turn.plan.scope, level: turn.level }} />}
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
    </div>
    <form className="model-qa-form" onSubmit={event => void ask(event)}>
      <label htmlFor="model-qa-question">模型问答</label>
      <input id="model-qa-question" value={question} maxLength={MAX_QUESTION_LENGTH} autoComplete="off"
        placeholder="输入「可用命令」查看操作，或提问模型" onChange={event => setQuestion(event.target.value)} />
      <button type="submit" className="model-qa-submit" disabled={!question.trim() || pending || settingsOpen || !state.project || !configuration}>
        {pending ? '处理中…' : '提问'}
      </button>
      {(turn || pending) && !settingsOpen && <button type="button" aria-expanded={expanded} aria-controls="model-qa-result"
        onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开'}</button>}
      <button type="button" disabled={pending || settingsPending} aria-expanded={settingsOpen} aria-controls="model-qa-settings"
        onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? '关闭设置' : '模型设置'}</button>
    </form>
    <p className="model-qa-status">
      {floor && <span>当前楼层 {floor.name || floor.id}　</span>}
      {provider ? `由 ${provider.host}（${provider.model}）理解输入意图。查询时会发送匹配的模型证据` :
        !configuration ? '正在读取模型设置…' : configuration.expired ? '云端配置已失效，仍可执行本地操作' : '未启用语言模型，可使用本地命令和模型证据查询'}
    </p>
  </section>;
}
