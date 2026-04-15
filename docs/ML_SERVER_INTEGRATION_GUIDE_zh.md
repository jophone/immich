# Immich 服务端与算法端对接说明（交接版）

## 0. 整体

- 算法端是 `machine-learning/`，一个 FastAPI 服务，核心入口在 `machine-learning/immich_ml/main.py`。
- 服务端是 `server/`，通过 `server/src/repositories/machine-learning.repository.ts` 统一调用算法端。
- 绝大多数算法任务都不是实时同步 API，而是 **上传后由队列异步执行**（Smart Search、人脸、OCR、分类等）。

---

## 1. 如何使用算法端接口？（含算法说明）

算法端当前对外主要有 5 个 HTTP 接口：

- `GET /`：返回 `{ "message": "Immich ML" }`
- `GET /ping`：健康检查，返回 `pong`
- `POST /predict`：通用推理入口（CLIP / 人脸 / OCR）
- `POST /classify`：图像分类（YOLO 分类模型 或 CLIP 零样本分类）
- `POST /detect`：目标检测（YOLO）

### 1.1 `POST /predict`（通用推理）

#### 入参格式

`multipart/form-data`，包含：

- `entries`：JSON 字符串，定义要跑哪些 task/type/model
- `image` 或 `text`：二选一

`entries` 的结构是：

```json
{
  "<task>": {
    "<type>": {
      "modelName": "...",
      "options": { "...": "..." }
    }
  }
}
```

其中：

- `task`：`clip` / `facial-recognition` / `ocr`
- `type`：`visual` / `textual` / `detection` / `recognition`
- `modelName`：可选；不传时算法服务会使用自己启动配置里的默认模型。外部相册项目推荐不传，避免和算法服务内部模型配置耦合。

#### 示例 A：文本转 embedding（智能搜索文本向量）

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"clip":{"textual":{}}}' \
  -F 'text=beach sunset'
```

背后算法：CLIP 文本编码器（OpenCLIP 或 MCLIP 变体）。

#### 示例 B：图片转 embedding（智能搜索图片向量）

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"clip":{"visual":{}}}' \
  -F 'image=@/tmp/a.jpg'
```

背后算法：CLIP 视觉编码器。

#### 示例 C：人脸检测 + 人脸特征提取

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"facial-recognition":{"detection":{"options":{"minScore":0.7}},"recognition":{}}}' \
  -F 'image=@/tmp/a.jpg'
```

背后算法：

- 检测：InsightFace RetinaFace
- 识别特征：InsightFace ArcFace（输出 512 维 embedding）

#### 示例 D：OCR（文字检测 + 文字识别）

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"ocr":{"detection":{"options":{"minScore":0.5,"maxResolution":736}},"recognition":{"options":{"minScore":0.8}}}}' \
  -F 'image=@/tmp/a.jpg'
```

背后算法：PaddleOCR（RapidOCR 封装，PP-OCRv5 检测+识别）。

#### 返回格式（关键点）

- 返回里会按 task 给结果，例如 `clip`、`facial-recognition`、`ocr`
- 如果输入是图片，额外返回 `imageHeight` / `imageWidth`
- embedding 是 **JSON 字符串**（不是数组对象），服务端会直接存储为向量字段

---

### 1.2 `POST /classify`（分类）

请求字段（form-data）：

- `image`：图片
- `model_name`：可选；不传时使用算法服务默认分类模型
- `categories`：JSON 字符串数组
- `min_score`：阈值
- `max_results`：最多返回条数

算法逻辑分两条：

1. `model_name` 含 `yolo`：走 YOLO 分类模型，直接输出标签概率
2. 否则：走 CLIP 零样本分类
   - 图片 -> image embedding
   - 文本类别（`a photo of {category}`）-> text embedding
   - 计算 cosine similarity + softmax（带温度系数）

返回：

```json
{
  "classification": [
    { "categoryName": "portrait", "confidence": 0.91 }
  ]
}
```

---

### 1.3 `POST /detect`（目标检测）

请求字段（form-data）：

- `image`
- `model_name`：可选；不传时使用算法服务默认检测模型
- `min_score`

