import { parseCsv, type DataSource } from 'bimdown-editor';
import type { EngineeringDatum } from './core/index.js';
import type { ScalarEvidenceSet } from './core/rule-set.js';
import { executeToolRecipe, parseToolRecipe, textPresent, TOOL_PROFILES, toolId, type ToolEntry, type ToolMeasurement, type ToolRecipe } from './core/tool-recipes.js';
import type { CheckItem } from './check-import.js';
import { DOOR_WIDTH, doorUses, type DoorUse } from './door-width.js';

export const TOOL_EVIDENCE_PATH = 'engineering_evidence.json';
type Reader = Pick<DataSource, 'fetchText'>;
type ObjectRef = EngineeringDatum['object'];
type Target = ScalarEvidenceSet['targets'][number];
type Applicable = Target['applicability'][number] & { object: ObjectRef; applicability: string;
  dwellingCountBasis?: unknown; windowKind?: unknown };
type Fact = ToolMeasurement & { object: ObjectRef; concept: string; windowSillBasis?: unknown };
export const objectId = ({ scope, table, id }: ObjectRef) => JSON.stringify([scope, table, id]);
const validRef = (value: ObjectRef | undefined) => value && [value.scope, value.table, value.id].every(textPresent) &&
  !/[/\\:\0]/.test(value.scope) && !['.', '..'].includes(value.scope);
export type DoorUseEvidence = { object: ObjectRef; use: DoorUse; source: string; confirmed: boolean;
  openingAngleDeg: number; measurementLine: string };
type ClearHeightAreas = { object: ObjectRef; belowHeightMetres: number; usableAreaM2: number; lowAreaM2: number;
  boundaryRef: string; source: string; confirmed: boolean };
type Observation = { object: ObjectRef; revitUniqueId: string; modelFacts: Record<string, unknown> | null };
export const roomExportLabels = {
  disabled: '导出时未勾选「房间」',
  'no-host-rooms': '宿主 Revit 模型没有建筑房间',
  'no-placed-rooms': '建筑房间尚未放置',
  'no-csv-rows': '已放置房间未写入空间表',
  'no-positive-area': '已放置房间没有正面积',
  'missing-level-scope': '房间记录没有绑定到导出楼层',
  'no-footprints': '楼层房间未提取到有效轮廓',
  partial: '部分房间未生成有效轮廓',
  complete: '宿主房间已生成轮廓',
} as const;
type RoomExport = { status: keyof typeof roomExportLabels; hostRooms: number; placedRooms: number;
  csvRows: number; footprints: number; mepSpaces: number; linkInstances: number };

function readRoomExport(value: unknown): RoomExport | undefined {
  const data = value as RoomExport | null;
  if (!data || !Object.hasOwn(roomExportLabels, data.status) ||
      ![data.hostRooms, data.placedRooms, data.csvRows, data.footprints, data.mepSpaces, data.linkInstances]
        .every(number => Number.isSafeInteger(number) && number >= 0) ||
      data.placedRooms > data.hostRooms || data.footprints > data.csvRows) return undefined;
  const { status, hostRooms, placedRooms, csvRows, footprints, mepSpaces, linkInstances } = data;
  return { status, hostRooms, placedRooms, csvRows, footprints, mepSpaces, linkInstances };
}

