using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;

namespace BimDown.RevitAddin.Engineering;

internal sealed record ObjectRef(string Scope, string Table, string Id);
internal sealed record ExportObject(ObjectRef Object, string RevitUniqueId, Dictionary<string, string?> Row);

internal static class EngineeringEvidenceExporter
{
    const string Frame = "revit-host-internal-xy";
    static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    internal sealed record SourceRevision(string? VersionGuid, int? NumberOfSaves, bool HadUnsavedChanges);
    sealed record Observation(ObjectRef Object, string RevitUniqueId, object? ModelFacts, string[] ReviewRequired);
    sealed record RoomFeature(string Type, object Properties, object Geometry);
    internal sealed record RoomExportSummary(string Status, bool RoomTableRequested, bool LevelTableRequested,
        int HostRooms, int PlacedRooms, int RoomsWithPositiveArea, int CsvRows, int RowsWithLevel, int Footprints,
        int MepSpaces, int LinkInstances);

    internal static SourceRevision ReadSourceRevision(Document doc)
    {
        var modified = doc.IsModified;
        try
        {
            using var version = Document.GetDocumentVersion(doc);
            return version is null ? new(null, null, modified)
                : new(version.VersionGUID.ToString("D"), version.NumberOfSaves, modified);
        }
        catch (Autodesk.Revit.Exceptions.InvalidOperationException)
        {
            return new(null, null, modified);
        }
    }