算法：YOLO 目标检测（兼容标准输出和 end-to-end 输出，内部做 NMS/坐标还原）。

返回：

```json
{
  "detections": [
    {
      "className": "person",
      "confidence": 0.88,
      "bbox": { "x1": 0.1, "y1": 0.2, "x2": 0.4, "y2": 0.8 }
    }
  ]
}
```

默认关注类别映射在 `machine-learning/immich_ml/models/detection/detection_classes.py`。

---

### 1.4 模型加载与性能相关要点（你接手时常会碰到）

- 首次请求会自动下载模型（HuggingFace snapshot）并缓存
- 算法端有内存模型缓存 + TTL（空闲超时可卸载）
- 支持多后端执行（ONNX / ARMNN / RKNN，按环境能力选择）
- 可通过环境变量预加载模型，例如：
  - `MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL`
  - `MACHINE_LEARNING_PRELOAD__CLIP__VISUAL`
- 外部相册项目不需要知道预加载了哪些模型；如果请求没有传 `modelName` / `model_name`，算法端会自动选择默认模型。
- 默认模型选择优先级：`MACHINE_LEARNING_DEFAULT__...` 显式默认值 > 对应预加载列表的第一个模型 > Immich 内置默认值。

可选的显式默认模型环境变量：

- `MACHINE_LEARNING_DEFAULT__CLIP__TEXTUAL`
- `MACHINE_LEARNING_DEFAULT__CLIP__VISUAL`
- `MACHINE_LEARNING_DEFAULT__FACIAL_RECOGNITION__DETECTION`
- `MACHINE_LEARNING_DEFAULT__FACIAL_RECOGNITION__RECOGNITION`
- `MACHINE_LEARNING_DEFAULT__OCR__DETECTION`
- `MACHINE_LEARNING_DEFAULT__OCR__RECOGNITION`
- `MACHINE_LEARNING_DEFAULT__CLASSIFICATION`
- `MACHINE_LEARNING_DEFAULT__DETECTION`

可用 `GET /models` 查看当前算法端对外默认模型，主要用于排查，不要求业务调用方依赖它。

### 1.5 如何测试算法端接口（假设端口 `3003`）

下面给一套“从 0 到 1”的最小可用测试流程（本地算法服务地址：`http://127.0.0.1:3003`）。

#### 步骤 1：准备变量和测试图片

```bash
export ML_URL='http://127.0.0.1:3003'

# 准备测试图片（任选一张本地图片）
export IMG='/tmp/a.jpg'
test -f "$IMG" && echo "OK: $IMG" || echo "请先准备测试图片到 $IMG"
```

#### 步骤 2：健康检查

```bash
curl -s "$ML_URL/ping"
```

预期返回：

- `pong`

可选检查：

```bash
curl -s "$ML_URL/"
```

预期包含：

- `{"message":"Immich ML"}`

#### 步骤 3：测试 `POST /predict`（文本 -> CLIP embedding）

```bash
curl -s -X POST "$ML_URL/predict" \
  -F 'entries={"clip":{"textual":{}}}' \
  -F 'text=beach sunset'
```

预期关注字段：

- 返回 JSON 中有 `clip`
- `clip` 是字符串（内容是 embedding 的 JSON 字符串）

#### 步骤 4：测试 `POST /predict`（图片 -> CLIP embedding）

```bash
curl -s -X POST "$ML_URL/predict" \
  -F 'entries={"clip":{"visual":{}}}' \
  -F "image=@$IMG"
```

预期关注字段：

- 有 `clip`
- 有 `imageHeight` / `imageWidth`

#### 步骤 5：测试 `POST /predict`（人脸检测+识别）

```bash
curl -s -X POST "$ML_URL/predict" \
  -F 'entries={"facial-recognition":{"detection":{"options":{"minScore":0.7}},"recognition":{}}}' \
  -F "image=@$IMG"
```

预期关注字段：

- 有 `facial-recognition`（数组）
- 数组元素里有 `boundingBox`、`embedding`、`score`

#### 步骤 6：测试 `POST /predict`（OCR）

