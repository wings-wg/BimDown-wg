# BimDown Revit Add-in

A Revit add-in for bidirectional BIM data exchange via CSV files. Export building elements to structured CSV tables, modify them externally, and import changes back into Revit with automatic diff-based synchronization.

## Features

### Export

Exports Revit model elements to CSV files organized by category:

| Category | Tables |
|----------|--------|
| Global | `level`, `grid` |
| Architecture | `wall`, `column`, `slab`, `space`, `door`, `window`, `stair`, `curtain_wall` |
| Structure | `structure_wall`, `structure_column`, `structure_slab`, `beam`, `brace`, `isolated_foundation`, `strip_foundation`, `raft_foundation` |
| MEP | `duct`, `pipe`, `cable_tray`, `conduit`, `mep_node`, `equipment`, `terminal` |

Each CSV uses `element.UniqueId` as the `id` field. Units are metric (meters, square meters, degrees).

### Import

Reads CSV files from a folder and performs a three-way diff against the current model:

- **Update** — CSV row `id` matches an existing element's UniqueId: parameters and geometry are updated
- **Create** — CSV row `id` not found in the model: a new element is created
- **Delete** — model element not present in any CSV row: element is deleted

**Supported element types (v1):** Level, Grid, Wall, Curtain Wall, Column, Slab, Space, Door, Window.

Each table is imported in a separate transaction, so a failure in one table does not affect others. Import order respects dependencies (levels before walls, walls before doors).

#### Type Auto-Creation

When importing elements that require specific family types (wall thickness, column profile, door/window dimensions), the importer automatically resolves or creates types:

- Searches for an existing type with matching parameters
- If not found, duplicates an existing type and modifies its parameters
- Naming convention: `BimDown_{dimension}` (e.g., `BimDown_200mm`, `BimDown_rect_400x400`, `BimDown_900x2100`)

#### Read-Only Fields

The following fields are computed by Revit and ignored during import:
`bbox_min_x/y/z`, `bbox_max_x/y/z`, `volume`, `area`, `length`, `height` (computed), `created_at`, `updated_at`, `material`.

### Batch Export

The `BatchExportApp` (registered as an `IExternalApplication`) supports headless batch export. Place a JSON config at `%TEMP%/bimdown-batch.json`:

```json
{"ModelPath": "C:\\path\\to\\model.rvt", "OutputDir": "C:\\output"}
```

Revit will export all tables on document open and terminate automatically.

## Project Structure

```
revit-addin/
├── ExportCommand.cs          # IExternalCommand for interactive CSV export
├── ImportCommand.cs          # IExternalCommand for interactive CSV import
├── BatchExportApp.cs         # IExternalApplication for headless batch export
├── CsvWriter.cs              # CSV serialization (with quote escaping)
├── CsvReader.cs              # CSV deserialization (symmetric with CsvWriter)
├── UnitConverter.cs           # Bidirectional unit conversion (metric ↔ Revit feet/radians)
├── GeometryUtils.cs           # Bounding box, polygon serialization/deserialization
├── Extractors/                # Field extractors for export (composable pipeline)
│   ├── IFieldExtractor.cs
│   ├── CompositeExtractor.cs
│   ├── ElementExtractor.cs    # Base fields: id, name, level_id, bbox, etc.
│   ├── LineElementExtractor.cs
│   ├── PointElementExtractor.cs
│   ├── PolygonElementExtractor.cs
│   ├── HostedElementExtractor.cs
│   ├── VerticalSpanExtractor.cs
│   ├── SectionProfileExtractor.cs
│   └── ...
├── Tables/                    # Table exporter definitions
│   ├── ITableExporter.cs
│   ├── TableExporter.cs       # Generic exporter using category + extractors
│   ├── GlobalTableExporters.cs
│   ├── ArchitectureTableExporters.cs
│   ├── StructureTableExporters.cs
│   └── MepTableExporters.cs
├── Import/                    # Import framework
│   ├── ITableImporter.cs      # Interface + ImportResult record
│   ├── TableImporterBase.cs   # Abstract base: collect → diff → dispatch
│   ├── DiffEngine.cs          # UniqueId-based three-way diff
│   ├── DiffResult.cs          # ToUpdate / ToCreate / ToDelete
│   ├── TypeResolver.cs        # Auto-create family types by dimension
│   ├── IdMap.cs               # Cross-table ID resolution for references
│   ├── GlobalImporters.cs     # Level, Grid importers
│   ├── ArchitectureImporters.cs # Wall, CurtainWall, Column, Slab, Space, Door, Window importers
│   ├── StructureImporters.cs  # Structure wall, column, slab, beam, brace, foundation importers
│   └── MepImporters.cs        # Duct, pipe, cable tray, conduit, equipment, terminal importers
├── BimDown.addin              # Revit add-in manifest
└── BimDown.RevitAddin.csproj
```

## Building

```bash
dotnet build BimDown.RevitAddin.csproj
# or specify Revit version:
dotnet build BimDown.RevitAddin.csproj -p:RevitVersion=2025
```

Requires the [Nice3point Revit API NuGet packages](https://github.com/Nice3point/RevitApi). Default target is Revit 2026 on .NET 8.

## 工程证据导出

在 Revit 附加模块的 BimDown 导出窗口勾选楼层、房间、结构板和门，正常导出 `.bimdown`。工程证据与网格选项独立。解压后可在根目录查看 `engineering_evidence.json`。每包生成独立的工程版本，和同包 `project_metadata.json` 中的 `engineering_revision` 匹配。每条观测带 BIMDown 的目录、表、短 ID 和 Revit UniqueId。

导出弹窗与证据里的 `roomExport` 会记录宿主建筑房间、已放置房间、正面积房间、CSV 记录、楼层绑定和有效轮廓的数量。未勾选房间、宿主没有建筑房间、房间未放置或没有正面积、缺楼层绑定及轮廓提取失败各有状态。链接实例和机电空间单独计数。模型核查的 **工程证据预检** 会显示该总览。

- **楼层**记录 Revit 标高、项目标高和相邻标高候选。等标高出现多条记录时保留配对待定。
- **房间**记录名称、编号、部门、Revit 房间面积和未约束高度。有效房间的完成面边界写入所属楼层的 `space.geojson`，保留单外环和内部洞口。坐标为 Revit 宿主模型内部 XY、单位为米。曲边记录为 Revit 折线近似。断开、自交、相触或多个独立外环的房间保留诊断。墙中线、产权套界和净高分析需单独核定。
- **结构板**记录板型、名义厚度、复合层功能及各型层厚度、结构材质层与可变层索引。实际施工类型、悬挑状态及有效结构层厚度需复核。
- **门**记录原导出参数中的名义尺寸、类型、开启操作和宿主标识。用途、开启角、测线及考虑门框和五金后的有效净宽需复核。

如需运行模型核查，在同一导出包内按证据契约补充经复核的 `measurements`、`applicability`，以及相应的 `clearHeightAreas`、`doorUses` 或 `spaceRelations`。逐对象保留量测口径和依据。模型重新导出后需复核记录与新版本是否对应。面积分摊的房间归属、受益范围和计入系数继续在项目配置中审核。 [工程证据契约](../spec/engineering_evidence.schema.yaml) · [导出开发清单](../research/BIMDown数据导出待开发.md)

## Installation

Copy `BimDown.addin` to `%AppData%\Autodesk\Revit\Addins\{version}\` and update the `<Assembly>` path to point to the built DLL.
