import type { CheckItem } from './check-import.js';
import { HEIGHT, ROOM_NET_AREA } from './pal-plan.js';
import { toolDataContract } from './tool-evidence.js';
import type { Blocker, PalDiagnosis } from './pal-readiness.js';

export interface ExportFeedback {
  ruleId: string;
  affected: number;
  blockers: { kind: Blocker; count: number }[];
  files: string[];
  fields: string[];
  advice: string;
  scope?: { ruleId: string; ruleVersion: string; applicability: string };
}

/** Use engineering evidence contracts; don't infer export instructions from provider prose. */
export function buildExportFeedback(items: CheckItem[], results: { ruleId: string; status: string; diagnosis?: PalDiagnosis }[]): ExportFeedback[] {
  const unresolved = new Map<string, { affected: number; counts: Map<Blocker, number> }>();
  for (const result of results) {
    if (result.status !== 'indeterminate') continue;
    const entry = unresolved.get(result.ruleId) ?? { affected: 0, counts: new Map<Blocker, number>() };
    entry.affected++;
    for (const kind of result.diagnosis?.blockers ?? [])
      entry.counts.set(kind, (entry.counts.get(kind) ?? 0) + 1);
    unresolved.set(result.ruleId, entry);
  }
  return items.flatMap(item => {
    const entry = unresolved.get(item.id);
    if (!entry) return [];
    const base = { ruleId: item.id, affected: entry.affected,
      blockers: [...entry.counts].map(([kind, count]) => ({ kind, count })) };
    const toolRule = item.rule ?? item.doorWidthRule;
    if (item.libraryTool && toolRule) {
      const { recipe } = item.libraryTool;
      const contract = toolDataContract(recipe);
      return [{ ...base, files: contract.files, fields: [...contract.fields, 'applicability',
        ...(item.doorWidthRule ? ['doorUses.use', 'doorUses.openingAngleDeg', 'doorUses.measurementLine', 'doorUses.source'] : [])],
        advice: `${contract.advice} 适用性记录使用相同的对象 ID、规则版本和适用范围正文。`,
        scope: { ruleId: toolRule.id, ruleVersion: toolRule.version, applicability: toolRule.applicability } }];
    }
    if (item.rule?.concept === HEIGHT) return [{ ...base, files: ['global/level.csv', 'project_metadata.json'],
      fields: ['楼层 ID', '建筑完成面标高', '标高对应上层 ID', '楼层用途', '单位'],
      advice: '区分结构标高与建筑完成面标高。重导后需复核楼层用途、配对和适用范围。' }];
    if (item.rule?.concept === ROOM_NET_AREA) return [{ ...base, files: ['<楼层>/space.csv', '<楼层>/space.geojson', 'project_metadata.json'],
      fields: ['房间 ID', '边界与洞口', 'properties.net_area', '面积边界口径', '模型单位'],
      advice: '导出与房间 ID 一一对应的轮廓及模型记载净面积，保留生成来源；种子点不可替代边界。' }];
    if (item.clearHeightRule) return [{ ...base, files: ['<楼层>/space.csv', '<楼层>/space.geojson',
      'engineering_evidence.json', 'project_metadata.json'],
      fields: ['房间用途与作用域', '使用面积 (m²)', '最低完成面净高 (m)',
        `低于 ${item.clearHeightRule.nominalHeight} m 的面积 (m²)`, 'clearHeightAreas.boundaryRef', '净高分析来源', '逐对象适用性'],
      advice: '导出已复核的完成面净高、指定限值下面积和同一使用面积边界。梁下、吊顶或包封限制留来源；也可在网页录入复核后的净高指标。',
      scope: { ruleId: item.clearHeightRule.id, ruleVersion: item.clearHeightRule.version, applicability: item.clearHeightRule.applicability } }];
    if (item.overlapRule) return [{ ...base, files: ['global/level.csv', '<楼层>/space.csv', '<楼层>/space.geojson',
      'project_metadata.json', 'engineering_evidence.json'],
      fields: ['spaceRelations.levelPairs', 'spaceRelations.footprints', '逐对象适用性', '平面坐标基准', '有效闭合轮廓和洞口'],
      advice: '复核上下层对应关系、下层房间清单与用途的完整性、统一坐标和轮廓来源后重导。',
      scope: { ruleId: item.overlapRule.id, ruleVersion: item.overlapRule.version, applicability: item.overlapRule.applicability } }];
    if (item.componentMinimumRule) return [{ ...base, files: ['global/level.csv', '<楼层>/stair.csv', '<楼层>/stair_run.csv',
      '<楼层>/stair_landing.csv', 'project_metadata.json', 'engineering_evidence.json'],
      fields: ['楼层与构件 ID', 'host_id', '逐对象适用性', 'stair.flight-minimum-headroom', 'stair.landing-minimum-headroom',
        'stairHeadroomCoverage', 'measurementGroup / location', '量测单位及来源'],
      advice: '逐实体梯段和平台导出，同层绑定宿主楼梯。若是多层重复楼梯，需逐实例形成构件记录。提供从步行基面至上方限制面的最低垂直净高，并确认结构、风管和其他管线障碍覆盖。',
      scope: { ruleId: item.componentMinimumRule.id, ruleVersion: item.componentMinimumRule.version,
        applicability: item.componentMinimumRule.applicability } }];
    if (item.dwellingMinimumRule) return [{ ...base, files: ['project_metadata.json', 'engineering_evidence.json'],
      fields: ['project_number', 'dwellingInventory', 'applicability.dwellingCountBasis'],
      advice: '提供整项目范围与独立核定总户数，以幢号和户号逐户记录已确认的无障碍分类及来源。按规则版本复核适用的配建依据、最低套数和比例。',
      scope: { ruleId: item.dwellingMinimumRule.id, ruleVersion: item.dwellingMinimumRule.version,
        applicability: item.dwellingMinimumRule.applicability } }];
    if (item.conditionalRequirementRule) return [{ ...base, files: ['<楼层>/window.csv', 'project_metadata.json', 'engineering_evidence.json'],
      fields: ['逐外窗适用性和 windowKind', 'window.sill-clear-height', 'windowSillBasis', 'measurementGroup', 'windowGuards'],
      advice: '以室内完成地面为普通外窗和落地窗的起算面，飘窗核对可踏面。低窗台需补同部位已复核的防护设置状态和来源。',
      scope: { ruleId: item.conditionalRequirementRule.id, ruleVersion: item.conditionalRequirementRule.version,
        applicability: item.conditionalRequirementRule.applicability } }];
    return [];
  });
}
