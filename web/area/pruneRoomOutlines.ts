import type { DataSource } from './dataSource.ts';

const pendingSaves = new WeakMap<DataSource, Map<string, Promise<unknown>>>();

/** Serialize all edits to the same floor's space.csv and space.geojson. */
export function enqueueRoomLayerSave<T>(ds: DataSource, levelId: string, write: () => Promise<T>): Promise<T> {
  const saves = pendingSaves.get(ds) ?? new Map<string, Promise<unknown>>();
  pendingSaves.set(ds, saves);
  const previous = saves.get(levelId) ?? Promise.resolve();
  const save = previous.catch(() => {}).then(write);
  saves.set(levelId, save);
  const clear = () => { if (saves.get(levelId) === save) saves.delete(levelId); };
  void save.then(clear, clear);
  return save;
}

export function persistRoomLayer(ds: DataSource, levelId: string, roomIds: string[],
  writeCsv: () => Promise<void>): Promise<void> {
  return enqueueRoomLayerSave(ds, levelId, async () => {
    await pruneRoomOutlines(ds, levelId, roomIds);
    await writeCsv();
  });
}

/** Space CSV is authoritative. Keep the saved outlines of surviving rooms. */
async function pruneRoomOutlines(ds: DataSource, levelId: string, roomIds: string[]): Promise<void> {
  const path = `${levelId}/space.geojson`;
  const content = await ds.fetchText(path);
  if (!content) return;

  let collection: { type?: string; features?: { properties?: { id?: string | number } }[] };
  try {
    collection = JSON.parse(content);
  } catch {
    return;
  }
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) return;
  const live = new Set(roomIds);
  const features = collection.features.filter(feature => {
    const id = feature?.properties?.id;
    return id == null || live.has(String(id));
  });
  if (features.length !== collection.features.length) {
    await ds.saveFile(path, JSON.stringify({ ...collection, features }, null, 2) + '\n');
  }
}
