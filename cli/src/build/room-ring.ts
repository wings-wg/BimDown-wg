type Point = { x: number; y: number };

/** Drop out-and-back wall branches and reject ambiguous rings. */
export function simpleRoomBoundary<T extends Point>(face: T[]): T[] | null {
  const keys = face.map(({ x, y }) => `${x},${y}`);
  const edges = keys.map((from, i) => ({ from, to: keys[(i + 1) % keys.length], point: face[i] }));
  const edgeKeys = new Set(edges.map(({ from, to }) => `${from}:${to}`));
  const boundary = edges.filter(({ from, to }) => from !== to && !edgeKeys.has(`${to}:${from}`));
  if (boundary.length < 3 || new Set(boundary.map(edge => edge.from)).size !== boundary.length ||
      boundary.some((edge, i) => edge.to !== boundary[(i + 1) % boundary.length].from)) return null;

  const points = boundary.map(edge => edge.point);
  const origin = points[0];
  const twiceArea = points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length];
    return sum + (point.x - origin.x) * (next.y - origin.y) - (next.x - origin.x) * (point.y - origin.y);
  }, 0);
  return Number.isFinite(twiceArea) && twiceArea > 0 ? points : null;
}