```bash
curl -s -X POST "$ML_URL/predict" \
  -F 'entries={"ocr":{"detection":{"options":{"minScore":0.5,"maxResolution":736}},"recognition":{"options":{"minScore":0.8}}}}' \
  -F "image=@$IMG"
```

预期关注字段：

- 有 `ocr`
- `ocr` 下通常包含 `text`、`box`、`boxScore`、`textScore`

#### 步骤 7：测试 `POST /classify`

```bash
curl -s -X POST "$ML_URL/classify" \
  -F "image=@$IMG" \
  -F 'categories=["landscape","portrait","food"]' \
  -F 'min_score=0.1' \
  -F 'max_results=5'
```

预期关注字段：

- 返回 `classification` 数组
- 元素包含 `categoryName` 和 `confidence`

#### 步骤 8：测试 `POST /detect`

```bash
curl -s -X POST "$ML_URL/detect" \
  -F "image=@$IMG" \
  -F 'min_score=0.25'
```

预期关注字段：

- 返回 `detections` 数组
- 元素包含 `className`、`confidence`、`bbox`

#### 常见问题（测试时）

- `422 Unprocessable Entity`：通常是 `entries` JSON 格式错误，或 `categories` 不是合法 JSON 数组。
- `400 Either image or text must be provided`：`/predict` 没传 `image` 也没传 `text`。
- 首次很慢：模型首次下载/加载导致，属于正常现象。
- `500 Failed to load model`：模型名写错、模型文件缺失，或当前硬件后端不支持该模型。

---

## 2. 数据怎么在服务端和算法端流通？

下面给你“上传后一张图”最常见链路：

### 2.1 触发点：上传完成 + 缩略图生成后

在 `server/src/services/job.service.ts`：

- `AssetGenerateThumbnails` 缩略图生成后，会继续排队：
  - `SmartSearch`
  - `AssetDetectFaces`
  - `Ocr`
  - `Classification`

也就是：**同一资产会并行进入多个 ML 子流程**。

### 2.2 统一调用层：`MachineLearningRepository`

`server/src/repositories/machine-learning.repository.ts` 做了几件关键事：

1. 读取图片文件路径 -> 组装 `FormData`
2. 调用算法端 `/predict`、`/classify`、`/detect`
3. 健康检查 + failover（`/ping` + 多 URL 轮询）

配置来源：

- `IMMICH_MACHINE_LEARNING_URL`
- `machineLearning.urls`（支持多实例）

### 2.3 各子流程的数据落点

#### A. Smart Search（CLIP）

- 输入：预览图路径
- 调用：`encodeImage -> /predict`
- 结果：embedding 落库到 `smart_search.embedding`
- 表：`smart_search`（向量索引 `clip_index`）

#### B. 人脸

- 输入：预览图路径
- 调用：`detectFaces -> /predict`（检测+识别）
- 结果拆两部分：
  - 检测框落到 `asset_face`
  - 人脸 embedding 落到 `face_search`

后续再用 `face_search` 做相似度匹配，决定是否归并到已有 person。

#### C. OCR

- 输入：预览图路径
- 调用：`ocr -> /predict`
- 结果：
  - 每条文本框 + 分数 + 文本 -> `asset_ocr`
  - 所有文本拼接 token -> `ocr_search.text`（供全文/模糊检索）

#### D. 分类 + 检测增强

- 输入：预览图路径
- 调用：
  - `classifyImage -> /classify`
  - （可选）`detectObjects -> /detect`
- 结果统一写入 `asset_categories`（类别名 + 置信度）

### 2.4 编辑后的可见性同步

当图片被裁剪编辑后，服务端会重新计算：

- 哪些人脸框仍在可视区域（更新 `asset_face.isVisible`）
- 哪些 OCR 框仍可见（更新 `asset_ocr.isVisible`，并同步 `ocr_search.text`）

对应逻辑在 `server/src/services/media.service.ts` + `server/src/utils/editor.ts`。

---

## 3. 服务端如何使用算法返回内容？最终实现什么功能？

按功能看最直观：

### 3.1 智能搜索（文搜图 / 图搜图）

- 用户调用 `POST /search/smart`
- 服务端把文本编码成向量（或用参考图已有向量）
- 在 `smart_search` 里做向量距离排序（`<=>`）

