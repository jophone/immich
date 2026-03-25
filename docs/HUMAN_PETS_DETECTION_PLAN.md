# YOLO 检测模型集成方案：人数统计 + 宠物识别 + 人宠共现

## Context

"人/宠物" 大类已在 `ImageNet_Taxonomy.csv` 中定义了 26 个 L3 标签（人物主体 15、宠物主体 8、人宠共现 3），但 YOLO26l-cls **分类模型**只能对整张图做分类，无法计数人或物体。需要引入 YOLO **检测模型**来获取目标边界框和类别，再通过后处理映射到正确的 L3 标签。

由于分类模型不包含"人"相关的标签，无法基于分类结果判断是否需要运行检测，因此检测对**每张图片无条件执行**。

## 总体架构

```
Classification Job (Server)
  ① POST /classify → 分类结果 (portrait, animal, ...)
  ② POST /detect → 检测结果 [{className, confidence, bbox}]   ← 无条件执行
  ③ 后处理: 检测计数 → 子类别标签 (single_person, pet_dog, ...)
  ④ 合并分类 + 检测衍生标签 → 存入 asset_categories
```

---

## 阶段一：ML 服务 — YoloDetectionModel

### 1.1 新建文件：`machine-learning/immich_ml/models/detection/__init__.py`

空文件，标记 Python 包。

### 1.2 新建文件：`machine-learning/immich_ml/models/detection/yolo_detect.py`

参照 `YoloClassificationModel`（`models/classification/yolo.py`）的模式：

```python
@dataclass
class Detection:
    class_id: int
    class_name: str
    confidence: float
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 (归一化 0~1)

class YoloDetectionModel:
    def __init__(self, model_name, cache_dir=None, session=None,
                 conf_threshold=0.25, iou_threshold=0.45):
        self.model_name = clean_name(model_name)
        self.cache_dir = ...
        self.session = session
        self.loaded = False
        self.input_size = 640
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold

    def load(self): ...
    def predict(self, image: Image, classes_of_interest: dict[int, str] | None = None) -> list[Detection]: ...
```

**预处理 (`_preprocess`)：**
- letterbox resize 到 input_size×input_size，保持宽高比，填充灰色(114)
- 归一化到 [0, 1]，HWC → CHW 转置，expand_dims 到 [1, 3, H, W]
- 返回 `(tensor, scale_info)` 用于坐标反算

**推理 + 自动 NMS 适配 (`predict`)：**
```python
outputs = session.run(None, {self.input_name: tensor})

if self._is_end2end_output(outputs):
    # 免 NMS 模型：直接解析 [batch_id, x1, y1, x2, y2, class_id, score] 或类似格式
    detections = self._parse_end2end(outputs, classes_of_interest)
else:
    # 标准模型：需要 NMS
    detections = self._parse_standard_and_nms(outputs, classes_of_interest)
```

**NMS / 免 NMS 自动判断 (`_is_end2end_output`)：**
```python
def _is_end2end_output(self, outputs: list) -> bool:
    """判断模型输出是否为免 NMS 格式。

    免 NMS 模型的典型输出：
    - 多输出: num_dets[1,1] + boxes[1,N,4] + scores[1,N] + labels[1,N]  (YOLOv8/v11 end2end)
    - 单输出: [1, N, 7] 其中 7 = batch_id + x1,y1,x2,y2 + class_id + score (YOLOv10)
    - 单输出: [1, N, 6] 其中 6 = x1,y1,x2,y2 + score + class_id

    标准模型的输出：
    - [1, 4+num_classes, num_anchors]  num_classes ≥ 80, num_anchors >> 1000
    """
    if len(outputs) >= 3:
        return True   # 多输出 = end2end (num_dets, boxes, scores, labels)

    output = outputs[0]
    shape = output.shape  # e.g. [1, 8400, 84] or [1, 300, 6]
    if len(shape) == 3:
        last_dim = shape[-1]
        # end2end: 最后一维很小 (6 或 7)；标准: 最后一维 = 4 + num_classes (≥ 84)
        if last_dim <= 10:
            return True
        # 也检查转置情况：[1, 84, 8400] 标准 vs [1, 6, 300] end2end(极少见)
        if shape[1] <= 10 and shape[2] > 100:
            return True
    return False
```

**标准后处理 (`_parse_standard_and_nms`)：**
1. 若 shape 为 [1, 84, N]，transpose → [N, 84]
2. 前 4 列 = cx, cy, w, h → 转换为 x1, y1, x2, y2
3. 后 80 列取 argmax 得 class_id，取 max 得 class_score
4. 过滤 conf_threshold
5. 仅保留 `classes_of_interest` 中的类别
6. numpy NMS (按类别分组，IoU 阈值 `iou_threshold`)
7. 坐标用 scale_info 反算回原图归一化比例

