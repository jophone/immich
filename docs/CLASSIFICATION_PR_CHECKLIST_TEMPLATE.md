# 分类层级变更 PR 检查模板

> 用途：新增/调整分类（L1/L2/L3）时，作为 PR 描述的自检清单。

## 基本信息

- 变更类型：`新增` / `调整` / `重命名` / `删除`
- 涉及一级分类：
- 涉及二级分类：
- 是否影响历史标签解释：`是` / `否`

## 数据与映射同步

- [ ] `docs/ImageNet_Taxonomy.csv` 已更新
  - [ ] L1/L2 行已补齐
  - [ ] L3 标签格式为 `raw_en（中文）`
  - [ ] 同一行 L3 标签以全角逗号 `，` 分隔
- [ ] `docs/ImageNet_Taxonomy_v2.csv` 已更新
  - [ ] L1/L2 稳定 ID 已补齐
  - [ ] `zh/en` 命名已补齐且与产品文案一致
- [ ] `server/src/utils/category-taxonomy.ts` 已更新
  - [ ] `L1_RENAME_MAP` 已同步
  - [ ] `L2_RENAME_MAP` 已同步
  - [ ] 无遗漏映射导致回退到 `other/other_misc`

## 行为与兼容性

- [ ] 旧 `category`（三级）过滤路径不受影响
- [ ] 新 `categoryL1/categoryL2` 能正确扩展为 `categoryNames`
- [ ] `other/other_misc` 的“未映射标签”语义保持正确
- [ ] Explore 一级/二级联动展示正常

## 验证记录

- [ ] 单测通过：
  - [ ] `pnpm --filter immich exec vitest --config test/vitest.config.mjs --run src/utils/category-taxonomy.spec.ts src/services/search.service.spec.ts`
- [ ] 必要时 E2E 回归已补充/已通过（尤其是去重与未映射场景）
- [ ] 本地重启后验证通过（Explore / Search Filter 可见并可筛选）

## 风险与回滚

- 风险点：
- 回滚方式：
  - [ ] 回滚 `docs/ImageNet_Taxonomy.csv`
  - [ ] 回滚 `docs/ImageNet_Taxonomy_v2.csv`
  - [ ] 回滚 `server/src/utils/category-taxonomy.ts`

## 本次变更摘要（粘贴到 PR）

- 新增/调整 L1：
- 新增/调整 L2：
- 新增/调整 L3（数量）：
- 影响范围（Explore / Search Filter / API / 测试）：