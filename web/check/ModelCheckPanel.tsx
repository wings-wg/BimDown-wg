import { useEffect, useMemo, useRef, useState } from 'react';
import { unitRoomView, useDataSource, useEditorDispatch, useEditorState, ZOOM_TO_EVENT } from 'bimdown-editor';
import { HEIGHT, MAX_CLAUSE_TEXT_LENGTH, ROOM_NET_AREA, bindLocalStoreyHeight, bindPalPlan, importJsonRules,
  importSheetRules, importTextRule, type CheckItem } from './check-import.js';
import { PAL_BATCH_SIZE } from './pal-plan.js';
import { MODEL_PAL_LIBRARY_PATH, type ModelQaConnection } from '../area/model-qa-types.js';
import { compilePalClauses } from '../area/pal-client.js';
import { readCheckLevels, readCheckRooms, runModelCheck, type RoomClearHeightEntry } from './check-model.js';
import { isRoofDatum, isStoreyPair, storeyHeightMetres, suggestStoreyChoices, type StoreyChoice } from './storey-height.js';
import { RoomClearHeightFields } from './RoomClearHeightFields.tsx';
import { ModelCheckLibrary } from './ModelCheckLibrary.tsx';
import { TOOL_PROFILES, type ToolEntry } from './core/tool-recipes.js';
import { doorUses, type DoorUse } from './door-width.js';
import { roomExportLabels, type DoorUseEvidence } from './tool-evidence.js';
import { blockerLabels } from './pal-readiness.js';
import { candidateLimit, readCandidatePackage } from './pal-candidate-package.js';
import type { PalResult } from './pal-plan.js';
import { compareModelCheckReports, readComparisonBaseline, type ComparisonBaseline } from './report-comparison.js';
import type { WorkspaceCommandRequest } from '../area/editor-commands.js';
import './model-check.css';

const labels = { fail: '不通过', pass: '通过', indeterminate: '无法判断', 'not-applicable': '不适用' } as const;
const observationTables = { level: '标高', space: '房间', door: '门', structure_slab: '结构板' } as const;
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

