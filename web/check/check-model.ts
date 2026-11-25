import { parseCsv, type DataSource } from 'bimdown-editor';
import { runScalarRuleSet, type ScalarEvidenceSet } from './core/rule-set.js';
import { checkClearHeight } from './core/clear-height.js';
import { HEIGHT, ROOM_NET_AREA, type CheckItem } from './check-import.js';
import { isStoreyPair, manualHeightMetres, storeyHeightMetres, type ModelLevel, type StoreyChoice } from './storey-height.js';
import { buildExportFeedback } from './export-feedback.js';
import { objectId, parseEvidence, readToolEvidence, TOOL_EVIDENCE_PATH } from './tool-evidence.js';
import { DOOR_WIDTH } from './door-width.js';
import { checkSpaceOverlap } from './space-overlap.js';
import { TOOL_PROFILES, executeToolRecipe } from './core/tool-recipes.js';
import { diagnosePalResults } from './pal-readiness.js';

type Reader = Pick<DataSource, 'fetchText'>;
type Target = ScalarEvidenceSet['targets'][number];
type Geometry = { type?: unknown; geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> };
export interface RoomClearHeightEntry {
  applicability: 'pending' | 'applies' | 'excluded' | 'sloped';
  minimumHeight: string;
  usableArea: string;
  lowAreas: Record<string, string>;
  source: string;
}
export const roomCheckKey = (scope: string, id: string) => JSON.stringify([scope, id]);
const scales = new Map([['m', 1], ['mm', 0.001], ['ft', 0.3048], ['in', 0.0254]]);
const validScope = (value: string) => !!value && !/[/\\:\0]/.test(value) && value !== '.' && value !== '..';
const number = (value: string | undefined) =>
  value?.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;

export async function readCheckLevels(ds: Reader) {
  const [metadata, table] = await Promise.all([ds.fetchText('project_metadata.json'), ds.fetchText('global/level.csv')]);
  const unit: unknown = metadata ? JSON.parse(metadata)?.units : undefined;
  const levels: ModelLevel[] = table ? parseCsv(table.replace(/^\uFEFF/, '')).map(row => ({
    id: row.id, name: row.name || row.number || row.id, elevation: number(row.elevation),
    usage: row.usage || undefined, elevationBasis: row.elevation_basis || undefined,
    elevationSource: row.elevation_source || undefined, upperLevelId: row.upper_level_id || undefined,
  })) : [];
  if (levels.some(level => !validScope(level.id)) || new Set(levels.map(level => level.id)).size !== levels.length)
    throw new Error('楼层表有缺失、无效或重复的楼层 ID。');
  return { levels, unit: typeof unit === 'string' ? unit : undefined,
    scale: typeof unit === 'string' ? scales.get(unit) : undefined, raw: [metadata, table] };
}

async function readRooms(ds: Reader, level: ModelLevel) {
  const path = `${level.id}/space`;
  const raw = await Promise.all([ds.fetchText(`${path}.csv`), ds.fetchText(`${path}.geojson`)]);
  const csv = raw[0] ? parseCsv(raw[0].replace(/^\uFEFF/, '')) : [];
  const byId = new Map<string, { name: string; features: Geometry[] }>();
  for (const row of csv) {
    if (!row.id?.trim() || byId.has(row.id)) throw new Error(`${level.name}的房间表有缺失或重复的 ID。`);
    byId.set(row.id, { name: row.name || row.id, features: [] });
  }
  const geojson = raw[1] ? JSON.parse(raw[1]) : undefined;
  if (geojson && (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)))
    throw new Error(`${level.name}的房间轮廓不是有效的 GeoJSON 要素集。`);
  for (const feature of (geojson?.features ?? []) as Geometry[]) {
    const id = feature?.properties?.id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const key = String(id);
    if (!key.trim()) continue;
    const room = byId.get(key) ?? { name: key, features: [] };
    byId.set(key, room);
    room.features.push(feature);
  }
  return { level, byId, csvIds: new Set(csv.map(row => row.id)), path, raw };
}

export async function readCheckRooms(ds: Reader, levels: ModelLevel[]) {
  const data = await Promise.all(levels.map(level => readRooms(ds, level)));
  const rooms = data.flatMap(({ level, byId }) => [...byId].map(([id, room]) => ({
    id, scope: level.id, name: `${level.name} · ${room.name} · ${id}`,
  })));
  const snapshot = JSON.stringify(data.map(room => [room.level.id, room.raw]));
  return { data, rooms, snapshot };
}

