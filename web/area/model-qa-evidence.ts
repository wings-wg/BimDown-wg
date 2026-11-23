import { describeRoomBoundaries, type DataSource, type EditorState } from 'bimdown-editor';
import { polygonArea } from './core/index.js';
import type { calculateProjectAreasFromText } from './core/project-input.js';
import { AREA_CONFIG_PATH, parseProjectAreaConfig } from './project-area-storage.js';
import { MAX_EVIDENCE_ITEMS, type ModelEvidence } from './model-qa-types.js';

type AreaReport = Pick<ReturnType<typeof calculateProjectAreasFromText>, 'units' | 'ruleSource'>;
type Level = NonNullable<EditorState['project']>['levels'][number];
type ObjectRow = { level: string; table: string; id: string; attrs: Record<string, string> };
type Outline = {
  properties?: { id?: string | number; redundant?: boolean; net_area?: number };
  geometry?: { type?: string; coordinates?: number[][][] };
};

const unitsInMetres = new Map(Object.entries({ m: 1, mm: 0.001, ft: 0.3048, in: 0.0254 }));
const objectFields = ['name', 'number', 'material', 'function', 'type_id', 'width', 'height', 'thickness',
  'host_id', 'position', 'base_level_id', 'top_level_id', 'base_offset', 'top_offset', 'operation', 'system_type'];
const ignoredTables = new Set(['grid', 'dimension', 'text_note', 'detail_line', 'mesh', 'model_group']);
const fixed = (value: number) => Number(value.toFixed(4));
const text = (value: string | undefined) => value?.slice(0, 160);

