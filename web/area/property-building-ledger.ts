import { cents, decimalSum, squareMetres } from '../check/core/decimal.js';
import type { PropertyModelEvidence } from './core/property-model-evidence.js';
import { readPropertyPolygon, roomOutlinesOverlap } from './core/property-room-evidence.js';
import type { ProjectAreaConfig } from './core/project-input.js';
import { activeBoundaryRecords, makeBoundaryScope, type BoundaryReviewFile } from './property-boundary-review.js';
import { buildingUnitIds, currentPropertyRoomUse } from './property-room-use.js';

type LedgerInput = {
  building: string;
  levelIds: string[];
  scopeConfirmed: boolean;
  gross: { areaM2: number; source: string } | null;
};
type Issue = { code: string; message: string; level?: string; roomId?: string; path?: string };

/** Reconcile the scoped candidate register against a separately measured gross area. */
export async function reconcilePropertyBuilding(evidence: PropertyModelEvidence, file: BoundaryReviewFile,
  config: ProjectAreaConfig, input: LedgerInput) {
  const { building, levelIds, scopeConfirmed } = input;
  const issues: Issue[] = [];
  const levels = new Set(levelIds);
  const units = buildingUnitIds(config, building);
  const nodes = new Map(config.nodes.map(node => [node.id, node]));
  const gross = input.gross && Number.isFinite(input.gross.areaM2) && input.gross.areaM2 > 0 && input.gross.source.trim()
    ? { areaM2: input.gross.areaM2, source: input.gross.source.trim() } : null;
  if (!building.trim() || !units.length || units.some(id => !id.trim() || config.nodes.filter(node => node.id === id).length !== 1))
    issues.push({ code: 'invalid-unit-roster', message: '请在面积配置中核对本幢的户号及归属。' });
  if (!levels.size || !scopeConfirmed)
    issues.push({ code: 'unconfirmed-level-scope', message: '请选择本幢自然层并确认楼层和房间清单覆盖范围。' });
  if (!gross)
    issues.push({ code: 'missing-independent-gross', message: '请录入独立核定的幢总面积及复核依据。' });
  for (const id of levels) if (!evidence.levels.some(level => level.id === id))
    issues.push({ code: 'unknown-level', message: `所选楼层 ${id} 已不在当前模型中。` });
  for (const item of evidence.diagnostics) if (item.path === 'global/level.csv')
    issues.push({ code: 'ambiguous-level-inventory', message: '楼层清单包含重复或缺失编号，请核对。', path: item.path });

  const scopes = await Promise.all(evidence.levels.map(level => makeBoundaryScope(evidence, level, config)));
  const selectedLevels = scopes.filter(scope => levels.has(scope.level.id)).map(({ level, snapshot }) => ({
    id: level.id, name: level.name, elevationM: level.elevationM, snapshot,
  }));
  const rows = scopes.flatMap(scope => {
    const { level } = scope;
    const records = activeBoundaryRecords(file, scope);
    const selected = levels.has(level.id);
    const assignments = config.selections.filter(item => item.level === level.id && item.table === 'space');
    const relevant = assignments.filter(item => nodes.get(item.owner)?.building === building);
    if (!selected) {
      if (relevant.length || [...records.values()].some(record => record.propertyUse?.building === building))
        issues.push({ code: 'omitted-building-level', message: '本层已有本幢归属或用途记录，请核对是否漏选。', level: level.id });
      return [];
    }

    if (level.elevationM === null || level.sameElevationLevelIds.some(id => levels.has(id)))
      issues.push({ code: 'ambiguous-level-datum', message: '选定楼层标高无效或重复，请核对自然层。', level: level.id });
    if (!scope.rooms.length)
      issues.push({ code: 'missing-room-inventory', message: '本层没有可定位的房间记录，请补充清单。', level: level.id });
    for (const item of level.diagnostics) {
      if (item.path !== `${level.id}/space.csv` && item.path !== `${level.id}/space.geojson`) continue;
      if (!['duplicate-id', 'missing-id', 'orphan-room-outline'].includes(item.code)) continue;
      issues.push({ code: item.code, message: '房间编号重复、缺失或缺少对应的属性记录，请核对源文件。',
        level: level.id, path: item.path });
    }
    const byRoom = new Map<string, typeof assignments>();
    for (const item of assignments) {
      const list = byRoom.get(item.elementId) ?? [];
      list.push(item);
      byRoom.set(item.elementId, list);
    }
    const roomIds = new Set(scope.rooms.map(room => room.id));
    for (const item of relevant) if (!roomIds.has(item.elementId))
      issues.push({ code: 'missing-referenced-room', message: `归属房间 ${item.elementId} 在本层清单中缺失。`, level: level.id });

    const levelRows = scope.rooms.flatMap(room => {
      const saved = records.get(room.id);
      const ref = { level: level.id, roomId: room.id, path: room.path };
      if ((byRoom.get(room.id)?.length ?? 0) > 1) {
        issues.push({ ...ref, code: 'duplicate-assignment', message: `${room.name} 有重复的面积归属记录。` });
        return [];
      }
      const assignedBuilding = nodes.get(room.group.id)?.building;
      const valid = saved?.reviewed && saved.source.trim() &&
          saved.modelRevision === evidence.modelRevision && saved.original.path === room.path &&
          saved.group.kind === room.group.kind && saved.group.id === room.group.id;
      const use = valid ? currentPropertyRoomUse(saved, config) : undefined;
      if (use?.building === building && saved?.reviewed)
        return [{ ...ref, name: room.name, review: { ...saved, propertyUse: use, reviewed: saved.reviewed } }];
      if ((assignedBuilding && assignedBuilding !== building) || (use && use.building !== building)) return [];

      const message = !saved ? '缺少当前模型下有效的边界复核。'
        : !saved.reviewed ? '边界仍待复核。'
          : saved.propertyUse ? '边界依据、用途或受益户记录待重新核对。' : '缺少用途、幢号或受益户复核。';
      issues.push({ ...ref, code: 'unreviewed-room', message: `${room.name}（${room.id}）${message}` });
      return [];
    });
    const measured = levelRows.map(row => ({ row, polygon: readPropertyPolygon(row.review.reviewed.outline, 1).polygon }));
    for (const [index, current] of measured.entries()) {
      const ref = { level: level.id, roomId: current.row.roomId, path: current.row.path };
      for (let previous = 0; previous < index; previous++) {
        const other = measured[previous];
        try {
          if (roomOutlinesOverlap(current.polygon, other.polygon))
            issues.push({ ...ref, code: 'overlapping-reviewed-rooms', message: `复核轮廓与房间 ${other.row.roomId} 重叠，请核对重复计量。` });
        } catch {
          issues.push({ ...ref, code: 'reviewed-room-overlay-error', message: `无法检查与房间 ${other.row.roomId} 的重叠，请复核轮廓。` });
        }
      }
    }
    return levelRows;
  });
  for (const item of config.selections) if (item.table === 'space' && nodes.get(item.owner)?.building === building &&
    !evidence.levels.some(level => level.id === item.level))
    issues.push({ code: 'missing-assigned-level', message: `归属记录所用的楼层 ${item.level} 已不在当前模型中。` });

  const areas = (kind: typeof rows[number]['review']['propertyUse']['kind']) =>
    rows.filter(row => row.review.propertyUse.kind === kind).map(row => row.review.reviewed.areaM2);
  const unitAreas = units.map(id => {
    const parts = rows.filter(row => row.review.propertyUse.kind === 'private' && row.review.propertyUse.recipients[0] === id);
    if (!parts.length) issues.push({ code: 'missing-private-parts', message: `户 ${id} 缺少已复核的套内分项。` });
    return { id, areaM2: parts.length ? decimalSum(parts.map(row => row.review.reviewed.areaM2)).raw : null };
  });
  const privateAreas = areas('private');
  const nonAllocatable = areas('non-allocatable');
  const independent = areas('independent-use');
  const common = areas('allocatable');
  const selectedCommon = rows.filter(row => row.review.propertyUse.scope === 'selected-units');
  const complete = !issues.length && gross !== null;
  const total = (values: number[]) => values.length || complete ? decimalSum(values).raw : null;
  let comparison = null;
  let status: 'pending' | 'conflict' | 'balanced' = 'pending';
  if (complete) {
    const residualTerms = [gross.areaM2, ...[...privateAreas, ...nonAllocatable, ...independent].map(value => -value)];
    const residual = decimalSum(residualTerms);
    const roundedResidual = cents(residualTerms);
    const roundedCommon = cents(common);
    comparison = {
      rawResidualM2: residual.raw, residualM2: squareMetres(roundedResidual),
      commonM2: squareMetres(roundedCommon), differenceM2: squareMetres(roundedResidual - roundedCommon),
    };
    status = residual.coefficient >= 0n && roundedResidual === roundedCommon ? 'balanced' : 'conflict';
    if (status === 'conflict') issues.push({ code: 'gross-ledger-conflict',
      message: residual.coefficient < 0n ? '幢总面积小于套内和扣除项的合计。'
        : '幢总面积扣除套内和扣除项后的差额，与共有候选台账取位后不一致。' });
  }
  return {
    format: 'bimdown.property-building-ledger', version: 1, modelRevision: evidence.modelRevision, unit: 'm2',
    building, selectedLevels, scopeConfirmed, gross, status, issues, unitAreas, rows, comparison,
    totals: { privateM2: total(privateAreas), nonAllocatableM2: total(nonAllocatable),
      independentUseM2: total(independent), commonM2: total(common),
      selectedUnitCommonM2: total(selectedCommon.map(row => row.review.reviewed.areaM2)) },
    hasSelectedUnitCommon: selectedCommon.length > 0,
  };
}

export type PropertyBuildingLedgerResult = Awaited<ReturnType<typeof reconcilePropertyBuilding>>;