export async function runModelCheck(
  ds: Reader, items: CheckItem[], choices: ReadonlyMap<string, StoreyChoice>, reviewedLevels: Awaited<ReturnType<typeof readCheckLevels>>['raw'],
  clearHeightInput?: { snapshot: string; entries: ReadonlyMap<string, RoomClearHeightEntry> },
) {
  const rules = items.flatMap(item => item.rule && !item.libraryTool ? [{ ...item.rule, reviewed: true }] : []);
  const toolItems = items.filter(item => (item.rule || item.doorWidthRule) && item.libraryTool);
  const heightRules = rules.filter(rule => rule.concept === HEIGHT);
  const roomRules = rules.filter(rule => rule.concept === ROOM_NET_AREA);
  const clearHeightRules = items.flatMap(item => item.clearHeightRule ? [{ ...item.clearHeightRule, reviewed: true }] : []);
  const overlapRules = items.flatMap(item => item.overlapRule ? [{ ...item.overlapRule, reviewed: true }] : []);
  const { levels, unit, scale, raw } = await readCheckLevels(ds);
  if ((heightRules.length || clearHeightRules.length) && raw.some((text, i) => text !== reviewedLevels[i]))
    throw new Error('模型标高或单位已变化，请重新确认层高。');
  const levelIndex = new Map(levels.map(level => [level.id, level]));
  const inventory = roomRules.length || clearHeightRules.length || overlapRules.length ? await readCheckRooms(ds, levels) : undefined;
  const evidenceText = await ds.fetchText(TOOL_EVIDENCE_PATH);
  const toolEvidence = toolItems.length ? await readToolEvidence(ds, levels, toolItems, raw[0], evidenceText) : undefined;
  if (clearHeightRules.length && clearHeightInput && clearHeightInput.snapshot !== inventory?.snapshot)
    throw new Error('模型的房间清单或轮廓已变化，请重新核对净高证据。');
  if (heightRules.length * levels.length + (roomRules.length + clearHeightRules.length + overlapRules.length) *
      (inventory?.rooms.length ?? 0) > 20000)
    throw new Error('条款与对象的组合超过 20,000 项，请拆分规则文件。');
  const resolvedNames = new Map<string, string>();
  const key = (object: Target['object']) => JSON.stringify([object.scope, object.table, object.id]);
  const targets: Target[] = [];
  for (const level of heightRules.length ? levels : []) {
    const object = { scope: 'global', table: 'level', id: level.id };
    resolvedNames.set(key(object), level.name);
    const choice = choices.get(level.id);
    const upper = choice?.mode === 'upper' ? levelIndex.get(choice.id) : undefined;
    const measurements: Target['measurements'] = [];
    const modelHeight = upper && isStoreyPair(level, upper) ? storeyHeightMetres(level.elevation, upper.elevation, scale) : undefined;
    if (upper && modelHeight !== undefined) {
      measurements.push({ concept: HEIGHT, unit: 'm', value: modelHeight, confirmed: true,
        source: `global/level.csv · ${level.id} (${level.elevation} ${unit}) → ${upper.id} (${upper.elevation} ${unit}) · 用户确认建筑标高对` +
          [level.elevationSource, upper.elevationSource].filter(Boolean).map(source => ` · ${source}`).join('') });
    }
    if (choice?.mode === 'manual') {
      const value = manualHeightMetres(choice.height);
      if (value !== undefined && choice.source.trim()) {
        measurements.push({ concept: HEIGHT, unit: 'm', value, confirmed: true,
          source: `用户录入建筑层高 · ${choice.source.trim()}` });
      }
    }
    const applicability: Target['applicability'] = choice && choice.mode !== 'pending' ? heightRules.map(rule => ({
      ruleId: rule.id, ruleVersion: rule.version, decision: choice.mode === 'excluded' ? 'does-not-apply' : 'applies',
      source: choice.mode === 'excluded' ? '用户确认该楼层不适用' : '用户确认该楼层适用',
    })) : [];
    targets.push({ object, applicability, measurements });
  }
  for (const { level, byId, path } of roomRules.length ? inventory!.data : []) {
    for (const [id, room] of byId) {
      const object = { scope: level.id, table: 'space', id };
      resolvedNames.set(key(object), `${level.name} · ${room.name}`);
      const feature = room.features.length === 1 ? room.features[0] : undefined;
      const value = feature?.properties?.net_area;
      const measurements: Target['measurements'] = scale !== undefined && feature?.geometry?.type === 'Polygon' &&
        feature.properties?.redundant !== true && typeof value === 'number' && Number.isFinite(value) && value > 0
        ? [{ concept: ROOM_NET_AREA, unit: 'm2', value: value * scale ** 2, confirmed: true,
          source: `${path}.geojson · ${id} · net_area = ${value} ${unit}²` }] : [];
      targets.push({ object, measurements, applicability: roomRules.map(rule => ({
        ruleId: rule.id, ruleVersion: rule.version, decision: 'applies', source: '用户确认该条款适用于模型全部房间',
      })) });
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify([raw, inventory?.snapshot, toolEvidence?.snapshot, evidenceText]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const modelVersion = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const result = rules.length ? runScalarRuleSet({ rules }, { modelVersion, targets })
    : { version: 1, modelVersion, results: [] };
  const projectRevision = raw[0] ? JSON.parse(raw[0]).engineering_revision : undefined;
  let sidecar: ReturnType<typeof parseEvidence> | undefined;
  let sidecarError: string | undefined;
  if (evidenceText) {
    try { sidecar = parseEvidence(evidenceText, projectRevision); }
    catch (error) { sidecarError = error instanceof Error ? error.message : '工程证据文件无法读取。'; }
  }
  const clearHeightResults = clearHeightRules.map(rule => {
    const base = { ruleId: rule.id, ruleVersion: rule.version, source: rule.source, modelVersion, tool: 'clear-height-with-local-exception@1',
      clearHeight: { nominalHeight: rule.nominalHeight, minimumHeight: rule.minimumHeight, maxLowAreaFraction: rule.maxLowAreaFraction } };
    const rooms = inventory?.rooms ?? [];
    if (!rooms.length) return [{ ...base, object: null, name: undefined, status: 'indeterminate' as const, reason: '模型没有房间记录。' }];
    return rooms.map(({ scope, id, name }) => {
      const row = { ...base, object: { scope, table: 'space', id }, name };
      const entry = clearHeightInput?.entries.get(roomCheckKey(scope, id));
      if (!entry && sidecar) {
        const key = objectId(row.object);
        const scopeKey = JSON.stringify([key, rule.id, rule.version, rule.applicability]);
        const decision = sidecar.applicability.get(scopeKey);
        if (!sidecar.duplicate.has(scopeKey) && decision?.decision === 'does-not-apply')
          return { ...row, status: 'not-applicable' as const, reason: decision.source };
        const concept = 'space.finished-minimum-clear-height';
        const areaKey = JSON.stringify([key, rule.nominalHeight]);
        const areas = sidecar.clearHeightAreas.get(areaKey);
        if (decision?.decision === 'applies' && areas?.confirmed &&
            ![scopeKey, areaKey, JSON.stringify([key, concept])].some(item => sidecar!.duplicate.has(item))) {
          const measured = executeToolRecipe({ concept, operation: 'read', inputs: [TOOL_PROFILES[concept].inputs.measured] },
            sidecar.facts.get(key) ?? new Map());
          const checked = checkClearHeight(rule, { minimumHeight: measured.value,
            usableArea: areas.usableAreaM2, lowArea: areas.lowAreaM2, belowHeight: areas.belowHeightMetres,
            source: [areas.source, areas.boundaryRef, ...(measured.measurements?.map(fact => fact.source) ?? [])].join(' · ') });
          return { ...row, status: checked.status, reason: checked.reason, applicabilitySource: decision.source,
            clearHeightEvidence: 'evidence' in checked ? checked.evidence : undefined };
        }
        return { ...row, status: 'indeterminate' as const,
          reason: '缺少本条款适用性、同一使用面积边界或对应限值的确认记录，或存在重复记录。' };
      }
      if (entry?.applicability === 'excluded' || entry?.applicability === 'sloped') return {
        ...row, status: 'not-applicable' as const, reason: entry.applicability === 'sloped'
          ? '用户确认是坡屋顶卧室或起居室，需按坡屋顶条款另行核查。' : '用户确认不在本条核查范围内。',
      };
      if (!entry || entry.applicability !== 'applies')
        return { ...row, status: 'indeterminate' as const, reason: sidecarError ?? '请确认房间用途和本条适用性。' };
      const checked = checkClearHeight(rule, { minimumHeight: number(entry.minimumHeight), usableArea: number(entry.usableArea),
        lowArea: number(entry.lowAreas[rule.nominalHeight]), belowHeight: rule.nominalHeight, source: entry.source.trim() });
      const { status, reason } = checked;
      return { ...row, status, reason, clearHeightEvidence: 'evidence' in checked ? checked.evidence : undefined };
    });
  }).flat();
  const scalarResults = result.results.map(row => ({
    ...row, name: row.object ? resolvedNames.get(key(row.object)) : undefined,
  }));
  const toolResults = toolEvidence?.cases.map(({ item, tool, targets, getDetail, evidenceError }) => {
    if (item.doorWidthRule) {
      const rule = item.doorWidthRule;
      const base = { ruleId: rule.id, ruleVersion: rule.version, source: rule.source, libraryToolId: tool.id };
      if (!targets.length) return [{ ...base, object: null, name: undefined, status: 'indeterminate' as const,
        reason: evidenceError ?? '没有相符的门构件记录。' }];
      return targets.map(target => {
        const detail = getDetail(target.object);
        const decision = target.applicability[0];
        const row = { ...base, object: target.object, name: detail?.name };
        if (decision?.decision === 'does-not-apply')
          return { ...row, status: 'not-applicable' as const, applicabilitySource: decision.source };
        const doorUse = detail?.doorUse;
        if (!doorUse) return { ...row, status: 'indeterminate' as const, reason: detail?.detail ?? '缺少门用途证据。' };
        const branch = { ...rule, reviewed: true, targetTable: 'door', concept: DOOR_WIDTH, operator: '>=' as const,
          unit: 'm' as const, threshold: rule.thresholds[doorUse.use] };
        const [result] = runScalarRuleSet({ rules: [branch] }, { modelVersion, targets: [target] }).results;
        return { ...result, ...row, doorUse, libraryInputs: detail.inputs,
          ...(result.status === 'indeterminate' && { reason: detail.detail }) };
      });
    }
    return runScalarRuleSet({ rules: [{ ...item.rule!, reviewed: true }] }, { modelVersion, targets }).results.map(row => {
      const detail = row.object ? getDetail(row.object) : undefined;
      return { ...row, name: detail?.name, libraryToolId: tool.id, libraryInputs: detail?.inputs, doorUse: undefined,
        ...(row.status === 'indeterminate' && { reason: detail?.detail ?? evidenceError ?? '没有相符的构件记录。' }) };
    });
  }).flat() ?? [];
  const overlapResults = overlapRules.map(rule =>
    checkSpaceOverlap(rule, inventory!, evidenceText, projectRevision, modelVersion, unit)).flat();
  const roomOutlines = new Set(inventory?.data.flatMap(({ level, byId }) =>
    [...byId].filter(([, room]) => room.features.length === 1 && room.features[0].geometry?.type === 'Polygon' &&
      room.features[0].properties?.redundant !== true)
      .map(([id]) => objectId({ scope: level.id, table: 'space', id }))));
  const results = diagnosePalResults(items, [...scalarResults, ...clearHeightResults, ...toolResults, ...overlapResults], {
    levels, scale, evidence: sidecar, evidenceError: sidecarError, roomOutlines, manualRoomEntries: clearHeightInput?.entries,
  });
  const observedByTable: Record<string, number> = Object.create(null);
  for (const { object } of sidecar?.observations.values() ?? [])
    observedByTable[object.table] = (observedByTable[object.table] ?? 0) + 1;
  const executed = new Set(results.map(row => row.ruleId));
  return { ...result, unit, results, clauseTrace: items.map(item => ({
    id: item.id, title: item.title, source: item.source, clause: item.clause, plan: item.plan,
    rule: item.rule ?? item.clearHeightRule ?? item.doorWidthRule ?? item.overlapRule,
    toolId: item.libraryTool?.id, toolVersion: item.libraryTool?.version,
    status: executed.has(item.id) ? 'executed' as const : 'pending' as const, reason: item.reason,
  })), evidenceInventory: {
    revision: typeof projectRevision === 'string' ? projectRevision : undefined,
    status: sidecarError ? 'invalid' as const : sidecar ? 'loaded' as const : 'missing' as const,
    error: sidecarError, observedByTable,
    confirmedMeasurements: [...(sidecar?.facts.values() ?? [])].reduce((sum, facts) => sum + [...facts.values()]
      .filter(fact => fact.confirmed && !sidecar?.duplicate.has(JSON.stringify([objectId(fact.object), fact.concept]))).length, 0),
    applicabilityRecords: sidecar?.applicability.size ?? 0,
    roomExport: sidecar?.roomExport,
  }, exportFeedback: buildExportFeedback(items, results),
    pending: items.filter(item => !item.rule && !item.clearHeightRule && !item.doorWidthRule && !item.overlapRule)
      .map(item => ({ ...item, status: 'indeterminate' as const })) };
}