你能得到：自然语言搜图、以图搜图。

### 3.2 重复照片检测

- 基于 CLIP 向量距离（`duplicateDetection.maxDistance`）
- 结果写入 `asset.duplicateId`

你能得到：自动重复分组与清理入口。

### 3.3 人脸识别与人物管理

- 检测框 + embedding 入库后，服务端跑人脸近邻搜索
- 自动创建/归并 person，生成人物封面图
- 对外通过 `people` 相关 API 展示与管理

你能得到：人物聚类、人物相册、手动合并/重分配。

### 3.4 OCR 文本检索

- 单资产：`GET /assets/:id/ocr` 可拿到文字框与文本
- 全局搜索：可在搜索条件里用 `ocr` 文本过滤

你能得到：截图/文档/照片文字可检索。

### 3.5 场景分类与内容标签

- `/classify` 产出场景类标签（如 landscape/portrait...）
- `/detect` 产出目标检测标签（person/dog/cat...）
- 服务端做规则增强（如 `person_with_dog`、`multiple_people`）

你能得到：分类浏览、探索页分类入口、按类别筛选。

---

## 4. 你接手时最实用的排查顺序（建议）

1. 看服务端配置是否开启：`machineLearning.enabled` 及各子开关
2. 确认算法端健康：`GET /ping`
3. 在服务端看队列是否堆积：`/queues`（admin）
4. 看资产是否有对应结果落库：
   - `smart_search`
   - `asset_face` / `face_search`
   - `asset_ocr` / `ocr_search`
   - `asset_categories`
5. 必要时手动重跑队列（SmartSearch/Face/Ocr/Classification）

---

## 5. 一句话总结

在 Immich 里，算法端负责“把图片/文本变成结构化结果（向量、框、文本、类别）”，服务端负责“调度、落库、检索、聚类和对外 API”，两者通过 `MachineLearningRepository` + Job 队列完成解耦。

---

## 6. 给业务后端同事的 TypeScript 示例代码

下面的示例参考了 Immich 的实际服务端调用方式，重点不是复刻 Immich 的 NestJS 结构，而是告诉你在自己的相册后端里应该怎么正确调用算法端、怎么保存结果、怎么做搜索。

建议先把算法端封装成一个小客户端，不要在各个业务接口里到处手写 `fetch + FormData`。

示例 SQL 使用的是 Immich 风格的表名和字段名，你可以按自己项目的数据库 schema 改名；真正需要保持一致的是算法端请求字段、返回字段、向量距离计算方式和坐标含义。

### 6.1 先封装一个 `MlClient`

适用环境：Node.js 18+ / 20+ / 24+，需要全局 `fetch`、`FormData`、`Blob`。如果你的 TypeScript 项目没有 DOM 类型，可以改用 `undici` 导出的 `fetch/FormData/Blob`。

