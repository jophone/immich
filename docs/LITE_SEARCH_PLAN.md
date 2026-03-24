# 边缘设备轻量化搜索方案 (Lite Search) — EmbeddingGemma-300M

## Context

Immich 的搜索功能依赖 CLIP 模型（1-4GB），无法在边缘设备上运行。项目已有 YOLO 分类系统（每个 asset 上传时生成分类标签 → `asset_categories` 表），及完整三级中英文分类体系。

**方案**: 将每个 asset 的分类标签拼接成 `categories string`，使用轻量级文本嵌入模型 `google/embeddinggemma-300m`（308M 参数，<200MB RAM with quantization）将用户查询文本与 categories string 进行语义匹配。

**模型**: EmbeddingGemma-300M
- 输出维度: 768（支持 MRL 截断到 512/256/128）
- 多语言: 支持 100+ 语言（含中文）
- ONNX 版本: `onnx-community/embeddinggemma-300m-ONNX`（适配现有 ML 服务的 ONNX Runtime）
- 加载优先级: 本地路径 `/root/snap/model/embeddinggemma-300m` → HuggingFace 下载

---

## Phase 1: ML Service — 新增 EmbeddingGemma 模型

### 1.1 新增 ModelTask 和 ModelSource

**修改文件**: `machine-learning/immich_ml/schemas.py`

```python
class ModelTask(StrEnum):
    FACIAL_RECOGNITION = "facial-recognition"
    SEARCH = "clip"
    OCR = "ocr"
    LITE_SEARCH = "lite-search"    # 新增

class ModelSource(StrEnum):
    INSIGHTFACE = "insightface"
    MCLIP = "mclip"
    OPENCLIP = "openclip"
    PADDLE = "paddle"
    GOOGLE = "google"              # 新增
```

### 1.2 新增 TextEmbedding 模型类

**新建文件**: `machine-learning/immich_ml/models/text_embedding/__init__.py`
**新建文件**: `machine-learning/immich_ml/models/text_embedding/embedding_gemma.py`

模型类继承 `InferenceModel`，遵循现有 CLIP textual encoder 的模式（`models/clip/textual.py`）:

```python
class EmbeddingGemmaEncoder(InferenceModel):
    depends = []
    identity = (ModelType.TEXTUAL, ModelTask.LITE_SEARCH)

    def __init__(self, model_name: str, local_model_path: str | None = None, **kwargs):
        self.local_model_path = local_model_path
        super().__init__(model_name, **kwargs)

    def _download(self) -> None:
        """优先从本地路径加载，不存在则从 HuggingFace 下载 ONNX 版本"""
        if self.local_model_path and Path(self.local_model_path).exists():
            # 从本地路径拷贝/链接到 cache 目录
            ...
        else:
            # 从 HuggingFace 下载 onnx-community/embeddinggemma-300m-ONNX
            snapshot_download("onnx-community/embeddinggemma-300m-ONNX", ...)

    def _load(self) -> ModelSession:
        """加载 ONNX 模型 + tokenizer"""
        session = self._make_session(self.model_path)
        # 使用 tokenizers 库加载 tokenizer（与 CLIP textual 同模式）
        # 或使用 transformers AutoTokenizer（ONNX 版本需要）
        self.tokenizer = AutoTokenizer.from_pretrained(self.tokenizer_path)
        return session

    def _predict(self, inputs: str, **kwargs) -> str:
        """文本 → embedding 向量"""
        tokens = self.tokenizer(inputs, padding=True, return_tensors="np")
        # ONNX 推理，输出 sentence_embedding (1, 768)
        _, sentence_embedding = self.session.run(None, tokens.data)
        embedding = sentence_embedding[0]  # (768,)
        return serialize_np_array(embedding)
```

关键参考: `models/clip/textual.py:22-25`（`_predict` 方法流程一致：tokenize → session.run → serialize）

### 1.3 模型路由注册

**修改文件**: `machine-learning/immich_ml/models/__init__.py`

```python
from .text_embedding.embedding_gemma import EmbeddingGemmaEncoder

def get_model_class(...):
    match source, model_type, model_task:
        # ... existing cases ...
        case ModelSource.GOOGLE, ModelType.TEXTUAL, ModelTask.LITE_SEARCH:
            return EmbeddingGemmaEncoder
```

**修改文件**: `machine-learning/immich_ml/models/constants.py`

```python
_GOOGLE_MODELS = {"embeddinggemma300m"}  # clean_name of google/embeddinggemma-300m

def get_model_source(model_name: str) -> ModelSource | None:
    cleaned_name = clean_name(model_name)
    if cleaned_name in _GOOGLE_MODELS:
        return ModelSource.GOOGLE
    # ... existing checks
```

