# 照片分类层级化实现方案（一级/二级展示）

## 1. 目标

在保持三级原始标签（YOLO 输出）可追溯的前提下，将 Explore 与搜索筛选升级为层级分类体验：

- Explore：先展示一级分类，点击后展开二级分类。
- Search Filter：支持一级与二级分类过滤。
- 详情页：继续展示原始三级标签与置信度。

## 2. 实施原则

- **读时映射**：数据库继续保存原始 `categoryName`，不改写历史分类结果。
- **兼容优先**：保留原有 `category`（三级）过滤能力，新增 `categoryL1/categoryL2`。
- **多语言显示**：分类映射同时提供 `zh/en`，Web 依据系统语言选择展示文本。
- **未命中兜底**：映射不到 taxonomy 的标签统一归入 `other/other_misc`。

## 3. 数据与映射资产

- 原始映射源：`docs/ImageNet_Taxonomy.csv`（三级标签来源）。
- 优化命名资产：`docs/ImageNet_Taxonomy_v2.csv`（一级/二级命名与稳定 ID）。
- 服务端映射逻辑：`server/src/utils/category-taxonomy.ts`。

## 4. 后端改造点

### 4.1 分类摘要增强

- 文件：`server/src/services/classification.service.ts`
- 能力：`GET /categories` 在原 `categoryName/count` 基础上，补充：
  - `categoryL1Id/categoryL1NameZh/categoryL1NameEn`
  - `categoryL2Id/categoryL2NameZh/categoryL2NameEn`
  - `categoryNameZh`（可选）

### 4.2 搜索过滤扩展

- 文件：`server/src/dtos/search.dto.ts`
- 新增字段：`categoryL1?: string`、`categoryL2?: string`

- 文件：`server/src/services/search.service.ts`
- 逻辑：当存在 `categoryL1/categoryL2` 且无 `category` 时，将层级过滤扩展为原始三级标签数组（`categoryNames`）。

- 文件：`server/src/repositories/search.repository.ts`
- 新增搜索选项：`categoryNames?: string[]`

- 文件：`server/src/utils/database.ts`
- 查询层支持 `categoryNames`：
  - 使用 `EXISTS` 子查询进行分类过滤，避免同一资产因命中多个三级标签而重复返回。
  - `other/other_misc` 支持“未映射标签”语义（匹配不在 taxonomy 已知集合中的原始三级标签）。
  - 兼容非空数组 `IN (...)` 与空数组短路 `false` 语义。

### 4.3 Explore 层级输出

- 文件：`server/src/services/search.service.ts`
- 输出从单层 `category` 升级为：
  - `fieldName: 'categoryL1'`
  - `fieldName: 'categoryL2'`（包含 `parentValue`）

- 文件：`server/src/dtos/search.dto.ts`
- `SearchExploreItem` 扩展可选字段：`labelZh/labelEn/parentValue/parentLabelZh/parentLabelEn`

## 5. 前端改造点

### 5.1 Explore 页面

- 文件：`web/src/routes/(user)/explore/+page.svelte`
- 改造：
  - 展示一级分类卡片并维护选中态。
  - 基于选中一级分类显示二级分类卡片。
  - 二级分类点击跳转搜索（携带 `categoryL1/categoryL2`）。

### 5.2 Search Filter Modal

- 文件：`web/src/lib/modals/SearchFilterModal.svelte`
- 改造：
  - `SearchFilter` 新增 `categoryL1/categoryL2`。
  - 初始化、重置、提交流程透传新字段。

- 文件：`web/src/lib/components/shared-components/search-bar/search-category-section.svelte`
- 改造：
  - 从 `getCategorySummaries()` 获取聚合源。
  - 一级/二级双 `Combobox`，二级随一级联动。
  - 根据系统语言展示中文或英文标签。

### 5.3 搜索结果页

- 文件：`web/src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte`
- 改造：搜索参数类型与 chips 展示支持 `categoryL1/categoryL2`。

## 6. 验证计划

### 6.1 服务端单测

- `pnpm --filter immich run test -- --run src/services/search.service.spec.ts`
- `pnpm --filter immich run test -- --run src/services/classification.service.spec.ts`

### 6.2 Web 类型检查

- `pnpm --filter immich-web run check:svelte`

### 6.3 手工验收

- Explore 显示一级分类，点击后仅展示该一级下的二级分类。
- Search Filter 可选择一级/二级并生效。
- 详情页仍显示原始三级标签。
- 未映射标签在 Explore/Filter 中归入“其他/未分类”。

### 6.4 E2E 回归（防重复）

- 文件：`e2e/src/specs/server/api/search.e2e-spec.ts`
- 用例：`should not return duplicate assets when category hierarchy matches multiple raw categories of the same asset`
- 覆盖点：
  - 同一资产写入两个同属某二级类别的三级标签（如 `tabby_cat` 与 `tiger_cat`）。
  - 使用 `categoryL2` 过滤搜索时，结果中该资产只出现一次（去重回归保护）。

## 7. 后续优化（可选）

- 将 taxonomy 从 `docs/` 迁移为服务端运行时资源并纳入构建产物。
- 完成 OpenAPI/SDK 同步，使 `categoryL1/categoryL2` 在 SDK 中获得强类型支持。
- 增加按一级/二级的 suggestions 接口，统一与 location 级联交互模式。
