import { bindPalPlan, importSheetRules, type SheetRow } from './check-import.js';
import { HEIGHT, validatePalResponse } from './pal-plan.js';
import { toolId, verifyToolRecipe, type ToolRecipe, type ToolEntry } from './core/tool-recipes.js';
import { DOOR_WIDTH } from './door-width.js';

const minimumHeight = 'space.finished-minimum-clear-height';
const slabThickness = 'slab.cast-in-place-solid-structural-thickness';
const fixtureRevision = 'pal-offline-fixture-1';
const fixtureSource = '合成算例，经构造验证';
const applicability = {
  'JT-01': '住宅楼层',
  'JT-02': '已核实的普通卧室、起居室',
  'JT-03': '已核实的厨房、卫生间',
  'JG-03': '已核实适用基本限值的非悬挑现浇实心楼板',
  'JT-08': '已核实的上层卫生间',
  'JT-12': '已核实的户门、居室门及厨卫门',
};

const rows = [
  ['编号', '核查对象', '核查属性', '判定条件', '阈值或限值', '适用条件'],
  ['JT-01', '楼层', '建筑层高', '建筑层高低于 3.000m 判FAIL', '', applicability['JT-01']],
  ['JT-02', '卧室、起居室', '完成面净高', '净高低于 2.600m 判FAIL',
    '净高不少于 2.600m；局部低于 2.600m 的面积不大于 1/3 且局部净高不小于 2.200m', applicability['JT-02']],
  ['JT-03', '厨房、卫生间', '完成面最低净高', '完成面净高低于 2.200m 判FAIL', '', applicability['JT-03']],
  ['JG-03', '非悬挑现浇实心楼板', '有效结构层厚度', '结构层厚度低于 100mm 判FAIL', '', applicability['JG-03']],
  ['JT-08', '卫生间与下层空间叠合', '投影关系', '本层卫生间投影落在下层卧室、起居室、厨房、餐厅 判FAIL',
    '不得直接布置在下层上述房间的上层', applicability['JT-08']],
  ['JT-12', '户门、居室门及厨卫门', '有效通行净宽',
    '户门低于 0.900m、居室门低于 0.800m、厨房门低于 0.800m、卫生间门低于 0.700m 判FAIL',
    '户门不少于 0.900m；居室不少于 0.800m；厨房不少于 0.800m；卫生间不少于 0.700m', applicability['JT-12']],
];

const makeSheet = (): SheetRow[] => rows.map((fields, index) => ({ number: index + 1,
  cells: new Map(fields.map((value, i) => [i + 1, value])), formulaColumns: new Set() }));

const recipes = [minimumHeight, slabThickness, DOOR_WIDTH].map(concept => ({
  concept: concept as ToolRecipe['concept'], operation: 'read', inputs: [concept],
} satisfies ToolRecipe));
const tools: ToolEntry[] = recipes.map((recipe, i) => ({ id: toolId(recipe), version: 1, recipe, status: 'active',
  createdAt: '2026-01-01T00:00:00Z', approvedAt: '2026-01-01T00:00:00Z',
  origin: { model: 'synthetic-codex-proposal', clauseId: ['JT-03', 'JG-03', 'JT-12'][i] },
  verification: verifyToolRecipe(recipe) }));
const proposals = [
  { id: 'JT-01', kind: 'scalar', scope: 'project-storeys', concept: HEIGHT, operator: '>=', threshold: '3.000m' },
  { id: 'JT-02', kind: 'clear-height-with-local-exception', scope: 'ordinary-residential-rooms',
    nominalHeight: '2.600m', minimumHeight: '2.200m', maxLowAreaFraction: '1/3' },
  { id: 'JT-03', kind: 'tool-draft', recipe: recipes[0], operator: '>=', threshold: '2.200m' },
  { id: 'JG-03', kind: 'tool-draft', recipe: recipes[1], operator: '>=', threshold: '100mm' },
  { id: 'JT-08', kind: 'space-projection-exclusion' },
  { id: 'JT-12', kind: 'door-clear-width-by-use', thresholds: {
    entrance: '0.900m', habitable: '0.800m', kitchen: '0.800m', bathroom: '0.700m',
  } },
];

export function offlineRules() {
  const input = importSheetRules('离线验收算例', '合成规则', makeSheet());
  const plans = validatePalResponse(JSON.stringify({ rules: proposals }), input.map(item => item.clause!), tools);
  return input.map((item, index) => bindPalPlan(item, plans[index].plan, tools));
}

export function offlineCompilationInput() {
  return { input: importSheetRules('离线验收算例', '合成规则', makeSheet()), proposals, tools };
}

