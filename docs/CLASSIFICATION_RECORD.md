# 照片自动分类功能实现记录

## Phase 1 & Phase 2 代码变更总结

---

### Phase 1: ML 服务 — `POST /classify` 端点

**修改文件**: `machine-learning/immich_ml/main.py`

#### 核心设计

复用已有 CLIP visual/textual encoder 实现零样本图像分类，**不引入任何新模型或新依赖**。

#### 新增内容（按顺序）

| 行号区间 | 内容 | 说明 |
|----------|------|------|
| 13, 17 | `import numpy as np` / `from numpy.typing import NDArray` | 新增导入，用于 embedding 计算 |
| 43-51 | `DEFAULT_CATEGORIES` (30个) + `SOFTMAX_TEMPERATURE = 100.0` | 模块级常量 |
| 58 | `_text_embedding_cache: dict[tuple[str, str], NDArray]` | 文本 embedding 缓存，key = `(model_name, category)` |
| 208-232 | `classify()` 端点 | 编排层，调用下面 4 个函数 |
| 235-244 | `_parse_categories()` | 输入校验：解析 JSON、校验非空、返回 `list[str]` |
| 247-251 | `_get_image_embedding()` | 加载 CLIP visual encoder → 推理 → 反序列化为 numpy |
| 254-269 | `_get_text_embeddings()` | 加载 CLIP textual encoder → 带缓存的批量文本推理 |
| 272-281 | `_cosine_softmax()` | 纯函数：余弦相似度 → temperature scaling → softmax |

#### 请求/响应格式

```
POST /classify  (multipart/form-data)
├── image: bytes          (必填)
├── model_name: str       (默认 "ViT-B-32__openai")
├── categories: str|null  (JSON 数组，默认 DEFAULT_CATEGORIES)
├── min_score: float      (默认 0.15)
└── max_results: int      (默认 5)

Response: {"classification": [{"categoryName": "landscape", "confidence": 0.85}, ...]}
```

#### 关键实现细节

1. **模型复用**: 通过 `model_cache.get(model_name, ModelType.VISUAL, ModelTask.SEARCH)` 获取与 `/predict` 完全相同的 CLIP 模型实例
2. **Embedding 反序列化**: CLIP encoder 返回 `serialize_np_array()` 的 JSON 字符串，用 `np.array(orjson.loads(...))` 转回 numpy
3. **文本缓存**: `_text_embedding_cache` 是模块级 dict，首次请求后 30 个类别的文本 embedding 被缓存，后续请求只需做一次图像推理
4. **Softmax temperature=100**: CLIP 原始相似度范围很窄（通常 0.15-0.35），temperature 放大差异使概率分布更有区分度

#### 后续替换算法时的改动点

只需修改 `classify()` 函数体——把 CLIP 调用换成新的分类模型调用，保持返回格式 `{"classification": [{categoryName, confidence}]}` 不变。

---

### Phase 2: 数据库 — 新表 + 迁移

#### 2a. 新建表定义

**新文件**: `server/src/schema/tables/asset-category.table.ts`

```
asset_categories
├── id: uuid (PK, auto-generated)
├── assetId: uuid (FK → asset.id, CASCADE DELETE/UPDATE)
├── categoryName: text
└── confidence: real
```

对标 `asset-ocr.table.ts`。不需要 `isVisible`、`createdAt`、`updatedAt` 等列——分类结果是整体替换语义（delete + insert），不做增量更新。

#### 2b. job status 表新增列

**修改文件**: `server/src/schema/tables/asset-job-status.table.ts`

在 `ocrAt` 之后新增 `classifiedAt: Timestamp | null`，用于标记资产是否已完成分类（`NULL` = 待分类）。

#### 2c. Schema 注册

**修改文件**: `server/src/schema/index.ts`

三处变更（均按字母序插入）：
- 导入 `AssetCategoryTable`
- 加入 `tables` 数组
- 加入 `DB` 接口

#### 2d. 迁移文件

**新文件**: `server/src/schema/migrations/1773301586574-CreateAssetCategories.ts`

`up()` 包含 6 条 SQL：

| # | SQL | 用途 |
|---|-----|------|
| 1 | `CREATE TABLE "asset_categories" (...)` | 建表 |
| 2 | `ADD CONSTRAINT ... PRIMARY KEY` | 主键 |
| 3 | `ADD CONSTRAINT ... FOREIGN KEY` | 外键(CASCADE) |
| 4 | `CREATE INDEX ... ("assetId")` | 按资产查询索引 |
| 5 | `CREATE INDEX ... ("categoryName")` | 按分类名查询索引（Explore 页面用） |
| 6 | `ALTER TABLE "asset_job_status" ADD "classifiedAt"` | job status 新列 |

`down()` 反向：先删列再删表。

---

### 测试状态

| 项目 | 结果 |
|------|------|
| Python 语法 (AST parse) | ✅ |
| Ruff lint | ✅ All checks passed |
| ML pytest (88 tests) | ✅ 88 passed, 0 failed |
| TypeScript type-check | ⚠️ 环境限制未能运行（worktree 中 `pnpm install` OOM），需在完整开发环境中验证 |