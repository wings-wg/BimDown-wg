import { describe, expect, it } from 'vitest';
import { loadProject, type EditorState } from 'bimdown-editor';
import { createMemoryDataSource } from 'bimdown-editor/data-sources';
import { collectModelEvidence } from './model-qa-evidence.js';
import { areaSample } from './sample.ts';

async function sample(extra: [string, string][] = []) {
  const { dataSource } = createMemoryDataSource(new Map([...areaSample, ...extra]));
  const project = await loadProject(dataSource);
  const state = { project, document: null, currentLevel: 'lv-1' } as EditorState;
  return { state, dataSource };
}

describe('model question evidence', () => {
  it('grounds room area and attribution in scoped evidence and reports the net height gap', async () => {
    const { state, dataSource } = await sample();
    const evidence = await collectModelEvidence(state, new Set(), dataSource, 'sp-101 的面积、归属和净高');
    expect(evidence).toContainEqual(expect.objectContaining({
      target: { level: 'lv-1', elementId: 'sp-101' },
      facts: expect.objectContaining({ 轮廓面积m2: 80, 配置归属: '101', 配置计入系数: 'auto',
        平面墙线证据: expect.objectContaining({ closedPlan: true }) }),
    }));
    expect(evidence.some(item => item.label === '三维判断所需证据')).toBe(true);
    expect(evidence.every(item => item.target?.elementId !== 'sp-102')).toBe(true);
  });

  it('matches explicit floor numbers exactly and does not reuse a different floor’s short ID', async () => {
    const { state, dataSource } = await sample([
      ['global/level.csv', 'id,number,name,elevation\nlv-1,1,F1,0\nlv-10,10,F10,30\n'],
      ['lv-10/space.csv', 'id,name,x,y\nsp-101,另一层房间,1,1\n'],
    ]);
    const evidence = await collectModelEvidence(state, new Set(['sp-101']), dataSource, 'F10 的 sp-101 面积是多少？');
    expect(evidence.filter(item => item.target).every(item => item.target?.level === 'lv-10')).toBe(true);
    expect(evidence).toContainEqual(expect.objectContaining({
      target: { level: 'lv-10', elementId: 'sp-101' },
      facts: expect.objectContaining({ 测算轮廓: '缺少唯一有效的房间多边形' }),
    }));
  });

  it('distinguishes saved assignments from a measurement report', async () => {
    const { state, dataSource } = await sample();
    const draft = await collectModelEvidence(state, new Set(), dataSource, '101 户分摊多少？');
    expect(draft.find(item => item.label === '101 户的面积')?.facts).toMatchObject({
      诊断: '尚无本次经审核的测算结果',
    });
    const measured = await collectModelEvidence(state, new Set(), dataSource, '101 户分摊多少？', undefined, {
      ruleSource: '合成审核记录',
      units: [{ id: '101', building: 'B1', internalArea: 80, sharedArea: 20, totalArea: 100 }],
    });
    expect(measured.find(item => item.label === '101 户的面积')?.facts)
      .toMatchObject({ 套内m2: 80, 分摊m2: 20, 合计m2: 100 });
  });
});