export function ModelCheckPanel({ open, close, connection, libraryRevision, textDraft, setTextDraft, command }: {
  open: boolean; close: () => void; connection?: ModelQaConnection;
  libraryRevision: number; textDraft: string; setTextDraft: (value: string) => void;
  command?: WorkspaceCommandRequest;
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
  const [baseline, setBaseline] = useState<ComparisonBaseline>();
  const [ruleFilter, setRuleFilter] = useState('');
  const [importingCandidates, setImportingCandidates] = useState(false);
  const [candidateMessage, setCandidateMessage] = useState<{ ok: boolean; text: string }>();
  const [filter, setFilter] = useState<Status | 'all' | 'pending'>('all');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState('');
  const [commandNotice, setCommandNotice] = useState('');
  const handledCommand = useRef<WorkspaceCommandRequest>(undefined);
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
    ? { ...item, rule: undefined, clearHeightRule: undefined, doorWidthRule: undefined, overlapRule: undefined,
      libraryTool: undefined, reason: '本次未审核放行。' } : item) ?? [];
  const hasHeight = activeItems.some(item => item.rule?.concept === HEIGHT);
  const hasRoomArea = activeItems.some(item => item.rule?.concept === ROOM_NET_AREA);
  const clearHeightThresholds = [...new Set(activeItems.flatMap(item => item.clearHeightRule ? [item.clearHeightRule.nominalHeight] : []))];
  const hasClearHeight = clearHeightThresholds.length > 0;
  const hasLibraryRules = activeItems.some(item => item.libraryTool && (item.rule || item.doorWidthRule));
  const hasOverlap = activeItems.some(item => item.overlapRule);
  const needsReview = hasHeight || hasRoomArea || hasClearHeight || hasLibraryRules || hasOverlap;

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
      setBaseline(undefined);
      setRuleFilter('');
      setCandidateMessage(undefined);
      setFocus(undefined);
      setBusy(false);
      setReading(false);
      setError('');
      setNotice('');
      setCommandNotice('');
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
    setBaseline(undefined);
    setRuleFilter('');
    setCandidateMessage(undefined);
    setFocus(undefined);
    setNotice('');
    setCommandNotice('');
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
        items = importSheetRules(file.name, sheet, rows).map(bindLocalStoreyHeight);
      } else if (/\.json$/i.test(file.name)) {
        const [text, tools] = await Promise.all([file.text(), fetchLibrary().catch(() => [])]);
        items = importJsonRules(text, tools);
      } else {
        throw new Error('请选择 .xlsx 或 .json 条款文件。');
      }
      if (id === fileRequest.current) setInput({ fileName: file.name, items, needsCompile: excel,
        ...(items.some(item => item.compiledLocally) && { models: ['本地层高解析'] }) });
    } catch (reason) {
      if (id === fileRequest.current)
        setError(`文件导入失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (id === fileRequest.current) setReading(false);
    }
  }

  async function loadText() {
    if (!configuredModel || reading || importingCandidates || compileRequest.current || busy) return;
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
    if (!configuredModel || !clausesToCompile.length || importingCandidates || compileRequest.current) return;
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
      setInput(current => current && { ...current, items: current.items.map(item =>
        (item.plan?.kind === 'tool-draft' || item.plan?.kind === 'door-clear-width-by-use') &&
        item.plan.toolId === tool.id ? bindPalPlan(item, item.plan, [tool]) : item) });
      setReviewed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function downloadCandidateTemplate() {
    const entries = (input?.items ?? []).filter(item => item.clause && (!item.plan || item.plan.kind === 'blocked'))
      .slice(0, candidateLimit).map(({ clause, source, id }) => ({ clause, source, proposal: { id, kind: '' }, verification: [] }));
    if (entries.length) saveJson({ version: 1, origin: 'Codex', entries }, 'pal-candidate-template.json');
  }

  async function importCandidates(file: File) {
    if (!input || importingCandidates || reading || busy || compileRequest.current) return;
    const inputId = fileRequest.current;
    setImportingCandidates(true);
    setCandidateMessage(undefined);
    try {
      if (file.size > 64 * 1024) throw new Error('候选包不能超过 64 KB，请分批导入。');
      const data = readCandidatePackage(JSON.parse(await file.text()), input.items);
      if (inputId !== fileRequest.current) return;
      const response = await fetch(`${MODEL_PAL_LIBRARY_PATH}/import`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const payload = await response.json() as { tools?: ToolEntry[]; plans?: PalResult[]; error?: string };
      if (!response.ok || !payload.tools || !payload.plans) throw new Error(payload.error ?? '候选包未能导入。');
      const tools = payload.tools;
      setLibrary(tools);
      if (inputId !== fileRequest.current) return;
      const plans = new Map(payload.plans.map(result => [result.id, result.plan]));
      const items = input.items.map(item => {
        const plan = plans.get(item.id);
        return plan && (!item.plan || item.plan.kind === 'blocked') ? bindPalPlan(item, plan, tools) : item;
      });
      const applied = items.filter((item, i) => item !== input.items[i]);
      if (applied.length) {
        setInput({ ...input, items, models: [...new Set([...(input.models ?? []), data.origin])] });
        setReviewed(false);
      }
      setCandidateMessage({ ok: true, text: `验证通过 ${payload.plans.length} 条，补入 ${applied.length} 条待处理方案。工具库已刷新，已有报告可继续查看。` });
    } catch (reason) {
      if (inputId === fileRequest.current)
        setCandidateMessage({ ok: false, text: `候选验证失败 · ${reason instanceof Error ? reason.message : String(reason)}` });
    } finally { setImportingCandidates(false); }
  }

  async function importBaseline(file: File) {
    if (!input) return;
    const inputId = fileRequest.current;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('复跑基线文件不能超过 25 MB。');
      const value = readComparisonBaseline(JSON.parse(await file.text()), input.items);
      if (inputId === fileRequest.current) { setBaseline(value); setError(''); }
    } catch (reason) {
      if (inputId === fileRequest.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function run(confirmed = reviewed, ruleIds?: readonly string[]) {
    if (!input || !levelData || compileProgress || importingCandidates || (needsReview && !confirmed) || (hasClearHeight && !roomInventory)) return;
    const requested = ruleIds ? new Set(ruleIds) : undefined;
    const items = requested ? activeItems.filter(item => requested.has(item.id)) : activeItems;
    if (!items.length) return;
    const id = ++runRequest.current;
    setReport(undefined);
    setNotice('');
    setCommandNotice('');
    setError('');
    setBusy(true);
    try {
      const result = await runModelCheck(ds, items, new Map([...suggestions, ...storeyEdits]), levelData.raw,
        roomInventory && { snapshot: roomInventory.snapshot, entries: clearHeightEntries });
      if (id === runRequest.current) {
        setFilter('all');
        setRuleFilter('');
        setReport(result);
      }
    } catch (reason) {
      if (id === runRequest.current)
        setError(`核查失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (id === runRequest.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!open || !command || handledCommand.current === command) return;
    handledCommand.current = command;
    if (busy || compileProgress || reading || importingCandidates) setCommandNotice('当前仍在读取、编译或核查，请完成后再运行。');
    else if (!input) setCommandNotice('请先上传核查条款文件。');
    else if (!needsReview) setCommandNotice('当前没有可执行条款，请先编译条款或启用所需工具。');
    else if (!reviewed) setCommandNotice('请先核对来源、限值和适用性，再运行已就绪条款。');
    else if (!levelData || (hasClearHeight && !roomInventory)) setCommandNotice('模型证据正在读取，请稍后重试。');
    else void run();
  }, [open, command, busy, compileProgress, reading, importingCandidates, input, needsReview, reviewed, levelData, hasClearHeight, roomInventory, run]);

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
    const discipline = object.table === 'structure_slab' ? 'structure'
      : object.table === 'space' || object.table === 'door' ? 'architecture' : undefined;
    if (discipline && state.activeDiscipline !== 'all' && state.activeDiscipline !== discipline)
      dispatch({ type: 'SET_DISCIPLINE', discipline });
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
    saveJson({ ...report, ruleFile: input.fileName, viewFilter: { status: filter, ruleId: ruleFilter || null },
      ...(comparison && { comparison }),
      workbook: input.items.map(item => ({ id: item.id, source: item.source, clause: item.clause, plan: item.plan,
        status: report.clauseTrace.find(entry => entry.id === item.id)?.status ?? 'not-run' })),
      ...(input.needsCompile && { pal: { models: input.models ?? [], plans: input.items.flatMap(item => item.plan
        ? [{ id: item.id, locator: item.source.locator,
          reviewed: reviewed && !excludedRules.has(item.id) && !!(item.rule || item.clearHeightRule || item.doorWidthRule || item.overlapRule),
          plan: item.plan }]
        : []) } }),
    }, 'model-check-report.json');
  }

  function downloadReviewedRules() {
    if (!reviewed || compileProgress) return;
    const rules = activeItems.flatMap(item => {
      const rule = item.rule ?? item.clearHeightRule ?? item.doorWidthRule ?? item.overlapRule;
      return rule ? [{ ...rule, reviewed: true, ...(item.libraryTool && { registeredToolId: item.libraryTool.id }) }] : [];
    });
    if (rules.length) saveJson({ rules }, 'reviewed-model-check-rules.json');
  }

  const ready = input?.items.filter(item => item.rule || item.clearHeightRule || item.doorWidthRule || item.overlapRule) ?? [];
  const activeReady = ready.filter(item => !excludedRules.has(item.id));
  const comparison = useMemo(() => report && baseline && report !== baseline
    ? compareModelCheckReports(baseline, report) : undefined, [report, baseline]);
  const compiled = input?.items.filter(item => item.plan ? item.plan.kind !== 'blocked' :
    item.rule || item.clearHeightRule || item.doorWidthRule || item.overlapRule).length ?? 0;
  const affectedRules = baseline?.exportFeedback.map(item => item.ruleId)
    .filter(id => activeReady.some(item => item.id === id)) ?? [];
  const reportRules = report?.clauseTrace ?? [];
  const displayedResults = report?.results.filter(row => !ruleFilter || row.ruleId === ruleFilter) ?? [];
  const displayedPending = report?.pending.filter(row => !ruleFilter || row.id === ruleFilter) ?? [];
  const levels = levelData?.levels ?? [];
  const counts = Object.fromEntries(ordering.map(status => [status,
    displayedResults.filter(result => result.status === status).length]));

  return <aside className="area-panel model-check-panel" id="model-check-panel" aria-labelledby="model-check-title" hidden={!open}>
    <div className="model-check-head"><h2 id="model-check-title">模型核查</h2><button type="button" onClick={close}>关闭</button></div>
    <ModelCheckLibrary tools={library} disabled={!!compileProgress || busy || importingCandidates} approve={approveTool} />
    {input?.items.some(item => item.clause) && <details>
      <summary>导入 Codex 候选包</summary>
      <button type="button" onClick={downloadCandidateTemplate}
        disabled={importingCandidates || !input.items.some(item => item.clause && (!item.plan || item.plan.kind === 'blocked'))}>下载待处理条款模板</button>
      <label>候选包 JSON <input type="file" accept=".json" disabled={importingCandidates || reading || busy || !!compileProgress}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void importCandidates(file);
        }} /></label>
      {importingCandidates && <small role="status">正在验证候选包…</small>}
      {candidateMessage && <small role={candidateMessage.ok ? 'status' : 'alert'}>{candidateMessage.text}</small>}
    </details>}
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
          reading || busy || importingCandidates || !!compileProgress}>编译文本条款</button></p>
      </form>
    </details>
    {reading && <p role="status">正在读取条款文件…</p>}
    {commandNotice && <p role="status">{commandNotice}</p>}
    {error && <p className="area-error" role="alert">{error}</p>}
    {input && <>
      <p className="model-check-file">{input.fileName}<br /><small>
        原表 {input.items.length} 条 · 已编译 {compiled} 条 · 待审核 {reviewed ? 0 : activeReady.length} 条 ·
        已执行 {reportRules.filter(row => row.status === 'executed').length} 条 · 待处理 {input.items.length - activeReady.length} 条
      </small></p>
      <details>
        <summary>条款追踪（{input.items.length}）</summary>
        <ul className="model-check-list">{input.items.map(item => {
          const ready = activeReady.some(rule => rule.id === item.id);
          const wasExecuted = reportRules.some(rule => rule.id === item.id && rule.status === 'executed');
          return <li key={item.id}>
            <strong>{item.id} · {item.title}</strong>
            <small>{wasExecuted ? '本报告已执行' : ready ? reviewed ? '已审核待执行' : '待审核' : item.reason ?? '待处理'}
              {item.plan && ` · ${item.plan.kind}`}</small>
            <small>{item.source.document} · {item.source.locator} · {item.source.text}</small>
            {wasExecuted && <button type="button" onClick={() => { setRuleFilter(item.id); setFilter('all'); resultsHeading.current?.focus(); }}>
              查看条款结果
            </button>}
          </li>;
        })}</ul>
      </details>
      {input.needsCompile && <div className="model-check-levels">
        {configuredModel ? <small>PAL 将待编译的条款文本发送至 {configuredModel.host}（{configuredModel.model}）。</small>
          : <small>请先在页面底部的「模型设置」配置语言模型。已审核 JSON 规则包可直接核查。</small>}
        {pendingClauses.length > 0 && <p><button type="button" disabled={!configuredModel || importingCandidates || !!compileProgress}
          onClick={() => void compile()}>PAL 编译 {pendingClauses.length} 条条款</button></p>}
        {compileProgress && <p><span role="status">PAL 正在编译 {compileProgress.done} / {compileProgress.total} 条</span>
          {' '}<button type="button" onClick={() => compileRequest.current?.abort()}>停止编译</button></p>}
        {!pendingClauses.length && <small> · {input.items.length - ready.length} 条需要补充或人工处理。</small>}
      </div>}
      {ready.length > 0 && <details open>
        <summary>可执行条款与审核</summary>
        <ul className="model-check-list">{ready.map(({ id, title, source, rule, clearHeightRule, doorWidthRule, overlapRule, plan, libraryTool, compiledLocally }) =>
          <li key={id}><strong>{id} · {title}</strong>
            {compiledLocally && <small>限值从原表本地解析 · 确认建筑标高及适用楼层后执行</small>}
            {rule && <small>{libraryTool ? TOOL_PROFILES[libraryTool.recipe.concept].title
              : rule.concept === HEIGHT ? '建筑层高 · 确认适用楼层' : '模型记载净面积 · 模型全部房间'}
              {' · '}{rule.operator} {rule.threshold} {rule.unit === 'm2' ? 'm²' : rule.unit}</small>}
            {clearHeightRule && <small>常规净高 {clearHeightRule.nominalHeight} m · 局部下限 {clearHeightRule.minimumHeight} m ·
              低净高面积 ≤ 使用面积的 {clearHeightRule.maxLowAreaFraction.numerator}/{clearHeightRule.maxLowAreaFraction.denominator}</small>}
            {doorWidthRule && <small>{(Object.keys(doorUses) as DoorUse[])
              .map(use => `${doorUses[use]} ≥ ${doorWidthRule.thresholds[use]} m`).join(' · ')}</small>}
            {overlapRule && <small>上层卫生间与下层卧室、起居室、厨房、餐厅的投影相交面积须为 0 m²。</small>}
            {plan && ('quote' in plan || 'quotes' in plan) &&
              <small>原文限值：{'quote' in plan ? plan.quote : Object.values(plan.quotes).join('、')}</small>}
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
        <small>预填候选建筑标高配对。请复核适用楼层，可改选上方标高、录入带来源的层高或标记不适用。屋面标高点保留待确认。</small>
        {levelData && levelData.scale === undefined && <p className="area-status">模型未声明受支持的坐标单位。请选择手动填写，或先补充模型单位。</p>}
        {!levels.length && <p className="area-status">当前没有可用的楼层记录。</p>}
        {levels.map(level => {
          const edit = storeyEdits.get(level.id);
          const choice = edit ?? suggestions.get(level.id);
          const upper = choice?.mode === 'upper' ? levels.find(item => item.id === choice.id) : undefined;
          const height = upper && isStoreyPair(level, upper) ? storeyHeightMetres(level.elevation, upper.elevation, levelData?.scale) : undefined;
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
                {levels.filter(item => isStoreyPair(level, item)).map(item => (
                  <option key={item.id} value={item.id}>{item.name} · {item.elevation} {levelData?.unit}</option>
                ))}
              </select>
            </label>
            {(level.usage || level.elevationBasis) && <small>
              {level.usage && `用途 ${level.usage}`}{level.elevationBasis && ` · 口径 ${level.elevationBasis}`}
              {level.elevationSource && ` · ${level.elevationSource}`}
            </small>}
            {height !== undefined && <small>{edit ? '按选定标高计算' : '自动预填'} · 建筑层高 {measurement.format(height)} m</small>}
            {!choice && isRoofDatum(level) && <small>屋面标高点 · 请确认是否在住宅楼层核查范围内</small>}
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
        disabled={!!compileProgress || importingCandidates || !levelData || (hasClearHeight && !roomInventory)}
        onChange={event => {
          const confirmed = event.target.checked;
          setReviewed(confirmed);
          invalidateReport();
          if (confirmed && input.needsCompile && !baseline) void run(true);
        }} />
        <span>我已核对可执行条款的来源、限值和项目适用性。
          {hasHeight && '我确认当前各层层高的建筑标高配对、手工依据和适用范围。'}
          {hasClearHeight && '我已复核本次各房间的适用性、完成面净高和面积证据。'}
          {hasRoomArea && '我确认各净面积条款适用于模型全部房间，且采用模型记载净面积口径。'}
          {hasLibraryRules && '工具库规则按证据文件中的逐对象适用性执行。'}
          {hasOverlap && '已核对跨层配对、室内用途和投影轮廓的适用性。'}
          {input.needsCompile && !baseline && '确认后自动运行核查。'}</span></label>}
      <button type="button" className="area-primary" onClick={() => void run()}
        disabled={busy || importingCandidates || !!compileProgress || (needsReview && !reviewed) || !levelData || (hasClearHeight && !roomInventory)}>
        {busy ? '正在核查…' : needsReview ? '运行已就绪条款' : '查看待处理条款'}
      </button>
      {input.needsCompile && reviewed && needsReview && <p><button type="button" onClick={downloadReviewedRules}>
        下载已审核规则包
      </button></p>}
      <label>读取复跑基线 <input type="file" accept=".json" disabled={busy || importingCandidates} onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void importBaseline(file);
      }} /></label>
      {baseline && <fieldset className="model-check-levels">
        <legend>补证据与复跑</legend>
        <small>已保存基线。模型快照 {baseline.modelVersion.slice(0, 12)}{baseline.evidenceInventory.revision &&
          ` · 工程版本 ${baseline.evidenceInventory.revision}`}。更新项目文件后刷新证据并复核条款。</small>
        <div>
          <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新模型证据</button>{' '}
          <button type="button" disabled={!reviewed || !levelData || !affectedRules.length || busy || importingCandidates ||
            !!compileProgress || (hasClearHeight && !roomInventory)}
            onClick={() => void run(reviewed, affectedRules)}>复跑受影响条款（{affectedRules.length}）</button>{' '}
          <button type="button" onClick={() => saveJson(baseline, 'model-check-baseline.json')}>下载基线</button>
        </div>
      </fieldset>}
    </>}
    {report && <section className="model-check-results" aria-label="核查结果">
      <h3 ref={resultsHeading} tabIndex={-1}>核查结果</h3>
      <p>已评估 {new Set(report.results.map(row => row.ruleId)).size} 条条款，
        产生 {report.results.filter(row => row.object).length} 个对象结果。
        {report.results.some(row => !row.object) && `另有 ${report.results.filter(row => !row.object).length} 条缺少核查对象。`}
        {report.pending.length > 0 && ` ${report.pending.length} 条待处理。`}</p>
      <details open>
        <summary>工程证据预检</summary>
        {report.evidenceInventory.status === 'loaded' ? <p>
          {Object.entries(observationTables).map(([table, label]) => `${label} ${report.evidenceInventory.observedByTable[table] ?? 0} 条观测`).join(' · ')}
          。已确认量测 {report.evidenceInventory.confirmedMeasurements} 条，规则适用性记录 {report.evidenceInventory.applicabilityRecords} 条。
        </p> : <p>{report.evidenceInventory.error ?? '项目缺少 engineering_evidence.json。'}</p>}
        {report.evidenceInventory.roomExport && <p>
          {roomExportLabels[report.evidenceInventory.roomExport.status]}。宿主房间 {report.evidenceInventory.roomExport.hostRooms}，
          已放置 {report.evidenceInventory.roomExport.placedRooms}，导出记录 {report.evidenceInventory.roomExport.csvRows}，
          轮廓 {report.evidenceInventory.roomExport.footprints}。机电空间 {report.evidenceInventory.roomExport.mepSpaces}，
          链接实例 {report.evidenceInventory.roomExport.linkInstances}。
        </p>}
      </details>
      <div className="model-check-summary" aria-label="按结果筛选">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
        {ordering.map(status => <button key={status} type="button" aria-pressed={filter === status}
          onClick={() => setFilter(status)}>{labels[status]} {counts[status]}</button>)}
        {displayedPending.length > 0 && <button type="button" aria-pressed={filter === 'pending'}
          onClick={() => setFilter('pending')}>待处理条款 {displayedPending.length}</button>}
      </div>
      <label>仅看条款 <select value={ruleFilter} onChange={event => { setRuleFilter(event.target.value); setFilter('all'); }}>
        <option value="">全部条款</option>
        {reportRules.map(rule => <option key={rule.id} value={rule.id}>{rule.id} · {rule.title}</option>)}
      </select></label>
      {comparison && <details open>
        <summary>复跑对比 · {comparison.changes.length} 项状态变化</summary>
        <small>模型快照 {comparison.beforeModelVersion.slice(0, 12)} → {comparison.afterModelVersion.slice(0, 12)} ·
          复跑条款 {comparison.rules.join('、')}</small>
        <ul className="model-check-list">{comparison.changes.map(change => <li
          key={JSON.stringify([change.ruleId, change.ruleVersion, change.object])}>
          <small>{change.ruleId} · {change.object ? `${change.object.scope}/${change.object.table}/${change.object.id}` : '条款级'}
            {' · '}{change.before ? labels[change.before] : '无原结果'} → {change.after ? labels[change.after] : '无本次结果'}</small>
        </li>)}</ul>
      </details>}
      {notice && <p role="status">{notice}</p>}
      <ul className="model-check-list">
        {ordering.filter(status => filter === 'all' || filter === status).flatMap(status =>
          displayedResults.filter(row => row.status === status).map(row => {
            const evidence = 'evidence' in row ? row.evidence : undefined;
            const clearHeightEvidence = 'clearHeightEvidence' in row ? row.clearHeightEvidence : undefined;
            const doorUse = 'doorUse' in row ? row.doorUse as DoorUseEvidence | undefined : undefined;
            const evidenceFiles = row.object && status === 'indeterminate'
              ? report.exportFeedback.find(item => item.ruleId === row.ruleId)?.files.map(path => path.replace('<楼层>', row.object!.scope))
              : undefined;
            return <li key={JSON.stringify([row.ruleId, row.object])} className={status === 'fail' ? 'model-check-fail' : undefined}>
              <strong>{labels[status]} · {row.ruleId}</strong>
              {row.name && <span>{row.name}</span>}
              {evidence && <small>核查值 {measurement.format(evidence.normalizedValue)} {evidence.unit === 'm2' ? 'm²' : evidence.unit}
                {' · 要求 '}{evidence.operator} {evidence.threshold} {evidence.unit === 'm2' ? 'm²' : evidence.unit}</small>}
              {clearHeightEvidence && <small>最低净高 {measurement.format(clearHeightEvidence.minimumHeight)} m ·
                低于 {clearHeightEvidence.belowHeight} m 的面积 {measurement.format(clearHeightEvidence.lowArea)} m² /
                {' '}{measurement.format(clearHeightEvidence.usableArea)} m²（{percent.format(clearHeightEvidence.ratio)}）</small>}
              {'reason' in row && row.reason && <small>{row.reason}</small>}
              {row.diagnosis && <small>{row.diagnosis.blockers.map(kind => blockerLabels[kind]).join('、')}</small>}
              {!!evidenceFiles?.length && <small>补证据文件 {evidenceFiles.join('、')}</small>}
              {row.diagnosis?.candidate && <small>
                {row.diagnosis.candidate.label} {measurement.format(row.diagnosis.candidate.value)} {row.diagnosis.candidate.unit}
                {' · 待复核 · '}{row.diagnosis.candidate.source}
              </small>}
              {'libraryToolId' in row && typeof row.libraryToolId === 'string' && <small>工具 {row.libraryToolId}</small>}
              {doorUse && <small>{doorUses[doorUse.use]} · 开启角 {doorUse.openingAngleDeg}° ·
                {doorUse.measurementLine} · {doorUse.source}</small>}
              {'overlap' in row && row.overlap?.violations.map(({ lowerObject, evidence }) => <span
                key={JSON.stringify(lowerObject)}>与 {lowerObject.scope}/{lowerObject.id} 相交 {measurement.format(evidence.area)} m²
                {' '}<button type="button" onClick={() => locate(lowerObject)}>定位下层房间</button></span>)}
              {status === 'indeterminate' && !('reason' in row) && <small>{!row.object ? '模型没有可核查的此类对象。'
                : 'diagnostic' in row && row.diagnostic.status === 'clarification-required'
                  ? '该对象的适用性待确认。' : '缺少符合规则口径的测量证据。'}</small>}
              <small>{row.source.locator}{evidence && ` · ${evidence.dataSource}`}{clearHeightEvidence && ` · ${clearHeightEvidence.source}`}</small>
              {row.object && <button type="button" onClick={() => locate(row.object!)}>
                {row.object.table === 'level' ? '定位楼层' : row.object.table === 'space' ? '定位房间' : '定位构件'}
              </button>}
            </li>;
          }))}
      </ul>
      {(filter === 'all' || filter === 'pending') && displayedPending.length > 0 && <details open>
        <summary>待处理条款（{displayedPending.length}）</summary>
        <ul className="model-check-list">{displayedPending.map(item => <li key={item.id}>
          <strong>{item.id} · {item.title}</strong>
          <small>{item.plan?.kind === 'blocked' && item.plan.gap && `${gapLabels[item.plan.gap]} · `}{item.reason}</small>
          {(item.plan?.kind === 'tool-draft' || item.plan?.kind === 'door-clear-width-by-use') &&
            <small>在 PAL 工具库审核启用后，再核对条款和数据。</small>}
          <small>{item.source.locator} · {item.source.text}</small>
        </li>)}</ul>
      </details>}
      {report.exportFeedback.length > 0 && <details open>
        <summary>BIMDown 导出建议（{report.exportFeedback.length}）</summary>
        <ul className="model-check-list">{report.exportFeedback.map(item => <li key={item.ruleId}>
          <strong>{item.ruleId} · {item.affected} 项无法判断</strong>
          {item.blockers.length > 0 && <small>{item.blockers.map(({ kind, count }) => `${blockerLabels[kind]} ${count} 项`).join(' · ')}</small>}
          <small>文件 {item.files.join('、')}</small><small>字段 {item.fields.join('、')}</small><small>{item.advice}</small>
          {item.scope && <small>适用性记录 {item.scope.ruleId} · {item.scope.ruleVersion} · {item.scope.applicability}</small>}
          <button type="button" onClick={() => { setRuleFilter(item.ruleId); setFilter('indeterminate'); resultsHeading.current?.focus(); }}>查看受影响对象</button>
        </li>)}</ul>
      </details>}
      {filter !== 'all' && filter !== 'pending' && counts[filter] === 0 && <p>没有此状态的对象结果。</p>}
      <button type="button" onClick={download}>下载核查报告</button>
      {report.exportFeedback.length > 0 && <button type="button" onClick={() => setBaseline(report)}>保存为复跑基线</button>}
    </section>}
  </aside>;
}
