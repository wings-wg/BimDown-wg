using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using System.Text.Json;

namespace BimDown.RevitAddin.Area;

/// <summary>Host-document room evidence. No view creation, model mutation or linked-model inference.</summary>
internal static class AreaFeatureExporter
{
    static IEnumerable<Solid> Solids(GeometryElement geometry)
    {
        foreach (GeometryObject obj in geometry)
        {
            if (obj is Solid s && s.Volume > 0) yield return s;
            if (obj is GeometryInstance instance)
                foreach (var nested in Solids(instance.GetInstanceGeometry())) yield return nested;
        }
    }

    // Explicit shared/project text parameters: "true"/"false" only; absent stays unknown.
    static bool? Confirmed(Element element, string name)
    {
        var value = element.LookupParameter("BimDown_Area_" + name)?.AsString();
        return bool.TryParse(value, out var parsed) ? parsed : null;
    }

    internal static void Write(Document doc, string directory,
        IReadOnlyDictionary<string, string> ids, List<string> errors)
    {
        var rooms = new FilteredElementCollector(doc).OfClass(typeof(SpatialElement))
            .OfType<Room>().Where(r => r.Area > 0 && r.Location is LocationPoint).ToList();
        var doors = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Doors)
            .WhereElementIsNotElementType().OfType<FamilyInstance>().ToList();
        var covers = new List<(string Id, Solid Solid, BoundingBoxXYZ Box)>();
        foreach (var category in new[] { BuiltInCategory.OST_Roofs, BuiltInCategory.OST_Floors, BuiltInCategory.OST_Ceilings })
            foreach (var element in new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
                try
                {
                    var box = element.get_BoundingBox(null);
                    if (box is null) continue;
                    var geometry = element.get_Geometry(new Options { DetailLevel = ViewDetailLevel.Fine });
                    if (geometry is null) continue;
                    foreach (var solid in Solids(geometry)) covers.Add((element.UniqueId, solid, box));
                }
                catch (Exception ex) { errors.Add($"Area cover geometry {element.UniqueId}: {ex.Message}"); }
        var results = new List<object>();
        foreach (var room in rooms)
        {
            try
            {
                var box = room.get_BoundingBox(null);
                if (box is null) continue;
                var origin = ((LocationPoint)room.Location).Point;
                var z = origin.Z + UnitConverter.LengthToFeet(0.1);
                var step = UnitConverter.LengthToFeet(0.5);
                // Cap work for large spaces; each sample has the same cell area.
                step = Math.Max(step, Math.Sqrt(Math.Max(0, (box.Max.X - box.Min.X) * (box.Max.Y - box.Min.Y)) / 10000));
                var hitIds = new HashSet<string>();
                int samples = 0, covered = 0;
                for (double x = box.Min.X + step / 2; x < box.Max.X; x += step)
                    for (double y = box.Min.Y + step / 2; y < box.Max.Y; y += step)
                    {
                        var p = new XYZ(x, y, z);
                        if (!room.IsPointInRoom(p)) continue;
                        samples++;
                        using var ray = Line.CreateBound(p, p + XYZ.BasisZ * UnitConverter.LengthToFeet(100));
                        var nearest = double.PositiveInfinity;
                        string? hit = null;
                        foreach (var cover in covers)
                        {
                            if (x < cover.Box.Min.X || x > cover.Box.Max.X || y < cover.Box.Min.Y || y > cover.Box.Max.Y || cover.Box.Max.Z <= z) continue;
                            using var intersection = cover.Solid.IntersectWithCurve(ray, new SolidCurveIntersectionOptions());
                            if (intersection.SegmentCount == 0) continue;
                            var distance = intersection.GetCurveSegment(0).GetEndPoint(0).DistanceTo(p);
                            if (distance < nearest) { nearest = distance; hit = cover.Id; }
                        }
                        if (hit is not null) { covered++; hitIds.Add(hit); }
                    }
                var boundaryIds = new HashSet<string>();
                bool boundariesSupported = true;
                var loops = room.GetBoundarySegments(new SpatialElementBoundaryOptions());
                if (loops is null || loops.Count == 0) boundariesSupported = false;
                else foreach (var loop in loops)
                    foreach (var segment in loop)
                    {
                        var boundary = doc.GetElement(segment.ElementId);
                        if (boundary is null) { boundariesSupported = false; continue; }
                        boundaryIds.Add(boundary.UniqueId);
                        // Room separators, linked boundaries and railings do not prove enclosure.
                        if (boundary is not Wall) boundariesSupported = false;
                    }
                var connections = new List<object>();
                foreach (var door in doors)
                {
                    // Resolve at the room's phase, rather than the document's last phase.
                    var phase = doc.GetElement(room.get_Parameter(BuiltInParameter.ROOM_PHASE).AsElementId()) as Phase;
                    if (phase is null) continue;
                    var from = door.get_FromRoom(phase);
                    var to = door.get_ToRoom(phase);
                    if (from?.Id != room.Id && to?.Id != room.Id) continue;
                    var other = from?.Id == room.Id ? to : from;
                    connections.Add(new { doorUuid = door.UniqueId, targetRoomUuid = other?.UniqueId,
                        targetId = other is null ? null : ids.GetValueOrDefault(other.UniqueId),
                        relation = other is null ? "unresolved_or_exterior" : "door_adjacency" });
                }
                results.Add(new {
                    id = ids.GetValueOrDefault(room.UniqueId), uuid = room.UniqueId, name = room.Name,
                    phaseUuid = doc.GetElement(room.get_Parameter(BuiltInParameter.ROOM_PHASE).AsElementId())?.UniqueId,
                    // Sampling evidence is deliberately not asserted as an exact coverage boolean.
                    covered = Confirmed(room, "Covered"), enclosed = Confirmed(room, "Enclosed"),
                    connectedToIndoor = Confirmed(room, "ConnectedToIndoor"),
                    confirmationSource = "Optional BimDown_Area_* text parameters; geometry remains evidence",
                    coverEvidence = new { samples, coveredSamples = covered,
                        sampledCoverageRatio = samples == 0 ? (double?)null : (double)covered / samples,
                        coverUuids = hitIds.OrderBy(x => x), method = "uniform-XY-upward-solid-intersection",
                        sampleStepMetres = UnitConverter.Length(step), maxRayMetres = 100 },
                    enclosureEvidence = new { boundaryUuids = boundaryIds.OrderBy(x => x),
                        allBoundariesAreWalls = boundariesSupported,
                        status = "requires-wall-height-and-opening-review" },
                    connections,
                    reviewReasons = new[] { "Sampled cover is not exact area coverage", "Room boundary does not prove full-height enclosure",
                        "Door adjacency does not establish indoor use or traversability", "Host document only; links, design options and non-door openings require review" }
                });
            }
            catch (Exception ex) { errors.Add($"Area room {room.UniqueId}: {ex.Message}"); }
        }
        File.WriteAllText(Path.Combine(directory, "area_features.json"), JsonSerializer.Serialize(
            new { version = 1, units = "m", source = "Revit room evidence", rooms = results },
            new JsonSerializerOptions { WriteIndented = true }));
    }
}
