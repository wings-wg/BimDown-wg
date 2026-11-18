# 面积测算与分摊

`bimdown area-calculate area-input.json -o area-report.json`

输入示例：仓库 `sample_data/area-example/area-input.json`。输出101户套内90、分摊18、合计108平方米；102户套内110、分摊22、合计132平方米。

这是显式、经人工确认的数据计算模块。规则整理来源为用户提供的《建筑面积分摊》材料第2—6页；不宣称验证了规范现行效力。不会自动从房间名称推断产权、协议、功能区或适用标准。可把输入文件放在解压后的BIMDown项目内，使用模型构件ID作为部位ID或记录在source中；当前命令不自动读取压缩包或Revit模型。

## 输入

- version固定1，confirmed必须true，ruleSource记录审核后的依据。
- 所有输入面积为平方米，rings坐标为米；不随项目元数据自动换算。
- nodes：unit为户，pool为共有面积分摊池，excluded为计入总面积但不参与分摊的独立空间。building为幢ID。
- parts：每个部位只能属于一个节点。kind为usable/wall/balcony/common/excluded；area与rings必须二选一。factor为0、0.5、1，source记录边界、墙体归属或审核依据。公共墙分别记账时，应明确两侧份额，避免遗漏或重复。
- rings：闭合XY多边形，首环为外环，其余为孔洞，方向不限；使用鞋带公式。调用方必须保证轮廓简单、孔洞在外环内且互不重叠；本版本不做自交、重叠或空间覆盖检查。复杂斜墙/弧墙应先按审核规则生成测算边界，不直接使用三维表面积。
- groups：每个pool恰好有一条分摊规则；recipients可为户或下级pool，必须同幢，无循环。
- method=area：权重为接收节点basis（如显式确认的功能区相关面积），缺省为该节点自身计入面积。不会自动推导下级户的面积总和。method=equal为等份；weights使用每个recipient的显式非负weight，可表达协议分配。
- 分摊按依赖顺序执行，上级分配额加到下级pool自身面积后继续分配。户最终面积为自身计入面积加收到的全部分摊额。
- buildingTotals可提供独立核定的幢总面积；与部位计入面积总和不一致时拒绝计算，容差0.000001平方米。

## 输出及边界

JSON包含units、parts、allocations、buildings，保留原始精度及规则来源。allocations包含每一步权重、系数和金额；buildings校验计入总量=最终分户面积+排除面积。不要逐行四舍五入后当作正式成果；本版本未定义法规取位及尾差分配，不输出法定精度表。

同一部位使用不同ID重复输入无法仅靠ID校验识别；分摊服务范围、独立单元、垂直通道分层和协议效力需人工确认。配置confirmed不代替这些业务审核。自动Revit边界提取、平面标注、图形审核、正式测绘报表均属于后续集成工作。

## 自动计入系数

part.factor 可设为 `"auto"`，并提供 features。结果包含解析后的数值 factor、factorMode 和 factorDecision（规则编号、原因）。证据不完整时拒绝整个计算，不默认取0。原来的数字factor保持人工模式兼容。

```json
{
  "id": "balcony-101", "owner": "101", "kind": "balcony",
  "area": 20, "factor": "auto", "source": "审核后的模型特征",
  "features": {
    "type": "balcony", "permanent": true, "height": 2.2,
    "variableHeight": false, "publicPassage": false,
    "enclosed": false, "connectedToIndoor": true
  }
}
```

上述示例自动得出0.5，计入10平方米。支持room（有盖封闭）、balcony（封闭/开放/不相通）、outdoor_stair（广场式/有盖/无盖）、skywalk（封闭/开放/无盖）、wall（公共/私有墙归属）。墙的0.5是面积归属比例，不是建筑形态合规判定。

非墙部位需明确publicPassage分类；普通路径还需明确variableHeight=false、适用高度和永久性。height为按条款确认的适用高度，不能直接用任意包围盒高度代替。变高度部位需先拆分；当前不自动截取斜屋顶。source记录特征来源，但程序不能验证其真实性。形态特征需由调用方提供，尚未实现从Revit/GLB自动识别顶盖、围护及连通性。材料中模糊或未覆盖的走廊、雨棚等不自动判定。inferAreaFactor可单独调用，返回indeterminate用于待审队列。当前规则集固定对应用户材料，不代表项目所在地现行标准。

## 从 BIMDown 自动测算并分摊

```bash
bimdown area-project ./project.bimdown -c project-config.json -o report.json
bimdown area-project ./project-directory -c project-config.json -o report.json
```

可运行示例：`sample_data/area-example/model` 与 `sample_data/area-example/project-config.json`。示例自动从Polygon得到80平方米，系数1，分摊20，总计100。

配置沿用nodes/groups/buildingTotals；selections代替手工填写面积，指定id、owner、level、table、elementId、kind、factor、source及可选features。每个选择从`level/table.geojson`查找唯一匹配ID的Polygon，XY投影并按project_metadata.json的m/mm/ft/in转换为米。支持孔洞。需要确认这些轮廓符合测算边界要求；普通space轮廓不自动等于套内产权面积。二维轮廓以外的墙体面积等可通过parts补充（始终平方米）。同一模型轮廓禁止重复选择；不同轮廓之间仍需人工检查空间重叠。

factor=auto调用已有规则。若根目录存在area_features.json，仅导入匹配房间ID的明确布尔covered/enclosed/connectedToIndoor；不会从采样覆盖率或墙边界推断确认值。显式features优先。其余适用条件需要配置提供，缺失时拒绝出具结果。报告包含modelSources，保留模型几何路径及识别证据。未选择的模型对象不会自动参与面积总量；buildingTotals应填写独立审核总量以检查遗漏。

仅支持format_version=2的GeoJSON输入。压缩包在内存读取，不解压、不修改原模型。输入应为可信项目文件；当前没有为超大压缩包实现资源配额。未实现自动识别户界、用途、分摊服务范围、精确顶盖覆盖和闭合围护；本入口自动执行的是“模型轮廓测算→已确认特征系数→配置分摊”，不是无配置的法定房产测绘。
