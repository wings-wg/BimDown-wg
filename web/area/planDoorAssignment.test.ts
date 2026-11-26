import { describe, expect, it } from 'vitest';
import { createHarness, saveHarness } from '../test/authorHarness.ts';
import { loadProject } from '../utils/loader.ts';
import { memoryDataSource } from '../test/memoryDataSource.ts';
import { createDocument } from '../model/document.ts';
import { parseFloorLayers } from '../model/parse.ts';
import type { LineElement, Point } from '../model/elements.ts';
import { automaticRoomPatches, previewAutomaticRooms } from './autoRooms.ts';
import { previewFloorDoorAssignments, previewPlanDoorAssignment, previewTransferredFloorDoors, stageTransferredDoorMarks } from './planDoorAssignment.ts';

function wall(id: string, start: Point, end: Point): LineElement {
  return { id, tableName: 'wall', discipline: 'architecture', geometry: 'line',
    start, end, strokeWidth: 0.2, attrs: { id, thickness: '0.2' } };
}

function door(id: string, x: number, y = 2): LineElement {
  const hostId = `w-${x}`;
  return { id, tableName: 'door', discipline: 'architecture', geometry: 'line', hostId,
    start: { x, y: y - 0.45 }, end: { x, y: y + 0.45 }, strokeWidth: 0.08,
    attrs: { id, host_id: hostId, position: String(y) } };
}

const entry = { level: 'lv-1', elementId: 'd-entry' };
function plan(duplicate = false) {
  const h = createHarness([{ id: 'lv-1', number: '1', name: 'F1', elevation: 0 }]);
  const walls = [0, 4, 8, 12, 16].map(x => wall(`w-${x}`, { x, y: 0 }, { x, y: 4 }));
  walls.push(wall('w-bottom', { x: 0, y: 0 }, { x: 16, y: 0 }), wall('w-top', { x: 0, y: 4 }, { x: 16, y: 4 }));
  h.dispatch({ type: 'CREATE_ELEMENTS', elements: [
    ...walls, door('d-entry', 8), door('d-interior', 12), door('d-neighbour', 4),
    ...(duplicate ? [door('d-second-entry', 8, 3)] : []),
  ] });
  const rooms = previewAutomaticRooms(h.state, 'level');
  h.dispatch({ type: 'APPLY_LEVEL_EDITS', description: 'Create rooms',
    patches: automaticRoomPatches(h.state, rooms.rooms, rooms.firstNumber) });
  return h;
}

describe('door assignment with rooms created in the editor', () => {
  it('uses live room seeds and follows the door network on the chosen side', () => {
    const h = plan();
    const result = previewPlanDoorAssignment(h.state, entry, new Set());
    expect(result.source).toBe('floor-plan');
    expect(result.candidates.map(side => side.rooms.map(room => room.name))).toEqual([
      ['F1-room2', 'F1-room1'], ['F1-room3', 'F1-room4'],
    ]);
    expect(result.candidates[1].rooms.map(room => room.level)).toEqual(['lv-1', 'lv-1']);
    const hall = result.candidates[0].inside.elementId;
    expect(previewPlanDoorAssignment(h.state, entry, new Set([hall])).candidates).toEqual([result.candidates[1]]);
  });

  it('rejects a second door that reconnects the two sides', () => {
    expect(() => previewPlanDoorAssignment(plan(true).state, entry, new Set())).toThrow('两侧仍能通过其他门相通');
  });

  it('requires a valid position on the selected door host', () => {
    const h = plan();
    const bad = door('d-bad', 8, 9);
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [bad] });
    expect(() => previewPlanDoorAssignment(h.state, { ...entry, elementId: bad.id }, new Set())).toThrow('宿主墙和门位置');
  });

  it('finds a stairwell through an ordinary door and reloads explicit markings from CSV', async () => {
    const h = plan();
    const [stair] = [...h.state.document!.elements.values()].filter(room => room.tableName === 'space');
    h.dispatch({ type: 'UPDATE_ATTRS', id: 'd-entry', attrs: { is_unit_entrance: 'true' } });
    h.dispatch({ type: 'UPDATE_ATTRS', id: stair.id, attrs: { circulation_use: 'stairwell' } });
    const files = await saveHarness(h);
    const project = await loadProject(memoryDataSource(files));
    const document = createDocument(entry.level, parseFloorLayers(project.floors.get(entry.level)!.layers));
    const result = previewPlanDoorAssignment({ ...h.state, project, document }, entry, new Set());
    expect(result.candidates.map(side => side.rooms.map(room => room.name))).toEqual([['F1-room3', 'F1-room4']]);
    expect(result.publicSide?.rooms.map(room => room.name)).toEqual(['F1-room2', 'F1-room1']);
    expect(result.publicSide?.anchors.map(room => room.elementId)).toEqual([stair.id]);
  });

  it('cuts other entrances and recognizes a named elevator lobby', () => {
    const h = plan();
    const [, lobby] = [...h.state.document!.elements.values()].filter(room => room.tableName === 'space');
    for (const id of ['d-entry', 'd-neighbour']) h.dispatch({ type: 'UPDATE_ATTRS', id, attrs: { is_unit_entrance: 'true' } });
    h.dispatch({ type: 'UPDATE_ATTRS', id: lobby.id, attrs: { name: '电梯前室' } });
    const result = previewPlanDoorAssignment(h.state, entry, new Set());
    expect(result.candidates[0].rooms.map(room => room.name)).toEqual(['F1-room3', 'F1-room4']);
    expect(result.publicSide?.rooms.map(room => room.name)).toEqual(['电梯前室']);
  });

  it('leaves unlabelled or conflicting public sides unresolved', () => {
    const h = plan();
    h.dispatch({ type: 'UPDATE_ATTRS', id: 'd-entry', attrs: { is_unit_entrance: 'true' } });
    expect(() => previewPlanDoorAssignment(h.state, entry, new Set())).toThrow('两侧均未找到');
    const [left, , , right] = [...h.state.document!.elements.values()].filter(room => room.tableName === 'space');
    h.dispatch({ type: 'UPDATE_ATTRS', id: left.id, attrs: { circulation_use: 'stairwell' } });
    h.dispatch({ type: 'UPDATE_ATTRS', id: right.id, attrs: { circulation_use: 'elevator_lobby' } });
    expect(() => previewPlanDoorAssignment(h.state, entry, new Set())).toThrow('两侧都能通向');
    h.dispatch({ type: 'UPDATE_ATTRS', id: right.id, attrs: { circulation_use: 'other', name: '电梯间' } });
    expect(() => previewPlanDoorAssignment(h.state, entry, new Set([right.id]))).toThrow('与已设置的公共区域');
  });
});

