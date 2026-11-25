import type { CheckItem } from './check-import.js';
import { HEIGHT, ROOM_NET_AREA } from './pal-plan.js';
import { toolDataContract } from './tool-evidence.js';

export interface ExportFeedback {
  ruleId: string;
  affected: number;
  files: string[];
  fields: string[];
  advice: string;
  scope?: { ruleId: string; ruleVersion: string; applicability: string };
}

/** Use engineering evidence contracts; don't infer export instructions from provider prose. */
export function buildExportFeedback(items: CheckItem[], results: { ruleId: string; status: string }[]): ExportFeedback[] {
  const unresolved = new Map<string, number>();
  for (const result of results) {
    if (result.status === 'indeterminate')
      unresolved.set(result.ruleId, (unresolved.get(result.ruleId) ?? 0) + 1);
  }
  return items.flatMap(item => {
    const affected = unresolved.get(item.id) ?? 0;
    if (!affected) return [];
    const base = { ruleId: item.id, affected };
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
    return [];
  });
}
