import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { EditorShell, generateMeasurementOutlines, parseCsv, parseLayer, previewPlanDoorAssignment, useDataSource, useEditorDispatch, useEditorState, useSelectionState } from 'bimdown-editor';
import { calculateProjectAreasFromText, projectGeometryPath } from './core/project-input.js';
import type { ProjectAreaConfig } from './core/project-input.js';
import { applyDoorAssignment, previewDoorAssignment } from './core/door-assignment.js';
import { AutomaticRooms } from './AutomaticRooms.tsx';
import { UnitRoomList } from './UnitRoomList.tsx';
import { CommonRoomAllocations } from './CommonRoomAllocations.tsx';
import { ManualRoomAssignment } from './ManualRoomAssignment.tsx';
import { assignSelectedRooms } from './manual-room-assignment.js';
import { removeAreaRooms, removeAreaUnit } from './area-deletion.js';
import { listCommonRooms, roomPoolId, saveSelectedRoomAllocations, type RoomReference } from './common-room-allocation.js';
import { AREA_CONFIG_PATH, getProjectAreaStore, parseProjectAreaConfig } from './project-area-storage.js';
import { ModelQuestionPanel } from './ModelQuestionPanel.tsx';
import { ModelCheckPanel } from '../check/ModelCheckPanel.tsx';
import type { ModelQaConnection } from './model-qa-types.js';
import { AreaPalPlan } from './AreaPalPlan.tsx';
import { DevelopmentFeedback } from './DevelopmentFeedback.tsx';
import './area.css';

type Report = ReturnType<typeof calculateProjectAreasFromText> & { pendingCommonRooms: RoomReference[] };
type Selection = ProjectAreaConfig['selections'][number];
type DoorPreviewResult = ReturnType<typeof previewDoorAssignment> & { source?: 'floor-plan' };
type DoorPreview = DoorPreviewResult & { missingContours: Set<string> };
const blank: ProjectAreaConfig = { version: 1, confirmed: false, ruleSource: '', nodes: [], groups: [], selections: [] };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const size = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });
export const AreaConfigInArchive = createContext(false);
type SaveStatus = { text: string; phase: 'saving' | 'saved' | 'loaded' | 'empty' | 'error'; error?: string };

export function AreaWorkspace() {
  const [panel, setPanel] = useState<'area' | 'check' | 'feedback'>();
  const [checkMounted, setCheckMounted] = useState(false);
  const [configText, setConfigText] = useState(json(blank));
  const [report, setReport] = useState<Report>();
  const [modelConnection, setModelConnection] = useState<ModelQaConnection>();
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [textDraft, setTextDraft] = useState('');
  const ds = useDataSource();
  useEffect(() => setTextDraft(''), [ds]);

  function openCheck(text?: string) {
    if (text !== undefined) setTextDraft(text);
    setCheckMounted(true);
    setPanel('check');
  }
  return (
    <div className="area-page">
      <div className="area-workspace">
        <div className="area-editor"><EditorShell /></div>
        <div className="area-tools">
          <button className="area-toggle" type="button" aria-expanded={panel === 'area'} aria-controls="area-panel"
            onClick={() => setPanel(panel === 'area' ? undefined : 'area')}>面积测算与分摊</button>
          <button className="area-toggle model-check-toggle" type="button" aria-expanded={panel === 'check'} aria-controls="model-check-panel"
            onClick={() => {
              setCheckMounted(true);
              setPanel(panel === 'check' ? undefined : 'check');
            }}>模型核查</button>
          <button className="area-toggle feedback-toggle" type="button" aria-expanded={panel === 'feedback'}
            aria-controls="development-feedback" onClick={() => setPanel(panel === 'feedback' ? undefined : 'feedback')}>功能建议</button>
        </div>
        <AreaPanel open={panel === 'area'} configText={configText} setConfigText={setConfigText} report={report} setReport={setReport}
          connection={modelConnection} openCheck={openCheck} />
        {checkMounted && <ModelCheckPanel open={panel === 'check'} close={() => setPanel(undefined)} connection={modelConnection}
          libraryRevision={libraryRevision} textDraft={textDraft} setTextDraft={setTextDraft} />}
        <DevelopmentFeedback open={panel === 'feedback'} close={() => setPanel(undefined)} />
      </div>
      <ModelQuestionPanel areaDraft={configText} report={report} onConnectionChange={setModelConnection} openCheck={openCheck}
        toolDrafted={() => setLibraryRevision(value => value + 1)} />
    </div>
  );
}

