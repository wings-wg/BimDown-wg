import { insidePoint } from '../geometry/pickBoundary.ts';
import { roomAreas } from '../geometry/roomArea.ts';
import { findSpaceBoundary, getSpaceFaceGraph } from '../geometry/spaceBoundary.ts';
import type { Point } from '../model/elements.ts';
import type { Level } from '../types.ts';
import type { DataSource } from '../utils/dataSource.ts';
import { enqueueRoomLayerSave } from '../utils/pruneRoomOutlines.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';
import { nestedRoomFaces, roomBoundaryWalls, spanningRoomWalls } from './autoRooms.ts';
import type { EditorState } from './editorTypes.ts';
import { levelElements } from './levelEdits.ts';
import { simpleRoomBoundary } from './room-ring.js';

type Scope = 'level' | 'project';
type Room = { elementId: string; name: string };
type Issue = { level: string; room?: Room; reason: string };
type Feature = {
  type: 'Feature';
  properties: { id: string; boundary_basis: 'wall-centerline'; net_area?: number };
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
};
type SavedFeature = {
  properties?: { id?: string | number; redundant?: boolean };
  geometry?: { type?: string; coordinates?: unknown };
};
type Result = { generated: number; preserved: number; issues: Issue[] };

function deriveOutlines(state: EditorState, level: Level, upm: number, spans: ReturnType<typeof spanningRoomWalls>['spans']) {
  const elements = [...levelElements(state, level.id).values()];
  const rooms = elements.filter(element => element.tableName === 'space');
  if (!rooms.length) return [];
  const walls = roomBoundaryWalls(elements, level, upm, spans);
  const graph = getSpaceFaceGraph(walls);
  const nested = nestedRoomFaces(graph.faces);
  const matches = rooms.map(element => {
    const seed = element.geometry === 'point' ? element.position :
      element.geometry === 'polygon' ? insidePoint(element.vertices) : null;
    const room = { elementId: element.id, name: element.attrs.name || element.id };
    return { room, face: seed && findSpaceBoundary(graph, seed) };
  });
  const occupants = new Map<Point[], number>();
  for (const { face } of matches) if (face) occupants.set(face, (occupants.get(face) ?? 0) + 1);

  return matches.map(({ room, face }): { room: Room; feature?: Feature; reason?: string } => {
    if (!face) return { room, reason: '房间定位点未落在闭合墙体区域内。' };
    if ((occupants.get(face) ?? 0) > 1) return { room, reason: '同一闭合区域有多个房间，请核对重复房间。' };
    if (nested.has(face)) return { room, reason: '轮廓存在嵌套，需核对孔洞和测算边界。' };
    const polygon = simpleRoomBoundary(face);
    if (!polygon) return { room, reason: '无法生成单一有效轮廓，请核对墙体交接。' };
    const ring = polygon.map(({ x, y }): [number, number] => [x, y]);
    const net = roomAreas(polygon, walls, upm);
    return { room, feature: {
      type: 'Feature',
      properties: { id: room.elementId, boundary_basis: 'wall-centerline', ...(net.netPolygon && { net_area: net.area }) },
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    } };
  });
}

function mergeOutlines(level: string, content: string | null, candidates: ReturnType<typeof deriveOutlines>) {
  const collection: { type: string; features: SavedFeature[] } = content === null
    ? { type: 'FeatureCollection', features: [] }
    : JSON.parse(content);
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features))
    throw new Error('现有 space.geojson 格式无效，请检查文件。');
  const savedById = new Map<string, SavedFeature[]>();
  for (const feature of collection.features) {
    const id = feature?.properties?.id;
    if (id == null) continue;
    const key = String(id);
    const entries = savedById.get(key) ?? [];
    entries.push(feature);
    savedById.set(key, entries);
  }
  const added: Feature[] = [];
  const result: Result = { generated: 0, preserved: 0, issues: [] };
  for (const { room, feature, reason } of candidates) {
    const saved = savedById.get(room.elementId);
    if (saved) {
      const [first] = saved;
      if (saved.length === 1 && first.geometry?.type === 'Polygon' &&
          Array.isArray(first.geometry.coordinates) && first.geometry.coordinates.length &&
          !first.properties?.redundant) {
        result.preserved++;
      } else {
        result.issues.push({ level, room, reason: '已有轮廓重复或不可测算，请核对原有文件。' });
      }
    } else if (feature) {
      added.push(feature);
    } else {
      result.issues.push({ level, room, reason: reason ?? '缺少可测算轮廓。' });
    }
  }
  result.generated = added.length;
  const text = added.length ? JSON.stringify({ ...collection, features: [...collection.features, ...added] }, null, 2) + '\n' : undefined;
  return { result, text };
}

/** Fill missing room outlines with wall-centre polygons for the current model snapshot. */
export async function generateMeasurementOutlines(
  state: EditorState, ds: DataSource, scope: Scope, isCurrent = () => true,
): Promise<Result> {
  if (!state.project || state.readonly || state.groupEdit || !state.document ||
      state.currentLevel !== state.document.levelId) throw new Error('请先打开可编辑的楼层并退出组编辑。');
  const levels = state.project.levels.filter(level => scope === 'project' || level.id === state.currentLevel);
  const upm = unitsPerMetreOf(getProjectUnits(state));
  const { spans } = spanningRoomWalls(state);
  let manifest: Promise<string[]> | undefined;
  const results = await Promise.all(levels.map(async (level): Promise<Result> => {
    try {
      if (!level.id || level.id === '.' || level.id === '..' || /[\\/:]/.test(level.id))
        throw new Error('楼层 ID 无法用于项目内文件路径。');
      const candidates = deriveOutlines(state, level, upm, spans);
      if (!candidates.length) return { generated: 0, preserved: 0, issues: [] };
      return await enqueueRoomLayerSave(ds, level.id, async () => {
        const path = `${level.id}/space.geojson`;
        const content = await ds.fetchText(path);
        if (content === null && ds.listFiles && (await (manifest ??= ds.listFiles())).includes(path))
          throw new Error('已有轮廓文件无法读取，请检查权限。');
        if (!isCurrent()) throw new Error('模型或楼层已变化，请重新生成。');
        const { result, text } = mergeOutlines(level.id, content, candidates);
        if (text !== undefined) await ds.saveFile(path, text);
        return result;
      });
    } catch (error) {
      return { generated: 0, preserved: 0, issues: [
        { level: level.id, reason: error instanceof Error ? error.message : String(error) },
      ] };
    }
  }));
  return {
    generated: results.reduce((count, result) => count + result.generated, 0),
    preserved: results.reduce((count, result) => count + result.preserved, 0),
    issues: results.flatMap(result => result.issues),
  };
}
