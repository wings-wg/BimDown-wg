type Level = { id: string; elevation: number };

/** Display order only. A multi-floor household is anchored at its lowest known floor. */
export function orderAssignedUnits<T extends ReadonlyMap<string, unknown>>(
  units: ReadonlyMap<string, T>, levels: readonly Level[],
): [string, T][] {
  const elevations = new Map(levels.filter(level => Number.isFinite(level.elevation))
    .map(level => [level.id, level.elevation]));
  return [...units].map(([id, rooms], index) => {
    let elevation: number | undefined;
    for (const level of rooms.keys()) {
      const value = elevations.get(level);
      if (value !== undefined && (elevation === undefined || value < elevation)) elevation = value;
    }
    return { id, rooms, index, elevation };
  }).sort((a, b) => {
    if (a.elevation === undefined) return b.elevation === undefined ? a.index - b.index : 1;
    if (b.elevation === undefined) return -1;
    return a.elevation - b.elevation || a.index - b.index;
  }).map(({ id, rooms }) => [id, rooms]);
}
