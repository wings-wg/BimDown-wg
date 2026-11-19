import { useEffect, useRef, useState } from 'react';
import { EditorShell, useDataSource, useEditorDispatch, useEditorState, useSelectionState } from 'bimdown-editor';
import { calculateProjectAreasFromText, projectGeometryPath } from './core/project-input.js';
import type { ProjectAreaConfig } from './core/project-input.js';
import './area.css';

type Report = ReturnType<typeof calculateProjectAreasFromText>;
type Selection = ProjectAreaConfig['selections'][number];
const blank: ProjectAreaConfig = { version: 1, confirmed: false, ruleSource: '', nodes: [], groups: [], selections: [] };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const size = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });

export function AreaWorkspace() {
  const [open, setOpen] = useState(false);
  return (
    <div className="area-workspace">
      <div className="area-editor"><EditorShell /></div>
      <button className="area-toggle" type="button" aria-expanded={open} aria-controls="area-panel"
        onClick={() => setOpen(!open)}>面积测算与分摊</button>
      <AreaPanel open={open} />
    </div>
  );
}

function AreaPanel({ open }: { open: boolean }) {
  const ds = useDataSource();
  const { currentLevel, project } = useEditorState();
  const { selectedIds } = useSelectionState();
  const dispatch = useEditorDispatch();
  const [configText, setConfigText] = useState(json(blank));
  const [reviewed, setReviewed] = useState(false);
  const [report, setReport] = useState<Report>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    const invalidate = () => {
      sequence.current += 1;
      setReport(undefined);
      setReviewed(false);
    };
    invalidate();
    const unsubscribe = ds.watchChanges(path => {
      if (path.endsWith('.geojson') || ['project_metadata.json', 'area_features.json'].includes(path)) invalidate();
    });
    return () => {
      sequence.current += 1;
      unsubscribe();
    };
  }, [ds]);

  useEffect(() => {
    sequence.current += 1;
    setReport(undefined);
    setReviewed(false);
  }, [project]);

  function update(text: string) {
    sequence.current += 1;
    setConfigText(text);
    setReviewed(false);
    setReport(undefined);
    setNotice('');
  }

  function parse(text = configText): ProjectAreaConfig {
    const config = JSON.parse(text) as ProjectAreaConfig;
    if (config?.version !== 1 || !Array.isArray(config.nodes) || !Array.isArray(config.groups) ||
        !Array.isArray(config.selections) || (config.parts !== undefined && !Array.isArray(config.parts)))
      throw new Error('请提供版本 1 的面积配置，包含 nodes、groups 和 selections 数组。');
    if (typeof config.ruleSource !== 'string' || config.nodes.some(node => typeof node?.id !== 'string') ||
        config.groups.some(group => typeof group?.id !== 'string') ||
        config.selections.some(item => !item || [item.id, item.level, item.table, item.elementId, item.owner]
          .some(field => typeof field !== 'string')))
      throw new Error('请检查配置中的规则来源及对象引用。');
    return config;
  }

  function importConfig(text: string) {
    parse(text);
    update(text);
  }

  async function addRoom(form: FormData) {
    const request = sequence.current;
    const [selected] = selectedIds;
    const delimiter = selected?.indexOf(':') ?? -1;
    const level = delimiter < 0 ? currentLevel : selected.slice(0, delimiter);
    if (selectedIds.size !== 1 || !level) throw new Error('请在平面图中选中一个房间。');
    const elementId = delimiter < 0 ? selected : selected.slice(delimiter + 1);
    const owner = String(form.get('owner')).trim();
    const source = String(form.get('source')).trim();
    const building = String(form.get('building')).trim();
    const kind = form.get('kind') === 'common' ? 'common' : 'usable';
    const type = kind === 'common' ? 'pool' : 'unit';
    if (!owner || !source || !building) throw new Error('请填写建筑、归属节点和边界审核依据。');
    const config = parse();
    const existing = config.nodes.find(node => node.id === owner);
    if (existing && (existing.building !== building || existing.type !== type))
      throw new Error('此归属节点已用于其他建筑或部位类型。');
    const selection: Selection = { id: `${level}/space/${elementId}`, level, elementId, table: 'space',
      owner, source, kind, factor: Number(form.get('factor')) as 0 | 0.5 | 1 };
    if (config.selections.some(item => item.level === level && item.table === 'space' && item.elementId === elementId))
      throw new Error('该房间已加入测算。');
    const content = await ds.fetchText(projectGeometryPath(selection));
    const matches = content && JSON.parse(content).features?.filter(
      (feature: { properties?: { id?: unknown } }) => String(feature.properties?.id) === elementId,
    );
    if (!matches || matches.length !== 1 || matches[0].geometry?.type !== 'Polygon')
      throw new Error('所选对象没有唯一的房间多边形，请核对楼层和房间轮廓。');
    if (request !== sequence.current) return;
    if (!existing) config.nodes.push({ id: owner, building, type });
    config.selections.push(selection);
    update(json({ ...config, confirmed: false }));
    setNotice(`已加入 ${level} / ${elementId}`);
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
    const result = calculateProjectAreasFromText(path => files.get(path) ?? undefined, config);
    if (request === sequence.current) {
      setReport(result);
      setNotice('计算完成');
    }
  }

  async function run(action: () => void | Promise<void>) {
    setBusy(true);
    setNotice('');
    try { await action(); } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }

  function locate(selection: Selection) {
    dispatch({ type: 'SET_LEVEL', levelId: selection.level });
    dispatch({ type: 'SELECT', ids: [`${selection.level}:${selection.elementId}`], exact: true });
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

  return (
    <aside id="area-panel" className="area-panel" aria-label="面积测算与分摊" hidden={!open}>
      <header><h2>面积测算与分摊</h2></header>
      <div className="area-actions">
        <label className="area-file">导入配置<input type="file" accept=".json" disabled={busy} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void run(async () => importConfig(await file.text()));
        }} /></label>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const config = await ds.fetchText('project-config.json');
          if (!config) throw new Error('项目中没有 project-config.json，可导入本地配置。');
          importConfig(config);
        })}>读取项目配置</button>
      </div>
      <details open>
        <summary>添加房间 <small>{selectedIds.size === 1 ? [...selectedIds][0] : '在平面中选中一个房间'}</small></summary>
        <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(() => addRoom(data)); }}>
          <div className="area-grid">
            <label>建筑 ID<input name="building" required defaultValue="B1" /></label>
            <label>分户／共有池 ID<input name="owner" required /></label>
            <label>部位<select name="kind"><option value="usable">套内</option><option value="common">共有</option></select></label>
            <label>计入系数<select name="factor"><option value="1">1</option><option value="0.5">0.5</option><option value="0">0</option></select></label>
          </div>
          <label>边界审核依据<input name="source" required /></label>
          <button type="submit" disabled={busy || selectedIds.size !== 1}>加入所选房间</button>
        </form>
        {!!draft?.selections.length && <ul className="area-parts">{draft.selections.map(item =>
          <li key={item.id}><button type="button" onClick={() => locate(item)}>{item.level} / {item.elementId}</button><small>{item.owner}</small></li>,
        )}</ul>}
      </details>
      <details>
        <summary>设置共有池分摊</summary>
        <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(() => addGroup(data)); }}>
          <label>共有池 ID<input name="pool" required /></label>
          <label>接收节点 ID（以逗号分隔）<input name="recipients" required /></label>
          <label>方法<select name="method"><option value="area">自身计入面积比例</option><option value="equal">等份</option></select></label>
          <label>分摊依据<input name="source" required /></label>
          <button type="submit" disabled={busy}>添加分摊规则</button>
        </form>
      </details>
      <label>测算规则来源<input value={draft?.ruleSource ?? ''} disabled={!draft || busy}
        onChange={event => { if (draft) update(json({ ...draft, ruleSource: event.target.value, confirmed: false })); }} /></label>
      <details>
        <summary>配置 JSON</summary>
        <label>完整配置<textarea rows={12} spellCheck={false} value={configText} onChange={event => update(event.target.value)} /></label>
        {configError && <p className="area-status">{configError}</p>}
        <button type="button" disabled={!draft} onClick={() => { if (draft) download({ ...draft, confirmed: reviewed }, 'project-config.json'); }}>下载配置</button>
      </details>
      <label className="area-review"><input type="checkbox" checked={reviewed} onChange={event => {
        setReviewed(event.target.checked);
        sequence.current += 1;
        setReport(undefined);
      }} />我已审核测算边界、归属、系数和分摊规则</label>
      <button className="area-primary" type="button" disabled={busy || !reviewed || !draft}
        onClick={() => void run(calculate)}>运行测算</button>
      <p role="status" className="area-status">{notice}</p>
      {report && <section>
        <h3>分户结果 <small>m²</small></h3>
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
            <th>{transfer.from}</th><td>{transfer.to}</td><td>{size.format(transfer.area)}</td>
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
