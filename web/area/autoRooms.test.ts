import { describe, expect, it } from 'vitest';
import { createHarness, saveHarnessAll } from '../test/authorHarness.ts';
import type { LineElement, Point, PointElement } from '../model/elements.ts';
import { parseCsv } from '../utils/loader.ts';
import { automaticRoomPatches, previewAutomaticRooms } from './autoRooms.ts';
import type { ElementPatch } from './levelEdits.ts';

const wall = (id: string, start: Point, end: Point, width = 0.2): LineElement => ({
  id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
  start, end, strokeWidth: width, attrs: { id, thickness: String(width) },
});

function rectangle(n: number, x: number, y: number, w: number, h: number, width = 0.2) {
  const points = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return points.map((point, index) => wall(`w-${n + index}`, point, points[(index + 1) % points.length], width));
}

describe('automatic room creation', () => {
  it('adds one room per unoccupied closed region across floors, with stable names and one undo', async () => {
    const h = createHarness([
      { id: 'lv-1', name: 'F1', number: '1', elevation: 0 },
      { id: 'lv-2', name: 'F2', number: '2', elevation: 3 },
    ]);
    const first = rectangle(1, 0, 0, 8, 5);
    first.push(wall('w-5', { x: 4, y: 0 }, { x: 4, y: 5 }));
    const old: PointElement = {
      id: 'sp-1', tableName: 'space', discipline: 'architecture', geometry: 'point', position: { x: 2, y: 2 },
      width: 0.3, height: 0.3, attrs: { id: 'sp-1', name: '已有房间', x: '2', y: '2' },
    };
    const second = rectangle(1, 0, 0, 4, 5);
    // The other unclosed perimeter on F2 stays empty.
    second.push(...rectangle(5, 10, 0, 4, 5).slice(0, 3));
    h.dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Fixture', patches: new Map<string, ElementPatch>([
      ['lv-1', new Map([...first, old].map(el => [el.id, el]))],
      ['lv-2', new Map(second.map(el => [el.id, el]))],
    ]) });
    expect(previewAutomaticRooms(h.state, 'level').rooms.map(room => room.levelName)).toEqual(['F1']);
    const preview = previewAutomaticRooms(h.state, 'project');
    expect(preview.existing).toBe(1);
    expect(preview.rooms.map(room => room.levelName)).toEqual(['F1', 'F2']);
    for (const room of preview.rooms) expect(room.areaM2).toBeCloseTo(18.24);

    const patches = automaticRoomPatches(h.state, preview.rooms, preview.firstNumber);
    h.dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Create rooms', patches });
    expect(previewAutomaticRooms(h.state, 'project')).toMatchObject({ rooms: [], firstNumber: 3, existing: 3 });
    const saved = await saveHarnessAll(h);
    expect(parseCsv(saved['lv-1/space.csv']).map(row => row.name)).toEqual(['已有房间', 'F1-room1']);
    expect(parseCsv(saved['lv-2/space.csv'])[0]).toMatchObject({ id: 'sp-1', name: 'F2-room2', number: 'room2', x: '2', y: '2.5' });
    h.dispatch({ type: 'UNDO' });
    expect(previewAutomaticRooms(h.state, 'project').rooms).toHaveLength(2);
  });

  it('does not create overlapping rooms from disconnected nested boundaries', () => {
    const h = createHarness();
    const walls = [...rectangle(1, 0, 0, 10, 10), ...rectangle(5, 3, 3, 4, 4)];
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: walls });
    expect(previewAutomaticRooms(h.state, 'level')).toMatchObject({ rooms: [], skipped: 2 });
  });

  it('reports areas in square metres for a millimetre model', () => {
    const h = createHarness();
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: rectangle(1, 0, 0, 4000, 5000, 200) });
    const project = h.state.project!;
    const preview = previewAutomaticRooms({ ...h.state, project: { ...project, metadata: { ...project.metadata, units: 'mm' } } }, 'level');
    expect(preview.rooms[0].areaM2).toBeCloseTo(18.24);
  });
});
