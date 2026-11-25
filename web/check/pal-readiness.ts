import type { EngineeringDatum } from './core/index.js';
import type { CheckItem } from './check-import.js';
import { HEIGHT, ROOM_NET_AREA } from './pal-plan.js';
import { isStoreyPair, storeyHeightMetres, suggestStoreyChoices, type ModelLevel } from './storey-height.js';
import { objectId, type parseEvidence } from './tool-evidence.js';

type ObjectRef = EngineeringDatum['object'];
type Evidence = ReturnType<typeof parseEvidence>;
type Finding = { ruleId: string; object: ObjectRef | null; status: string; blocker?: Blocker };

export const blockerLabels = {
  'missing-object': '未导出核查对象',
  'invalid-evidence': '工程证据版本或格式无效',
  'confirm-level': '建筑标高配对或适用范围待确认',
  'confirm-applicability': '逐对象规则适用性待确认',
  'confirm-measurement': '缺少指定口径的已确认量测',
  'confirm-door-use': '门用途、开启角或测线待确认',
  'confirm-height-areas': '同一使用面积边界和限值下面积待确认',
  'confirm-space-relations': '房间用途、跨层配对或下层清单待确认',
  'missing-outline': '缺少房间轮廓证据',
  'input-conflict': '证据重复或存在取数冲突',
  'execution-input': '执行所需的其他前提未满足',
} as const;
export type Blocker = keyof typeof blockerLabels;
export type ModelCandidate = { label: string; value: number; unit: 'm' | 'm²'; source: string;
  relatedObject?: ObjectRef };

export interface PalDiagnosis {
  blockers: Blocker[];
  candidate?: ModelCandidate;
}

interface Inputs {
  levels: ModelLevel[];
  scale?: number;
  evidence?: Evidence;
  evidenceError?: string;
  roomOutlines: ReadonlySet<string>;
  manualRoomEntries?: ReadonlyMap<string, unknown>;
}

const minimum = 'space.finished-minimum-clear-height';
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function diagnosePalResults<T extends Finding>(items: CheckItem[], rows: T[], input: Inputs) {
  const itemsById = new Map(items.map(item => [item.id, item]));
  const levels = new Map(input.levels.map(level => [level.id, level]));
  const suggestions = suggestStoreyChoices(input.levels);
  const evidencePath = 'engineering_evidence.json';

  function candidateFor(object: ObjectRef): ModelCandidate | undefined {
    const observation = input.evidence?.observations.get(objectId(object));
    const facts = observation?.modelFacts;
    const source = `${evidencePath} · ${object.scope}/${object.table}/${object.id}`;
    if (object.table === 'level') {
      const lower = levels.get(object.id);
      const suggestion = suggestions.get(object.id);
      const upper = suggestion?.mode === 'upper' ? levels.get(suggestion.id) : undefined;
      // Export candidates agree with the unique pair in the CSV, which owns the
      // elevations and units used for the displayed delta.
      if (!facts || !lower || !upper || facts.candidateUpperLevelId !== upper.id ||
          facts.exportedElevationM !== lower.elevation || input.scale !== 1 || !isStoreyPair(lower, upper)) return;
      const value = storeyHeightMetres(lower.elevation, upper.elevation, input.scale);
      if (value !== undefined) return { label: '候选标高差', value, unit: 'm', source: `global/level.csv · ${source}`,
        relatedObject: { scope: 'global', table: 'level', id: upper.id } };
    }
    if (object.table === 'structure_slab' && positive(facts?.nominalThicknessM))
      return { label: '名义板厚', value: facts.nominalThicknessM, unit: 'm', source };
    if (object.table === 'door' && positive(facts?.nominalWidthM))
      return { label: '名义门宽', value: facts.nominalWidthM, unit: 'm', source };
    if (object.table === 'space' && positive(facts?.revitRoomAreaM2))
      return { label: 'Revit 房间面积', value: facts.revitRoomAreaM2, unit: 'm²', source };
  }

  function diagnose(row: T, item: CheckItem): PalDiagnosis {
    const object = row.object;
    if (!object) return { blockers: ['missing-object'] };
    const candidate = candidateFor(object);
    if (item.rule?.concept === HEIGHT) return { blockers: ['confirm-level'], candidate };
    if (item.rule?.concept === ROOM_NET_AREA)
      return { blockers: [input.roomOutlines.has(objectId(object)) ? 'confirm-measurement' : 'missing-outline'], candidate };
    if (input.manualRoomEntries?.has(JSON.stringify([object.scope, object.id])) && item.clearHeightRule)
      return { blockers: ['execution-input'], candidate };
    if (input.evidenceError) return { blockers: ['invalid-evidence'] };

    const blockers = new Set<Blocker>();
    const rule = item.rule ?? item.clearHeightRule ?? item.overlapRule ?? item.doorWidthRule;
    const key = objectId(object);
    const evidence = input.evidence;
    if (rule) {
      const scopeKey = JSON.stringify([key, rule.id, rule.version, rule.applicability]);
      if (evidence?.duplicate.has(scopeKey)) blockers.add('input-conflict');
      else if (!evidence?.applicability.has(scopeKey)) blockers.add('confirm-applicability');
    }
    const concepts = item.libraryTool?.recipe.inputs ?? (item.clearHeightRule ? [minimum] : []);
    for (const concept of concepts) {
      if (evidence?.duplicate.has(JSON.stringify([key, concept]))) blockers.add('input-conflict');
      else if (evidence?.facts.get(key)?.get(concept)?.confirmed !== true) blockers.add('confirm-measurement');
    }
    if (item.clearHeightRule) {
      const areaKey = JSON.stringify([key, item.clearHeightRule.nominalHeight]);
      if (evidence?.duplicate.has(areaKey)) blockers.add('input-conflict');
      else if (evidence?.clearHeightAreas.get(areaKey)?.confirmed !== true) blockers.add('confirm-height-areas');
    }
    if (item.doorWidthRule) {
      if (evidence?.duplicate.has(key)) blockers.add('input-conflict');
      else if (evidence?.classifications.get(key)?.confirmed !== true) blockers.add('confirm-door-use');
    }
    if (item.overlapRule) {
      if (!input.roomOutlines.has(key)) blockers.add('missing-outline');
      if (!evidence?.spaceRelations) blockers.add('confirm-space-relations');
    }
    if (row.blocker) blockers.add(row.blocker);
    if (!blockers.size) blockers.add('execution-input');
    return { blockers: [...blockers], candidate };
  }

  return rows.map(row => {
    const item = itemsById.get(row.ruleId);
    return { ...row, diagnosis: row.status === 'indeterminate' && item ? diagnose(row, item) : undefined };
  });
}