```ts
import { readFile } from 'node:fs/promises';

export type BoundingBox = { x1: number; y1: number; x2: number; y2: number };

export type Face = {
  boundingBox: BoundingBox; // 人脸接口返回的是图片像素坐标
  embedding: string; // JSON 字符串，例如 "[0.1,0.2,...]"，不要 JSON.parse 后再存
  score: number;
};

export type OcrResult = {
  text: string[];
  box: number[]; // 每 8 个数字表示一个四点框：x1,y1,x2,y2,x3,y3,x4,y4，坐标已归一化到 0~1
  boxScore: number[];
  textScore: number[];
};

export type ClassificationResult = { categoryName: string; confidence: number };
export type DetectionResult = {
  className: string;
  confidence: number;
  bbox: BoundingBox; // 目标检测接口返回的是归一化坐标 0~1
};

type PredictEntry = { modelName?: string; options?: Record<string, unknown> };
type PredictEntries = Record<string, Record<string, PredictEntry>>;
type OcrOptions = {
  modelName?: string;
  minDetectionScore?: number;
  minRecognitionScore?: number;
  maxResolution?: number;
};
type ClassificationOptions = {
  modelName?: string;
  categories?: string[];
  minScore?: number;
  maxResults?: number;
};

export class MlClient {
  constructor(
    private readonly urls: string[],
    private readonly timeoutMs = 120_000,
  ) {}

  async ping() {
    for (const baseUrl of this.urls) {
      try {
        const response = await fetch(new URL('/ping', baseUrl), {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok && (await response.text()) === 'pong') {
          return true;
        }
      } catch {
        // 尝试下一个算法端实例
      }
    }
    return false;
  }

  async encodeImage(imagePath: string, options: { modelName?: string } = {}) {
    const visual: PredictEntry = options.modelName ? { modelName: options.modelName } : {};
    const response = await this.predict<{ clip: string; imageHeight: number; imageWidth: number }>(
      { imagePath },
      { clip: { visual } },
    );

    return {
      embedding: response.clip,
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
    };
  }

  async encodeText(text: string, options: { modelName?: string; language?: string } = {}) {
    const textual: PredictEntry = {
      ...(options.modelName ? { modelName: options.modelName } : {}),
      ...(options.language ? { options: { language: options.language } } : {}),
    };
    const response = await this.predict<{ clip: string }>(
      { text },
      { clip: { textual } },
    );

    return response.clip;
  }

  async detectFaces(imagePath: string, options: { modelName?: string; minScore?: number } = {}) {
    const detection: PredictEntry = {
      ...(options.modelName ? { modelName: options.modelName } : {}),
      options: { minScore: options.minScore ?? 0.7 },
    };
    const recognition: PredictEntry = options.modelName ? { modelName: options.modelName } : {};
    const response = await this.predict<{
      'facial-recognition': Face[];
      imageHeight: number;
      imageWidth: number;
    }>(
      { imagePath },
      {
        'facial-recognition': {
          detection,
          recognition,
        },
      },
    );

    return {
      imageHeight: response.imageHeight,
      imageWidth: response.imageWidth,
      faces: response['facial-recognition'],
    };
  }

  async ocr(imagePath: string, options: OcrOptions = {}) {
    const detection: PredictEntry = {
      ...(options.modelName ? { modelName: options.modelName } : {}),
      options: { minScore: options.minDetectionScore ?? 0.5, maxResolution: options.maxResolution ?? 736 },
    };
    const recognition: PredictEntry = {
      ...(options.modelName ? { modelName: options.modelName } : {}),
      options: { minScore: options.minRecognitionScore ?? 0.8 },
    };
    const response = await this.predict<{ ocr: OcrResult }>(
      { imagePath },
      {
        ocr: {
          detection,
          recognition,
        },
      },
    );

    return response.ocr;
  }

  async classifyImage(imagePath: string, options: ClassificationOptions = {}) {
    const formData = await this.formWithImage(imagePath);
    if (options.modelName) {
      formData.append('model_name', options.modelName);
    }
    if (options.categories) {
      formData.append('categories', JSON.stringify(options.categories));
    }
    if (options.minScore !== undefined) {
      formData.append('min_score', String(options.minScore));
    }
    if (options.maxResults !== undefined) {
      formData.append('max_results', String(options.maxResults));
    }

    const response = await this.postJson<{ classification: ClassificationResult[] }>('/classify', formData);
    return response.classification;
  }

  async detectObjects(imagePath: string, options: { modelName?: string; minScore?: number } = {}) {
    const formData = await this.formWithImage(imagePath);
    if (options.modelName) {
      formData.append('model_name', options.modelName);
    }
    formData.append('min_score', String(options.minScore ?? 0.25));

    const response = await this.postJson<{ detections: DetectionResult[] }>('/detect', formData);
    return response.detections;
  }

  private async predict<T>(payload: { imagePath: string } | { text: string }, entries: PredictEntries): Promise<T> {
    const formData = new FormData();
    formData.append('entries', JSON.stringify(entries));

    if ('imagePath' in payload) {
      const file = await readFile(payload.imagePath);
      formData.append('image', new Blob([new Uint8Array(file)]), 'image');
    } else {
      formData.append('text', payload.text);
    }

    return this.postJson<T>('/predict', formData);
  }

  private async formWithImage(imagePath: string) {
    const formData = new FormData();
    const file = await readFile(imagePath);
    formData.append('image', new Blob([new Uint8Array(file)]), 'image');
    return formData;
  }

  private async postJson<T>(endpoint: string, formData: FormData): Promise<T> {
    const errors: string[] = [];

    for (const baseUrl of this.urls) {
      try {
        const response = await fetch(new URL(endpoint, baseUrl), {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) {
          return (await response.json()) as T;
        }

        errors.push(`${baseUrl}: ${response.status} ${response.statusText} ${await response.text()}`);
      } catch (error) {
        errors.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`Machine learning request failed: ${errors.join('; ')}`);
  }
}
```

