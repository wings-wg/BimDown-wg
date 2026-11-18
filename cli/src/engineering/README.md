# Engineering MVP：首批契约闭环

这是C1/C2/C3的最小确定性增量，不是完整首版MVP。提供手工审核规则、标量数据契约诊断、单位归一化、阈值判断及证据记录。尚无LLM转换、自动空间派生、通用工具图或完整模型加载集成。

构建后，从根目录执行：

```bash
node cli/dist/cli.js engineering-check research/benchmarks/scalar-input.json -o /tmp/engineering-report.json
```

输入为cases数组，每项包含rule和可选datum。示例包含有意不通过和无法判断的案例，因此命令写报告后退出码为1。全部通过才为0；输入契约异常也为1。

Rule声明id/version/reviewed、原文来源、适用条件、工程概念、单位、比较符和阈值。当前适用条件为审核文本，不自动判断对象适用性；调用方必须先筛选确认对象。候选规则reviewed=false不执行。仅支持>=、<=及m/m2，不支持例外表达式和任意代码。

Datum声明scope/table/id、concept、unit、value、source、modelVersion、confirmed。毫米/平方毫米可归一至米/平方米。concept必须精确匹配；存在数值但概念不同仍拒绝执行。confirmed是外部确认声明，系统不能自行证明其真实性。暂不支持从其他concept派生。

输出为pass/fail/indeterminate，诊断保留缺失、语义不匹配、待澄清或不支持原因；成功执行保留对象、数据来源、模型版本、规则/工具版本、原始及归一值。尚无模型哈希或完整证据图。

验证：Node原生执行合成基准及异常检查通过；npm依赖安装因ENOTFOUND失败，完整构建、CLI命令与Vitest尚未执行。合成阈值不是经核实的规范限值。后续按research/ROADMAP.md扩展Rule schema、数据目录、工具契约与真实BIMDown绑定。