### 1.4 新增 ML Service 端点

**修改文件**: `machine-learning/immich_ml/main.py`

新增 `/encode-lite-text` 端点（独立于 `/predict`，类似 `/classify` 的模式）:

```python
@app.post("/encode-lite-text")
async def encode_lite_text(
    text: str = Form(),
    model_name: str = Form(default="google/embeddinggemma-300m"),
    local_model_path: str = Form(default="/root/snap/model/embeddinggemma-300m"),
) -> Any:
    model = await model_cache.get(
        model_name, ModelType.TEXTUAL, ModelTask.LITE_SEARCH,
        ttl=settings.model_ttl, local_model_path=local_model_path
    )
    model = await load(model)
    embedding = await run(model.predict, text)
    return ORJSONResponse({"embedding": embedding})
```

### 1.5 依赖管理

**修改文件**: `machine-learning/pyproject.toml`

EmbeddingGemma ONNX 版本需要 `transformers` 的 `AutoTokenizer`:
```toml
# 新增依赖（仅 tokenizer 部分，不需要 torch）
transformers = ">=4.40.0"
```

注：`transformers` 可以在无 torch 环境下运行 tokenizer（只需 `tokenizers` + `safetensors`）。

### 1.6 配置

**修改文件**: `machine-learning/immich_ml/config.py`

```python
class LiteSearchSettings(BaseModel):
    model_name: str = "google/embeddinggemma-300m"
    local_model_path: str = "/root/snap/model/embeddinggemma-300m"

class Settings(BaseSettings):
    # ... existing settings
    lite_search: LiteSearchSettings = LiteSearchSettings()
```

---

## Phase 2: Server — Lite Search 数据层

### 2.1 新增 `lite_search` 表

**新建文件**: `server/src/schema/tables/lite-search.table.ts`

```typescript
@Table({ name: 'lite_search' })
@Index({
  name: 'lite_search_index',
  using: 'hnsw',
  expression: 'embedding vector_cosine_ops',
  with: 'ef_construction = 300, m = 16',
  synchronize: false,
})
export class LiteSearchTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'vector', length: 768, storage: 'external', synchronize: false })
  embedding!: string;
}
```

参考: `server/src/schema/tables/smart-search.table.ts`（完全相同的模式，仅表名和维度不同）

### 2.2 数据库迁移

**新建文件**: `server/src/schema/migrations/<timestamp>-CreateLiteSearchTable.ts`

```sql
CREATE TABLE "lite_search" (
  "assetId" uuid PRIMARY KEY REFERENCES "asset"("id") ON DELETE CASCADE,
  "embedding" vector(768) STORAGE EXTERNAL
);
CREATE INDEX "lite_search_index" ON "lite_search"
  USING hnsw (embedding vector_cosine_ops) WITH (ef_construction = 300, m = 16);
```

### 2.3 Server 端 ModelTask 扩展

**修改文件**: `server/src/repositories/machine-learning.repository.ts`

新增 `ModelTask.LITE_SEARCH` 和 `encodeLiteText()` 方法:

```typescript
export enum ModelTask {
  FACIAL_RECOGNITION = 'facial-recognition',
  SEARCH = 'clip',
  OCR = 'ocr',
  LITE_SEARCH = 'lite-search',  // 新增
}

// 新增类型
export type LiteSearchTextualRequest = { [ModelTask.LITE_SEARCH]: { [ModelType.TEXTUAL]: ModelOptions } };
export type LiteSearchTextualResponse = { [ModelTask.LITE_SEARCH]: string };

// 新增方法 — 通过独立端点调用
async encodeLiteText(text: string, config: LiteSearchConfig): Promise<string> {
  const formData = new FormData();
  formData.append('text', text);
  formData.append('model_name', config.modelName);
  formData.append('local_model_path', config.localModelPath);
  const data = await this.postWithFailover<{ embedding: string }>('/encode-lite-text', formData, 'encode-lite-text');
  return data.embedding;
}
```

### 2.4 SearchRepository 新增方法

**修改文件**: `server/src/repositories/search.repository.ts`

新增 `searchLite()` 和 `upsertLite()`:

```typescript
// 搜索 — 与 searchSmart() 完全相同的模式，仅换表
searchLite(pagination, options) {
  return this.db.transaction().execute(async (trx) => {
    await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.LiteSearch])}`.execute(trx);
    const items = await searchAssetBuilder(trx, options)
      .selectAll('asset')
      .innerJoin('lite_search', 'asset.id', 'lite_search.assetId')
      .orderBy(sql`lite_search.embedding <=> ${options.embedding}`)
      .limit(pagination.size + 1)
      .offset((pagination.page - 1) * pagination.size)
      .execute();
    return paginationHelper(items, pagination.size);
  });
}

