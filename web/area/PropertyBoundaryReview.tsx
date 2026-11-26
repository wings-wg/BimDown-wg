import { useEffect, useMemo, useRef, useState } from 'react';
import { useDataSource, useEditorDispatch, usePropertyBoundaryPreview } from 'bimdown-editor';
import { inspectPropertyModelEvidence, type PropertyModelEvidence } from './core/property-model-evidence.js';
import { parseProjectAreaConfig } from './project-area-storage.js';
import { PropertyRoomUseReview } from './PropertyRoomUseReview.tsx';
import { currentPropertyRoomUse, reviewPropertyRoomUse, roomUseLabels } from './property-room-use.js';
import {
  activeBoundaryRecords, createBoundaryRecord, makeBoundaryScope, PROPERTY_BOUNDARY_REVIEW_PATH,
  readBoundaryReview, storeBoundaryRecord, type BoundaryScope, type BoundaryLevel, type BoundaryRecord, type ReviewDecision,
} from './property-boundary-review.js';

const decisions: Record<ReviewDecision, string> = { keep: '保留候选', adjust: '调整轮廓', defer: '保留待核' };
const bases = { 'wall-centerline': '墙中心线', 'revit-room-finish': 'Revit 房间完成面', 'unknown-saved-boundary': '口径待核' };
const area = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const formatArea = (value: number | null | undefined) => value == null ? '待核' : `${area.format(value)} m²`;
type Room = BoundaryScope['rooms'][number];

function groupName({ group }: Room) {
  if (group.kind === 'unit') return `户 ${group.id}`;
  return { common: '共用区域', excluded: '已排除', unassigned: '待归户' }[group.kind];
}

