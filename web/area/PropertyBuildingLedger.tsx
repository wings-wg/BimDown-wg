import { useEffect, useMemo, useRef, useState } from 'react';
import { useDataSource, useEditorDispatch } from 'bimdown-editor';
import type { PropertyModelEvidence } from './core/property-model-evidence.js';
import { parseProjectAreaConfig } from './project-area-storage.js';
import { PROPERTY_BOUNDARY_REVIEW_PATH, readBoundaryReview } from './property-boundary-review.js';
import { reconcilePropertyBuilding, type PropertyBuildingLedgerResult } from './property-building-ledger.js';
import { roomUseLabels } from './property-room-use.js';

const area = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const display = (value: number | null) => value === null ? '—' : `${area.format(value)} m²`;

export function PropertyBuildingLedger({ evidence, configText, revision, locate, download }: {
  evidence: PropertyModelEvidence; configText: string; revision: number;
  locate: (level: string, id?: string) => void; download: (name: string, text: string) => void;
}) {
  const ds = useDataSource();
  const dispatch = useEditorDispatch();
  const [building, setBuilding] = useState('');
  const [levels, setLevels] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [gross, setGross] = useState('');
  const [source, setSource] = useState('');
  const [result, setResult] = useState<PropertyBuildingLedgerResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const config = useMemo(() => {
    try { return parseProjectAreaConfig(configText); } catch { return undefined; }
  }, [configText]);
  const buildings = [...new Set(config?.nodes.filter(node => node.type === 'unit' && node.building).map(node => node.building))].sort();
  const selectedBuilding = buildings.includes(building) ? building : buildings.length === 1 ? buildings[0] : '';

  function invalidate() {
    generation.current++;
    setResult(undefined);
    setError('');
    setBusy(false);
  }

  useEffect(() => {
    setConfirmed(false);
  }, [evidence, configText]);

  useEffect(() => {
    setLevels([]);
    setConfirmed(false);
    setGross('');
    setSource('');
  }, [selectedBuilding]);

  useEffect(() => {
    invalidate();
  }, [evidence, configText, revision]);

  useEffect(() => {
    const stop = ds.watchChanges(path => {
      if (path === PROPERTY_BOUNDARY_REVIEW_PATH) invalidate();
    });
    return () => { generation.current++; stop(); };
  }, [ds]);

  async function run() {
    if (!config || !selectedBuilding || busy) return;
    invalidate();
    const id = generation.current;
    setBusy(true);
    try {
      const raw = await ds.fetchText(PROPERTY_BOUNDARY_REVIEW_PATH);
      if (raw === null && (await ds.listFiles?.())?.includes(PROPERTY_BOUNDARY_REVIEW_PATH))
        throw new Error('边界复核文件已存在，但无法读取。');
      const report = await reconcilePropertyBuilding(evidence, readBoundaryReview(raw), config, {
        building: selectedBuilding, levelIds: levels, scopeConfirmed: confirmed,
        gross: gross.trim() ? { areaM2: Number(gross), source } : null,
      });
      if (id === generation.current) setResult(report);
    } catch (failure) {
      if (id === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }

  function focus(level: string, id?: string) {
    dispatch({ type: 'SET_VIEW_MODE', mode: '2d' });
    locate(level, id);
  }

  return <details>
    <summary>整幢台账与对账</summary>
    <p>汇总已复核的房间几何面积。幢总面积及其依据由独立测量或核定材料提供。结果供专项复核。</p>
    {buildings.length === 0 ? <p>请先在面积配置中建立带幢号的分户清单。</p> : <>
      <label>对账楼幢<select value={selectedBuilding} onChange={event => {
        setBuilding(event.target.value);
        invalidate();
      }}>
        <option value="">选择楼幢</option>
        {buildings.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <fieldset className="area-recipients" disabled={!selectedBuilding}>
        <legend>本幢自然层</legend>
        <div>{evidence.levels.map(level => <label className="area-review" key={level.id}>
          <input type="checkbox" checked={levels.includes(level.id)} onChange={event => {
            setLevels(event.target.checked ? [...levels, level.id] : levels.filter(id => id !== level.id));
            setConfirmed(false);
            invalidate();
          }} />
          {level.name} · {level.elevationM === null ? '标高待核' : `${level.elevationM} m`}
        </label>)}</div>
      </fieldset>
      <label className="area-review"><input type="checkbox" checked={confirmed} disabled={!levels.length}
        onChange={event => { setConfirmed(event.target.checked); invalidate(); }} />
        已确认所选自然层及房间清单覆盖本幢，清单未列出的部位类别确认为无
      </label>
      <label>独立核定的幢总面积（m²）<input type="number" min="0" step="any" value={gross}
        onChange={event => { setGross(event.target.value); invalidate(); }} /></label>
      <label>幢总面积依据<input type="text" value={source}
        onChange={event => { setSource(event.target.value); invalidate(); }} /></label>
      <button type="button" disabled={!selectedBuilding || busy} onClick={() => void run()}>
        {busy ? '正在汇总…' : '汇总并对账'}
      </button>
    </>}
    {error && <p role="alert">{error}</p>}
    {result && <>
      <p role="status">{result.status === 'pending' ? '待核 · 暂无对账结论'
        : result.status === 'conflict' ? '存在差异 · 请复核幢总面积与各项台账'
          : '候选台账对账一致（按 0.01 m² 比较）'}</p>
      <dl>
        <dt>幢总面积</dt><dd>{display(result.gross?.areaM2 ?? null)}</dd>
        <dt>已纳入套内合计</dt><dd>{display(result.totals.privateM2)}</dd>
        <dt>已纳入计入但不分摊</dt><dd>{display(result.totals.nonAllocatableM2)}</dd>
        <dt>已纳入独立使用空间</dt><dd>{display(result.totals.independentUseM2)}</dd>
        <dt>已纳入共有候选面积</dt><dd>{display(result.totals.commonM2)}</dd>
        <dt>其中部分户共有</dt><dd>{display(result.totals.selectedUnitCommonM2)}</dd>
        {result.comparison && <>
          <dt>幢总量扣除套内和扣除项后的面积</dt><dd>{display(result.comparison.residualM2)}</dd>
          <dt>与共有候选台账的差额</dt><dd>{display(result.comparison.differenceM2)}</dd>
        </>}
      </dl>
      {result.hasSelectedUnitCommon && <p>该幢包含部分户共有分项，需另行复核分级分摊范围。</p>}
      {!!result.issues.length && <details open><summary>待核与差异（{result.issues.length}）</summary>
        <ul className="area-room-preview">{result.issues.map(({ level, roomId, message, path }, index) => <li key={index}>
          {level && <button type="button" onClick={() => focus(level, roomId)}>
            {evidence.levels.find(item => item.id === level)?.name ?? level}
            {roomId && ` · ${roomId}`}
          </button>}{' '}{message}{path && <small> {path}</small>}
        </li>)}</ul>
      </details>}
      {!!result.unitAreas.length && <details><summary>分户套内清单（{result.unitAreas.length}）</summary><ul className="area-room-preview">
        {result.unitAreas.map(unit => <li key={unit.id}>{unit.id} · {display(unit.areaM2)}</li>)}
      </ul></details>}
      {!!result.rows.length && <details><summary>已纳入房间分项（{result.rows.length}）</summary><ul className="area-room-preview">
        {result.rows.map(row => <li key={JSON.stringify([row.level, row.roomId])}>
          <button type="button" onClick={() => focus(row.level, row.roomId)}>
            {evidence.levels.find(level => level.id === row.level)?.name ?? row.level} · {row.name}
          </button>{' '}{roomUseLabels[row.review.propertyUse.kind]} · {display(row.review.reviewed.areaM2)}
          {row.review.propertyUse.scope === 'selected-units' && ` · ${row.review.propertyUse.recipients.join('、')}`}
        </li>)}
      </ul></details>}
      <button type="button" onClick={() => download('property-building-ledger.json', JSON.stringify(result, null, 2))}>下载整幢候选台账</button>
    </>}
  </details>;
}