// 存储 embedding
upsertLite(assetId: string, embedding: string) {
  return this.db
    .insertInto('lite_search')
    .values({ assetId, embedding })
    .onConflict((oc) => oc.column('assetId').doUpdateSet((eb) => ({ embedding: eb.ref('excluded.embedding') })))
    .execute();
}
```

参考: `searchSmart()` (L299-315) 和 `upsert()` (L449-455) — 逻辑完全一致。

### 2.5 新增 VectorIndex 枚举值

**修改文件**: `server/src/enum.ts`

```typescript
export enum VectorIndex {
  Clip = 'clip_index',
  Face = 'face_index',
  LiteSearch = 'lite_search_index',  // 新增
}
```

---

## Phase 3: Server — Embedding 生成管道

### 3.1 配置

**修改文件**: `server/src/config.ts`

在 `machineLearning` 下新增 `liteSearch`:

```typescript
machineLearning: {
  // ... existing config
  liteSearch: {
    enabled: true,
    modelName: 'google/embeddinggemma-300m',
    localModelPath: '/root/snap/model/embeddinggemma-300m',
  },
}
```

### 3.2 新增 Job 和 Queue

**修改文件**: `server/src/enum.ts`

```typescript
export enum QueueName {
  // ... existing
  LiteSearch = 'liteSearch',  // 新增
}

export enum JobName {
  // ... existing
  LiteSearchQueueAll = 'LiteSearchQueueAll',  // 新增
  LiteSearch = 'LiteSearch',                   // 新增
}
```

### 3.3 新增 LiteSearchService

**新建文件**: `server/src/services/lite-search.service.ts`

遵循 `SmartInfoService`（`server/src/services/smart-info.service.ts`）的模式:

```typescript
@Injectable()
export class LiteSearchService extends BaseService {

  @OnJob({ name: JobName.LiteSearchQueueAll, queue: QueueName.LiteSearch })
  async handleQueueEncodeLiteSearch({ force }) {
    // 流式获取需要编码的 assets（有分类但无 lite_search embedding 的）
    // 批量入队 JobName.LiteSearch 任务
  }

  @OnJob({ name: JobName.LiteSearch, queue: QueueName.LiteSearch })
  async handleEncodeLiteSearch({ id }) {
    // 1. 获取 asset 的分类标签
    const categories = await this.categoryRepository.getByAssetId(id);
    if (!categories.length) return JobStatus.Skipped;

    // 2. 构建 categories string（中英文标签拼接）
    const categoryString = buildCategoryString(categories);

    // 3. 调用 ML 服务编码
    const embedding = await this.machineLearningRepository.encodeLiteText(
      categoryString, config.machineLearning.liteSearch
    );

    // 4. 存储 embedding
    await this.searchRepository.upsertLite(id, embedding);
  }
}
```

`buildCategoryString()` 逻辑:
- 获取每个 category 的中英文标签（通过 `getCategoryHierarchy()` from `category-taxonomy.ts`）
- 拼接为: `"landscape 风景 nature 自然 mountain 山脉"`
- 中英文都包含，EmbeddingGemma 支持多语言，可以匹配中文或英文查询

### 3.4 触发时机

在分类完成后自动触发 lite search encoding:

**修改文件**: `server/src/services/classification.service.ts`

在 `handleClassification()` 成功后追加:
```typescript
// 分类完成后，触发 lite search embedding 生成
if (isLiteSearchEnabled(machineLearning)) {
  await this.jobRepository.queue({ name: JobName.LiteSearch, data: { id } });
}
```

---

## Phase 4: Server — 搜索端点

### 4.1 新增 DTO

**修改文件**: `server/src/dtos/search.dto.ts`

```typescript
export class LiteSearchDto extends BaseSearchWithResultsDto {
  @ValidateString({ optional: false, trim: true })
  query!: string;

  @Optional() language?: string;
  @Optional() @Type(() => Number) page?: number;
}
```

### 4.2 新增 Feature Flag

**修改文件**: `server/src/dtos/server.dto.ts`

```typescript
export class ServerFeaturesDto {
  // ... existing
  @ApiProperty({ description: 'Whether lightweight search is enabled' })
  liteSearch!: boolean;
}
```

**修改文件**: `server/src/services/server.service.ts`

```typescript
liteSearch: isLiteSearchEnabled(machineLearning),
```

**修改文件**: `server/src/utils/misc.ts`

```typescript
export const isLiteSearchEnabled = (machineLearning: SystemConfig['machineLearning']) =>
  isMachineLearningEnabled(machineLearning) && machineLearning.liteSearch.enabled;