export function PropertyBoundaryReview({ evidence, level, configText, active, locate, download }: {
  evidence: PropertyModelEvidence; level: BoundaryLevel; configText: string; active: boolean;
  locate: (level: string, id?: string) => void; download: (name: string, text: string) => void;
}) {
  const ds = useDataSource();
  const dispatch = useEditorDispatch();
  const setOverlay = usePropertyBoundaryPreview();
  const [scope, setScope] = useState<BoundaryScope>();
  const [file, setFile] = useState<ReturnType<typeof readBoundaryReview>>();
  const [fileText, setFileText] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [show, setShow] = useState(false);
  const [decision, setDecision] = useState<ReviewDecision>('keep');
  const [source, setSource] = useState('');
  const [geometry, setGeometry] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [saving, setSaving] = useState(false);
  const current = useRef({ ds, scope, configText });
  current.current = { ds, scope, configText };
  const config = useMemo(() => {
    try { return parseProjectAreaConfig(configText); } catch { return undefined; }
  }, [configText]);

  useEffect(() => {
    let live = true;
    setScope(undefined);
    setFile(undefined);
    setNotice(undefined);
    setShow(false);
    Promise.all([
      Promise.resolve().then(() => makeBoundaryScope(evidence, level, parseProjectAreaConfig(configText))),
      ds.fetchText(PROPERTY_BOUNDARY_REVIEW_PATH),
    ]).then(async ([nextScope, raw]) => {
      if (raw === null && (await ds.listFiles?.())?.includes(PROPERTY_BOUNDARY_REVIEW_PATH))
        throw new Error('边界复核文件已存在，但无法读取。');
      const parsed = readBoundaryReview(raw);
      if (!live) return;
      setScope(nextScope);
      setSelected(nextScope.rooms.some(room => room.id === selected) ? selected : nextScope.rooms[0]?.id ?? '');
      setFile(parsed);
      setFileText(raw);
    }).catch(error => { if (live) setNotice({ text: error.message, error: true }); });
    return () => { live = false; };
  }, [ds, evidence, level, configText]);

  const records = useMemo(() => file && scope ? activeBoundaryRecords(file, scope) : new Map<string, BoundaryRecord>(), [file, scope]);
  const ledger = useMemo(() => {
    if (!scope || !config) return [];
    return scope.rooms.map(item => {
      const boundary = records.get(item.id);
      return { item, use: currentPropertyRoomUse(boundary, config), areaM2: boundary?.reviewed?.areaM2 };
    });
  }, [scope, config, records]);
  const room = scope?.rooms.find(item => item.id === selected);
  const record = records.get(selected);
  useEffect(() => {
    setDecision(record?.decision ?? (room?.outline ? 'keep' : 'defer'));
    setSource(record?.source ?? '');
    setGeometry((record?.reviewed?.outline ?? room?.outline) ? JSON.stringify(record?.reviewed?.outline ?? room?.outline, null, 2) : '');
  }, [room, record]);

  const colors = useMemo(() => {
    const groups = [...new Set(scope?.rooms.filter(item => item.group.kind === 'unit').map(item => item.group.id))].sort();
    return new Map(groups.map((id, i) => [id, `hsl(${(i * 137.508 + 24) % 360} 72% 48%)`]));
  }, [scope]);
  const adjusted = useMemo(() => {
    if (!scope || !file || !room || decision !== 'adjust') return undefined;
    try { return createBoundaryRecord(scope, file, room.id, decision, '预览', geometry).reviewed ?? undefined; }
    catch { return undefined; }
  }, [scope, file, room, decision, geometry]);
  useEffect(() => {
    if (!active || !show || !scope) return;
    setOverlay({ level: scope.level.id, items: scope.rooms.flatMap(item => {
      const editable = item.id === selected && adjusted;
      const saved = records.get(item.id);
      const outline = editable ? editable.outline : saved?.reviewed?.outline ?? item.outline;
      if (!outline) return [];
      const moved = editable || saved?.decision === 'adjust';
      const color = item.group.kind === 'unit' ? colors.get(item.group.id) ?? '#9a6700' :
        item.group.kind === 'common' ? '#087f76' : '#6b7280';
      return [{ id: item.id, color, selected: item.id === selected, outline: outline.coordinates,
        original: moved ? item.outline?.coordinates : undefined }];
    }) });
    return () => setOverlay(undefined);
  }, [active, show, scope, selected, records, adjusted, colors, setOverlay]);

  function focus(id?: string) {
    dispatch({ type: 'SET_VIEW_MODE', mode: '2d' });
    if (id) setSelected(id);
    setShow(true);
    locate(level.id, id);
  }

  async function save(build: () => BoundaryRecord, description: string) {
    if (!scope || !room || !file || saving) return;
    setSaving(true);
    setNotice(undefined);
    const isCurrent = () => current.current.ds === ds && current.current.scope === scope && current.current.configText === configText;
    try {
      const entry = build();
      const latest = await inspectPropertyModelEvidence(path => ds.fetchText(path));
      const latestLevel = latest.levels.find(item => item.id === scope.level.id);
      if (!latestLevel || (await makeBoundaryScope(latest, latestLevel, parseProjectAreaConfig(configText))).snapshot !== scope.snapshot)
        throw new Error('模型边界或定位点已变化，请重新提取候选证据。');
      if (!isCurrent()) return;
      const next = storeBoundaryRecord(file, entry);
      const text = JSON.stringify(next, null, 2) + '\n';
      const write = async () => {
        if (await ds.fetchText(PROPERTY_BOUNDARY_REVIEW_PATH) !== fileText)
          throw new Error('复核记录已由其他操作更新，请重新提取候选证据后再保存。');
        if (isCurrent()) await ds.saveFile(PROPERTY_BOUNDARY_REVIEW_PATH, text);
      };
      if (navigator.locks) await navigator.locks.request(PROPERTY_BOUNDARY_REVIEW_PATH, write);
      else await write();
      if (isCurrent()) {
        setFile(next);
        setFileText(text);
        setNotice({ text: `已保存 ${room.name} 的${description}。` });
      }
    } catch (error) {
      if (isCurrent()) setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally { setSaving(false); }
  }

  const stale = file?.records.some(item => item.level === level.id && item.roomId === selected && item.snapshot !== scope?.snapshot);
  return <section aria-label="测算边界复核">
    <h3>测算边界复核</h3>
    <div className="area-actions">
      <button type="button" disabled={!scope?.rooms.length} onClick={() => show ? setShow(false) : focus()}>
        {show ? '隐藏平面边界' : '在平面显示边界'}
      </button>
      {file?.records.length ? <button type="button" onClick={() =>
        download(PROPERTY_BOUNDARY_REVIEW_PATH, JSON.stringify(file, null, 2) + '\n')}>下载边界复核记录</button> : null}
    </div>
    {scope?.rooms.length === 0 && <p>本层缺少可复核的房间记录。</p>}
    {scope && room && file && <form onSubmit={event => {
      event.preventDefault();
      void save(() => createBoundaryRecord(scope, file, room.id, decision, source, geometry), '边界复核记录');
    }}>
      <label>复核房间<select value={selected} disabled={saving} onChange={event => focus(event.target.value)}>
        {scope.rooms.map(item => <option key={item.id} value={item.id}>
          {groupName(item)} · {item.name} · {item.id}{records.has(item.id) ? ` · ${decisions[records.get(item.id)!.decision]}` : ''}
        </option>)}
      </select></label>
      <button type="button" onClick={() => focus(room.id)}>定位该房间</button>
      <p>原候选 {formatArea(room.areaM2)}{(record || adjusted) && ` · 复核 ${formatArea(adjusted?.areaM2 ?? record?.reviewed?.areaM2)}`}</p>
      {room.basis && <p>候选口径 {bases[room.basis]}</p>}
      <small>{room.path}{room.status === 'derived' && ` · 墙线来源 ${level.rooms.sourceFiles.join('、')}`}</small>
      {stale && !record && <p>存在旧版本复核记录，请按当前边界重新复核。</p>}
      <label>处理方式<select value={decision} disabled={saving} onChange={event => setDecision(event.target.value as ReviewDecision)}>
        <option value="keep" disabled={!room.outline}>保留候选</option>
        <option value="adjust">调整轮廓</option>
        <option value="defer">保留待核</option>
      </select></label>
      {decision === 'adjust' && <label>调整后的 GeoJSON Polygon（米）
        <textarea rows={7} value={geometry} disabled={saving} required onChange={event => setGeometry(event.target.value)} />
      </label>}
      <label>复核或调整依据<input value={source} required maxLength={2000} disabled={saving}
        onChange={event => setSource(event.target.value)} /></label>
      <button type="submit" disabled={saving}>保存边界复核记录</button>
    </form>}
    {scope && config && room && <>
      <details>
        <summary>共有部位与受益户复核</summary>
        <PropertyRoomUseReview record={record} config={config} saving={saving} locate={locate}
          save={input => {
            if (record) void save(() => reviewPropertyRoomUse(record, config, input), '用途及受益范围');
          }} />
      </details>
      <details>
        <summary>本层部位清单（{ledger.filter(row => row.use).length} / {ledger.length} 间已复核）</summary>
        <p>已复核候选合计 · {Object.entries(roomUseLabels).map(([kind, label]) => {
          const areas = ledger.flatMap(row => row.use?.kind === kind && row.areaM2 !== undefined ? [row.areaM2] : []);
          return `${label} ${areas.length ? formatArea(areas.reduce((sum, value) => sum + value, 0)) : '暂无记录'}`;
        }).join(' · ')}</p>
        <ul className="area-room-preview">
          {ledger.map(({ item, use, areaM2 }) => <li key={item.id}>
              <button type="button" onClick={() => focus(item.id)}>{item.name} · {item.id}</button>{' '}
              {use ? `${roomUseLabels[use.kind]} · ${formatArea(areaM2)}` : '用途待核'}
              {use?.kind === 'allocatable' && ` · ${use.scope === 'whole-building' ? '全幢' : '部分户'} ${use.recipients.length} 户`}
            </li>)}
        </ul>
      </details>
    </>}
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>;
}