**免 NMS 后处理 (`_parse_end2end`)：**
- 多输出格式：从 `boxes/scores/labels` 直接提取
- 单输出格式 [1, N, 6/7]：按列索引直接提取
- 过滤 conf_threshold + `classes_of_interest`

**NMS 实现 (`_nms`)：** 纯 numpy 实现，无外部依赖：
```python
def _nms(self, boxes, scores, iou_threshold):
    """Standard NMS: returns indices to keep."""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= iou_threshold]
    return keep
```

**模型路径优先级：**
```python
@property
def _cache_dir_default(self) -> Path:
    model_slug = self.model_name.casefold()
    repo_root = Path(__file__).resolve().parents[4]
    candidates = [
        Path("/root/snap/model/yolo26"),                 # ① 用户本地优先路径
        repo_root / "model-cache" / model_slug,           # ② 项目 model-cache
        settings.cache_folder / model_slug,               # ③ ML 缓存目录
        settings.cache_folder / "detection" / model_slug, # ④ detection 子目录
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[1]  # 默认回退到项目 model-cache
```

### 1.3 新建文件：`machine-learning/immich_ml/models/detection/detection_classes.py`

**独立可维护的关注类别配置**，方便后续自定义模型修改：

```python
"""
检测模型关注类别配置。

修改说明:
- 键 = 模型输出的 class_id（COCO 数据集的类别索引）
- 值 = 语义类别名（将传递给 Server 端后处理）
- 自定义模型: 替换为你训练模型的 class_id → class_name 映射
"""

# 默认 COCO 数据集关注类别
DETECTION_CLASSES_OF_INTEREST: dict[int, str] = {
    0: "person",
    14: "bird",
    15: "cat",
    16: "dog",
    17: "horse",
    18: "sheep",
    19: "cow",
    20: "elephant",
    21: "bear",
    22: "zebra",
    23: "giraffe",
}
```

`YoloDetectionModel.predict()` 默认使用此配置，也可通过参数覆盖：
```python
def predict(self, image, classes_of_interest=None):
    if classes_of_interest is None:
        from .detection_classes import DETECTION_CLASSES_OF_INTEREST
        classes_of_interest = DETECTION_CLASSES_OF_INTEREST
    ...
```

---

## 阶段二：ML 服务 — `/detect` 端点

### 修改文件：`machine-learning/immich_ml/main.py`

新增 `/detect` 端点，与 `/classify` 平行：

```python
from immich_ml.models.detection.yolo_detect import YoloDetectionModel
from immich_ml.models.detection.detection_classes import DETECTION_CLASSES_OF_INTEREST

detection_model_cache: dict[str, YoloDetectionModel] = {}

@app.post("/detect", dependencies=[Depends(update_state)])
async def detect(
    image: bytes = File(),
    model_name: str = Form(default="yolo11n"),
    min_score: float = Form(default=0.25),
) -> Any:
    pil_image = await run(lambda: decode_pil(image))
    detector = _get_detection_model(model_name)
    await run(detector.load)
    detections = await run(detector.predict, pil_image)  # 使用默认 DETECTION_CLASSES_OF_INTEREST

    results = [
        {
            "className": d.class_name,
            "confidence": round(d.confidence, 4),
            "bbox": {"x1": d.bbox[0], "y1": d.bbox[1], "x2": d.bbox[2], "y2": d.bbox[3]},
        }
        for d in detections
        if d.confidence >= min_score
    ]
    return ORJSONResponse({"detections": results})


def _get_detection_model(model_name: str) -> YoloDetectionModel:
    cache_key = clean_name(model_name)
    with lock:
        if cache_key not in detection_model_cache:
            detection_model_cache[cache_key] = YoloDetectionModel(model_name)
        return detection_model_cache[cache_key]
```

**lifespan 清理：** 在 `lifespan()` 的 `finally` 中添加 `detection_model_cache.clear()`。

---

## 阶段三：Server — ML Repository 扩展

### 修改文件：`server/src/repositories/machine-learning.repository.ts`

新增类型和方法：