    internal static RoomExportSummary Write(Document doc, string outputDir, string modelRevision, SourceRevision sourceRevision,
        IEnumerable<ExportObject> exported, bool roomTableRequested, bool levelTableRequested)
    {
        var objects = exported.ToList();
        // The same printed CSV elevations (not unrounded Revit levels) define pairing candidates.
        var byElevation = objects.Where(entry => entry.Object.Table == "level")
            .GroupBy(entry => Number(entry.Row, "elevation"))
            .Where(group => group.Key.HasValue)
            .OrderBy(group => group.Key)
            .Select(group => group.ToArray()).ToArray();
        var candidates = new Dictionary<string, (string? Lower, string? Upper)>();
        for (int i = 0; i < byElevation.Length; i++)
            if (byElevation[i].Length == 1)
                candidates[byElevation[i][0].Object.Id] = (
                    i > 0 && byElevation[i - 1].Length == 1 ? byElevation[i - 1][0].Object.Id : null,
                    i + 1 < byElevation.Length && byElevation[i + 1].Length == 1 ? byElevation[i + 1][0].Object.Id : null);

        var observations = new List<Observation>();
        var footprints = objects.Where(entry => entry.Object.Table == "space" && entry.Object.Scope != "global")
            .Select(entry => entry.Object.Scope).Distinct().ToDictionary(scope => scope, _ => new List<RoomFeature>());
        foreach (var entry in objects)
        {
            try
            {
                var element = doc.GetElement(entry.RevitUniqueId);
                observations.Add((entry.Object.Table, element) switch
                {
                    ("level", Level level) => LevelEvidence(entry, level, candidates.GetValueOrDefault(entry.Object.Id)),
                    ("space", Room room) => RoomEvidence(entry, room, footprints.GetValueOrDefault(entry.Object.Scope)),
                    ("structure_slab", Floor floor) => SlabEvidence(entry, floor),
                    ("door", FamilyInstance door) => DoorEvidence(entry, door),
                    _ => new(entry.Object, entry.RevitUniqueId, null, ["Revit object no longer resolves to the exported table."])
                });
            }
            catch (Exception ex)
            {
                observations.Add(new(entry.Object, entry.RevitUniqueId, null, [$"Revit evidence extraction failed: {ex.Message}"]));
            }
        }

        foreach (var (scope, features) in footprints)
            WriteJson(Path.Combine(outputDir, scope, "space.geojson"), new { type = "FeatureCollection", features });

        var rooms = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms)
            .WhereElementIsNotElementType().OfType<Room>().ToList();
        var placedRooms = rooms.Where(room => room.Location is LocationPoint).ToList();
        var positive = placedRooms.Count(room => room.Area > 0);
        var rows = objects.Count(entry => entry.Object.Table == "space");
        var rowsWithLevel = objects.Count(entry => entry.Object.Table == "space" && entry.Object.Scope != "global");
        var footprintCount = footprints.Values.Sum(features => features.Count);
        var status = !roomTableRequested ? "disabled"
            : rooms.Count == 0 ? "no-host-rooms"
            : placedRooms.Count == 0 ? "no-placed-rooms"
            : rows == 0 ? "no-csv-rows"
            : positive == 0 ? "no-positive-area"
            : rowsWithLevel == 0 ? "missing-level-scope"
            : footprintCount == 0 ? "no-footprints"
            : footprintCount < rooms.Count ? "partial"
            : "complete";
        var roomExport = new RoomExportSummary(status, roomTableRequested, levelTableRequested,
            rooms.Count, placedRooms.Count, positive, rows, rowsWithLevel, footprintCount,
            new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_MEPSpaces).WhereElementIsNotElementType().GetElementCount(),
            new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).GetElementCount());
        WriteJson(Path.Combine(outputDir, "engineering_evidence.json"), new
        {
            version = 1, modelRevision, sourceRevision, planarFrame = Frame,
            measurements = Array.Empty<object>(),
            applicability = Array.Empty<object>(),
            roomExport,
            observations
        });
        return roomExport;
    }

    static Observation LevelEvidence(ExportObject entry, Level level, (string? Lower, string? Upper) candidates) =>
        new(entry.Object, entry.RevitUniqueId, new
        {
            source = "Revit Level.Elevation and Level.ProjectElevation",
            exportedElevationM = Number(entry.Row, "elevation"),
            projectElevationM = UnitConverter.Length(level.ProjectElevation),
            candidateLowerLevelId = candidates.Lower, candidateUpperLevelId = candidates.Upper
        },
        ["Confirm level use, finished-floor elevation datum and the actual lower/upper level pairing."]);

    static Observation RoomEvidence(ExportObject entry, Room room, List<RoomFeature>? destination)
    {
        var review = new List<string>
        {
            "Confirm room use, the finished usable-floor boundary and the applicable rule.",
            "Provide reviewed minimum clear height and low-clearance area at the rule's height, including limiting surfaces."
        };
        var boundaryUids = new HashSet<string>();
        string? footprintPath = null;
        if (destination is null) review.Add("Missing exported level directory for room footprint.");
        else if (!(room.Area > 0)) review.Add("No positive Revit room area. Check if the room is placed and bounded.");
        else
        {
            try
            {
                var (polygon, tessellated) = ExtractRoomBoundary(room, boundaryUids);
                destination.Add(new("Feature", new
                {
                    id = entry.Object.Id, boundary_basis = "revit-room-finish", frame = Frame,
                    boundary_approximation = tessellated ? "revit-curve-tessellation" : "linear"
                }, new { type = "Polygon", coordinates = polygon }));
                footprintPath = $"{entry.Object.Scope}/space.geojson";
            }
            catch (Exception ex)
            {
                review.Add($"Room footprint unavailable: {ex.Message}");
            }
        }
        return new(entry.Object, entry.RevitUniqueId, new
        {
            name = room.Name, number = room.Number,
            department = room.get_Parameter(BuiltInParameter.ROOM_DEPARTMENT)?.AsString(),
            source = "Revit Room.Area, Room.UnboundedHeight and room Finish boundary",
            revitRoomAreaM2 = room.Area * UnitConverter.Length(1) * UnitConverter.Length(1),
            revitUnboundedHeightM = UnitConverter.Length(room.UnboundedHeight),
            footprintPath,
            boundaryRevitUniqueIds = boundaryUids.OrderBy(id => id, StringComparer.Ordinal)
        }, [.. review]);
    }

    static (double[][][] Polygon, bool Tessellated) ExtractRoomBoundary(Room room, HashSet<string> boundaryUids)
    {
        using var options = new SpatialElementBoundaryOptions
        {
            SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
        };
        var segments = room.GetBoundarySegments(options);
        if (segments is null) throw new ArgumentException("No Revit room boundary.");
        var loops = new List<List<PlanPoint>>();
        var tessellated = false;
        foreach (var loop in segments)
        {
            var points = new List<PlanPoint>();
            foreach (var segment in loop)
            {
                var element = room.Document.GetElement(segment.ElementId);
                if (element is not null) boundaryUids.Add(element.UniqueId);
                using var curve = segment.GetCurve();
                tessellated |= curve is not Line;
                var vertices = curve.Tessellate().Select(p => new PlanPoint(
                    Math.Round(UnitConverter.Length(p.X), 6), Math.Round(UnitConverter.Length(p.Y), 6))).ToArray();
                if (vertices.Length < 2) throw new ArgumentException("Boundary curve has no usable XY segment.");
                if (points.Count > 0 && !RoomFootprint.Near(points[^1], vertices[0]))
                    throw new ArgumentException("Boundary segments are disconnected in XY.");
                foreach (var point in vertices)
                    if (points.Count == 0 || !RoomFootprint.Near(points[^1], point)) points.Add(point);
            }
            if (points.Count < 4 || !RoomFootprint.Near(points[0], points[^1]))
                throw new ArgumentException("Room boundary loop is open or degenerate in XY.");
            points.RemoveAt(points.Count - 1);
            loops.Add(points);
        }
        return (RoomFootprint.Polygon(loops), tessellated);
    }

    static Observation SlabEvidence(ExportObject entry, Floor floor)
    {
        var floorType = floor.Document.GetElement(floor.GetTypeId()) as FloorType;
        using var compound = floorType?.GetCompoundStructure();
        var layers = compound?.GetLayers().Select(layer => new
        {
            function = layer.Function.ToString(),
            typeLayerWidthM = UnitConverter.Length(layer.Width)
        }).ToArray();
        return new(entry.Object, entry.RevitUniqueId, new
        {
            source = "Revit floor type compound structure and exported nominal floor thickness",
            typeName = floorType?.Name, typeRevitUniqueId = floorType?.UniqueId,
            nominalThicknessM = Number(entry.Row, "thickness"),
            structuralMaterialIndex = compound?.StructuralMaterialIndex,
            variableLayerIndex = compound?.VariableLayerIndex,
            layers
        }, ["Confirm construction type, cast-in-place solid and cantilever status, and measure effective structural thickness."]);
    }

    static Observation DoorEvidence(ExportObject entry, FamilyInstance door) =>
        new(entry.Object, entry.RevitUniqueId, new
        {
            source = "Revit door exporter parameters",
            typeName = door.Symbol?.Name, hostRevitUniqueId = door.Host?.UniqueId,
            nominalWidthM = Number(entry.Row, "width"), nominalHeightM = Number(entry.Row, "height"),
            operation = entry.Row.GetValueOrDefault("operation")
        }, ["Confirm door use and effective clear passage at the reviewed leaf angle and measurement line, accounting for frame and hardware."]);

    static double? Number(Dictionary<string, string?> row, string key) =>
        double.TryParse(row.GetValueOrDefault(key), NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
        && double.IsFinite(value) ? value : null;

    static void WriteJson(string path, object value)
    {
        using var stream = File.Create(path);
        JsonSerializer.Serialize(stream, value, JsonOptions);
    }
}