```

### 4.3 SearchService 新增方法

**修改文件**: `server/src/services/search.service.ts`

```typescript
async searchLite(auth: AuthDto, dto: LiteSearchDto): Promise<SearchResponseDto> {
  const { machineLearning } = await this.getConfig({ withCache: false });
  if (!isLiteSearchEnabled(machineLearning)) {
    throw new BadRequestException('Lite search is not enabled');
  }

  // 1. 用 EmbeddingGemma 编码用户查询
  const embedding = await this.machineLearningRepository.encodeLiteText(
    dto.query, machineLearning.liteSearch
  );

  // 2. 向量相似度搜索
  const { hasNextPage, items } = await this.searchRepository.searchLite(
    { page: dto.page ?? 1, size: dto.size || 100 },
    { ...searchOptions, userIds, embedding }
  );

  return this.mapResponse(items, hasNextPage ? (page + 1).toString() : null, { auth });
}
```

### 4.4 新增 Controller Endpoint

**修改文件**: `server/src/controllers/search.controller.ts`

```typescript
@Post('lite')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
searchLite(@Auth() auth: AuthDto, @Body() dto: LiteSearchDto): Promise<SearchResponseDto> {
  return this.service.searchLite(auth, dto);
}
```

### 4.5 重新生成 SDK

```bash
make open-api && make sql
```

---

## Phase 5: Web 前端 — 搜索入口切换

### 5.1 新增 QueryType

**修改文件**: `web/src/lib/constants.ts`

```typescript
export enum QueryType {
  SMART = 'smart',
  LITE = 'lite',        // 新增
  METADATA = 'metadata',
  DESCRIPTION = 'description',
  OCR = 'ocr',
}
export const validQueryTypes = new Set([QueryType.SMART, QueryType.LITE, ...]);
```

### 5.2 搜索选项面板 — 新增 Radio Button

**修改文件**: `web/src/lib/components/shared-components/search-bar/search-text-section.svelte`

- Props `queryType` 类型加入 `'lite'`
- 新增 radio button（受 `featureFlagsManager.value.liteSearch` 控制）
- 新增对应输入框 placeholder: `"猫, 风景, 美食 / cat, landscape, food"`

### 5.3 搜索面板 Payload 构建

**修改文件**: `web/src/lib/modals/SearchFilterModal.svelte`

- `SearchFilter.queryType` 加入 `'lite'`
- `search()` 中当 `queryType === 'lite'` 时设置 `liteQuery` 字段

### 5.4 搜索结果页分发

**修改文件**: `web/src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte`

`loadNextPage()` 中修改分发逻辑（约 L146-149）:

```typescript
let result;
if ('liteQuery' in searchDto) {
  result = await searchLite({ liteSearchDto: { query: searchDto.liteQuery, ...common } });
} else if (('query' in searchDto) && smartSearchEnabled) {
  result = await searchSmart({ smartSearchDto: searchDto });
} else {
  result = await searchAssets({ metadataSearchDto: searchDto });
}
```

### 5.5 顶部搜索栏

**修改文件**: `web/src/lib/components/shared-components/search-bar/search-bar.svelte`

- `searchTypes` 数组新增 `{ value: 'lite', label: () => $t('lite_search') }`
- `getSearchType()` switch 新增 `'lite'` case
- `buildSearchPayload()` 新增 `'lite'` case: `return { liteQuery: term }`

### 5.6 国际化

**修改文件**: `web/src/lib/i18n/en.json`, `zh.json`

```
en: "lite_search": "Category Search", "lite_search_placeholder": "cat, landscape, food..."
zh: "lite_search": "分类搜索", "lite_search_placeholder": "猫, 风景, 美食..."
```

---

## Phase 6: 边缘设备启动脚本

### 6.1 边缘配置文件

**新建文件**: `docker/immich-edge.config.yml`

```yaml
machineLearning:
  enabled: true
  clip:
    enabled: false          # 禁用 CLIP
  facialRecognition:
    enabled: false
  duplicateDetection:
    enabled: false
  ocr:
    enabled: false
  classification:
    enabled: true           # 保留 YOLO 分类
  liteSearch:
    enabled: true           # 启用轻量搜索
    modelName: "google/embeddinggemma-300m"
    localModelPath: "/root/snap/model/embeddinggemma-300m"