export function parseEvidence(text: string | null, projectRevision?: string) {
  const facts = new Map<string, Map<string, Fact>>();
  const duplicate = new Set<string>();
  const applicability = new Map<string, Applicable>();
  const classifications = new Map<string, DoorUseEvidence>();
  const clearHeightAreas = new Map<string, ClearHeightAreas>();
  const observations = new Map<string, Observation>();
  const empty = { facts, duplicate, applicability, classifications, clearHeightAreas, observations };
  if (!text) return { ...empty, spaceRelations: undefined, roomExport: undefined, stairHeadroomCoverage: undefined,
    dwellingInventory: undefined, windowGuards: undefined };
  const value = JSON.parse(text) as { version?: number; modelRevision?: string; measurements?: Fact[];
    applicability?: Applicable[]; doorUses?: DoorUseEvidence[]; clearHeightAreas?: ClearHeightAreas[];
    spaceRelations?: unknown; observations?: unknown; roomExport?: unknown; stairHeadroomCoverage?: unknown;
    dwellingInventory?: unknown; windowGuards?: unknown };
  if (value?.version !== 1 || !Array.isArray(value.measurements) || !Array.isArray(value.applicability) ||
      (value.doorUses !== undefined && !Array.isArray(value.doorUses)) ||
      (value.clearHeightAreas !== undefined && !Array.isArray(value.clearHeightAreas)) ||
      value.measurements.length + value.applicability.length + (value.doorUses?.length ?? 0) +
        (value.clearHeightAreas?.length ?? 0) > 100_000)
    throw new Error(`${TOOL_EVIDENCE_PATH} 格式无效或超过限制。`);
  if (!textPresent(projectRevision) || value.modelRevision !== projectRevision)
    throw new Error('证据文件的 modelRevision 必须匹配 project_metadata.json 的 engineering_revision。');
  for (const fact of value.measurements) {
    if (!fact || !validRef(fact.object) || !textPresent(fact.concept) || !Number.isFinite(fact.value) ||
        !['m', 'mm'].includes(fact.unit) || !textPresent(fact.source) || typeof fact.confirmed !== 'boolean')
      throw new Error(`${TOOL_EVIDENCE_PATH} 包含无效的测量记录。`);
    const key = objectId(fact.object);
    const measurements = facts.get(key) ?? new Map<string, Fact>();
    if (measurements.has(fact.concept)) duplicate.add(JSON.stringify([key, fact.concept]));
    measurements.set(fact.concept, fact);
    facts.set(key, measurements);
  }
  for (const entry of value.applicability) {
    if (!entry || !validRef(entry.object) || ![entry.ruleId, entry.ruleVersion, entry.source, entry.applicability].every(textPresent) ||
        !['applies', 'does-not-apply'].includes(entry.decision))
      throw new Error(`${TOOL_EVIDENCE_PATH} 包含无效的适用性记录。`);
    const id = JSON.stringify([objectId(entry.object), entry.ruleId, entry.ruleVersion, entry.applicability]);
    if (applicability.has(id)) {
      duplicate.add(id);
    } else applicability.set(id, entry);
  }
  for (const entry of value.doorUses ?? []) {
    if (!entry || !validRef(entry.object) || entry.object.table !== 'door' ||
        typeof entry.use !== 'string' || !Object.hasOwn(doorUses, entry.use) || !textPresent(entry.source) ||
        typeof entry.confirmed !== 'boolean' || !Number.isFinite(entry.openingAngleDeg) ||
        entry.openingAngleDeg <= 0 || entry.openingAngleDeg > 180 || !textPresent(entry.measurementLine))
      throw new Error('门用途证据缺少有效的用途、来源、开启角或测线。');
    const key = objectId(entry.object);
    if (classifications.has(key)) duplicate.add(key);
    classifications.set(key, entry);
  }
  for (const entry of value.clearHeightAreas ?? []) {
    if (!entry || !validRef(entry.object) || entry.object.table !== 'space' ||
        ![entry.belowHeightMetres, entry.usableAreaM2, entry.lowAreaM2].every(Number.isFinite) ||
        entry.belowHeightMetres <= 0 || entry.usableAreaM2 <= 0 || entry.lowAreaM2 < 0 || entry.lowAreaM2 > entry.usableAreaM2 ||
        !textPresent(entry.boundaryRef) || !textPresent(entry.source) || typeof entry.confirmed !== 'boolean')
      throw new Error('净高面积记录缺少有效的限值、面积、公共测算边界或确认来源。');
    const key = JSON.stringify([objectId(entry.object), entry.belowHeightMetres]);
    if (clearHeightAreas.has(key)) duplicate.add(key);
    clearHeightAreas.set(key, entry);
  }
  // These optional exporter hints are never inputs to the reviewed measurement maps.
  if (Array.isArray(value.observations) && value.observations.length <= 100_000) {
    const repeated = new Set<string>();
    for (const observation of value.observations as (Observation | null)[]) {
      if (!observation || !validRef(observation.object) || !textPresent(observation.revitUniqueId)) continue;
      const key = objectId(observation.object);
      if (observations.delete(key)) repeated.add(key);
      if (repeated.has(key)) continue;
      const facts = observation.modelFacts;
      observations.set(key, { ...observation, modelFacts: facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : null });
    }
  }
  return { ...empty, spaceRelations: value.spaceRelations, roomExport: readRoomExport(value.roomExport),
    stairHeadroomCoverage: value.stairHeadroomCoverage, dwellingInventory: value.dwellingInventory, windowGuards: value.windowGuards };
}