const scoped = (scope: string, table: string, id: string) => ({ scope, table, id });
const room = (scope: string, id: string) => scoped(scope, 'space', id);
const rectangle = (x: number, y: number, w: number, h: number) =>
  [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const feature = (id: string, ...coordinates: number[][][]) => ({ type: 'Feature', properties: { id },
  geometry: { type: 'Polygon', coordinates } });
const collection = (features: ReturnType<typeof feature>[]) => ({ type: 'FeatureCollection', features });
const assign = (ruleId: keyof typeof applicability, object: ReturnType<typeof scoped>, applies: boolean) => ({
  object, ruleId, ruleVersion: 'pal-1', applicability: applicability[ruleId],
  decision: applies ? 'applies' : 'does-not-apply', source: fixtureSource,
});
const fact = (object: ReturnType<typeof scoped>, concept: string, value: number) => ({
  object, concept, value, unit: 'mm', source: fixtureSource, confirmed: true,
});
const usableAreas = (object: ReturnType<typeof room>, lowAreaM2: number) => ({
  object, lowAreaM2, usableAreaM2: 12, belowHeightMetres: 2.6,
  boundaryRef: `合成边界:${object.scope}/${object.id}`, source: fixtureSource, confirmed: true,
});

export type OfflineCase = 'baseline' | 'complete' | 'wrong-concept' | 'stale';

export function offlineModel(scenario: OfflineCase) {
  const exportFiles = new Map<string, string>([
    ['project_metadata.json', JSON.stringify({ format_version: 2, units: 'm', engineering_revision: fixtureRevision })],
    ['global/level.csv', 'id,name,number,elevation,usage,elevation_basis,upper_level_id,elevation_source\n' +
      'lv-1,F1,1,0,residential,architectural-finish,lv-2,合成建筑剖面\n' +
      'lv-2,F2,2,3,residential,architectural-finish,lv-3,合成建筑剖面\n' +
      'lv-3,F3,3,5.9,other,architectural-finish,,合成建筑剖面\n' +
      'lv-4,屋顶,4,9,roof-datum,architectural-finish,,合成建筑剖面\n'],
    ['lv-1/space.csv', 'id,name\nr-1,下层卧室\nr-2,下层起居室\n'],
    ['lv-2/space.csv', 'id,name\nr-1,上层有相交\nr-2,上层在洞内\nr-3,上层仅边界相接\nr-4,上层分离\n'],
    ['lv-1/space.geojson', JSON.stringify(collection([
      feature('r-1', rectangle(0, 0, 6, 6), rectangle(2, 2, 2, 2).reverse()),
      feature('r-2', rectangle(10, 10, 3, 4)),
    ]))],
    ['lv-2/space.geojson', JSON.stringify(collection([
      feature('r-1', rectangle(0, 0, 1, 1)), feature('r-2', rectangle(2.2, 2.2, 1, 1)),
      feature('r-3', rectangle(6, 0, 1, 1)), feature('r-4', rectangle(20, 20, 1, 1)),
    ]))],
    ['lv-1/structure_slab.csv', 'id,name,thickness\ns-1,板一,0.3\ns-2,悬挑板,0.3\n'],
    ['lv-1/structure_slab.geojson', JSON.stringify(collection([
      feature('s-1', rectangle(0, 0, 8, 8)), feature('s-2', rectangle(8, 0, 1, 2)),
    ]))],
    ['lv-2/structure_slab.csv', 'id,name,thickness\ns-1,板二,0.3\n'],
    ['lv-2/structure_slab.geojson', JSON.stringify(collection([feature('s-1', rectangle(0, 0, 8, 8))]))],
    ['lv-1/door.csv', 'id,name,width\nd-1,户门,1\nd-2,居室门,1\nd-3,厨房门,1\nd-4,卫生间门,1\nd-5,用途未确认,1\n'],
    ['lv-1/door.geojson', JSON.stringify({ type: 'FeatureCollection', features: Array.from({ length: 5 }, (_, index) => ({
      type: 'Feature', properties: { id: `d-${index + 1}` }, geometry: { type: 'Point', coordinates: [index + 1, 0] },
    })) })],
  ]);
  if (scenario === 'baseline') return exportFiles;
  const lower = ['r-1', 'r-2'].map(id => room('lv-1', id));
  const upper = ['r-1', 'r-2', 'r-3', 'r-4'].map(id => room('lv-2', id));
  const slabs = [scoped('lv-1', 'structure_slab', 's-1'), scoped('lv-2', 'structure_slab', 's-1')];
  const doors = Array.from({ length: 5 }, (_, i) => scoped('lv-1', 'door', `d-${i + 1}`));
  exportFiles.set('engineering_evidence.json', JSON.stringify({
    version: 1,
    modelRevision: scenario === 'stale' ? 'prior-revision' : fixtureRevision,
    measurements: [
      ...lower.map((object, index) => fact(object, minimumHeight, index ? 2199 : 2200)),
      ...upper.map((object, index) => fact(object, minimumHeight, index === 1 ? 2199 : 2200)),
      ...slabs.map((object, index) => fact(object,
        scenario === 'wrong-concept' ? 'slab.nominal-thickness' : slabThickness, index ? 99 : 100)),
      ...doors.map((object, index) => fact(object, DOOR_WIDTH, index === 3 ? 700 : 800)),
    ],
    applicability: [
      ...lower.map(object => assign('JT-02', object, true)), ...upper.map(object => assign('JT-02', object, false)),
      ...lower.map(object => assign('JT-03', object, false)), ...upper.map(object => assign('JT-03', object, true)),
      ...slabs.map(object => assign('JG-03', object, true)), assign('JG-03', scoped('lv-1', 'structure_slab', 's-2'), false),
      ...doors.map(object => assign('JT-12', object, true)),
      ...lower.map(object => assign('JT-08', object, false)), ...upper.map(object => assign('JT-08', object, true)),
    ],
    clearHeightAreas: lower.map(object => usableAreas(object, 4)),
    doorUses: ['entrance', 'habitable', 'kitchen', 'bathroom'].map((use, i) => ({
      object: doors[i], use, confirmed: true, source: fixtureSource, openingAngleDeg: 90, measurementLine: '经复核通行测线 A',
    })),
    spaceRelations: {
      levelPairs: [{ upper: 'lv-2', lower: 'lv-1', lowerInventoryConfirmed: true, source: fixtureSource, frame: 'local-xy' }],
      footprints: [
        ...lower.map((object, index) => ({ object, use: index ? 'living' : 'bedroom', confirmed: true, frame: 'local-xy', source: fixtureSource })),
        ...upper.map(object => ({ object, use: 'bathroom', confirmed: true, frame: 'local-xy', source: fixtureSource })),
      ],
    },
  }));
  return exportFiles;
}
