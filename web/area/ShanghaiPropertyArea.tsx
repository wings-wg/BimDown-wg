import { useEffect, useRef, useState } from 'react';
import { useDataSource, useEditorState } from 'bimdown-editor';
import { executeShanghaiPropertyArea, inspectShanghaiPropertyArea, PROPERTY_AREA_PATH, SHANGHAI_PROFILE } from './core/shanghai-property.js';
import { inspectPropertyModelEvidence, type PropertyModelEvidence } from './core/property-model-evidence.js';
import type { WorkspaceCommandRequest } from './editor-commands.js';
import { PropertyBoundaryReview } from './PropertyBoundaryReview.tsx';

type Result = Awaited<ReturnType<typeof executeShanghaiPropertyArea>>;
type Readiness = Awaited<ReturnType<typeof inspectShanghaiPropertyArea>>;
const area = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const openingLabels: Record<PropertyModelEvidence['levels'][number]['openings'][number]['status'], string> = {
  'hosted-cut': '按宿主投影扣除',
  'already-in-host-hole': '原板轮廓已留洞',
  'partially-in-host': '仅部分落在宿主有效面内',
  'outside-host': '洞口位于宿主轮廓外',
  'unresolved-host': '无法唯一确认同层宿主',
  'cross-level-shaft': '待审核跨层洞口或井道',
  'missing-geometry': '缺洞口轮廓',
  'geometry-error': '洞口几何无效或叠置失败',
};
const diagnosticLabels: Record<string, string> = {
  ...openingLabels,
  'missing-model-revision': '缺工程导出版本',
  'engineering-revision-mismatch': '工程观测与导出版本不匹配',
  'invalid-engineering-evidence': '工程观测文件无效',
  'missing-id': '缺对象编号',
  'duplicate-id': '文件内对象编号重复',
  'invalid-feature-collection': '轮廓文件无效',
  'invalid-elevation': '缺有效标高',
  'missing-surface-polygon': '板或屋面缺轮廓',
  'missing-surface-row': '板或屋面轮廓缺关联属性',
  'invalid-surface-polygon': '板或屋面轮廓无效',
  'surface-overlay-failed': '板或屋面投影叠置失败',
  'no-surface-polygons': '缺可用板或屋面轮廓',
  'orphan-room-outline': '轮廓缺对应房间记录',
  'invalid-room-boundary-line': '房间边界线无效',
  'unscoped-global-wall': '全局墙缺可核对的竖向范围',
  'no-space-rows': '缺房间表记录',
  'no-space-outlines': '缺可用房间轮廓',
};
const roomBasisLabels = {
  'wall-centerline': '墙中心线', 'revit-room-finish': 'Revit 房间完成面', 'unknown-saved-boundary': '已保存轮廓，边界口径待核',
};
const roomIssueLabels: Record<string, string> = {
  'invalid-or-redundant-saved-outline': '已保存轮廓无效、重复或标记为冗余',
  'seed-outside-saved-outline': '定位点落在已保存轮廓之外',
  'invalid-room-seed': '缺有效定位点',
  'no-room-boundary-walls': '缺可用墙线或房间分隔线',
  'shared-room-face': '多个房间落在同一闭合区域',
  'unbounded-room': '定位点周边墙线未闭合',
  'nested-room-face': '墙线存在内圈，需核对洞口边界',
  'invalid-derived-room-outline': '无法生成有效单一轮廓',
  'overlapping-room-outlines': '与其他房间存在正面积重叠',
  'room-overlap-check-failed': '无法完成房间轮廓重叠校核',
};
const candidateInput = /^(global\/level\.csv|engineering_evidence\.json|[^/]+\/(slab|structure_slab|roof|opening|space|wall|structure_wall|curtain_wall|room_separator)\.(csv|geojson))$/;
const displayArea = (value: number | null) => value === null ? '待补' : area.format(value);
function download(name: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Locate = (level: string, id?: string) => void;

function ModelEvidenceView({ evidence, locate, currentLevel, active, configText }: {
  evidence: PropertyModelEvidence; locate: Locate; currentLevel: string; active: boolean; configText: string;
}) {
  const [levelId, selectLevel] = useState(currentLevel);
  const level = evidence.levels.find(item => item.id === levelId) ?? evidence.levels[0];
  const issues = [...evidence.diagnostics, ...level.diagnostics];
  const floorsWithRooms = evidence.levels.filter(item => item.rooms.rowCount > 0).length;
  const floorsWithOutlines = evidence.levels.filter(item => item.rooms.outlineIds.length + item.rooms.derivedOutlineIds.length > 0).length;
  const ids = [...level.surfaces.map(item => item.id), ...level.openings.map(item => item.ref.id), ...level.rooms.items.map(item => item.id)];
  const objectLink = (id: string, label: string) => ids.indexOf(id) === ids.lastIndexOf(id)
    ? <button type="button" onClick={() => locate(level.id, id)}>{label}</button>
    : <strong>{label}</strong>;
  return <section aria-label="模型候选证据">
    <p>{evidence.levels.length} 个标高层 · {floorsWithRooms} 层有房间记录 · {floorsWithOutlines} 层有房间轮廓</p>
    <p>板面投影和房间几何面积供边界复核。自然层、产权套界及共有受益户仍需确认。</p>
    <div className="area-actions">
      <label>候选证据楼层<select value={level.id} onChange={event => selectLevel(event.target.value)}>
        {evidence.levels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.elevationM === null ? '待核标高' : `${item.elevationM} m`}</option>)}
      </select></label>
      <button type="button" onClick={() => locate(level.id)}>定位楼层</button>
    </div>
    <dl>
      <dt>板面合并投影（m²）</dt><dd>{displayArea(level.projectedAreaM2)}</dd>
      <dt>扣除有宿主洞口后的投影（m²）</dt><dd>{displayArea(level.netProjectionM2)}</dd>
      <dt>房间轮廓候选</dt><dd>已保存 {level.rooms.outlineIds.length} · 由定位点推导 {level.rooms.derivedOutlineIds.length} · 待核 {level.rooms.needsReviewCount}</dd>
    </dl>
    <PropertyBoundaryReview key={level.id} evidence={evidence} level={level} configText={configText}
      active={active} locate={locate} download={download} />
    {!level.rooms.rowCount && <p>可从 Revit 补导房间及轮廓，或在网页自动创建房间。</p>}
    {!!level.rooms.items.length && <details><summary>逐间查看面积与边界（{level.rooms.rowCount}）</summary>
      <ul className="area-room-preview">
        {level.rooms.items.map(item => <li key={item.id}>
          {objectLink(item.id, `${item.name} · ${item.id}`)}{' '}
          {item.areaM2 === null ? `待核 · ${roomIssueLabels[item.issue ?? ''] ?? item.issue}`
            : `${displayArea(item.areaM2)} m² · ${item.basis ? roomBasisLabels[item.basis] : ''}`}
        </li>)}
      </ul>
    </details>}
    {level.roleHint && <p>楼层用途线索 {level.roleHint === 'roof-datum-by-name' ? '名称含屋顶' : level.roleHint}，请复核自然层归属。</p>}
    {!!level.sameElevationLevelIds.length && <p>同一标高另有 {level.sameElevationLevelIds.join('、')}，请复核重复计量。</p>}
    {!!level.surfaces.length && <details><summary>板或屋面来源（{level.surfaces.length}）</summary><ul>
      {level.surfaces.map(item => <li key={`${item.table}/${item.id}`}>
        {objectLink(item.id, `${item.table} · ${item.id}`)}{' '}
        {area.format(item.polygonAreaM2)} m² <small>{item.path}</small>
      </li>)}
    </ul></details>}
    {!!level.openings.length && <details><summary>洞口来源（{level.openings.length}）</summary><ul>
      {level.openings.map(item => <li key={item.ref.id}>
        {objectLink(item.ref.id, item.ref.id)}{' '}
        {openingLabels[item.status]}{item.host && ` · ${item.host.table}/${item.host.id}`}
      </li>)}
    </ul></details>}
    {!!issues.length && <ul aria-label="候选证据待核项">
      {issues.map((item, i) => <li key={`${item.path}/${item.id ?? ''}/${item.code}/${i}`}>
        {diagnosticLabels[item.code] ?? item.code} <small>{item.path}{item.id && ` · ${item.id}`}</small>
      </li>)}
    </ul>}
    <button type="button" onClick={() => download('property-model-evidence.json', JSON.stringify(evidence, null, 2))}>下载模型候选证据</button>
  </section>;
}