export function toolDataContract(recipe: ToolRecipe) {
  const profile = TOOL_PROFILES[recipe.concept];
  return {
    files: [`<楼层>/${profile.table}.csv`, TOOL_EVIDENCE_PATH, 'project_metadata.json'],
    fields: ['构件作用域/表/ID', ...recipe.inputs, 'unit', 'source', 'confirmed', 'modelRevision / engineering_revision',
      ...(recipe.operation === 'difference' ? ['measurementGroup'] : [])],
    advice: profile.exportAdvice,
  };
}

export async function readScopedToolMeasurements(ds: Reader, tool: ToolEntry, objects: ObjectRef[]) {
  const recipe = parseToolRecipe(tool.recipe);
  if (!recipe || tool.status !== 'active' || tool.id !== toolId(recipe))
    throw new Error('量测工具未启用或版本无效。');
  if (objects.some(object => object.table !== TOOL_PROFILES[recipe.concept].table ||
      !validRef(object) || /[\\/:]/.test(object.scope) || object.scope === '.' || object.scope === '..'))
    throw new Error('量测对象缺少有效的楼层、构件表或 ID。');
  const paths = [...new Set(objects.map(object => `${object.scope}/${object.table}.csv`))];
  const [text, metadata, tables] = await Promise.all([
    ds.fetchText(TOOL_EVIDENCE_PATH), ds.fetchText('project_metadata.json'),
    Promise.all(paths.map(async path => [path, parseCsv((await ds.fetchText(path) ?? '').replace(/^\uFEFF/, ''))] as const)),
  ]);
  let parsed: ReturnType<typeof parseEvidence>;
  try {
    parsed = parseEvidence(text, metadata ? JSON.parse(metadata)?.engineering_revision : undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '工程证据文件无效。';
    return objects.map(object => ({ object, result: { reason } }));
  }
  const rows = new Map(tables);
  return objects.map(object => {
    const key = objectId(object);
    if (rows.get(`${object.scope}/${object.table}.csv`)?.filter(row => row.id === object.id).length !== 1 ||
        recipe.inputs.some(field => parsed.duplicate.has(JSON.stringify([key, field]))))
      return { object, result: { reason: '构件或量测记录缺失、重复，无法唯一绑定。' } };
    return { object, result: executeToolRecipe(recipe, parsed.facts.get(key) ?? new Map()) };
  });
}

export async function readScopedObjectRows(ds: Reader, levels: { id: string; name: string }[], tables: readonly string[]) {
  const sources = await Promise.all(levels.flatMap(level => tables.map(async table => ({
      level, table, text: await ds.fetchText(`${level.id}/${table}.csv`),
    }))));
  const objects = new Map<string, { object: ObjectRef; name: string }>();
  const ambiguous = new Set<string>();
  const missingIds = new Set<string>();
  for (const { level, table, text: csv } of sources) {
    if (!csv) continue;
    for (const row of parseCsv(csv.replace(/^\uFEFF/, ''))) {
      if (!textPresent(row.id)) {
        missingIds.add(`${level.id}/${table}.csv`);
        continue;
      }
      const object = { scope: level.id, table, id: row.id };
      const key = objectId(object);
      if (objects.has(key)) ambiguous.add(key);
      objects.set(key, { object, name: `${level.name} · ${row.name || row.number || row.id}` });
    }
  }
  return { sources, objects, ambiguous, missingIds };
}

export async function readToolEvidence(ds: Reader, levels: { id: string; name: string }[], items: CheckItem[], metadata: string | null, text: string | null) {
  const tables = [...new Set(items.map(item => item.rule?.targetTable ?? 'door'))];
  const { sources, objects, ambiguous } = await readScopedObjectRows(ds, levels, tables);
  let parsed: ReturnType<typeof parseEvidence>;
  let evidenceError = text ? undefined : `当前 BIMDown 缺少 ${TOOL_EVIDENCE_PATH}。请补充已确认的适用性和量测来源。`;
  try {
    const projectRevision = metadata ? JSON.parse(metadata)?.engineering_revision : undefined;
    parsed = parseEvidence(text, projectRevision);
  }
  catch (error) {
    parsed = parseEvidence(null);
    evidenceError = error instanceof Error ? error.message : '证据文件无效。';
  }
  if (objects.size * items.length > 20_000)
    throw new Error('工具核查对象超过 20,000 项，请拆分规则文件。');

  return {
    snapshot: JSON.stringify([text, sources]),
    sources,
    cases: items.map(item => {
      const rule = item.rule ?? item.doorWidthRule!;
      const targetTable = item.rule?.targetTable ?? 'door';
      const concept = item.rule?.concept ?? DOOR_WIDTH;
      const tool = item.libraryTool!;
      const recipe = parseToolRecipe(tool.recipe);
      if (!recipe || tool.status !== 'active' || tool.id !== toolId(recipe) || recipe.concept !== concept ||
          TOOL_PROFILES[recipe.concept].table !== targetTable || (item.rule && item.rule.unit !== 'm'))
        throw new Error('规则和启用的工具版本不匹配。');
      const details = new Map<string, { name: string; detail?: string; inputs?: ToolMeasurement[]; doorUse?: DoorUseEvidence }>();
      const targets: Target[] = [];
      for (const [key, { object, name }] of objects) {
        if (object.table !== targetTable) continue;
        const scopeKey = JSON.stringify([key, rule.id, rule.version, rule.applicability]);
        const repeated = ambiguous.has(key) || parsed.duplicate.has(scopeKey) ||
          recipe.inputs.some(field => parsed.duplicate.has(JSON.stringify([key, field])));
        const scope = repeated ? undefined : parsed.applicability.get(scopeKey);
        const record: Target = { object, applicability: scope ? [scope] : [], measurements: [] };
        let detail = evidenceError;
        let inputs: ToolMeasurement[] | undefined;
        let doorUse: DoorUseEvidence | undefined;
        if (repeated) detail = '对象短 ID、适用性或量测记录重复，无法唯一绑定。';
        else if (!scope && !detail) detail = `缺少本规则版本、适用范围及对象的确认记录（${TOOL_EVIDENCE_PATH}）。`;
        else if (scope?.decision === 'applies') {
          if (item.doorWidthRule) {
            const classification = parsed.classifications.get(key);
            if (!classification?.confirmed || parsed.duplicate.has(key)) {
              detail = '同一扇门缺少已确认的用途、开启角及测线，或用途记录冲突。';
              details.set(key, { name, detail });
              targets.push(record);
              continue;
            }
            doorUse = classification;
          }
          const result = executeToolRecipe(recipe, parsed.facts.get(key) ?? new Map());
          if (result.value === undefined) detail = result.reason;
          else {
            inputs = result.measurements;
            record.measurements.push({ concept: recipe.concept, value: result.value, unit: result.unit, confirmed: true,
              source: inputs.map(input => input.source).join('；') });
          }
        }
        details.set(key, { name, detail, inputs, doorUse });
        targets.push(record);
      }
      return { item, tool, targets, getDetail: (object: ObjectRef) => details.get(objectId(object)), evidenceError };
    }),
  };
}
