using System.IO.Compression;
using System.Text.Json;
using Autodesk.Revit.DB;
using BimDown.RevitAddin;
using Nice3point.TUnit.Revit;

namespace BimDown.RevitTests;

public class EngineeringExportTests : RevitApiTest
{
    [Test]
    public async Task Export_ReportsNoHostRoomsWhenRoomCategoryIsEnabled()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        var directory = Directory.CreateTempSubdirectory("bimdown-no-rooms-");
        try
        {
            var (_, errors, rooms) = ExportPipeline.RunExport(doc, new ExportSettings
            {
                EnabledTables = ["level", "space"], ExportMesh = false, WriteIdsToModel = false
            }, directory.FullName);
            await Assert.That(errors.Count).IsEqualTo(0);
            await Assert.That(rooms!.RoomTableRequested).IsTrue();
            await Assert.That(rooms.Status).IsEqualTo("no-host-rooms");
        }
        finally
        {
            doc.Close(false);
            directory.Delete(true);
        }
    }

    [Test]
    public async Task Export_RecordsRoomFootprintWithHoleAndKeepsReviewPending()
    {
        var doc = RevitTestHelper.CreateTempDocument(Application);
        var directory = Directory.CreateTempSubdirectory("bimdown-engineering-");
        var archive = Path.Combine(directory.FullName, "export.bimdown");
        var model = directory.CreateSubdirectory("model");
        try
        {
            var level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
                .OrderBy(item => item.Elevation).First();
            var planType = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                .First(type => type.ViewFamily == ViewFamily.FloorPlan);
            string roomUid;
            using (var tx = new Transaction(doc, "Create bounded test room"))
            {
                tx.Start();
                var view = ViewPlan.Create(doc, planType.Id, level.Id);
                var sketch = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, level.Elevation)));
                doc.Create.NewRoomBoundaryLines(sketch, Rectangle(0, 0, 10, 10, level.Elevation), view);
                doc.Create.NewRoomBoundaryLines(sketch, Rectangle(2, 2, 4, 4, level.Elevation), view);
                doc.Regenerate();
                roomUid = doc.Create.NewRoom(level, new UV(1, 1)).UniqueId;
                tx.Commit();
            }

            var (_, errors, roomExport) = ExportPipeline.RunExport(doc, new ExportSettings
            {
                EnabledTables = ["level", "space"], ExportMesh = false, WriteIdsToModel = false
            }, model.FullName);
            if (errors.Count > 0) throw new InvalidOperationException(string.Join(Environment.NewLine, errors));
            using var metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(model.FullName, "project_metadata.json")));
            using var evidence = JsonDocument.Parse(File.ReadAllText(Path.Combine(model.FullName, "engineering_evidence.json")));
            var root = evidence.RootElement;
            await Assert.That(root.GetProperty("modelRevision").GetString())
                .IsEqualTo(metadata.RootElement.GetProperty("engineering_revision").GetString());
            await Assert.That(root.GetProperty("measurements").GetArrayLength()).IsEqualTo(0);
            await Assert.That(root.GetProperty("applicability").GetArrayLength()).IsEqualTo(0);
            await Assert.That(roomExport!.Status).IsEqualTo("complete");
            await Assert.That(root.GetProperty("roomExport").GetProperty("footprints").GetInt32()).IsEqualTo(1);
            var room = root.GetProperty("observations").EnumerateArray()
                .Single(item => item.GetProperty("revitUniqueId").GetString() == roomUid);
            var scope = room.GetProperty("object").GetProperty("scope").GetString()!;
            var id = room.GetProperty("object").GetProperty("id").GetString();
            ZipFile.CreateFromDirectory(model.FullName, archive);
            using var package = ZipFile.OpenRead(archive);
            using var geometry = JsonDocument.Parse(package.GetEntry($"{scope}/space.geojson")!.Open());
            var feature = geometry.RootElement.GetProperty("features").EnumerateArray().Single();
            await Assert.That(feature.GetProperty("properties").GetProperty("id").GetString()).IsEqualTo(id);
            await Assert.That(feature.GetProperty("geometry").GetProperty("coordinates").GetArrayLength()).IsEqualTo(2);

            var (_, withoutRoomsErrors, disabled) = ExportPipeline.RunExport(doc, new ExportSettings
            {
                EnabledTables = ["level"], ExportMesh = false, WriteIdsToModel = false
            }, directory.CreateSubdirectory("without-rooms").FullName);
            await Assert.That(withoutRoomsErrors.Count).IsEqualTo(0);
            await Assert.That(disabled!.Status).IsEqualTo("disabled");
            await Assert.That(disabled.HostRooms).IsEqualTo(1);
            await Assert.That(disabled.CsvRows).IsEqualTo(0);
        }
        finally
        {
            doc.Close(false);
            directory.Delete(true);
        }
    }

    [Test]
    [Explicit]
    [Arguments("Snowdon Towers Sample Architectural.rvt", "space")]
    [Arguments("Snowdon Towers Sample Structural.rvt", "structure_slab")]
    public async Task Export_InstalledSampleBindsEvidenceToCsv(string fileName, string expectedTable)
    {
        var samples = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Autodesk", $"Revit {Application.VersionNumber}", "Samples");
        var doc = Application.OpenDocumentFile(Path.Combine(samples, fileName));
        var directory = Directory.CreateTempSubdirectory("bimdown-sample-evidence-");
        try
        {
            var (_, errors, _) = ExportPipeline.RunExport(doc, new ExportSettings
            {
                EnabledTables = ["level", "space", "door", "structure_slab"], ExportMesh = false, WriteIdsToModel = false
            }, directory.FullName);
            if (errors.Count > 0) throw new InvalidOperationException(string.Join(Environment.NewLine, errors));
            using var evidence = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory.FullName, "engineering_evidence.json")));
            using var metadata = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory.FullName, "project_metadata.json")));
            var root = evidence.RootElement;
            await Assert.That(root.GetProperty("modelRevision").GetString())
                .IsEqualTo(metadata.RootElement.GetProperty("engineering_revision").GetString());
            var objects = root.GetProperty("observations").EnumerateArray().ToArray();
            await Assert.That(objects.Count(item => item.GetProperty("object").GetProperty("table").GetString() == expectedTable))
                .IsGreaterThan(0);
            var byTable = objects.GroupBy(item => item.GetProperty("object").GetProperty("table").GetString());
            foreach (var table in byTable)
                foreach (var scope in table.GroupBy(item => item.GetProperty("object").GetProperty("scope").GetString()!))
                {
                    var (_, rows) = CsvReader.Read(Path.Combine(directory.FullName, scope.Key, $"{table.Key}.csv"));
                    var observedIds = scope.Select(item => item.GetProperty("object").GetProperty("id").GetString()).ToHashSet();
                    await Assert.That(observedIds.SetEquals(rows.Select(row => row["id"]))).IsTrue();
                }
            if (expectedTable == "space")
                await Assert.That(Directory.GetFiles(directory.FullName, "space.geojson", SearchOption.AllDirectories)
                    .Any(path => File.ReadAllText(path).Contains("\"boundary_basis\""))).IsTrue();
        }
        finally
        {
            doc.Close(false);
            directory.Delete(true);
        }
    }

    static CurveArray Rectangle(double x1, double y1, double x2, double y2, double z)
    {
        XYZ[] points = [new(x1, y1, z), new(x2, y1, z), new(x2, y2, z), new(x1, y2, z)];
        var curves = new CurveArray();
        for (var i = 0; i < points.Length; i++)
            curves.Append(Line.CreateBound(points[i], points[(i + 1) % points.Length]));
        return curves;
    }
}