### 6.2 示例一：上传后给图片生成向量，用于文搜图

Immich 的做法是：缩略图/预览图生成后异步执行 Smart Search job，调用 `encodeImage`，把返回的 `embedding` 原样写入向量表。不要在用户上传接口里同步跑完整算法，模型首次加载可能很慢。

```ts
type Db = {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

type Asset = {
  id: string;
  ownerId: string;
  previewPath: string;
};

const ml = new MlClient([process.env.ML_URL ?? 'http://127.0.0.1:3003']);

export async function indexAssetForSmartSearch(db: Db, asset: Asset) {
  const { embedding } = await ml.encodeImage(asset.previewPath);

  // 如果你用 pgvector/vectorchord，embedding 可以作为字符串参数传入并 cast 成 vector。
  await db.query(
    `
      insert into smart_search ("assetId", embedding)
      values ($1, $2::vector)
      on conflict ("assetId")
      do update set embedding = excluded.embedding
    `,
    [asset.id, embedding],
  );
}
```

用户搜索时，再把搜索词编码成同一个 CLIP 模型的文本向量，用数据库向量距离排序：

```ts
export async function smartSearchByText(db: Db, ownerId: string, query: string, size = 100) {
  const embedding = await ml.encodeText(query, { language: 'zh' });

  const { rows } = await db.query(
    `
      select asset.*, smart_search.embedding <=> $2::vector as distance
      from asset
      join smart_search on smart_search."assetId" = asset.id
      where asset."ownerId" = $1
        and asset."deletedAt" is null
      order by distance asc
      limit $3
    `,
    [ownerId, embedding, size],
  );

  return rows;
}
```

关键点：

- 图片向量和文本向量必须使用同一个 CLIP 模型；推荐让算法服务统一使用自己的默认 CLIP 模型，业务端不要分别硬编码。
- `embedding` 是算法端返回的 JSON 字符串，Immich 会直接存到 `vector` 字段。
- 如果换模型，要确认向量维度并重建/清空旧索引，Immich 会在 `SmartInfoService` 里做维度检查。

### 6.3 示例二：人脸检测入库，并用向量距离做人物归并

Immich 的人脸流程分两步：

1. 调 `detectFaces` 得到人脸框和人脸 embedding，分别写入 `asset_face` 和 `face_search`。
2. 后续用 `face_search.embedding <=> 新人脸 embedding` 找相似脸，再决定归到已有 person 或创建新 person。

```ts
import { randomUUID } from 'node:crypto';

export async function detectAndSaveFaces(db: Db, asset: Asset) {
  const result = await ml.detectFaces(asset.previewPath, { minScore: 0.7 });

  for (const face of result.faces) {
    const faceId = randomUUID();

    // 真实项目里建议放到同一个事务里。
    await db.query(
      `
        insert into asset_face (
          id, "assetId", "imageHeight", "imageWidth",
          "boundingBoxX1", "boundingBoxY1", "boundingBoxX2", "boundingBoxY2"
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        faceId,
        asset.id,
        result.imageHeight,
        result.imageWidth,
        face.boundingBox.x1,
        face.boundingBox.y1,
        face.boundingBox.x2,
        face.boundingBox.y2,
      ],
    );

    await db.query(
      `
        insert into face_search ("faceId", embedding)
        values ($1, $2::vector)
        on conflict ("faceId")
        do update set embedding = excluded.embedding
      `,
      [faceId, face.embedding],
    );
  }

  return result.faces.length;
}
```

一个简化版人物归并逻辑如下。真实业务里还要考虑“这张脸是否已经有人物”“是否隐藏/删除”“出生日期约束”“人物封面”等规则；Immich 的完整逻辑在 `PersonService.handleRecognizeFaces`。

```ts
type FaceMatch = {
  id: string;
  personId: string | null;
  distance: number;
};

