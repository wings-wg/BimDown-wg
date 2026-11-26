import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UnitRoomList } from './UnitRoomList.tsx';
import { assignSelectedRooms } from './manual-room-assignment.js';
import type { ProjectAreaConfig } from './core/project-input.js';

vi.mock('bimdown-editor', () => ({
  useEditorState: () => ({ project: { levels: [
    { id: 'lv-10', name: 'F10', elevation: 30 },
    { id: 'lv-2', name: 'F2', elevation: 3 },
    { id: 'lv-1', name: 'F1', elevation: 0 },
  ] }, currentLevel: 'lv-10' }),
  useEditorDispatch: () => vi.fn(), unitRoomView: vi.fn(), ZOOM_TO_EVENT: 'zoom',
}));

describe('assigned list rendering after assignment', () => {
  it('shows households in floor order without changing assignments or same-floor order', () => {
    let draft: ProjectAreaConfig = { version: 1, confirmed: false, ruleSource: 'Synthetic', nodes: [], selections: [], groups: [] };
    for (const [unit, level] of [['1001', 'lv-10'], ['202', 'lv-2'], ['201', 'lv-2'], ['101', 'lv-1']]) {
      draft = assignSelectedRooms(draft, [{ level, elementId: `room-${unit}`, name: unit }], unit, false);
    }
    const before = JSON.stringify(draft);
    const html = renderToStaticMarkup(createElement(UnitRoomList, { draft, sectionRef: null, busy: false, remove: vi.fn() }));
    const labels = [...html.matchAll(/<span>(.*?)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(['101', '202', '201', '1001']);
    expect(JSON.stringify(draft)).toBe(before);
    expect(html.match(/1 间/g)).toHaveLength(4);
  });
});