```typescript
// === 新增类型 ===
export type DetectionResult = {
  className: string;
  confidence: number;
  bbox: { x1: number; y1: number; x2: number; y2: number };
};
export type DetectionResponse = { detections: DetectionResult[] };
export type DetectionOptions = {
  modelName: string;
  minScore: number;
};

// === 新增方法 ===
async detectObjects(
  imagePath: string,
  { modelName, minScore }: DetectionOptions,
): Promise<DetectionResult[]> {
  const fileBuffer = await readFile(imagePath);
  const formData = new FormData();
  formData.append('image', new Blob([new Uint8Array(fileBuffer)]));
  formData.append('model_name', modelName);
  formData.append('min_score', String(minScore));
  const data = await this.postWithFailover<DetectionResponse>('/detect', formData, 'detect');
  return data.detections;
}
```

---

## 阶段四：Server — 分类服务增强（无条件检测 + 动态后处理）

### 修改文件：`server/src/services/classification.service.ts`

**handleClassification() 改造：**

```typescript
async handleClassification({ id }: JobOf<JobName.Classification>): Promise<JobStatus> {
  // ... 现有校验逻辑不变 ...

  const { classification } = machineLearning;

  // ① 运行分类（现有逻辑）
  const classificationResults = await this.machineLearningRepository.classifyImage(...);

  // ② 无条件运行检测（如果 detection 已启用）
  let detectionCategories: { categoryName: string; confidence: number }[] = [];
  if (classification.detection?.enabled) {
    try {
      detectionCategories = await this.runDetectionAndPostProcess(
        asset.previewFile,
        classification.detection,
      );
    } catch (error) {
      this.logger.warn(`Detection failed for asset ${id}, skipping: ${error}`);
    }
  }

  // ③ 合并结果
  const allCategories = [...classificationResults, ...detectionCategories].map((r) => ({
    assetId: id,
    categoryName: r.categoryName,
    confidence: r.confidence,
  }));

  await this.categoryRepository.upsert(id, allCategories);
  await this.assetRepository.upsertJobStatus({ assetId: id, classifiedAt: new Date() });
  return JobStatus.Success;
}
```

### 动态后处理逻辑：`runDetectionAndPostProcess()`

基于检测到的类别**动态**生成 L3 标签，不硬编码具体的 className：

```typescript
/**
 * 检测类别 → L3 标签的映射规则。
 *
 * 维护说明：
 * - 修改 PERSON_CLASS / PET_CLASSES / COPRESENCE_RULES 即可适配不同检测模型
 * - 所有规则基于 ML 检测返回的 className（由 detection_classes.py 定义）
 */

// 哪个 className 代表"人"
const PERSON_CLASS = 'person';

// 检测类别 → L3 宠物标签
const PET_CLASSES: Record<string, string> = {
  dog: 'pet_dog',
  cat: 'pet_cat',
  bird: 'pet_bird',
  // 以下动物从 COCO 检测到时，可映射到"其他宠物"或不映射
  // horse, sheep, cow, elephant, bear, zebra, giraffe 暂不映射为宠物
};

// 人 + 特定宠物 → L3 共现标签
const COPRESENCE_RULES: Record<string, string> = {
  dog: 'person_with_dog',
  cat: 'person_with_cat',
  // 通配：任意宠物共现 → person_with_pet（在代码中单独处理）
};

private async runDetectionAndPostProcess(
  previewFile: string,
  config: DetectionConfig,
): Promise<{ categoryName: string; confidence: number }[]> {
  const detections = await this.machineLearningRepository.detectObjects(previewFile, {
    modelName: config.modelName,
    minScore: config.minScore,
  });

  if (detections.length === 0) return [];

  // 按 className 分组
  const byClass = new Map<string, DetectionResult[]>();
  for (const d of detections) {
    const list = byClass.get(d.className) ?? [];
    list.push(d);
    byClass.set(d.className, list);
  }

  const results: { categoryName: string; confidence: number }[] = [];
  const persons = byClass.get(PERSON_CLASS) ?? [];

  // === 人数统计 ===
  if (persons.length === 1) {
    results.push({ categoryName: 'single_person', confidence: persons[0].confidence });
  } else if (persons.length === 2) {
    results.push({ categoryName: 'two_people', confidence: avg(persons) });
  } else if (persons.length >= 3) {
    results.push({ categoryName: 'multiple_people', confidence: avg(persons) });
  }

  // === 宠物识别（动态遍历 PET_CLASSES）===
  let anyPetDetected = false;
  let maxPetConfidence = 0;
  for (const [className, tagName] of Object.entries(PET_CLASSES)) {
    const items = byClass.get(className);
    if (items && items.length > 0) {
      const conf = Math.max(...items.map((d) => d.confidence));
      results.push({ categoryName: tagName, confidence: conf });
      anyPetDetected = true;
      maxPetConfidence = Math.max(maxPetConfidence, conf);
    }
  }

  // === 人宠共现（动态遍历 COPRESENCE_RULES）===
  if (persons.length > 0) {
    const personConf = Math.max(...persons.map((d) => d.confidence));
    for (const [className, tagName] of Object.entries(COPRESENCE_RULES)) {
      const items = byClass.get(className);
      if (items && items.length > 0) {
        results.push({
          categoryName: tagName,
          confidence: Math.min(personConf, Math.max(...items.map((d) => d.confidence))),
        });
      }
    }
    // 通配共现：人 + 任意宠物
    if (anyPetDetected) {
      results.push({
        categoryName: 'person_with_pet',
        confidence: Math.min(personConf, maxPetConfidence),
      });
    }
  }

  return results;
}
```

