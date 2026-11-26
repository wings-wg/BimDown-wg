import { createContext, useContext, useMemo, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react';
import { useEditorState } from '../state/EditorContext.tsx';
import { currentFloorAssignmentColors, type FloorAssignmentColors } from '../state/floorAssignmentColors.ts';
import { getProjectUnits, unitsPerMetreOf } from '../utils/units.ts';

const Preview = createContext<FloorAssignmentColors | undefined>(undefined);
const SetPreview = createContext<Dispatch<SetStateAction<FloorAssignmentColors | undefined>>>(() => {});
type BoundaryPreview = { level: string; items: {
  id: string; color: string; selected: boolean; original?: number[][][]; outline: number[][][];
}[] };
const Boundaries = createContext<BoundaryPreview | undefined>(undefined);
const SetBoundaries = createContext<Dispatch<SetStateAction<BoundaryPreview | undefined>>>(() => {});
export const useFloorAssignmentPreview = () => useContext(SetPreview);
export const usePropertyBoundaryPreview = () => useContext(SetBoundaries);
export function FloorAssignmentPreviewProvider({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<FloorAssignmentColors>();
  const [boundaries, setBoundaries] = useState<BoundaryPreview>();
  return <SetPreview.Provider value={setPreview}><Preview.Provider value={preview}>
    <SetBoundaries.Provider value={setBoundaries}><Boundaries.Provider value={boundaries}>{children}</Boundaries.Provider></SetBoundaries.Provider>
  </Preview.Provider></SetPreview.Provider>;
}
export function FloorAssignmentOverlay() {
  const state = useEditorState();
  const preview = useContext(Preview);
  const boundaries = useContext(Boundaries);
  const fills = useMemo(() => currentFloorAssignmentColors(state, preview), [state, preview]);
  if (boundaries && boundaries.level === state.currentLevel && state.document?.levelId === boundaries.level) {
    const scale = unitsPerMetreOf(getProjectUnits(state));
    const path = (rings: number[][][]) => rings.map(ring => ring.map(([x, y], index) =>
      `${index ? 'L' : 'M'}${x * scale},${y * scale}`).join(' ') + ' Z').join(' ');
    return <g data-testid="property-boundary-overlay" transform="scale(1,-1)" pointerEvents="none">
      {boundaries.items.map(item => <g key={item.id} data-room-id={item.id}>
        <path d={path(item.outline)} fill={item.color} fillOpacity={item.selected ? 0.34 : 0.16} fillRule="evenodd"
          stroke={item.color} strokeWidth={item.selected ? 3 : 1.5} vectorEffect="non-scaling-stroke" />
        {item.original && <path d={path(item.original)} fill="none" stroke={item.color} strokeWidth={2}
          strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />}
      </g>)}
    </g>;
  }
  return <g data-testid="floor-assignment-overlay" transform="scale(1,-1)" pointerEvents="none">
    {fills.map(room => <path key={JSON.stringify([room.level, room.elementId])}
      data-room-level={room.level} data-room-id={room.elementId} d={room.path}
      fill={room.color} fillOpacity={0.32} fillRule="evenodd" />)}
  </g>;
}
