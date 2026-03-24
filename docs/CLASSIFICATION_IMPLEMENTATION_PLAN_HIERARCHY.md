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

### 3.1 三者职责与生效路径

- `docs/ImageNet_Taxonomy.csv`：**运行时主数据源**。服务端当前从该文件解析 `L1/L2 原始中文标签 + L3 原始标签`，并据此构建层级缓存（用于 Explore 与搜索筛选扩展）。
- `docs/ImageNet_Taxonomy_v2.csv`：**命名与 ID 规范资产**。用于定义稳定 `L1/L2 ID` 与 `zh/en` 显示名，作为 taxonomy 设计基准。
- `server/src/utils/category-taxonomy.ts`：**运行时硬编码映射层**。通过 `L1_RENAME_MAP` 与 `L2_RENAME_MAP` 将 `ImageNet_Taxonomy.csv` 中的原始中文分类名映射到稳定 ID 与中英文展示名。

> 当前实现下，`ImageNet_Taxonomy_v2.csv` 不是直接运行时输入；运行时是否生效由 `ImageNet_Taxonomy.csv + category-taxonomy.ts` 共同决定。

### 3.2 变更同步规则（必须同时更新）

新增或调整分类时，至少同步以下三处：

1. `docs/ImageNet_Taxonomy.csv`：补充对应 L1/L2 及三级原始标签列表。
2. `docs/ImageNet_Taxonomy_v2.csv`：补充/维护对应 L1/L2 的稳定 ID 与中英文命名。
3. `server/src/utils/category-taxonomy.ts`：补充 `L1_RENAME_MAP/L2_RENAME_MAP` 对应项。

若只改 CSV 但未改映射，运行时会回退到 `other/other_misc`；若只改 v2 而未改其余两处，前后端行为不会发生实际变化。

### 3.3 本次新增“人/宠物”落地说明

- 一级分类：`人/宠物` → `people_pets`
- 二级分类：
  - `人物主体` → `people_pets_people_subjects`
  - `宠物主体` → `people_pets_pet_subjects`
  - `人宠共现` → `people_pets_people_pet_copresence`
- 三级标签：已在 `ImageNet_Taxonomy.csv` 增加 26 个 raw 标签（人物主体 15、宠物主体 8、人宠共现 3），并在服务端硬编码映射中接入。

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
  - 同一资产写入两个同属某二级类别的三级标签（如 `tabby` 与 `tiger_cat`）。
  - 使用 `categoryL2` 过滤搜索时，结果中该资产只出现一次（去重回归保护）。

## 7. 后续优化（可选）

- 将 taxonomy 从 `docs/` 迁移为服务端运行时资源并纳入构建产物。
- 完成 OpenAPI/SDK 同步，使 `categoryL1/categoryL2` 在 SDK 中获得强类型支持。
- 增加按一级/二级的 suggestions 接口，统一与 location 级联交互模式。

## 8. PR 检查清单（新增/调整分类）

可直接复制模板：`docs/CLASSIFICATION_PR_CHECKLIST_TEMPLATE.md`

提交涉及分类层级的 PR 时，建议按下列顺序自检：

- [ ] `docs/ImageNet_Taxonomy.csv` 已更新：
  - [ ] 新增/调整的一级、二级分类已写入；
  - [ ] 三级标签使用可解析格式（`raw_en（中文）`），分隔符为全角逗号 `，`。
- [ ] `docs/ImageNet_Taxonomy_v2.csv` 已同步：
  - [ ] L1/L2 稳定 ID 已补充；
  - [ ] `zh/en` 命名与产品展示预期一致。
- [ ] `server/src/utils/category-taxonomy.ts` 已同步：
  - [ ] `L1_RENAME_MAP` 与 `L2_RENAME_MAP` 已补齐对应项；
  - [ ] 未出现遗漏导致回退 `other/other_misc`。
- [ ] 兼容性检查：
  - [ ] 旧 `category`（三级）过滤路径不受影响；
  - [ ] 新 `categoryL1/categoryL2` 过滤可正确扩展到 `categoryNames`。
- [ ] 测试与验证：
  - [ ] `pnpm --filter immich exec vitest --config test/vitest.config.mjs --run src/utils/category-taxonomy.spec.ts src/services/search.service.spec.ts` 通过；
  - [ ] 必要时补充/更新 E2E 用例（尤其是去重与未映射语义）。
- [ ] 运行方式验证：
  - [ ] 重启后端后，Explore 与 Search Filter 能看到新增分类；
  - [ ] 未映射标签仍正确归入“其他/未分类”。
