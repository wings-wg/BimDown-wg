# Revit area feature evidence

The standard export pipeline writes `area_features.json` at archive root, independent of ExportMesh. Read-only host-document analysis covers placed architectural Rooms with positive area. It does not edit parameters or create views.

- Cover: sample XY cells inside Room at 0.1 m above its location, cast up to 100 m against roof, floor and ceiling solids, including geometry instances. Export sample counts, ratio, grid step and nearest-hit element UniqueIds. Grid starts at 0.5 m spacing and grows to cap a bounding box near 10,000 cells. Small rooms may have zero samples. A ratio of 1 is a candidate, not proof of full coverage. Ceiling presence does not establish a permanent statutory roof.
- Enclosure: export Room boundary element IDs and whether every boundary is a Wall. Room separators, linked boundaries or missing boundaries do not count as wall evidence. A closed Room boundary does not prove a full-height enclosure: `enclosed` stays unknown pending review.
- Connectivity: resolve door FromRoom/ToRoom using ROOM_PHASE, export room adjacency and door evidence. A null neighbor may be exterior or missing room data. Connections are not proof of traversability or indoor use. Non-door openings and stairs are not inferred.

`covered`, `enclosed`, `connectedToIndoor` remain null unless explicitly confirmed through optional Room **text** parameters `BimDown_Area_Covered`, `BimDown_Area_Enclosed`, `BimDown_Area_ConnectedToIndoor` with values `true` or `false`. These confirmations are distinct from automatically measured evidence. Each exported room includes its Revit UUID, level directory (`scope`) and short ID.

The local editor can preview room assignment from a selected entrance using the phase-specific connections and the scoped Revit UUIDs in `_IdMap.csv`. To mark a shared room, set the optional Room text parameter `BimDown_Area_IsCommon` to `true`. To prevent traversal through another dwelling boundary, set the optional Door text parameter `BimDown_Area_IsUnitEntrance` to `true`. The editor keeps room assignment pending until the user confirms the preview. A missing or ambiguous mapping requires review or a fresh export.

The JSON is evidence for review, not an area-input.json: a reviewer/adapter must still establish the part type, applicability, permanent construction, uniform applicable height, public-passage classification, measurement outline, ownership and allocation scope before calling inferAreaFactor. No unverified evidence is silently mapped to a statutory counting factor.

The area feature analysis reads the host model. Exact cover polygons, full-height enclosure, non-door traversal and area-rule eligibility require additional evidence. Export warnings report individual room or cover extraction failures. See the [Revit export guide](../README.md#工程证据导出) for room footprints and revision-linked engineering observations.
