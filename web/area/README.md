# BimEditor 面积测算与分摊

面积侧栏运行在本地 BimEditor 实例中。用户从二维模型选取房间，也可以导入原有的 `project-config.json`。计算在浏览器中复用 CLI 的 [模型证据绑定](../../cli/src/area/project-input.ts) 和 [面积算法](../../cli/src/area/index.ts)。原版编辑器的模型打开、二维和三维功能由上游提供。

## 启动

在 BimDown 仓库根目录执行。已有 `.bimeditor-local` 时跳过克隆与切换版本。使用 Node.js 24 运行。

```powershell
git clone https://github.com/NovaShang/BimEditor.git .bimeditor-local
git -C .bimeditor-local checkout --detach f0c2e2386bce098484026ac093c3f30f7b95b3b3
npm --prefix .bimeditor-local install
node web/area/setup.mjs
npm --prefix .bimeditor-local run dev --workspace=app
```

用 Chrome 或 Edge 打开终端提示的本地地址，默认是 `http://localhost:5174`。更新面积侧栏或共享算法后，再运行一次 `node web/area/setup.mjs`。该命令将跟踪的集成源码复制到忽略的本地上游检出目录。生产构建使用 `npm --prefix .bimeditor-local run build --workspace=app`。

## 使用

1. 在首页打开本地项目目录、Revit 导出的 `.bimdown` 包或 `.zip` 包。先试运行时，可使用首页的样例入口。
2. 打开右上角的 **面积测算与分摊**。样例点 **读取项目配置**，实际项目可以导入配置，或在二维图中选择一个房间并填写建筑 ID、归属、计入系数和边界依据，再点 **加入所选房间**。
3. 为共有池设置接收节点和分摊方法。等份与自身计入面积比例可在表单录入。显式权重、补充测量分项、多种计入部位、自动系数条件与独立幢总量可在 **配置 JSON** 中维护。
4. 核对规则来源、轮廓边界、归属和分摊范围，勾选审核确认并运行测算。样例应显示套内 80 m²、分摊 20 m²、合计 100 m²。点击结果中的模型分项可定位房间。下载的配置与报告使用 CLI 格式。

测算支持现有 `area-project` 契约中的 BIMDown GeoJSON v2 及其单位。几何文件、测算配置与报告保留在本地浏览器或用户选择的本地位置。实际项目的边界、共有归属和计入系数仍由审核人确认。
