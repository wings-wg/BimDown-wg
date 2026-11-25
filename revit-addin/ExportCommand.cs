using System.IO.Compression;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace BimDown.RevitAddin;

[Transaction(TransactionMode.Manual)]
public class ExportCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        var doc = commandData.Application.ActiveUIDocument.Document;

        using var settingsForm = new ExportSettingsForm();
        settingsForm.ShowDialog();

        if (!settingsForm.Result.Confirmed)
            return Result.Cancelled;

        var settings = settingsForm.Result;
        var tempDir = Path.Combine(Path.GetTempPath(), $"bimdown-export-{Guid.NewGuid():N}");

        try
        {
            Directory.CreateDirectory(tempDir);
            var (tableCount, errors, rooms) = ExportPipeline.RunExport(doc, settings, tempDir);

            // Pack to .bimdown zip
            if (File.Exists(settings.OutputFile))
                File.Delete(settings.OutputFile);
            ZipFile.CreateFromDirectory(tempDir, settings.OutputFile);

            var msg = $"Exported {tableCount} tables to:\n{settings.OutputFile}";
            if (rooms is not null)
            {
                msg += "\n\n" + L.S($"Rooms: {rooms.HostRooms} in host, {rooms.CsvRows} rows, {rooms.Footprints} footprints.",
                    $"房间：宿主模型 {rooms.HostRooms} 间，导出 {rooms.CsvRows} 条，楼层轮廓 {rooms.Footprints} 个。");
                msg += rooms.Status switch
                {
                    "disabled" => "\n" + L.S("The Rooms category was not selected.", "未勾选「房间」。"),
                    "no-host-rooms" => "\n" + L.S("There are no Rooms in the host model. Check linked models and MEP Spaces separately.",
                        "宿主模型没有建筑房间。请分别检查链接模型和机电空间。"),
                    "no-placed-rooms" or "no-positive-area" => "\n" + L.S("Check room placement and enclosure.", "请检查房间是否已放置且闭合。"),
                    "missing-level-scope" => "\n" + L.S("Check the Levels export option and the rooms’ assigned levels.",
                        "请检查是否勾选「楼层」，并核对房间所属楼层。"),
                    "no-csv-rows" or "no-footprints" or "partial" => "\n" + L.S("See roomExport and room observations in engineering_evidence.json.",
                        "请查看 engineering_evidence.json 中的 roomExport 和房间观测记录。"),
                    _ => ""
                };
            }
            if (errors.Count > 0)
                msg += $"\n\nWarnings ({errors.Count}):\n" + string.Join("\n", errors);

            Autodesk.Revit.UI.TaskDialog.Show("BimDown Export", msg);
        }
        finally
        {
            try { Directory.Delete(tempDir, true); } catch { }
        }

        return Result.Succeeded;
    }
}
