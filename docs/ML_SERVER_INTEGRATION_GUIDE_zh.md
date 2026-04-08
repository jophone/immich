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

#### 示例 A：文本转 embedding（智能搜索文本向量）

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"clip":{"textual":{"modelName":"ViT-B-32__openai"}}}' \
  -F 'text=beach sunset'
```

背后算法：CLIP 文本编码器（OpenCLIP 或 MCLIP 变体）。

#### 示例 B：图片转 embedding（智能搜索图片向量）

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"clip":{"visual":{"modelName":"ViT-B-32__openai"}}}' \
  -F 'image=@/tmp/a.jpg'
```

背后算法：CLIP 视觉编码器。

#### 示例 C：人脸检测 + 人脸特征提取

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"facial-recognition":{"detection":{"modelName":"buffalo_l","options":{"minScore":0.7}},"recognition":{"modelName":"buffalo_l"}}}' \
  -F 'image=@/tmp/a.jpg'
```

背后算法：

- 检测：InsightFace RetinaFace
- 识别特征：InsightFace ArcFace（输出 512 维 embedding）

#### 示例 D：OCR（文字检测 + 文字识别）

```bash
curl -X POST http://127.0.0.1:3003/predict \
  -F 'entries={"ocr":{"detection":{"modelName":"PP-OCRv5_mobile","options":{"minScore":0.5,"maxResolution":736}},"recognition":{"modelName":"PP-OCRv5_mobile","options":{"minScore":0.8}}}}' \
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
- `model_name`：默认 `YOLO26l-cls`
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
- `model_name`（默认 `yolov8l`）
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
  -F 'entries={"clip":{"textual":{"modelName":"ViT-B-32__openai"}}}' \
  -F 'text=beach sunset'
```

预期关注字段：

- 返回 JSON 中有 `clip`
- `clip` 是字符串（内容是 embedding 的 JSON 字符串）

#### 步骤 4：测试 `POST /predict`（图片 -> CLIP embedding）

```bash
curl -s -X POST "$ML_URL/predict" \
  -F 'entries={"clip":{"visual":{"modelName":"ViT-B-32__openai"}}}' \
  -F "image=@$IMG"
```

预期关注字段：

- 有 `clip`
- 有 `imageHeight` / `imageWidth`

#### 步骤 5：测试 `POST /predict`（人脸检测+识别）

```bash
curl -s -X POST "$ML_URL/predict" \
  -F 'entries={"facial-recognition":{"detection":{"modelName":"buffalo_l","options":{"minScore":0.7}},"recognition":{"modelName":"buffalo_l"}}}' \
  -F "image=@$IMG"
```

预期关注字段：

- 有 `facial-recognition`（数组）
- 数组元素里有 `boundingBox`、`embedding`、`score`

#### 步骤 6：测试 `POST /predict`（OCR）

```bash
curl -s -X POST "$ML_URL/predict" \
  -F 'entries={"ocr":{"detection":{"modelName":"PP-OCRv5_mobile","options":{"minScore":0.5,"maxResolution":736}},"recognition":{"modelName":"PP-OCRv5_mobile","options":{"minScore":0.8}}}}' \
  -F "image=@$IMG"
```

预期关注字段：

- 有 `ocr`
- `ocr` 下通常包含 `text`、`box`、`boxScore`、`textScore`

#### 步骤 7：测试 `POST /classify`

```bash
curl -s -X POST "$ML_URL/classify" \
  -F "image=@$IMG" \
  -F 'model_name=YOLO26l-cls' \
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
  -F 'model_name=yolov8l' \
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