export function ShanghaiPropertyArea({ locate, outlineRevision, command, configText, active }: {
  locate: Locate; outlineRevision: number; command?: WorkspaceCommandRequest; configText: string; active: boolean;
}) {
  const ds = useDataSource();
  const { currentLevel, lastMutation, floorWrites } = useEditorState();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Result>();
  const [readiness, setReadiness] = useState<Readiness>();
  const [modelEvidence, setModelEvidence] = useState<PropertyModelEvidence>();
  const [error, setError] = useState('');
  const generation = useRef(0);
  const details = useRef<HTMLDetailsElement>(null);
  const handledCommand = useRef<WorkspaceCommandRequest>(undefined);

  useEffect(() => {
    const keys = [...(lastMutation?.keys ?? []), ...(floorWrites?.writes.at(-1)?.keys ?? [])];
    if (!keys.some(key => /\/(space|wall|structure_wall|curtain_wall|room_separator|opening|slab|structure_slab|roof)$/.test(key))) return;
    generation.current++;
    setModelEvidence(undefined);
    setBusy(false);
  }, [lastMutation, floorWrites]);

  useEffect(() => {
    generation.current++;
    setModelEvidence(undefined);
    setBusy(false);
  }, [outlineRevision]);

  useEffect(() => {
    generation.current++;
    setDraft('');
    setReviewed(false);
    setReport(undefined);
    setReadiness(undefined);
    setModelEvidence(undefined);
    setError('');
    setBusy(false);
    const stopWatching = ds.watchChanges(path => {
      const reportChanged = path === 'project_metadata.json' || path === PROPERTY_AREA_PATH || path.endsWith('/property_boundary.geojson');
      const modelChanged = path === 'project_metadata.json' || candidateInput.test(path);
      if (!reportChanged && !modelChanged) return;
      generation.current++;
      if (reportChanged) {
        setReviewed(false);
        setReport(undefined);
        setReadiness(undefined);
      }
      if (modelChanged) setModelEvidence(undefined);
      setBusy(false);
    });
    return () => { generation.current++; stopWatching(); };
  }, [ds]);

  function edit(text: string) {
    setDraft(text);
    setReviewed(false);
    setReport(undefined);
    setReadiness(undefined);
    setError('');
  }

  async function run(action: (isCurrent: () => boolean) => Promise<void>) {
    if (busy) return;
    const id = ++generation.current;
    const isCurrent = () => id === generation.current;
    setBusy(true);
    setError('');
    try { await action(isCurrent); }
    catch (error) { if (isCurrent()) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (isCurrent()) setBusy(false); }
  }

  const read = (path: string) => ds.fetchText(path);

  function inspectModel() {
    return run(async current => {
      const evidence = await inspectPropertyModelEvidence(read);
      if (current()) setModelEvidence(evidence);
    });
  }

  function checkConditions() {
    return run(async current => {
      setReport(undefined);
      setReadiness(undefined);
      const text = draft.trim() ? draft : await read(PROPERTY_AREA_PATH);
      if (!current()) return;
      if (!draft.trim() && text?.trim()) edit(text);
      const result = await inspectShanghaiPropertyArea(read, text ?? '');
      if (current()) setReadiness(result);
    });
  }

  useEffect(() => {
    if (busy || command?.plan.action !== 'editor.property-area' || handledCommand.current === command) return;
    handledCommand.current = command;
    if (details.current) {
      details.current.open = true;
      details.current.scrollIntoView({ block: 'nearest' });
    }
    if (command.plan.task === 'inspect') void inspectModel();
    else void checkConditions();
  }, [command, busy, inspectModel, checkConditions]);

  const diagnostics = report?.status === 'input-incomplete' ? report.diagnostics
    : !report && readiness?.status === 'input-incomplete' ? readiness.diagnostics : undefined;
  return <details ref={details} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>上海 2022 版单幢房产面积</summary>
    <p>使用已核定的幢总面积和已复核的套内、扣除项及共有台账，按套内建筑面积比例复算。</p>
    <div className="area-actions">
      <button type="button" disabled={busy} onClick={() => void inspectModel()}>从当前模型提取候选证据</button>
      <button type="button" disabled={busy} onClick={() => void run(async current => {
        const text = await read(PROPERTY_AREA_PATH);
        if (!current()) return;
        if (text !== null) edit(text);
        else {
          setReport(undefined);
          setReadiness(undefined);
          const result = await inspectShanghaiPropertyArea(read, '');
          if (current()) setReadiness(result);
        }
      })}>读取项目房产证据</button>
      <label className="area-file">导入复核证据<input type="file" accept=".json" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void run(async current => {
          if (file.size > 4 * 1024 * 1024) throw new Error('测算证据不能超过 4 MB。');
          const text = await file.text();
          if (current()) edit(text);
        });
      }} /></label>
      <button type="button" disabled={busy || !!draft.trim()} onClick={() => void run(async current => {
        const raw = await read('project_metadata.json');
        const version = raw ? JSON.parse(raw).engineering_revision : '';
        if (current()) edit(JSON.stringify({ version: 1, profile: SHANGHAI_PROFILE, modelRevision: version ?? '',
          building: { id: '', parcelId: '', scope: 'whole-residential-building', source: '' },
          business: { type: 'new-survey', measuredOn: '', source: '' }, review: { confirmed: false, source: '' },
          gross: { id: 'gross', basis: 'building-perimeter', areaM2: null, source: '' },
          units: [], deductions: [], common: { scope: 'whole-building', source: '', beneficiaryUnitIds: [], parts: [] },
        }, null, 2));
      })}>新建证据草稿</button>
    </div>
    {modelEvidence && <ModelEvidenceView evidence={modelEvidence} locate={locate} currentLevel={currentLevel}
      active={active && expanded} configText={configText} />}
    <label>房产面积专项证据<textarea rows={8} disabled={busy} value={draft} onChange={event => edit(event.target.value)} /></label>
    {!!draft.trim() && <small>在证据的 review.source 中填写本次复核依据。</small>}
    <p><button type="button" disabled={busy} onClick={() => void checkConditions()}>检查复算条件</button></p>
    {!report && readiness?.status === 'ready-for-review' && <p role="status">
      幢 {readiness.buildingId} 的 {readiness.unitCount} 户及共有台账通过证据检查。
      {!readiness.hasReviewSource && '请先填写复核依据。'} 勾选审核后即可运行单幢差额法。
    </p>}
    <label className="area-review"><input type="checkbox" checked={reviewed} disabled={busy || !draft.trim()}
      onChange={event => { setReviewed(event.target.checked); setReport(undefined); }} />
      我已复核业务类型、幢总量、套内边界、权属及全幢受益范围
    </label>
    <button type="button" disabled={busy || !reviewed} onClick={() => void run(async current => {
      const plan = JSON.parse(draft);
      const reviewedText = plan && typeof plan === 'object' && !Array.isArray(plan)
        ? JSON.stringify({ ...plan, review: { ...plan.review, confirmed: reviewed } })
        : draft;
      const result = await executeShanghaiPropertyArea(read, reviewedText, reviewed);
      if (current()) setReport(result);
    })}>运行单幢差额法</button>
    {!!draft.trim() && <button type="button" onClick={() => download(PROPERTY_AREA_PATH, draft)}>下载证据 JSON</button>}
    {error && <p role="alert">{error}</p>}
    {diagnostics && <ul aria-label="房产面积补证建议">
      {diagnostics.map(diagnostic => <li key={diagnostic.field}><strong>{diagnostic.field}</strong> · {diagnostic.message}</li>)}
    </ul>}
    {report?.status === 'success' && <section aria-label="单幢房产面积复算结果">
      <p>幢总面积 {area.format(report.reconciliation.adoptedGross)} m² ·
        扣除 {area.format(report.reconciliation.adoptedDeductions)} m² ·
        待分摊 {area.format(report.reconciliation.shared)} m²</p>
      <p>分摊系数 {report.reconciliation.coefficient.toPrecision(8)} ·
        报表尾差 {area.format(report.reconciliation.reportRoundingDifference)} m²</p>
      <table><thead><tr><th>权属单元</th><th>套内（m²）</th><th>分摊（m²）</th><th>套建筑面积（m²）</th></tr></thead>
        <tbody>{report.units.map(unit => <tr key={unit.id}><th>{unit.id}</th>
          <td>{area.format(unit.internalArea)}</td><td>{area.format(unit.sharedArea)}</td><td>{area.format(unit.totalArea)}</td>
        </tr>)}</tbody>
      </table>
      <details><summary>套内分项与轮廓来源</summary>
        <ul className="area-parts">{report.units.flatMap(unit => unit.parts.map(part => <li key={part.id}>
          <strong>{unit.id} · {part.id}</strong> {area.format(part.rawArea)} × {part.factor} = {area.format(part.countedArea)} m²
          <small>{part.source}{part.geometry && ` · ${part.geometry.path} · ${part.geometry.id}`}</small>
        </li>))}</ul>
      </details>
      <button type="button" onClick={() => download(PROPERTY_AREA_PATH, JSON.stringify(report.plan, null, 2))}>下载已复核证据</button>{' '}
      <button type="button" onClick={() => download('shanghai-property-area-report.json', JSON.stringify(report, null, 2))}>下载完整复算报告</button>
    </section>}
  </details>;
}
