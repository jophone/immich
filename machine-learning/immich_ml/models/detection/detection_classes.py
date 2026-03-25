"""
检测模型关注类别配置。

修改说明:
- 键 = 模型输出的 class_id（COCO 数据集的类别索引）
- 值 = 语义类别名（将传递给 Server 端后处理）
- 自定义模型: 替换为你训练模型的 class_id → class_name 映射
"""

from __future__ import annotations

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