describe('batch floor assignment', () => {
  it('uses the shared region of multiple entrances even when all room names are generic', () => {
    const h = plan();
    for (const id of ['d-neighbour', 'd-interior'])
      h.dispatch({ type: 'UPDATE_ATTRS', id, attrs: { is_unit_entrance: 'true' } });
    const batch = previewFloorDoorAssignments(h.state, entry.level, new Set());
    expect(batch.commonAreas).toHaveLength(1);
    expect(batch.commonAreas[0].doorIds).toEqual(['d-interior', 'd-neighbour']);
    expect(batch.commonAreas[0].rooms.map(room => room.name).sort()).toEqual(['F1-room2', 'F1-room3']);
    expect(batch.households.map(({ doorId, commonArea, candidate }) =>
      [doorId, commonArea, candidate.rooms.map(room => room.name)])).toEqual([
      ['d-interior', 0, ['F1-room4']],
      ['d-neighbour', 0, ['F1-room1']],
    ]);
    expect(() => previewFloorDoorAssignments(h.state, entry.level, new Set([batch.households[0].candidate.inside.elementId])))
      .toThrow('与已设共用或排除的房间相交');
  });

  it('flags an entrance when both sides intersect other entrances', () => {
    const h = plan();
    for (const id of ['d-neighbour', 'd-entry', 'd-interior'])
      h.dispatch({ type: 'UPDATE_ATTRS', id, attrs: { is_unit_entrance: 'true' } });
    expect(() => previewFloorDoorAssignments(h.state, entry.level, new Set()))
      .toThrow('入户门 d-entry 两侧都与其他入户门共用连通区域');
  });

  it('flags an entrance with no shared side or an alternate route around it', () => {
    const h = plan();
    for (const id of ['d-neighbour', 'd-interior'])
      h.dispatch({ type: 'UPDATE_ATTRS', id, attrs: { is_unit_entrance: 'true' } });
    h.dispatch({ type: 'DELETE_ELEMENTS', ids: ['d-entry'] });
    expect(() => previewFloorDoorAssignments(h.state, entry.level, new Set())).toThrow('两侧均无其他入户门共用的区域');
    h.dispatch({ type: 'CREATE_ELEMENTS', elements: [door('d-bypass', 12, 3)] });
    expect(() => previewFloorDoorAssignments(h.state, entry.level, new Set())).toThrow('两侧仍可经普通门相通');
  });
});

it('transfers positions across floors without altering either floor during preview', async () => {
  const h = plan();
  const entrances = new Set(['d-interior', 'd-neighbour']);
  for (const id of entrances) h.dispatch({ type: 'UPDATE_ATTRS', id, attrs: { is_unit_entrance: 'true' } });
  const files = await saveHarness(h);
  files['global/level.csv'] = 'id,number,name,elevation\nlv-1,1,F1,0\nlv-2,2,F2,3';
  for (const [path, file] of Object.entries(files)) {
    if (!path.startsWith('lv-1/')) continue;
    const target = path === 'lv-1/door.csv' ? file.replaceAll(',true', ',').replace('d-interior', 'd-right') : file;
    files[path.replace('lv-1/', 'lv-2/')] = target;
  }
  const project = await loadProject(memoryDataSource(files));
  const document = createDocument('lv-2', parseFloorLayers(project.floors.get('lv-2')!.layers));
  const state = { ...h.state, project, document };
  const preview = previewTransferredFloorDoors(state, 'lv-1', 'lv-2', entrances, new Set());
  expect(preview.transfer.matches).toEqual([
    { sourceDoorId: 'd-interior', targetDoorId: 'd-right', distanceMetres: 0 },
    { sourceDoorId: 'd-neighbour', targetDoorId: 'd-neighbour', distanceMetres: 0 },
  ]);
  expect(preview.commonAreas[0].rooms).toHaveLength(2);
  expect(document.elements.get('d-right')?.attrs.is_unit_entrance).not.toBe('true');
  const staged = stageTransferredDoorMarks(state, 'lv-2', preview.transfer.matches.map(match => match.targetDoorId));
  expect(staged.patches.get('lv-2')?.size).toBe(2);
  expect(staged.csv.split('\n').filter(line => line.endsWith(',true'))).toHaveLength(2);
  const near = door('d-near', 12, 2.02);
  const ambiguous = createDocument('lv-2', [...document.elements.values(), near]);
  expect(() => previewTransferredFloorDoors({ ...state, document: ambiguous }, 'lv-1', 'lv-2', entrances, new Set()))
    .toThrow('多个距离接近的候选门');
});
