import { Coordinate, GeometryFactory } from './jsts-exports.js';

type Position = readonly [number, number, ...number[]];
type GeoJsonGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: readonly Position[] }
  | { type: 'Polygon'; coordinates: readonly (readonly Position[])[] };

export interface JstsGeometry {
  getGeometryType(): 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | 'GeometryCollection' | (string & {});
  getCoordinates(): { x: number; y: number; z?: number }[];
  getCoordinate(): { x: number; y: number; z?: number };
  getEnvelopeInternal(): {
    getMinX(): number;
    getMinY(): number;
    getMaxX(): number;
    getMaxY(): number;
  };
  getNumGeometries(): number;
  getGeometryN(i: number): JstsGeometry;
  getExteriorRing(): JstsGeometry;
  intersection(other: JstsGeometry): JstsGeometry;
  union(other: JstsGeometry): JstsGeometry;
  difference(other: JstsGeometry): JstsGeometry;
  symDifference(other: JstsGeometry): JstsGeometry;
  buffer(distance: number): JstsGeometry;
  contains(other: JstsGeometry): boolean;
  intersects(other: JstsGeometry): boolean;
  isEmpty(): boolean;
  isValid(): boolean;
}

export type BimDownGeometry = JstsGeometry;

const factory = new GeometryFactory();

/**
 * Convert a GeoJSON geometry to a JSTS geometry.
 * Returns null for unsupported types.
 */
export function geoJsonToJsts(g: GeoJsonGeometry): BimDownGeometry | null {
  switch (g.type) {
    case 'Point': {
      const c = g.coordinates;
      return factory.createPoint(new Coordinate(c[0], c[1]));
    }
    case 'LineString': {
      const coords = g.coordinates.map((p) => new Coordinate(p[0], p[1]));
      return factory.createLineString(coords);
    }
    case 'Polygon': {
      const [outer, ...holes] = g.coordinates;
      if (!outer || outer.length < 4) return null;
      const outerRing = factory.createLinearRing(outer.map((p) => new Coordinate(p[0], p[1])));
      if (holes.length === 0) return factory.createPolygon(outerRing);
      const holeRings = holes.map((h) => factory.createLinearRing(h.map((p) => new Coordinate(p[0], p[1]))));
      return factory.createPolygon(outerRing, holeRings);
    }
  }
  return null;
}