function AreaPanel({ open, configText, setConfigText, report, setReport, connection, openCheck }: {
  open: boolean;
  configText: string;
  setConfigText: (value: string) => void;
  report?: Report;
  setReport: (value: Report | undefined) => void;
  connection?: ModelQaConnection;
  openCheck: (text: string) => void;
}) {
  const ds = useDataSource();
  const store = getProjectAreaStore(ds);
  const inArchive = useContext(AreaConfigInArchive);
  const state = useEditorState();
  const { currentLevel, project, document: currentDocument } = state;
  const { selectedIds } = useSelectionState();
  const dispatch = useEditorDispatch();
  const [loadedStore, setLoadedStore] = useState<typeof store>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>();
  const [reviewed, setReviewed] = useState(false);
  const [notice, setNotice] = useState('');
  const [doorNotice, setDoorNotice] = useState<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);
  const [outlineScope, setOutlineScope] = useState<'level' | 'project'>('level');
  const [outlineResult, setOutlineResult] = useState<Awaited<ReturnType<typeof generateMeasurementOutlines>>>();
  const [outlineError, setOutlineError] = useState('');
  const [doorPreview, setDoorPreview] = useState<DoorPreview>();
  const [doorSource, setDoorSource] = useState<'floor-plan' | 'revit'>('floor-plan');
  const [insideUuid, setInsideUuid] = useState('');
  const [unitNumber, setUnitNumber] = useState('');
  const sequence = useRef(0);
  const doorSequence = useRef(0);
  const assignedUnits = useRef<HTMLElement>(null);
  const ruleSourceField = useRef<HTMLInputElement>(null);
  const outlineDetails = useRef<HTMLDetailsElement>(null);
  const liveSource = useRef({ ds, project, currentDocument, currentLevel });
  liveSource.current = { ds, project, currentDocument, currentLevel };

  const displayConfig = useCallback((text: string) => {
    sequence.current += 1;
    doorSequence.current += 1;
    setConfigText(text);
    setReviewed(false);
    setReport(undefined);
    setDoorPreview(undefined);
    setDoorNotice(undefined);
    setNotice('');
  }, [setConfigText, setReport]);

  const restoreConfig = useCallback((text: string | null) => {
    const restored = text ?? json(blank);
    displayConfig(restored);
    setSaveStatus({ text: restored, phase: text === null ? 'empty' : 'loaded' });
  }, [displayConfig]);

  useEffect(() => {
    let active = true;
    store.load().then(text => {
      if (active) restoreConfig(text);
    }, error => {
      if (!active) return;
      const text = json(blank);
      displayConfig(text);
      setSaveStatus({ text, phase: 'error', error: message(error) });
    }).finally(() => {
      if (active) setLoadedStore(store);
    });
    return () => { active = false; };
  }, [store, displayConfig, restoreConfig]);

  const unsaved = saveStatus?.text !== configText || saveStatus?.phase === 'saving' || saveStatus?.phase === 'error';
  useEffect(() => {
    if (loadedStore !== store || !unsaved) return;
    function warnOnLeave(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', warnOnLeave);
    return () => window.removeEventListener('beforeunload', warnOnLeave);
  }, [loadedStore, store, unsaved]);

  useEffect(() => {
    const invalidate = () => {
      sequence.current += 1;
      doorSequence.current += 1;
      setReport(undefined);
      setReviewed(false);
      setDoorPreview(undefined);
    };
    invalidate();
    setOutlineResult(undefined);
    setOutlineError('');
    const unsubscribe = ds.watchChanges(path => {
      if (path.endsWith('.geojson') || path.endsWith('/door.csv') ||
          ['project_metadata.json', 'area_features.json', '_IdMap.csv'].includes(path)) invalidate();
    });
    return () => {
      sequence.current += 1;
      doorSequence.current += 1;
      unsubscribe();
    };
  }, [ds, setReport]);

  useEffect(() => {
    sequence.current += 1;
    setReport(undefined);
    setReviewed(false);
  }, [project, currentDocument, setReport]);

  useEffect(() => {
    doorSequence.current += 1;
    setDoorPreview(undefined);
  }, [currentLevel, currentDocument, project?.levels, project?.globalLayers, project?.metadata]);

  useEffect(() => {
    if (doorNotice && !doorNotice.error) assignedUnits.current?.scrollIntoView({ block: 'nearest' });
  }, [doorNotice]);

  function update(text: string) {
    const write = store.save(text);
    displayConfig(text);
    const status: SaveStatus = { text, phase: 'saving' };
    setSaveStatus(status);
    void write.then(
      () => setSaveStatus(current => current === status ? { text, phase: 'saved' } : current),
      error => setSaveStatus(current => current === status ? { text, phase: 'error', error: message(error) } : current),
    );
  }

  function parse() {
    return parseProjectAreaConfig(configText);
  }

  function selectedObject() {
    const [selected] = selectedIds;
    const delimiter = selected?.indexOf(':') ?? -1;
    const level = delimiter < 0 ? currentLevel : selected.slice(0, delimiter);
    if (selectedIds.size !== 1 || !level) return undefined;
    const elementId = delimiter < 0 ? selected : selected.slice(delimiter + 1);
    return { level, elementId };
  }

  async function previewEntrance() {
    setDoorPreview(undefined);
    const entry = selectedDoor;
    if (!entry) throw new Error('请在当前楼层单独选择一樘入户门。');
    const request = ++doorSequence.current;
    const config = parse();
    let result: DoorPreviewResult;
    if (doorSource === 'floor-plan') {
      const blockedOwners = new Set(config.nodes.filter(node => node.type === 'pool' || node.type === 'excluded').map(node => node.id));
      const excluded = new Set(config.selections.filter(item => item.level === entry.level && item.table === 'space' &&
        (blockedOwners.has(item.owner) || item.kind === 'common' || item.kind === 'excluded')).map(item => item.elementId));
      result = previewPlanDoorAssignment(state, entry, excluded);
    } else {
      const [evidence, mapping] = await Promise.all([ds.fetchText('area_features.json'), ds.fetchText('_IdMap.csv')]);
      if (!evidence || !mapping) throw new Error('缺少 Revit 门—房间证据，可切换为按当前平面预览。');
      result = previewDoorAssignment(JSON.parse(evidence), parseCsv(mapping).map(row =>
        ({ id: row.id, uuid: row.uuid, directory: row.directory })), entry, config);
    }
    const geometry = await ds.fetchText(projectGeometryPath({ level: entry.level, table: 'space' }));
    const features: { properties?: { id?: unknown; redundant?: boolean }; geometry?: { type?: string } }[] =
      geometry ? JSON.parse(geometry).features ?? [] : [];
    const missingContours = new Set(result.candidates.flatMap(candidate => candidate.rooms).filter(room => {
      const matches = features.filter(feature => String(feature.properties?.id) === room.elementId);
      return matches.length !== 1 || matches[0].geometry?.type !== 'Polygon' || matches[0].properties?.redundant === true;
    }).map(room => room.uuid));
    if (request !== doorSequence.current) throw new Error('项目数据已有变动，请重新预览户内房间。');
    setDoorPreview({ ...result, missingContours });
    setInsideUuid(result.candidates.length === 1 ? result.candidates[0].inside.uuid : '');
  }

  function confirmEntrance() {
    const candidate = chosenSide;
    if (doorPrerequisite || !activeDoorPreview || !candidate)
      throw new Error(doorPrerequisite || '请重新预览户内房间。');
    const config = applyDoorAssignment(parse(), activeDoorPreview, candidate, unitNumber.trim());
    const missing = candidate.rooms.filter(room => activeDoorPreview.missingContours.has(room.uuid)).length;
    update(json(config));
    setDoorNotice({ error: false, text: `已将 ${candidate.rooms.length} 个房间归入 ${unitNumber.trim()} 户。` +
      (missing ? `其中 ${missing} 个房间须补齐可测算轮廓。` : '请在测算前审核边界与计入系数。') });
  }

  function addGroup(form: FormData) {
    const config = parse();
    const pool = String(form.get('pool')).trim();
    const poolNode = config.nodes.find(node => node.id === pool && node.type === 'pool');
    const targets = String(form.get('recipients')).split(/[,，]/).map(id => id.trim()).filter(Boolean);
    const source = String(form.get('source')).trim();
    if (!poolNode || !source || !targets.length || targets.includes(pool) || new Set(targets).size !== targets.length ||
        targets.some(id => !config.nodes.some(node => node.id === id && node.type !== 'excluded' && node.building === poolNode.building)))
      throw new Error('请填写已存在的共有池、同幢且不重复的接收节点，以及分摊依据。');
    if (config.groups.some(group => group.pool === pool)) throw new Error('该共有池已有分摊规则，可在配置 JSON 中修改。');
    config.groups.push({ id: pool, pool, method: form.get('method') === 'equal' ? 'equal' : 'area',
      source, recipients: targets.map(id => ({ id })) });
    update(json({ ...config, confirmed: false }));
    setNotice(`已加入共有池 ${pool} 的分摊规则`);
  }

  async function calculate() {
    if (!reviewed) throw new Error('请先确认测算边界、归属及分摊规则。');
    const config = { ...parse(), confirmed: true };
    if (!config.selections.length && !config.parts?.length) throw new Error('请先添加房间轮廓或录入已测量分项。');
    const request = sequence.current;
    setReport(undefined);
    const paths = new Set(['project_metadata.json', 'area_features.json', ...config.selections.map(projectGeometryPath)]);
    const files = new Map(await Promise.all([...paths].map(async path => [path, await ds.fetchText(path)] as const)));
    const metadata = files.get('project_metadata.json');
    if (!metadata || !['m', 'mm', 'ft', 'in'].includes(JSON.parse(metadata)?.units))
      throw new Error('请补导出 project_metadata.json，并在 units 声明与模型轮廓一致的坐标单位。');
    const missing = config.selections.find(item => !files.get(projectGeometryPath(item)));
    if (missing) {
      const floor = levelNames.get(missing.level) ?? missing.level;
      const repair = missing.table === 'space' ? '请生成房间轮廓，或' : '请';
      throw new Error(`${floor} 缺少测算几何。${repair}从 BIMDown 补导出 ${projectGeometryPath(missing)}，保留与构件表一致的 ID、边界和坐标单位。`);
    }
    const result = calculateProjectAreasFromText(path => files.get(path) ?? undefined, config);
    if (request === sequence.current) {
      setReport({ ...result, pendingCommonRooms });
      setNotice('计算完成');
    }
  }

  async function generateOutlines(scope = outlineScope) {
    setOutlineResult(undefined);
    setOutlineError('');
    const isCurrent = () => {
      const live = liveSource.current;
      return live.ds === ds && live.project === project && live.currentDocument === currentDocument &&
        live.currentLevel === currentLevel;
    };
    try {
      const result = await generateMeasurementOutlines(state, ds, scope, isCurrent);
      if (liveSource.current.ds !== ds) return;
      setOutlineResult(result);
      if (result.generated) {
        sequence.current += 1;
        doorSequence.current += 1;
        setReport(undefined);
        setReviewed(false);
        setDoorPreview(undefined);
        setDoorNotice(undefined);
      }
    } catch (error) {
      setOutlineError(message(error));
    }
  }

  async function run(action: () => void | Promise<void>, doorAction = false) {
    setBusy(true);
    setNotice('');
    if (doorAction) setDoorNotice(undefined);
    try {
      await action();
    } catch (error) {
      if (doorAction) setDoorNotice({ text: message(error), error: true });
      else setNotice(message(error));
    } finally {
      setBusy(false);
    }
  }

  function locate(selection: Pick<Selection, 'level' | 'elementId'>) {
    if (selection.level !== currentLevel) dispatch({ type: 'SET_LEVEL', levelId: selection.level });
    dispatch({ type: 'SELECT', ids: [`${selection.level}:${selection.elementId}`], exact: true });
  }

  function deleteRooms(rooms: RoomReference[]) {
    if (state.readonly || state.groupEdit || currentDocument?.levelId !== currentLevel ||
        !rooms.length || rooms.some(room => room.level !== currentLevel ||
          currentDocument.elements.get(room.elementId)?.tableName !== 'space'))
      throw new Error('请在当前可编辑楼层重新选择要删除的房间。');

    const next = removeAreaRooms(parse(), rooms);
    // The native Delete also handles hosted annotations and its undo history.
    dispatch({ type: 'SET_PROJECT_SELECTION', levels: null });
    dispatch({ type: 'DELETE_ELEMENTS', ids: rooms.map(room => room.elementId) });
    update(json(next));
  }

  function download(value: unknown, name: string) {
    const url = URL.createObjectURL(new Blob([json(value)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let draft: ProjectAreaConfig | undefined;
  let configError = '';
  try { draft = parse(); } catch (error) { configError = message(error); }
  const modelRooms = useMemo(() => project?.levels.flatMap(({ id: level }) => {
    const elements = currentDocument?.levelId === level ? [...currentDocument.elements.values()] :
      project.floors.get(level)?.layers.filter(layer => layer.tableName === 'space').flatMap(parseLayer) ?? [];
    return elements.filter(element => element.tableName === 'space').map(element =>
      ({ level, elementId: element.id, name: element.attrs.name || element.id }));
  }) ?? [], [project, currentDocument]);
  const levelNames = new Map(project?.levels.map(level => [level.id, level.name || level.id]));
  const commonRooms = draft ? listCommonRooms(draft, modelRooms) : [];
  const pendingCommonRooms = commonRooms.filter(item => !item.group).map(item => item.room);
  const poolNames = new Map(commonRooms.filter(item => item.selection?.owner === roomPoolId(item.room))
    .map(({ room }) => [roomPoolId(room), `${levelNames.get(room.level) ?? room.level} · ${room.name}`]));
  const legacyPools = draft?.nodes.filter(node => node.type === 'pool' && !poolNames.has(node.id)) ?? [];
  const currentSelection = selectedObject();
  const selectedDoor = currentSelection?.level === currentLevel && currentDocument?.levelId === currentLevel &&
    currentDocument.elements.get(currentSelection.elementId)?.tableName === 'door' ? currentSelection : undefined;
  const activeDoorPreview = doorPreview?.entry.level === currentLevel &&
    (!selectedDoor || selectedDoor.elementId === doorPreview.entry.elementId) ? doorPreview : undefined;
  const chosenSide = activeDoorPreview?.candidates.find(candidate => candidate.inside.uuid === insideUuid);
  const doorPrerequisite = !draft ? '请先修正配置 JSON 中的错误。'
    : !activeDoorPreview ? (selectedDoor ? '请先点击「预览户内房间」。' : '请在当前楼层单独选中一樘入户门，再预览户内房间。')
    : !chosenSide ? '请在「选择户内一侧」中选择入户后的第一个房间。'
    : !unitNumber.trim() ? '请填写户号。' : '';

  const storageNotice = saveStatus?.phase === 'error' ? `项目配置未保存。 ${saveStatus.error}`
    : saveStatus?.text !== configText ? '有配置修改待保存。'
    : saveStatus.phase === 'saving' ? '正在保存项目配置…'
    : configError ? '项目配置无法解析，可在「配置 JSON」中检查或导入有效配置。'
    : saveStatus.phase === 'saved' && inArchive ? '归户及分摊配置已更新。请下载右上角的 ZIP 或保存到文件夹。'
    : saveStatus.phase === 'saved' ? '归户及分摊配置已保存到项目文件夹。'
    : saveStatus.phase === 'loaded' ? '已读取项目配置。' : '';
  const outlineUnavailable = !currentDocument || currentDocument.levelId !== currentLevel || state.readonly || !!state.groupEdit;

  if (loadedStore !== store) return (
    <aside id="area-panel" className="area-panel" aria-label="面积测算与分摊" hidden={!open}>
      <p className="area-status" role="status">正在读取项目配置…</p>
    </aside>
  );

  return (
    <aside id="area-panel" className="area-panel" aria-label="面积测算与分摊" hidden={!open}>
      <header><h2>面积测算与分摊</h2></header>
      <AreaPalPlan connection={connection} floor={{ id: currentLevel, name: levelNames.get(currentLevel) }}
        busy={busy} canCalculate={reviewed && !!draft?.ruleSource.trim()} canOutline={!outlineUnavailable}
        calculate={() => void run(calculate)} openCheck={openCheck} outline={scope => {
          setOutlineScope(scope);
          if (outlineDetails.current) outlineDetails.current.open = true;
          void run(() => generateOutlines(scope));
        }} />
      <div className="area-actions">
        <label className="area-file">导入配置<input type="file" accept=".json" disabled={busy} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void run(async () => update(await file.text()));
        }} /></label>
        <button type="button" disabled={busy || saveStatus?.phase === 'saving'} onClick={() => void run(async () => {
          if (unsaved && !window.confirm('读取项目配置会放弃当前未保存的修改。继续读取？')) return;
          restoreConfig(await store.load());
        })}>读取项目配置</button>
      </div>
      {storageNotice && <p className={saveStatus?.phase === 'error' ? 'area-status area-error' : 'area-status'}
        role={saveStatus?.phase === 'error' ? 'alert' : 'status'}>{storageNotice}</p>}
      {saveStatus?.phase === 'error' && draft && <button type="button" disabled={busy}
        onClick={() => void run(() => update(configText))}>重试保存配置</button>}
      {open && <AutomaticRooms />}
      <details ref={outlineDetails}>
        <summary>测算轮廓</summary>
        <p>沿墙中心线提取已有房间的边界，补齐对应楼层的测算轮廓文件。</p>
        <label>轮廓生成范围<select value={outlineScope} disabled={busy} onChange={event => {
          setOutlineScope(event.target.value === 'project' ? 'project' : 'level');
          setOutlineResult(undefined);
          setOutlineError('');
        }}>
          <option value="level">当前楼层（{levelNames.get(currentLevel) ?? currentLevel}）</option>
          <option value="project">全部楼层</option>
        </select></label>
        <button type="button" disabled={busy || outlineUnavailable} onClick={() => void run(generateOutlines)}>生成测算轮廓</button>
        {outlineError && <p role="alert" className="area-status area-error">{outlineError}</p>}
        {outlineResult && <div>
          <p className="area-status" role="status">
            {outlineResult.generated || outlineResult.preserved || outlineResult.issues.length
              ? `已生成 ${outlineResult.generated} 个轮廓，已有 ${outlineResult.preserved} 个，${outlineResult.issues.length} 项待核对。`
              : '所选范围内暂无房间。'}
          </p>
          {outlineResult.generated > 0 && <p className="area-status">{inArchive
            ? '轮廓已加入项目。请下载右上角的 ZIP 或保存到文件夹。'
            : '已保存至相应楼层的 space.geojson。'}</p>}
          {outlineResult.issues.length > 0 && <ul className="area-parts area-room-preview">
            {outlineResult.issues.map(({ level, room, reason }) => <li key={JSON.stringify([level, room?.elementId])}>
              <div>
                {room ? <button type="button" onClick={() => locate({ level, elementId: room.elementId })}>
                  {levelNames.get(level) ?? level} · {room.name} · {room.elementId}
                </button> : <span>{levelNames.get(level) ?? level}</span>}
                <div><small>{reason}</small></div>
              </div>
            </li>)}
          </ul>}
        </div>}
      </details>
      <details>
        <summary>按入户门归户</summary>
        <p>在当前楼层选中入户门，预览与户内一侧相连的房间。</p>
        {currentSelection && <p>当前选中 {currentSelection.level} / {currentSelection.elementId}</p>}
        <label>连通依据<select value={doorSource} disabled={busy} onChange={event => {
          setDoorSource(event.target.value === 'revit' ? 'revit' : 'floor-plan');
          doorSequence.current += 1;
          setDoorPreview(undefined);
          setDoorNotice(undefined);
        }}>
          <option value="floor-plan">当前平面（含网页新建房间）</option>
          <option value="revit">Revit 导出证据</option>
        </select></label>
        <label>户号<input placeholder="例如 101" value={unitNumber} disabled={busy} onChange={event => {
          setUnitNumber(event.target.value);
          setDoorNotice(undefined);
        }} /></label>
        <button type="button" disabled={busy || !draft || !selectedDoor}
          onClick={() => void run(previewEntrance, true)}>预览户内房间</button>
        {activeDoorPreview && <div>
          <p>入户门 {activeDoorPreview.entry.level} / {activeDoorPreview.entry.elementId}</p>
          {activeDoorPreview.candidates.length > 1 && <label>选择户内一侧<select value={insideUuid}
            disabled={busy} onChange={event => {
              setInsideUuid(event.target.value);
              setDoorNotice(undefined);
            }}>
            <option value="">请选择</option>
            {activeDoorPreview.candidates.map(item => <option value={item.inside.uuid} key={item.inside.uuid}>
              {item.inside.name} · {item.inside.elementId}（{item.rooms.length} 间）
            </option>)}
          </select></label>}
          {chosenSide && <>
            <ul className="area-parts area-room-preview">{chosenSide.rooms.map(room =>
              <li key={room.uuid}><button type="button" onClick={() => locate(room)}>{room.name} · {room.elementId}</button>
                {activeDoorPreview.missingContours.has(room.uuid) && <small>缺可测算轮廓</small>}</li>,
            )}</ul>
            {chosenSide.warnings.map(warning => <p className="area-status" key={warning}>{warning}</p>)}
            {doorSource === 'floor-plan' && <p>请核对预览是否包含公共走廊或相邻住户的房间。</p>}
            <p>确认这些房间均属该户。新增分项暂按系数 1 录入，测算前仍需审核。</p>
          </>}
        </div>}
        <div className="area-door-confirm">
          {doorPrerequisite && !doorNotice && <p className="area-status">{doorPrerequisite}</p>}
          <button type="button" disabled={busy}
            onClick={() => void run(confirmEntrance, true)}>确认批量归户</button>
          {doorNotice && <p role={doorNotice.error ? 'alert' : 'status'}
            className={doorNotice.error ? 'area-status area-error' : 'area-status'}>{doorNotice.text}</p>}
        </div>
      </details>
      {draft && <ManualRoomAssignment key={currentLevel} draft={draft} levelName={levelNames.get(currentLevel) ?? currentLevel}
        rooms={modelRooms.filter(room => room.level === currentLevel)} planIds={selectedIds} busy={busy}
        canDelete={!state.readonly && !state.groupEdit && currentDocument?.levelId === currentLevel} remove={deleteRooms}
        save={(rooms, unit, confirmMove) => update(json(assignSelectedRooms(parse(), rooms, unit, confirmMove)))} />}
      <UnitRoomList draft={draft} sectionRef={assignedUnits} busy={busy}
        remove={unitId => update(json(removeAreaUnit(parse(), unitId)))} />
      {draft && <CommonRoomAllocations draft={draft} rooms={commonRooms} level={currentLevel}
        levelNames={levelNames} busy={busy} locate={locate}
        save={(rooms, rule) => update(json(saveSelectedRoomAllocations(parse(), rooms, rule)))} />}
      {legacyPools.length > 0 && <details>
        <summary>已有共有池分摊</summary>
        <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(() => addGroup(data)); }}>
          <label>共有池 ID<select name="pool" required>
            {legacyPools.map(pool => <option key={pool.id} value={pool.id}>{pool.id}</option>)}
          </select></label>
          <label>接收节点 ID（以逗号分隔）<input name="recipients" required /></label>
          <label>方法<select name="method"><option value="area">自身计入面积比例</option><option value="equal">等份</option></select></label>
          <label>分摊依据<input name="source" required /></label>
          <button type="submit" disabled={busy}>添加分摊规则</button>
        </form>
      </details>}
      <label>测算规则来源<input ref={ruleSourceField} aria-required="true" value={draft?.ruleSource ?? ''}
        placeholder="填写采用的测算依据或审核记录" disabled={!draft || busy}
        onChange={event => { if (draft) displayConfig(json({ ...draft, ruleSource: event.target.value, confirmed: false })); }}
        onBlur={() => { if (draft && saveStatus?.text !== configText) update(configText); }} /></label>
      <details>
        <summary>配置 JSON</summary>
        <label>完整配置<textarea rows={12} spellCheck={false} value={configText} onChange={event => displayConfig(event.target.value)} /></label>
        {configError && <p className="area-status">{configError}</p>}
        <button type="button" disabled={!draft || busy} onClick={() => void run(() => update(configText))}>保存配置</button>
        <button type="button" disabled={!draft} onClick={() => { if (draft) download({ ...draft, confirmed: reviewed }, AREA_CONFIG_PATH); }}>下载配置</button>
      </details>
      <label className="area-review"><input type="checkbox" checked={reviewed} onChange={event => {
        setReviewed(event.target.checked);
        sequence.current += 1;
        setReport(undefined);
      }} />我已审核测算边界、归属、系数和分摊规则</label>
      {pendingCommonRooms.length > 0 && <p className="area-status">
        {pendingCommonRooms.length} 间共用房间待设置分摊。本次测算只计入已设置的分项。
      </p>}
      <button className="area-primary" type="button" disabled={busy || !reviewed || !draft}
        onClick={() => {
          if (!draft?.ruleSource.trim()) {
            setNotice('请填写「测算规则来源」，说明本次采用的测算依据。');
            ruleSourceField.current?.focus();
            return;
          }
          void run(calculate);
        }}>运行测算</button>
      <p role="status" className="area-status">{notice}</p>
      {report && <section>
        <h3>分户结果 <small>m²</small></h3>
        {report.pendingCommonRooms.length > 0 && <p className="area-status">
          {report.pendingCommonRooms.length} 间共用房间待设置分摊，结果仅汇总已设置的分项。
        </p>}
        <table><thead><tr><th>户</th><th>套内</th><th>分摊</th><th>合计</th></tr></thead>
          <tbody>{report.units.map(unit => <tr key={unit.id}><th>{unit.id}</th><td>{size.format(unit.internalArea)}</td>
            <td>{size.format(unit.sharedArea)}</td><td>{size.format(unit.totalArea)}</td></tr>)}</tbody></table>
        <details><summary>分项与来源</summary><ul className="area-parts">{report.parts.map(part => {
          const item = draft?.selections.find(selection => selection.id === part.id);
          return <li key={part.id}><div>{item ? <button type="button" onClick={() => locate(item)}>{part.id}</button> : part.id}
            <div><small>{part.source} · 系数 {part.factor}</small></div></div>
            <small>{size.format(part.countedArea)} m²</small></li>;
        })}</ul></details>
        <details><summary>分摊明细</summary><table>
          <thead><tr><th>共有池</th><th>接收节点</th><th>分摊 m²</th></tr></thead>
          <tbody>{report.allocations.map(transfer => <tr key={JSON.stringify([transfer.group, transfer.to])}>
            <th>{poolNames.get(transfer.from) ?? transfer.from}</th><td>{transfer.to}</td><td>{size.format(transfer.area)}</td>
          </tr>)}</tbody>
        </table></details>
        <details><summary>建筑面积平衡</summary><ul className="area-parts">{report.buildings.map(building =>
          <li key={building.building}><span>{building.building}</span>
            <small>{size.format(building.measuredArea)} = {size.format(building.allocatedArea)} + {size.format(building.excludedArea)} m²</small></li>,
        )}</ul></details>
        <button type="button" onClick={() => download(report, 'area-report.json')}>下载完整报告</button>
      </section>}
    </aside>
  );
}