```

通过已有 `IMMICH_CONFIG_FILE` 环境变量加载（`server/src/repositories/config.repository.ts:237`）。

### 6.2 Docker 启动脚本

**新建文件**: `scripts/edge-docker-dev.sh`

```bash
#!/usr/bin/env bash
export IMMICH_CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker/immich-edge.config.yml"
exec "$(dirname "$0")/docker-dev.sh" "$@"
```

### 6.3 本地启动脚本

**新建文件**: `scripts/edge-local-dev.sh`

```bash
#!/usr/bin/env bash
export IMMICH_CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker/immich-edge.config.yml"
exec "$(dirname "$0")/local-dev.sh" "$@"
```

### 6.4 Makefile

**修改文件**: `Makefile`

```makefile
edge:
	IMMICH_CONFIG_FILE=./docker/immich-edge.config.yml $(MAKE) dev
edge-update:
	IMMICH_CONFIG_FILE=./docker/immich-edge.config.yml $(MAKE) dev-update
```

---

## 关键文件清单

| 操作 | 文件路径 |
|------|----------|
| **新建** | `machine-learning/immich_ml/models/text_embedding/__init__.py` |
| **新建** | `machine-learning/immich_ml/models/text_embedding/embedding_gemma.py` |
| **新建** | `server/src/schema/tables/lite-search.table.ts` |
| **新建** | `server/src/schema/migrations/<ts>-CreateLiteSearchTable.ts` |
| **新建** | `server/src/services/lite-search.service.ts` |
| **新建** | `docker/immich-edge.config.yml` |
| **新建** | `scripts/edge-docker-dev.sh` |
| **新建** | `scripts/edge-local-dev.sh` |
| **修改** | `machine-learning/immich_ml/schemas.py` — ModelTask, ModelSource |
| **修改** | `machine-learning/immich_ml/models/__init__.py` — 模型路由 |
| **修改** | `machine-learning/immich_ml/models/constants.py` — 模型注册 |
| **修改** | `machine-learning/immich_ml/main.py` — `/encode-lite-text` 端点 |
| **修改** | `machine-learning/immich_ml/config.py` — LiteSearchSettings |
| **修改** | `server/src/config.ts` — liteSearch 配置 |
| **修改** | `server/src/enum.ts` — QueueName, JobName, VectorIndex |
| **修改** | `server/src/dtos/search.dto.ts` — LiteSearchDto |
| **修改** | `server/src/dtos/server.dto.ts` — ServerFeaturesDto |
| **修改** | `server/src/controllers/search.controller.ts` — POST /search/lite |
| **修改** | `server/src/services/search.service.ts` — searchLite() |
| **修改** | `server/src/services/server.service.ts` — getFeatures() |
| **修改** | `server/src/services/classification.service.ts` — 触发 lite embedding |
| **修改** | `server/src/repositories/search.repository.ts` — searchLite(), upsertLite() |
| **修改** | `server/src/repositories/machine-learning.repository.ts` — encodeLiteText() |
| **修改** | `server/src/utils/misc.ts` — isLiteSearchEnabled() |
| **修改** | `web/src/lib/constants.ts` — QueryType.LITE |
| **修改** | `web/src/lib/components/shared-components/search-bar/search-text-section.svelte` |
| **修改** | `web/src/lib/components/shared-components/search-bar/search-bar.svelte` |
| **修改** | `web/src/lib/modals/SearchFilterModal.svelte` |
| **修改** | `web/src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte` |
| **修改** | `web/src/lib/i18n/en.json`, `zh.json` |
| **修改** | `Makefile` |

## 实施顺序

1. Phase 1 (ML Service) → 测试 `/encode-lite-text` 端点
2. Phase 2 (Server 数据层) → 迁移创建表
3. Phase 3 (Embedding 生成) → 测试分类后自动生成 embedding
4. Phase 4 (搜索端点) → `make open-api && make sql` → API 测试
5. Phase 5 (Web 前端) → UI 测试
6. Phase 6 (启动脚本) → 端到端验证

## 验证方案

1. **ML 端点**: `curl -X POST /encode-lite-text -F "text=cat landscape"` → 返回 768 维向量
2. **Embedding 生成**: 上传图片 → YOLO 分类 → 自动生成 lite_search embedding → 检查 DB
3. **搜索**: `curl -X POST /search/lite -d '{"query":"猫"}'` → 返回分类含猫的 assets
4. **前端**: Search Options → "分类搜索" → 输入关键词 → 验证结果
5. **Edge 模式**: `scripts/edge-docker-dev.sh up` → smartSearch=false, liteSearch=true → 搜索面板只显示分类搜索
