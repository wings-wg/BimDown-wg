import { describe, expect, it } from 'vitest';
import { orderAssignedUnits } from './unit-list-order.js';

const levels = [
  { id: 'ten', elevation: 30 }, { id: 'two', elevation: 3 },
  { id: 'basement', elevation: -3 }, { id: 'one', elevation: 0 },
  { id: 'alias', elevation: 3 }, { id: 'invalid', elevation: NaN },
];
const rooms = (...ids: string[]) => new Map(ids.map(id => [id, new Set(['same-room-id'])]));

describe('assigned household display order', () => {
  it('orders by ascending elevation, preserving same-floor and same-elevation order', () => {
    const units = new Map([
      ['10', rooms('ten')], ['2b', rooms('two')], ['2a', rooms('two')],
      ['alias', rooms('alias')], ['B1', rooms('basement')], ['1', rooms('one')],
    ]);
    const before = structuredClone(units);
    const ordered = orderAssignedUnits(units, levels);
    expect(ordered.map(([id]) => id)).toEqual(['B1', '1', '2b', '2a', 'alias', '10']);
    expect(units).toEqual(before);
    expect(ordered.find(([id]) => id === '2b')![1]).toBe(units.get('2b'));
  });

  it('anchors multi-floor households at their lowest finite known elevation', () => {
    const units = new Map([
      ['upper', rooms('ten')], ['duplex', rooms('ten', 'two', 'missing')],
      ['lower', rooms('one')],
    ]);
    expect(orderAssignedUnits(units, levels).map(([id]) => id)).toEqual(['lower', 'duplex', 'upper']);
  });

  it('places missing, nonfinite and empty floor evidence last, in original order', () => {
    const units = new Map([
      ['missing', rooms('absent')], ['invalid', rooms('invalid')],
      ['empty', rooms()], ['known', rooms('one')],
    ]);
    expect(orderAssignedUnits(units, levels).map(([id]) => id)).toEqual(['known', 'missing', 'invalid', 'empty']);
    expect(orderAssignedUnits(units, []).map(([id]) => id)).toEqual([...units.keys()]);
    expect(orderAssignedUnits(new Map(), levels)).toEqual([]);
  });
});