export async function assignFaceToPerson(
  db: Db,
  ownerId: string,
  faceId: string,
  faceEmbedding: string,
  options = { maxDistance: 0.5, minFaces: 3 },
) {
  const { rows: matches } = await db.query<FaceMatch>(
    `
      select
        asset_face.id,
        asset_face."personId" as "personId",
        face_search.embedding <=> $2::vector as distance
      from asset_face
      join face_search on face_search."faceId" = asset_face.id
      join asset on asset.id = asset_face."assetId"
      where asset."ownerId" = $1
        and asset."deletedAt" is null
      order by distance asc
      limit $3
    `,
    [ownerId, faceEmbedding, options.minFaces],
  );

  const closeMatches = matches.filter((match) => match.distance <= options.maxDistance);
  if (closeMatches.length < options.minFaces) {
    return null;
  }

  const existingPersonId = closeMatches.find((match) => match.personId)?.personId;
  const personId = existingPersonId ?? randomUUID();

  if (!existingPersonId) {
    await db.query('insert into person (id, "ownerId", "faceAssetId") values ($1, $2, $3)', [
      personId,
      ownerId,
      faceId,
    ]);
  }

  await db.query('update asset_face set "personId" = $1 where id = any($2::uuid[])', [
    personId,
    closeMatches.map((match) => match.id),
  ]);

  return personId;
}
```

关键点：

- `/predict` 的人脸 `boundingBox` 是像素坐标，配套 `imageHeight/imageWidth` 一起存。
- 人脸 embedding 也是 JSON 字符串，直接写入向量字段。
- `maxDistance` 越小越严格；Immich 默认人脸归并阈值是 `0.5`，最少相似脸数量默认是 `3`。

### 6.4 示例三：OCR 结果落库并支持文字搜索

算法端 OCR 返回的是数组结构，`box` 是扁平数组。Immich 的做法是每 8 个数字拆成一个四点框，同时把所有文本拼成一份搜索文本。

```ts
export async function indexOcr(db: Db, asset: Asset) {
  const ocr = await ml.ocr(asset.previewPath, {
    minDetectionScore: 0.5,
    minRecognitionScore: 0.8,
    maxResolution: 736,
  });

  await db.query('delete from asset_ocr where "assetId" = $1', [asset.id]);

  for (let i = 0; i < ocr.text.length; i++) {
    const offset = i * 8;
    await db.query(
      `
        insert into asset_ocr (
          "assetId",
          x1, y1, x2, y2, x3, y3, x4, y4,
          "boxScore", "textScore", text
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        asset.id,
        ocr.box[offset],
        ocr.box[offset + 1],
        ocr.box[offset + 2],
        ocr.box[offset + 3],
        ocr.box[offset + 4],
        ocr.box[offset + 5],
        ocr.box[offset + 6],
        ocr.box[offset + 7],
        ocr.boxScore[i],
        ocr.textScore[i],
        ocr.text[i],
      ],
    );
  }

  const searchText = ocr.text.join(' ');
  await db.query(
    `
      insert into ocr_search ("assetId", text)
      values ($1, $2)
      on conflict ("assetId")
      do update set text = excluded.text
    `,
    [asset.id, searchText],
  );
}
```

关键点：

- OCR 的框坐标是归一化坐标，范围通常是 `0~1`，前端画框时再乘以图片宽高。
- `text`、`box`、`boxScore`、`textScore` 的索引一一对应。
- 搜索文本建议额外放一张检索表，方便加 trigram/全文索引。

### 6.5 示例四：分类 + 目标检测转成相册标签

Immich 的分类流程会先跑 `/classify`，再可选跑 `/detect`，最后把两类结果统一写成图片标签。下面是简化版：

```ts
const PERSON_CLASS = 'person';
const PET_CLASSES: Record<string, string> = {
  dog: 'pet_dog',
  cat: 'pet_cat',
  bird: 'pet_bird',
};

function maxConfidence(items: { confidence: number }[]) {
  return Math.max(...items.map((item) => item.confidence));
}

function avgConfidence(items: { confidence: number }[]) {
  return items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
}

function detectionsToTags(detections: DetectionResult[]): ClassificationResult[] {
  const byClass = new Map<string, DetectionResult[]>();

  for (const detection of detections) {
    byClass.set(detection.className, [...(byClass.get(detection.className) ?? []), detection]);
  }

  const tags: ClassificationResult[] = [];
  const persons = byClass.get(PERSON_CLASS) ?? [];

  if (persons.length === 1) {
    tags.push({ categoryName: 'single_person', confidence: persons[0].confidence });
  } else if (persons.length === 2) {
    tags.push({ categoryName: 'two_people', confidence: avgConfidence(persons) });
  } else if (persons.length >= 3) {
    tags.push({ categoryName: 'multiple_people', confidence: avgConfidence(persons) });
  }

  let maxPetConfidence = 0;
  for (const [className, tagName] of Object.entries(PET_CLASSES)) {
    const detectionsForClass = byClass.get(className) ?? [];
    if (detectionsForClass.length > 0) {
      const confidence = maxConfidence(detectionsForClass);
      tags.push({ categoryName: tagName, confidence });
      maxPetConfidence = Math.max(maxPetConfidence, confidence);
    }
  }

  if (persons.length > 0 && maxPetConfidence > 0) {
    tags.push({
      categoryName: 'person_with_pet',
      confidence: Math.min(maxConfidence(persons), maxPetConfidence),
    });
  }

  return tags;
}

export async function classifyAndTagAsset(db: Db, asset: Asset) {
  const classificationTags = await ml.classifyImage(asset.previewPath, {
    categories: ['landscape', 'portrait', 'food', 'animal', 'document'],
    minScore: 0.15,
    maxResults: 5,
  });

  const detections = await ml.detectObjects(asset.previewPath, { minScore: 0.25 });
  const detectionTags = detectionsToTags(detections);

  const tags = [...classificationTags, ...detectionTags];

  await db.query('delete from asset_categories where "assetId" = $1', [asset.id]);
  for (const tag of tags) {
    await db.query(
      `
        insert into asset_categories ("assetId", "categoryName", confidence)
        values ($1, $2, $3)
      `,
      [asset.id, tag.categoryName, tag.confidence],
    );
  }

  return tags;
}
```

关键点：

- `/classify` 适合“整张图是什么场景/类别”。
- `/detect` 适合“图里有什么目标”，比如 person/dog/cat。
- `/detect` 的 `bbox` 是归一化坐标，适合前端画目标框或做二次规则。
- 如果你换了自己的检测模型，后处理规则里的 `person/dog/cat` 这些 `className` 要和算法端 `detection_classes.py` 里的输出保持一致。

### 6.6 示例五：上传完成后异步调度

一个更接近 Immich 的后端结构是：上传接口只保存原图并生成预览图，然后投递异步任务。异步 worker 再调用上面的 `MlClient`。

```ts
type Queue = {
  add(name: string, data: unknown): Promise<void>;
};

export async function afterPreviewGenerated(queue: Queue, assetId: string) {
  await queue.add('smart-search', { assetId });
  await queue.add('face-detection', { assetId });
  await queue.add('ocr', { assetId });
  await queue.add('classification', { assetId });
}

export async function smartSearchWorker(db: Db, asset: Asset) {
  await indexAssetForSmartSearch(db, asset);
}

export async function faceDetectionWorker(db: Db, asset: Asset) {
  await detectAndSaveFaces(db, asset);
}

export async function ocrWorker(db: Db, asset: Asset) {
  await indexOcr(db, asset);
}

export async function classificationWorker(db: Db, asset: Asset) {
  await classifyAndTagAsset(db, asset);
}
```

这样做有几个好处：

- 算法端首次加载模型、下载模型、GPU 排队都不会阻塞上传接口。
- 某个算法失败时，只需要重跑对应 job，不影响资产本身。
- Smart Search、人脸、OCR、分类可以独立开关，也可以分别设置并发数。
