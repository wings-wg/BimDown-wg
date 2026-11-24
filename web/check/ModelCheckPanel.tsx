import { useEffect, useMemo, useRef, useState } from 'react';
import { unitRoomView, useDataSource, useEditorDispatch, useEditorState, ZOOM_TO_EVENT } from 'bimdown-editor';
import { HEIGHT, MAX_CLAUSE_TEXT_LENGTH, ROOM_NET_AREA, bindPalPlan, importJsonRules, importSheetRules, importTextRule, type CheckItem } from './check-import.js';
import { PAL_BATCH_SIZE } from './pal-plan.js';
import { MODEL_PAL_LIBRARY_PATH, type ModelQaConnection } from '../area/model-qa-types.js';
import { compilePalClauses } from '../area/pal-client.js';
import { readCheckLevels, readCheckRooms, runModelCheck, type RoomClearHeightEntry } from './check-model.js';
import { storeyHeightMetres, suggestStoreyChoices, type StoreyChoice } from './storey-height.js';
import { RoomClearHeightFields } from './RoomClearHeightFields.tsx';
import { ModelCheckLibrary } from './ModelCheckLibrary.tsx';
import { TOOL_PROFILES, type ToolEntry } from './core/tool-recipes.js';
import './model-check.css';

const labels = { fail: '不通过', pass: '通过', indeterminate: '无法判断', 'not-applicable': '不适用' } as const;
const ordering = ['fail', 'indeterminate', 'pass', 'not-applicable'] as const;
type Status = keyof typeof labels;
type Report = Awaited<ReturnType<typeof runModelCheck>>;
type CheckInput = { fileName: string; items: CheckItem[]; needsCompile: boolean; models?: string[] };
const measurement = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 });
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 4 });
const EXCLUDED = ':excluded';
const MANUAL = ':manual';
const gapLabels = { 'missing-tool': '缺少核查工具', 'external-evidence': '缺少外部证据', clarification: '条款待澄清' };

async function fetchLibrary(signal?: AbortSignal): Promise<ToolEntry[]> {
  const response = await fetch(MODEL_PAL_LIBRARY_PATH, { signal });
  if (!response.ok) throw new Error('无法读取工具库。');
  return (await response.json()).tools as ToolEntry[];
}