**可维护性说明：** 如果用户未来更换自定义检测模型：
1. ML 端：修改 `detection_classes.py` 中的 `DETECTION_CLASSES_OF_INTEREST`
2. Server 端：修改 `PERSON_CLASS` / `PET_CLASSES` / `COPRESENCE_RULES` 常量

---

## 阶段五：配置

### 修改文件：`server/src/config.ts`

在 `machineLearning.classification` 中新增 `detection` 子配置：

```typescript
classification: {
  enabled: true,
  modelName: 'YOLO26l-cls',
  minScore: 0.15,
  maxResults: 5,
  categories: [...],
  detection: {                    // <-- 新增
    enabled: true,
    modelName: 'yolo11n',         // 检测模型名称，可配置
    minScore: 0.25,               // 检测置信度阈值
  },
},
```

### 修改文件：`server/src/dtos/model-config.dto.ts`

新增 `ClassificationDetectionConfig` DTO 并在 `ClassificationConfig` 中引用：

```typescript
class ClassificationDetectionConfig {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  modelName!: string;

  @IsNumber() @Min(0) @Max(1)
  minScore!: number;
}
```

---

## 阶段六：待确认/后续增强

以下子类别**无法仅通过检测模型实现**，需后续探索：

| 子类别 | 难点 | 可能方案 |
|--------|------|----------|
| selfie（自拍）| 需判断拍摄角度与距离 | bbox 面积占比 + 人脸位置启发式 |
| half/full_body_portrait | 需判断人体裁切比例 | 人体 bbox 高度与图像高度的比例 |
| id_photo（证件照）| 需判断背景和构图 | 单人 + 纯色背景 + 正面 |
| close_up_portrait（人像特写）| 需判断人脸占比 | 结合人脸检测 bbox 面积比 |
| parent_child_photo 等关系类 | 需语义理解 | CLIP / 多模态模型 |

**本次实现范围：** single_person, two_people, multiple_people, pet_dog, pet_cat, pet_bird, person_with_dog, person_with_cat, person_with_pet（共 9 个标签）。

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `machine-learning/immich_ml/models/detection/__init__.py` | 新建 | Python 包标记 |
| `machine-learning/immich_ml/models/detection/detection_classes.py` | 新建 | 可维护的关注类别配置 |
| `machine-learning/immich_ml/models/detection/yolo_detect.py` | 新建 | YOLO 检测模型（预处理 + NMS/免NMS 自适应 + 后处理） |
| `machine-learning/immich_ml/main.py` | 修改 | `/detect` 端点 + 检测模型缓存 + lifespan 清理 |
| `server/src/repositories/machine-learning.repository.ts` | 修改 | `detectObjects()` + 类型 |
| `server/src/services/classification.service.ts` | 修改 | 无条件检测 + 动态后处理 |
| `server/src/config.ts` | 修改 | `detection` 子配置 |
| `server/src/dtos/model-config.dto.ts` | 修改 | `ClassificationDetectionConfig` DTO |

## 验证方案

1. **ML 服务单元测试**：用一张含多人+狗的测试图，验证 `/detect` 返回正确的检测数量和类别
2. **NMS 适配测试**：分别用需要 NMS 和免 NMS 的模型验证 `_is_end2end_output` 判断正确
3. **Server 单元测试**：mock ML 检测结果，验证后处理输出正确的 L3 标签
   - `pnpm --filter immich run test -- --run src/services/classification.service.spec.ts`
4. **集成测试**：上传含人/宠物照片，确认 `asset_categories` 表出现 `single_person`/`pet_dog` 等标签
5. **Web 验证**：Explore → "人/宠物" → 应展示正确的 L2 分组和资产