function containsToken(question: string, term: string | undefined) {
  if (!term?.trim()) return false;
  const literal = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${literal}(?![a-z0-9])`, 'iu').test(question);
}

function recordsAt(state: EditorState, level: string): ObjectRow[] {
  if (state.document?.levelId === level) {
    return [...state.document.elements.values()].filter(el => !ignoredTables.has(el.tableName))
      .map(el => ({ level, table: el.tableName, id: el.id, attrs: el.attrs }));
  }
  const layers = level === 'global' ? state.project?.globalLayers : state.project?.floors.get(level)?.layers;
  return (layers ?? []).filter(layer => !ignoredTables.has(layer.tableName))
    .flatMap(layer => [...layer.csvRows].map(([id, attrs]) => ({ level, table: layer.tableName, id, attrs })));
}

function levelMatches(question: string, level: Level) {
  return containsToken(question, level.id) || containsToken(question, level.name) ||
    !!level.number && (containsToken(question, `F${level.number}`) || containsToken(question, `${level.number}层`)) ||
    level.number === '1' && /首层|一层/.test(question);
}

function matchesObject(question: string, row: ObjectRow) {
  return containsToken(question, row.id) || containsToken(question, row.attrs.name) ||
    containsToken(question, row.attrs.number) && (
      row.table === 'space' && /^room\d+$/i.test(row.attrs.number) ||
      /构件|房间|门窗|门号|窗号|编号/.test(question)
    );
}

const keyOf = (row: ObjectRow) => `${row.level}/${row.table}/${row.id}`;

async function readJson(ds: DataSource, path: string) {
  try {
    const raw = await ds.fetchText(path);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function outlineFacts(outlines: readonly Outline[], id: string, scale: number | undefined) {
  const [outline, duplicate] = outlines.filter(item => String(item?.properties?.id) === id);
  if (duplicate || outline?.properties?.redundant || outline?.geometry?.type !== 'Polygon' ||
      !outline.geometry.coordinates) return { 测算轮廓: '缺少唯一有效的房间多边形' };
  if (scale === undefined) return { 测算轮廓: '已记录，项目坐标单位待核对' };
  try {
    const area = polygonArea(outline.geometry.coordinates.map(ring => ring.map(([x, y]) => [x * scale, y * scale])));
    const net = outline.properties?.net_area;
    return {
      测算轮廓: '已记录', 轮廓面积m2: fixed(area),
      ...(typeof net === 'number' && Number.isFinite(net) && net > 0 && { 墙面净面积m2: fixed(net * scale ** 2) }),
    };
  } catch {
    return { 测算轮廓: '多边形无效' };
  }
}

/** Only local, scoped facts and deterministic measurements are collected for each question. */
export async function collectModelEvidence(
  state: EditorState, selected: ReadonlySet<string>, ds: DataSource, question: string,
  previousQuestion?: string, report?: AreaReport, areaDraft?: string,
): Promise<ModelEvidence[]> {
  const project = state.project;
  if (!project) return [];
  const query = previousQuestion && /它|这个|这些|刚才|上述/.test(question) ? `${question} ${previousQuestion}` : question;
  const named = project.levels.filter(level => levelMatches(query, level));
  const levels = (named.length ? named : project.levels.filter(level => level.id === state.currentLevel)).slice(0, 4);
  const levelRows = levels.map(level => ({ level, rows: recordsAt(state, level.id) }));
  const rows = [...levelRows.flatMap(r => r.rows), ...recordsAt(state, 'global')];
  const mentioned = rows.filter(row => matchesObject(query, row));
  const selection = new Map<string, ObjectRow>();
  for (const raw of selected) {
    const separator = raw.indexOf(':');
    const level = separator < 0 ? state.currentLevel : raw.slice(0, separator);
    const id = separator < 0 ? raw : raw.slice(separator + 1);
    const source = levelRows.find(item => item.level.id === level)?.rows ?? recordsAt(state, level);
    const matching = source.filter(row => row.id === id);
    if (matching.length === 1) selection.set(keyOf(matching[0]), matching[0]);
    if (selection.size === 8) break;
  }
  const objects = (mentioned.length ? mentioned : named.length ? [] : [...selection.values()]).slice(0, 8);
  const metadata = await readJson(ds, 'project_metadata.json');
  const scale = unitsInMetres.get(metadata?.units);
  const evidence: ModelEvidence[] = [{
    label: '楼层与数据范围', source: 'global/level.csv · project_metadata.json',
    facts: {
      楼层总数: project.levels.length, 坐标单位: metadata?.units ?? '未声明', 查询楼层: levels.map(level => level.id),
      对象匹配方式: mentioned.length ? '按名称或编号' : objects.length ? '当前选中对象' : '未指定对象',
      ...(named.length > levels.length && { 诊断: '查询最多展开四层，请缩小范围' }),
      ...(mentioned.length > objects.length && { 对象诊断: '匹配数超过八个，请补充编号缩小范围' }),
    },
  }];
  for (const { level, rows } of levelRows) {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.table] = (counts[row.table] ?? 0) + 1;
    const next = project.levels.find(candidate => candidate.elevation > level.elevation);
    evidence.push({
      label: `${text(level.name) || level.id} 楼层`, source: `global/level.csv · ${level.id} 各构件表`,
      facts: {
        楼层: level.id, 模型构件计数: counts,
        ...(scale !== undefined && { 标高m: fixed(level.elevation * scale) }),
        ...(scale !== undefined && next && { 至上一层的层高m: fixed((next.elevation - level.elevation) * scale) }),
      },
    });
  }

  let config: ReturnType<typeof parseProjectAreaConfig> | undefined;
  try {
    const saved = areaDraft ?? await ds.fetchText(AREA_CONFIG_PATH);
    if (saved) config = parseProjectAreaConfig(saved);
  } catch { /* Other model facts remain useful when the area configuration is invalid. */ }
  const roomLevels = new Set(objects.filter(row => row.table === 'space').map(row => row.level));
  const outlines = new Map<string, readonly Outline[]>(await Promise.all([...roomLevels].map(async level => {
    if (!level || /[\\/:]/.test(level) || level === '.' || level === '..') return [level, []] as const;
    const file = await readJson(ds, `${level}/space.geojson`);
    return [level, Array.isArray(file?.features) ? file.features as Outline[] : []] as const;
  })));
  const boundaries = new Map(scale === undefined ? [] : [...roomLevels].map(level => [level, describeRoomBoundaries(state, level,
    objects.filter(row => row.table === 'space' && row.level === level).map(row => row.id))]));
  for (const row of objects) {
    const attributes = Object.fromEntries(objectFields.filter(field => row.attrs[field]?.trim())
      .map(field => [field, text(row.attrs[field])]));
    const target = row.level === 'global' ? undefined : { level: row.level, elementId: row.id };
    evidence.push({ label: `${text(row.attrs.name) || row.id} · ${keyOf(row)}`,
      source: `${row.level}/${row.table}.csv · 当前模型`, target,
      facts: { ...attributes, 楼层: row.level, 类型: row.table, 编号: row.id } });
    if (row.table !== 'space') continue;
    const candidates = config?.selections.filter(item => item.level === row.level &&
      item.table === 'space' && item.elementId === row.id) ?? [];
    const item = candidates.length === 1 ? candidates[0] : undefined;
    const node = config?.nodes.find(entry => entry.id === item?.owner);
    const group = node?.type === 'pool' ? config?.groups.find(entry => entry.pool === node.id) : undefined;
    const area = outlineFacts(outlines.get(row.level) ?? [], row.id, scale);
    evidence.push({
      label: `${text(row.attrs.name) || row.id} · 测算与轮廓`, target,
      source: `${row.level}/space.geojson · 墙体图层 · project-config.json`,
      facts: {
        ...area, 平面墙线证据: boundaries.get(row.level)?.get(row.id),
        ...(item && { 配置归属: text(item.owner), 配置计入系数: item.factor }),
        ...(group && Array.isArray(group.recipients) && {
          配置分摊方式: group.method, 配置接收户: group.recipients.slice(0, 12).map(r => text(r?.id)),
        }),
      },
    });
  }

  const unitIds = config?.nodes.filter(node => node.type === 'unit' && /户|套|分摊|unit/i.test(query) &&
    containsToken(query, node.id)).slice(0, 3) ?? [];
  const unitResults = report?.units.filter(unit => unitIds.some(node => node.id === unit.id)) ?? [];
  for (const node of unitIds) {
    const outcome = unitResults.find(unit => unit.id === node.id);
    evidence.splice(1, 0, { label: `${text(node.id)} 户的面积`,
      source: outcome ? '面积测算与分摊 · 本次测算结果' : AREA_CONFIG_PATH,
      facts: {
        户号: text(node.id), 配置分项数: config?.selections.filter(item => item.owner === node.id).length,
        ...(outcome ? { 套内m2: fixed(outcome.internalArea), 分摊m2: fixed(outcome.sharedArea), 合计m2: fixed(outcome.totalArea),
          测算依据: text(report?.ruleSource) } : { 诊断: '尚无本次经审核的测算结果' }),
      },
    });
  }
  if (/净高|顶盖|封闭|围护|clear height|enclos/i.test(query)) {
    evidence.splice(1, 0, { label: '三维判断所需证据', source: '当前问答支持的模型计算',
      facts: { 诊断: '可读取楼层标高、二维轮廓及可核实的墙体高度；本次查询未测量完成面至上方障碍的净高，也未核实顶盖和全高围护。' } });
  }
  return evidence.slice(0, MAX_EVIDENCE_ITEMS);
}