function saveJson(value: unknown, fileName: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ModelCheckPanel({ open, close, connection, libraryRevision, textDraft, setTextDraft }: {
  open: boolean; close: () => void; connection?: ModelQaConnection;
  libraryRevision: number; textDraft: string; setTextDraft: (value: string) => void;
}) {
  const ds = useDataSource();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [input, setInput] = useState<CheckInput>();
  const [compileProgress, setCompileProgress] = useState<{ done: number; total: number }>();
  const [library, setLibrary] = useState<ToolEntry[]>([]);
  const [excludedRules, setExcludedRules] = useState(new Set<string>());
  const compileRequest = useRef<AbortController>(undefined);
  const [levelData, setLevelData] = useState<Awaited<ReturnType<typeof readCheckLevels>>>();
  const [storeyEdits, setStoreyEdits] = useState(new Map<string, StoreyChoice>());
  const [clearHeightEntries, setClearHeightEntries] = useState(new Map<string, RoomClearHeightEntry>());
  const [roomInventory, setRoomInventory] = useState<Awaited<ReturnType<typeof readCheckRooms>>>();
  const [reviewed, setReviewed] = useState(false);
  const [report, setReport] = useState<Report>();
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [focus, setFocus] = useState<{ level: string; id: string; table: string }>();
  const fileRequest = useRef(0);
  const runRequest = useRef(0);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const textDetails = useRef<HTMLDetailsElement>(null);
  const doc = useRef<{ level?: string; version: number }>(undefined);
  const originalSource = useRef(ds);
  const levelSnapshot = useRef<Awaited<ReturnType<typeof readCheckLevels>>['raw']>(undefined);
  const roomSnapshot = useRef<string>(undefined);
  const suggestions = useMemo(() => suggestStoreyChoices(levelData?.levels ?? []), [levelData]);
  const configuredModel = connection?.configuration?.host && connection.configuration.model ? connection.configuration : undefined;
  const pendingClauses = input?.items.flatMap(item => item.clause && !item.plan ? [item.clause] : []) ?? [];
  const activeItems = input?.items.map(item => excludedRules.has(item.id)
    ? { ...item, rule: undefined, clearHeightRule: undefined, libraryTool: undefined, reason: '本次未审核放行。' } : item) ?? [];
  const hasHeight = activeItems.some(item => item.rule?.concept === HEIGHT);
  const hasRoomArea = activeItems.some(item => item.rule?.concept === ROOM_NET_AREA);
  const clearHeightThresholds = [...new Set(activeItems.flatMap(item => item.clearHeightRule ? [item.clearHeightRule.nominalHeight] : []))];
  const hasClearHeight = clearHeightThresholds.length > 0;
  const hasLibraryRules = activeItems.some(item => item.libraryTool && item.rule);
  const needsReview = hasHeight || hasRoomArea || hasClearHeight || hasLibraryRules;

  useEffect(() => {
    if (open && textDraft && textDetails.current) textDetails.current.open = true;
  }, [open, textDraft]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetchLibrary(controller.signal).then(tools => {
      if (!controller.signal.aborted) setLibrary(tools);
    }, () => { /* JSON without a library remains usable offline. */ });
    return () => controller.abort();
  }, [open, libraryRevision]);

  useEffect(() => {
    if (originalSource.current !== ds) {
      originalSource.current = ds;
      fileRequest.current++;
      runRequest.current++;
      setInput(undefined);
      compileRequest.current?.abort();
      compileRequest.current = undefined;
      setCompileProgress(undefined);
      setExcludedRules(new Set());
      setStoreyEdits(new Map());
      setClearHeightEntries(new Map());
      roomSnapshot.current = undefined;
      levelSnapshot.current = undefined;
      setReviewed(false);
      setReport(undefined);
      setFocus(undefined);
      setBusy(false);
      setReading(false);
      setError('');
      setNotice('');
    }
    return ds.watchChanges(path => {
      if (path === 'project_metadata.json' || path === 'engineering_evidence.json' || path.endsWith('.csv') || path.endsWith('.geojson'))
        setRevision(value => value + 1);
    });
  }, [ds]);

  useEffect(() => () => compileRequest.current?.abort(), [connection?.sessionId, connection?.configuration?.model]);

  useEffect(() => {
    let active = true;
    runRequest.current++;
    setReport(undefined);
    setFocus(undefined);
    setBusy(false);
    setLevelData(undefined);
    setReviewed(false);
    void readCheckLevels(ds).then(data => {
      if (!active) return;
      if (data.raw.some((text, i) => text !== levelSnapshot.current?.[i])) setStoreyEdits(new Map());
      levelSnapshot.current = data.raw;
      setLevelData(data);
    }, reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [ds, revision, state.project?.levels]);

  useEffect(() => {
    let active = true;
    setRoomInventory(undefined);
    if (!levelData || !hasClearHeight) return;
    void readCheckRooms(ds, levelData.levels).then(inventory => {
      if (!active) return;
      if (roomSnapshot.current !== inventory.snapshot) setClearHeightEntries(new Map());
      roomSnapshot.current = inventory.snapshot;
      setRoomInventory(inventory);
    }, reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [ds, levelData, hasClearHeight]);

  useEffect(() => {
    const level = state.document?.levelId;
    const previous = doc.current;
    doc.current = { level, version: state.documentVersion };
    if (previous && level === previous.level && state.documentVersion !== previous.version)
      setRevision(value => value + 1);
  }, [state.document?.levelId, state.documentVersion]);

  useEffect(() => {
    if (!focus || state.currentLevel !== focus.level || state.viewMode !== '2d') return;
    if (focus.table !== 'space') {
      if (state.document?.levelId !== focus.level) return;
      const element = state.document.elements.get(focus.id);
      setFocus(undefined);
      if (element?.tableName !== focus.table) {
        setNotice('当前平面找不到该构件，请核对模型导出和构件 ID。');
        return;
      }
      const layer = state.project?.floors.get(focus.level)?.layers.find(item => item.tableName === focus.table);
      if (layer) {
        const key = `${layer.discipline}/${layer.tableName}`;
        if (state.activeDiscipline !== 'all' && state.activeDiscipline !== layer.discipline)
          dispatch({ type: 'SET_DISCIPLINE', discipline: 'all' });
        if (!state.visibleLayers.has(key))
          dispatch({ type: 'SET_VISIBLE_LAYERS', keys: new Set([...state.visibleLayers, key]) });
      }
      dispatch({ type: 'SELECT', ids: [`${focus.level}:${focus.id}`], exact: true });
      setNotice('已在平面图中选中构件。');
      return;
    }
    const view = unitRoomView(state, focus.level, new Set([focus.id]));
    if (!view) return;
    setFocus(undefined);
    if (!view.ids.length) {
      setNotice('当前模型中找不到该房间，请重新核查。');
      return;
    }
    const roomLayer = 'architecture/space';
    if (!state.visibleLayers.has(roomLayer))
      dispatch({ type: 'SET_VISIBLE_LAYERS', keys: new Set([...state.visibleLayers, roomLayer]) });
    dispatch({ type: 'SELECT', ids: view.ids, exact: true });
    if (view.bounds) window.dispatchEvent(new CustomEvent(ZOOM_TO_EVENT, { detail: view.bounds }));
    setNotice('已在平面图中选中房间。');
  }, [focus, state, dispatch]);

  function startInput() {
    const id = ++fileRequest.current;
    compileRequest.current?.abort();
    compileRequest.current = undefined;
    setCompileProgress(undefined);
    setExcludedRules(new Set());
    runRequest.current++;
    setInput(undefined);
    setReport(undefined);
    setFocus(undefined);
    setNotice('');
    setError('');
    setClearHeightEntries(new Map());
    setReviewed(false);
    setBusy(false);
    setReading(true);
    return id;
  }

  async function load(file: File) {
    const id = startInput();
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('条款文件不能超过 5 MB。');
      let items: CheckItem[];
      const excel = /\.xlsx$/i.test(file.name);
      if (excel) {
        const { readClauseWorkbook } = await import('./check-xlsx.js');
        const { sheet, rows } = await readClauseWorkbook(await file.arrayBuffer());
        items = importSheetRules(file.name, sheet, rows);
      } else if (/\.json$/i.test(file.name)) {
        const [text, tools] = await Promise.all([file.text(), fetchLibrary().catch(() => [])]);
        items = importJsonRules(text, tools);
      } else {
        throw new Error('请选择 .xlsx 或 .json 条款文件。');
      }
      if (id === fileRequest.current) setInput({ fileName: file.name, items, needsCompile: excel });
    } catch (reason) {
      if (id === fileRequest.current)
        setError(`文件导入失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (id === fileRequest.current) setReading(false);
    }
  }

  async function loadText() {
    if (!configuredModel || reading || compileRequest.current || busy) return;
    const id = startInput();
    try {
      const item = await importTextRule(textDraft);
      if (id !== fileRequest.current) return;
      const next = { fileName: '自然语言条款', items: [item], needsCompile: true };
      setInput(next);
      setReading(false);
      await compile(next);
    } catch (reason) {
      if (id === fileRequest.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (id === fileRequest.current) setReading(false);
    }
  }

  async function compile(source = input) {
    const clausesToCompile = source?.items.flatMap(item => item.clause && !item.plan ? [item.clause] : []) ?? [];
    if (!configuredModel || !clausesToCompile.length || compileRequest.current) return;
    const controller = new AbortController();
    compileRequest.current = controller;
    const upload = fileRequest.current;
    setError('');
    setReviewed(false);
    invalidateReport();
    setCompileProgress({ done: 0, total: clausesToCompile.length });
    try {
      for (let start = 0; start < clausesToCompile.length; start += PAL_BATCH_SIZE) {
        const clauses = clausesToCompile.slice(start, start + PAL_BATCH_SIZE);
        const { results, model, tools } = await compilePalClauses(clauses, connection?.sessionId, controller.signal);
        if (upload !== fileRequest.current || controller.signal.aborted) return;
        const plans = new Map(results.map(result => [result.id, result.plan]));
        setLibrary(tools);
        setInput(current => current && { ...current, models: [...new Set([...(current.models ?? []), model])],
          items: current.items.map(item => {
            const plan = plans.get(item.id);
            return plan ? bindPalPlan(item, plan, tools) : item;
          }) });
        setCompileProgress({ done: start + clauses.length, total: clausesToCompile.length });
      }
    } catch (reason) {
      if (upload === fileRequest.current) setError(controller.signal.aborted
        ? 'PAL 编译已停止，未完成的条款可以继续编译。'
        : `PAL 编译中断：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (compileRequest.current === controller) {
        compileRequest.current = undefined;
        if (upload === fileRequest.current) setCompileProgress(undefined);
      }
    }
  }

  async function approveTool(entry: ToolEntry) {
    setError('');
    try {
      const response = await fetch(`${MODEL_PAL_LIBRARY_PATH}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId: entry.id, reviewed: true }),
      });
      const payload = await response.json() as { tool?: ToolEntry; error?: string };
      if (!response.ok || !payload.tool) throw new Error(payload.error ?? '工具启用失败。');
      const tool = payload.tool;
      setLibrary(previous => [...previous.filter(item => item.id !== tool.id), tool]);
      setInput(current => current && { ...current, items: current.items.map(item => item.plan?.kind === 'tool-draft' &&
        item.plan.toolId === tool.id ? bindPalPlan(item, item.plan, [tool]) : item) });
      setReviewed(false);
      invalidateReport();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function run(confirmed = reviewed) {
    if (!input || !levelData || compileProgress || (needsReview && !confirmed) || (hasClearHeight && !roomInventory)) return;
    const id = ++runRequest.current;
    setReport(undefined);
    setNotice('');
    setError('');
    setBusy(true);
    try {
      const result = await runModelCheck(ds, activeItems, new Map([...suggestions, ...storeyEdits]), levelData.raw,
        roomInventory && { snapshot: roomInventory.snapshot, entries: clearHeightEntries });
      if (id === runRequest.current) {
        setFilter('all');
        setReport(result);
      }
    } catch (reason) {
      if (id === runRequest.current)
        setError(`核查失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (id === runRequest.current) setBusy(false);
    }
  }

  useEffect(() => { if (report) resultsHeading.current?.focus(); }, [report]);

  function invalidateReport() {
    runRequest.current++;
    setBusy(false);
    setReport(undefined);
    setFocus(undefined);
    setNotice('');
  }

  function editStorey(level: string, choice: StoreyChoice) {
    setStoreyEdits(previous => new Map(previous).set(level, choice));
    invalidateReport();
  }

  function locate(object: NonNullable<Report['results'][number]['object']>) {
    const level = object.table === 'level' ? object.id : object.scope;
    if (!state.project?.levels.some(candidate => candidate.id === level)) {
      setNotice('当前模型中找不到该楼层，请重新核查。');
      return;
    }
    if (state.viewMode !== '2d') dispatch({ type: 'SET_VIEW_MODE', mode: '2d' });
    if (object.table === 'space' && state.activeDiscipline !== 'all' && state.activeDiscipline !== 'architecture')
      dispatch({ type: 'SET_DISCIPLINE', discipline: 'architecture' });
    if (state.currentLevel !== level) dispatch({ type: 'SET_LEVEL', levelId: level });
    if (object.table !== 'level') {
      setFocus({ level, id: object.id, table: object.table });
    } else {
      dispatch({ type: 'CLEAR_SELECTION' });
      setNotice(`已切换到 ${state.project.levels.find(candidate => candidate.id === level)?.name || level} 平面。`);
    }
    if (window.matchMedia('(max-width: 760px)').matches) close();
  }

  function download() {
    if (!report || !input) return;
    saveJson({ ...report, ruleFile: input.fileName,
      ...(input.needsCompile && { pal: { models: input.models ?? [], plans: input.items.flatMap(item => item.plan
        ? [{ id: item.id, locator: item.source.locator,
          reviewed: reviewed && !excludedRules.has(item.id) && !!(item.rule || item.clearHeightRule), plan: item.plan }]
        : []) } }),
    }, 'model-check-report.json');
  }

  function downloadReviewedRules() {
    if (!reviewed || compileProgress) return;
    const rules = activeItems.flatMap(item => {
      const rule = item.rule ?? item.clearHeightRule;
      return rule ? [{ ...rule, reviewed: true, ...(item.libraryTool && { registeredToolId: item.libraryTool.id }) }] : [];
    });
    if (rules.length) saveJson({ rules }, 'reviewed-model-check-rules.json');
  }

  const ready = input?.items.filter(item => item.rule || item.clearHeightRule) ?? [];
  const levels = levelData?.levels ?? [];
  const counts = Object.fromEntries(ordering.map(status => [status,
    (report?.results.filter(result => result.status === status).length ?? 0) +
      (status === 'indeterminate' ? report?.pending.length ?? 0 : 0)]));

  return <aside className="area-panel model-check-panel" id="model-check-panel" aria-labelledby="model-check-title" hidden={!open}>
    <div className="model-check-head"><h2 id="model-check-title">模型核查</h2><button type="button" onClick={close}>关闭</button></div>
    <ModelCheckLibrary tools={library} disabled={!!compileProgress || busy} approve={approveTool} />
    <label>上传核查条款文件
      <input type="file" accept=".xlsx,.json" onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void load(file);
      }} />
    </label>
    <small>支持 Excel 条款表（.xlsx）和已审核规则包（.json）。模型证据、核查与报告在本机处理。</small>
    <details ref={textDetails}>
      <summary>输入自然语言条款</summary>
      <form onSubmit={event => { event.preventDefault(); void loadText(); }}>
        <label>核查要求<textarea value={textDraft} rows={3} maxLength={MAX_CLAUSE_TEXT_LENGTH}
          placeholder="例如 住宅各适用楼层的建筑层高不小于 3.00 m。"
          onChange={event => setTextDraft(event.target.value)} /></label>
        {configuredModel ? <small>编译时向 {configuredModel.host} 发送条款原文，编译结果将替换当前条款列表。</small>
          : <small>请先在页面底部配置 PAL 语言模型。</small>}
        <p><button type="submit" disabled={!configuredModel || !textDraft.trim() || textDraft.length > MAX_CLAUSE_TEXT_LENGTH ||
          reading || busy || !!compileProgress}>编译文本条款</button></p>
      </form>
    </details>
    {reading && <p role="status">正在读取条款文件…</p>}
    {error && <p className="area-error" role="alert">{error}</p>}
    {input && <>
      <p className="model-check-file">{input.fileName}<br /><small>{input.items.length} 条条款 · {ready.length} 条可按下方确认执行</small></p>
      {input.needsCompile && <div className="model-check-levels">
        {configuredModel ? <small>PAL 将待编译的条款文本发送至 {configuredModel.host}（{configuredModel.model}）。</small>
          : <small>请先在页面底部的「模型设置」配置语言模型。已审核 JSON 规则包可直接核查。</small>}
        {pendingClauses.length > 0 && <p><button type="button" disabled={!configuredModel || !!compileProgress}
          onClick={() => void compile()}>PAL 编译 {pendingClauses.length} 条条款</button></p>}
        {compileProgress && <p><span role="status">PAL 正在编译 {compileProgress.done} / {compileProgress.total} 条</span>
          {' '}<button type="button" onClick={() => compileRequest.current?.abort()}>停止编译</button></p>}
        {!pendingClauses.length && <small> · {input.items.length - ready.length} 条需要补充或人工处理。</small>}
      </div>}
      {ready.length > 0 && <details open>
        <summary>可执行条款与审核</summary>
        <ul className="model-check-list">{ready.map(({ id, title, source, rule, clearHeightRule, plan, libraryTool }) =>
          <li key={id}><strong>{id} · {title}</strong>
            {rule && <small>{libraryTool ? TOOL_PROFILES[libraryTool.recipe.concept].title
              : rule.concept === HEIGHT ? '建筑层高 · 确认适用楼层' : '模型记载净面积 · 模型全部房间'}
              {' · '}{rule.operator} {rule.threshold} {rule.unit === 'm2' ? 'm²' : rule.unit}</small>}
            {clearHeightRule && <small>常规净高 {clearHeightRule.nominalHeight} m · 局部下限 {clearHeightRule.minimumHeight} m ·
              低净高面积 ≤ 使用面积的 {clearHeightRule.maxLowAreaFraction.numerator}/{clearHeightRule.maxLowAreaFraction.denominator}</small>}
            {plan && plan.kind !== 'blocked' && <small>原文限值：{'quote' in plan ? plan.quote : plan.quotes.join('、')}</small>}
            <small>{source.locator} · {source.text}</small>
            {plan && <label className="area-review">
              <input type="checkbox" aria-label={`纳入核查 ${id}`} checked={!excludedRules.has(id)} disabled={!!compileProgress}
                onChange={event => {
                  const include = event.target.checked;
                  setExcludedRules(previous => {
                    const next = new Set(previous);
                    if (include) next.delete(id); else next.add(id);
                    return next;
                  });
                  setReviewed(false);
                  invalidateReport();
                }} />纳入核查
            </label>}
          </li>)}</ul>
      </details>}
      {hasHeight && <fieldset className="model-check-levels">
        <legend>核对各层建筑层高</legend>
        <small>按最近的更高标高预填层高。可改选上方标高、手动填写层高或标记不适用。没有可靠配对的楼层保留待确认。</small>
        {levelData && levelData.scale === undefined && <p className="area-status">模型未声明受支持的坐标单位。请选择手动填写，或先补充模型单位。</p>}
        {!levels.length && <p className="area-status">当前没有可用的楼层记录。</p>}
        {levels.map(level => {
          const edit = storeyEdits.get(level.id);
          const choice = edit ?? suggestions.get(level.id);
          const upper = choice?.mode === 'upper' ? levels.find(item => item.id === choice.id) : undefined;
          const height = storeyHeightMetres(level.elevation, upper?.elevation, levelData?.scale);
          const selected = choice?.mode === 'upper' ? choice.id : choice?.mode === 'manual' ? MANUAL
            : choice?.mode === 'excluded' ? EXCLUDED : '';
          return <div className="model-check-storey" key={level.id}>
            <label>{level.name} · {level.elevation ?? '缺标高'} {levelData?.unit}
              <select aria-label={`${level.name}的上方建筑标高（${level.id}）`} value={selected} onChange={event => {
                const value = event.target.value;
                if (value === MANUAL) editStorey(level.id, { mode: 'manual', height: height?.toString() ?? '', source: '' });
                else if (value === EXCLUDED) editStorey(level.id, { mode: 'excluded' });
                else editStorey(level.id, value ? { mode: 'upper', id: value } : { mode: 'pending' });
              }}>
                <option value="">待确认</option><option value={EXCLUDED}>不适用</option>
                <option value={MANUAL}>手动填写层高</option>
                {levels.filter(item => item.elevation !== undefined && level.elevation !== undefined &&
                  item.elevation > level.elevation).map(item => (
                  <option key={item.id} value={item.id}>{item.name} · {item.elevation} {levelData?.unit}</option>
                ))}
              </select>
            </label>
            {height !== undefined && <small>{edit ? '按选定标高计算' : '自动预填'} · 建筑层高 {measurement.format(height)} m</small>}
            {choice?.mode === 'manual' && <>
              <label>建筑层高（m）<input type="number" step="any" min="0" value={choice.height}
                aria-label={`${level.name}的建筑层高（m）`}
                onChange={event => editStorey(level.id, { ...choice, height: event.target.value })} /></label>
              <label>手工层高依据<input type="text" value={choice.source}
                aria-label={`${level.name}的手工层高依据`} placeholder="如建筑剖面图号"
                onChange={event => editStorey(level.id, { ...choice, source: event.target.value })} /></label>
            </>}
          </div>;
        })}
      </fieldset>}
      {hasClearHeight && <RoomClearHeightFields rooms={roomInventory?.rooms} thresholds={clearHeightThresholds}
        entries={clearHeightEntries} edit={(key, entry) => {
          setClearHeightEntries(previous => new Map(previous).set(key, entry));
          invalidateReport();
        }} />}
      {needsReview && <label className="area-review"><input type="checkbox" checked={reviewed}
        disabled={!!compileProgress || !levelData || (hasClearHeight && !roomInventory)}
        onChange={event => {
          const confirmed = event.target.checked;
          setReviewed(confirmed);
          invalidateReport();
          if (confirmed && input.needsCompile) void run(true);
        }} />
        <span>我已核对可执行条款的来源、限值和项目适用性。
          {hasHeight && '我确认当前各层层高的建筑标高配对、手工依据和适用范围。'}
          {hasClearHeight && '我已复核本次各房间的适用性、完成面净高和面积证据。'}
          {hasRoomArea && '我确认各净面积条款适用于模型全部房间，且采用模型记载净面积口径。'}
          {hasLibraryRules && '工具库规则按证据文件中的逐对象适用性执行。'}
          {input.needsCompile && '确认后自动运行核查。'}</span></label>}
      <button type="button" className="area-primary" onClick={() => void run()}
        disabled={busy || !!compileProgress || (needsReview && !reviewed) || !levelData || (hasClearHeight && !roomInventory)}>
        {busy ? '正在核查…' : '运行模型核查'}
      </button>
      {input.needsCompile && reviewed && needsReview && <p><button type="button" onClick={downloadReviewedRules}>
        下载已审核规则包
      </button></p>}
    </>}
    {report && <section className="model-check-results" aria-label="核查结果">
      <h3 ref={resultsHeading} tabIndex={-1}>核查结果</h3>
      <div className="model-check-summary" aria-label="按结果筛选">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
        {ordering.map(status => <button key={status} type="button" aria-pressed={filter === status}
          onClick={() => setFilter(status)}>{labels[status]} {counts[status]}</button>)}
      </div>
      {notice && <p role="status">{notice}</p>}
      <ul className="model-check-list">
        {ordering.filter(status => filter === 'all' || filter === status).flatMap(status =>
          report.results.filter(row => row.status === status).map(row => {
            const evidence = 'evidence' in row ? row.evidence : undefined;
            const clearHeightEvidence = 'clearHeightEvidence' in row ? row.clearHeightEvidence : undefined;
            return <li key={JSON.stringify([row.ruleId, row.object])} className={status === 'fail' ? 'model-check-fail' : undefined}>
              <strong>{labels[status]} · {row.ruleId}</strong>
              {row.name && <span>{row.name}</span>}
              {evidence && <small>核查值 {measurement.format(evidence.normalizedValue)} {evidence.unit === 'm2' ? 'm²' : evidence.unit}
                {' · 要求 '}{evidence.operator} {evidence.threshold} {evidence.unit === 'm2' ? 'm²' : evidence.unit}</small>}
              {clearHeightEvidence && <small>最低净高 {measurement.format(clearHeightEvidence.minimumHeight)} m ·
                低于 {clearHeightEvidence.belowHeight} m 的面积 {measurement.format(clearHeightEvidence.lowArea)} m² /
                {' '}{measurement.format(clearHeightEvidence.usableArea)} m²（{percent.format(clearHeightEvidence.ratio)}）</small>}
              {'reason' in row && row.reason && <small>{row.reason}</small>}
              {'libraryToolId' in row && typeof row.libraryToolId === 'string' && <small>工具 {row.libraryToolId}</small>}
              {status === 'indeterminate' && !('reason' in row) && <small>{!row.object ? '模型没有可核查的此类对象。'
                : 'diagnostic' in row && row.diagnostic.status === 'clarification-required'
                  ? '该对象的适用性待确认。' : '缺少符合规则口径的测量证据。'}</small>}
              <small>{row.source.locator}{evidence && ` · ${evidence.dataSource}`}{clearHeightEvidence && ` · ${clearHeightEvidence.source}`}</small>
              {status === 'fail' && row.object && <button type="button" onClick={() => locate(row.object!)}>
                {row.object.table === 'level' ? '定位楼层' : row.object.table === 'space' ? '定位房间' : '定位构件'}
              </button>}
            </li>;
          }))}
      </ul>
      {(filter === 'all' || filter === 'indeterminate') && report.pending.length > 0 && <details open={filter === 'indeterminate'}>
        <summary>待处理条款（{report.pending.length}）</summary>
        <ul className="model-check-list">{report.pending.map(item => <li key={item.id}>
          <strong>{item.id} · {item.title}</strong>
          <small>{item.plan?.kind === 'blocked' && item.plan.gap && `${gapLabels[item.plan.gap]} · `}{item.reason}</small>
          {item.plan?.kind === 'tool-draft' && <small>在 PAL 工具库审核启用后，再核对条款和数据。</small>}
          <small>{item.source.locator} · {item.source.text}</small>
        </li>)}</ul>
      </details>}
      {report.exportFeedback.length > 0 && <details open>
        <summary>BIMDown 导出建议（{report.exportFeedback.length}）</summary>
        <ul className="model-check-list">{report.exportFeedback.map(item => <li key={item.ruleId}>
          <strong>{item.ruleId} · {item.affected} 项无法判断</strong>
          <small>文件 {item.files.join('、')}</small><small>字段 {item.fields.join('、')}</small><small>{item.advice}</small>
          {item.scope && <small>适用性记录 {item.scope.ruleId} · {item.scope.ruleVersion} · {item.scope.applicability}</small>}
        </li>)}</ul>
      </details>}
      {filter !== 'all' && counts[filter] === 0 && <p>没有此状态的结果。</p>}
      <button type="button" onClick={download}>下载核查报告</button>
    </section>}
  </aside>;
}
