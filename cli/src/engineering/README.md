# Engineering MVP：首批契约闭环

当前确定性链路支持手工审核的标量核查、面积分摊计划和跨层空间投影叠合。尚无LLM转换、自动空间派生、通用工具图或Engineering批次的BIMDown模型加载。

构建后，从根目录执行：

```bash
node cli/dist/cli.js engineering-check research/benchmarks/scalar-input.json -o /tmp/engineering-report.json
```

输入为cases数组，每项包含rule和可选datum。示例包含有意不通过和无法判断的案例，因此命令写报告后退出码为1。全部通过才为0；输入契约异常也为1。

Rule声明id/version/reviewed、原文来源、适用条件、工程概念、单位、比较符和阈值。当前适用条件为审核文本，不自动判断对象适用性；调用方必须先筛选确认对象。候选规则reviewed=false不执行。仅支持>=、<=及m/m2，不支持例外表达式和任意代码。

Datum声明scope/table/id、concept、unit、value、source、modelVersion、confirmed。毫米/平方毫米可归一至米/平方米。concept必须精确匹配；存在数值但概念不同仍拒绝执行。confirmed是外部确认声明，系统不能自行证明其真实性。暂不支持从其他concept派生。

输出为pass/fail/indeterminate，诊断保留缺失、语义不匹配、待澄清或不支持原因；成功执行保留对象、数据来源、模型版本、规则/工具版本、原始及归一值。尚无模型哈希或完整证据图。

## 独立规则包与证据清单

```bash
node cli/dist/cli.js engineering-rule-set research/benchmarks/scalar-rule-set.json research/benchmarks/scalar-evidence-set.json
```

规则包的 `rules` 沿用标量规则，加上 `targetTable`。每个规则 ID 在规则包内唯一。证据清单声明 `modelVersion`，在 `targets` 中按 `scope/table/id` 列出对象、带来源的 `measurements`，以及绑定规则 ID 和版本的 `applicability` 确认记录。执行器按表筛选目标，按工程概念选用已确认的测量，同一份测量可以被多条规则引用。修改阈值、运算符或适用条件时应更新规则版本并复核对应的适用性记录。

只有确认适用且有匹配证据的对象才进行比较。已确认排除的对象记为 `not-applicable`。未审核规则、缺少适用性确认、缺少测量或表内无目标均记为 `indeterminate`。报告中的结果仅覆盖提供的对象清单，当前不自动证明整栋模型的覆盖完整性。报告含 `fail` 或 `indeterminate` 时退出码为 1。命令尚未从 Excel 生成规则或从 BIMDown 自动提取证据。

样例使用合成层高证据。3000 mm 在配置下限 3 m 时通过，净高证据不能替代建筑层高，屋面标高点有显式排除记录。下限改为 3.1 m 后，使用同一测量可得到不通过。数值用于验证配置行为，正式项目需审查规范版本、适用条件和取数口径。

## 面积分摊

```bash
node cli/dist/cli.js engineering-check research/benchmarks/allocation-input.json
```

在同一个 `cases` 数组中用 `tool: "area-allocation"` 提交面积用例。声明模型版本、`unit: "m2"` 和已确认的 `AreaInput`。坐标环使用米；每个分户须有显式面积分项。输入内节点和分项 ID 各自唯一，报告中的引用与该输入快照绑定。原有 `area-project` 仍可直接读取BIMDown项目。

计算状态为 `success`、`input-incomplete` 或 `failed`。报告记录工具版本、规则来源、模型版本、分项与分摊明细，以及建筑面积守恒残差和有限数值校验。输入摘要是对 `JSON.stringify(input)` 计算的SHA-256，复算需保留原始计划。批次全部通过或成功时退出码为0。

合成算例中，A的外环70 m²减去洞口10 m²得60 m²，B为40 m²。上级分摊池的10 m²和下级池的20 m²合计30 m²，按60:40分配后两户分别为78 m²和52 m²。合计130 m²。验证记录见 [STATUS](../../../research/STATUS.md)。

## 跨层空间投影叠合

```powershell
node cli/dist/cli.js engineering-check research/benchmarks/overlap-input.json -o overlap-report.json
```

在 `cases` 中使用 `tool: "space-overlap"`。规则沿用审核后的标量规则结构，`concept` 为 `space.projected-overlap-area`，规则单位为 `m2`。提交两个已确认的XY多边形，声明同一模型版本、共享平面坐标系和坐标单位 `m` 或 `mm`。对象引用使用楼层作为 `scope`，不同楼层允许相同的表内短ID。坐标环须闭合，首环为外环，其余为孔洞。

报告保留输入轮廓、对象、来源和以米为单位的交集 MultiPolygon，以及交叠面积和阈值。边或点接触的面积为0；缺少输入、未经确认或几何无效时返回 `indeterminate`。工具检查交叠面积有限且不超过任一输入轮廓面积，并使用规则指定的比较符直接比较阈值。算例的矩形交集为7.5 m²，扣除1 m²洞口得6.5 m²，高于合成上限5 m²，所以写出报告并返回退出码1。

调用方负责选择适用对象、确认楼层关系和对齐XY坐标。当前仅计算两轮廓的平面投影交集，尚未实现自动模型选取、楼层关系推断或三维碰撞核查。
