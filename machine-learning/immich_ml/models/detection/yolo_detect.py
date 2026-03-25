from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from immich_ml.config import clean_name, log, settings
from immich_ml.models.transforms import decode_pil
from immich_ml.sessions.ort import OrtSession

from .detection_classes import DETECTION_CLASSES_OF_INTEREST


@dataclass
class Detection:
    class_id: int
    class_name: str
    confidence: float
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 (归一化 0~1)


@dataclass
class LetterboxInfo:
    """Stores letterbox transform parameters for coordinate reverse-mapping."""

    scale: float
    pad_w: float
    pad_h: float
    orig_w: int
    orig_h: int


class YoloDetectionModel:
    """YOLO detection model for object counting and identification.

    Supports both standard (NMS-required) and end-to-end (NMS-free) YOLO models.
    """

    def __init__(
        self,
        model_name: str,
        cache_dir: Path | str | None = None,
        session: OrtSession | None = None,
        conf_threshold: float = 0.25,
        iou_threshold: float = 0.45,
    ) -> None:
        self.model_name = clean_name(model_name)
        self.cache_dir = Path(cache_dir) if cache_dir is not None else self._cache_dir_default
        self.session: OrtSession | None = session
        self.loaded = session is not None
        self.input_name = "images"
        self.input_size = 640
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold

    def load(self) -> None:
        if self.loaded:
            return

        model_path = self.model_path
        if not model_path.is_file():
            raise FileNotFoundError(f"Detection model file not found: '{model_path}'")

        log.info(f"Loading local detection model '{self.model_name}' from {model_path}")
        session = OrtSession(model_path)
        input_node = session.get_inputs()[0]
        self.session = session
        self.input_name = input_node.name or "images"

        # Infer input size from model
        shape = input_node.shape
        if len(shape) == 4:
            h = shape[2] if isinstance(shape[2], int) and shape[2] > 0 else 640
            self.input_size = h

        self.loaded = True

    def predict(
        self,
        inputs: Image.Image | bytes,
        classes_of_interest: dict[int, str] | None = None,
    ) -> list[Detection]:
        self.load()
        session = self.session
        if session is None:
            raise RuntimeError(f"Detection model '{self.model_name}' is not loaded")

        if classes_of_interest is None:
            classes_of_interest = DETECTION_CLASSES_OF_INTEREST

        image = decode_pil(inputs)
        tensor, letterbox_info = self._preprocess(image)
        outputs = session.run(None, {self.input_name: tensor})

        if self._is_end2end_output(outputs):
            detections = self._parse_end2end(outputs, letterbox_info, classes_of_interest)
        else:
            detections = self._parse_standard_and_nms(outputs, letterbox_info, classes_of_interest)

        return detections

    # ------------------------------------------------------------------
    # Model path resolution
    # ------------------------------------------------------------------

    @property
    def model_path(self) -> Path:
        candidates = [
            self.cache_dir / "model.onnx",
            self.cache_dir / f"{self.model_name.casefold()}.onnx",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return candidate

        onnx_files = sorted(self.cache_dir.glob("*.onnx")) if self.cache_dir.is_dir() else []
        if len(onnx_files) == 1:
            return onnx_files[0]

        return candidates[0]

    @property
    def _cache_dir_default(self) -> Path:
        model_slug = self.model_name.casefold()
        repo_root = Path(__file__).resolve().parents[4]
        candidates = [
            Path("/root/snap/model/yolo26"),
            repo_root / "model-cache" / model_slug,
            settings.cache_folder / model_slug,
            settings.cache_folder / "detection" / model_slug,
        ]
        for candidate in candidates:
            if candidate.is_dir():
                return candidate
        return candidates[1]

    # ------------------------------------------------------------------
    # Preprocessing: letterbox resize
    # ------------------------------------------------------------------

    def _preprocess(self, image: Image.Image) -> tuple[NDArray[np.float32], LetterboxInfo]:
        orig_w, orig_h = image.size
        target = self.input_size

        scale = min(target / orig_w, target / orig_h)
        new_w = int(orig_w * scale)
        new_h = int(orig_h * scale)

        resized = image.resize((new_w, new_h), resample=Image.Resampling.BILINEAR)
        resized_np = np.asarray(resized.convert("RGB"), dtype=np.float32)

        # Pad to target size with gray (114)
        pad_w = (target - new_w) / 2.0
        pad_h = (target - new_h) / 2.0
        top, bottom = int(round(pad_h - 0.1)), int(round(pad_h + 0.1))
        left, right = int(round(pad_w - 0.1)), int(round(pad_w + 0.1))

        padded = np.full((target, target, 3), 114.0, dtype=np.float32)
        padded[top : top + new_h, left : left + new_w, :] = resized_np

        # Normalize to [0, 1], HWC -> CHW, add batch dim
        tensor = padded / 255.0
        tensor = tensor.transpose(2, 0, 1)
        tensor = np.expand_dims(np.ascontiguousarray(tensor), 0)

        info = LetterboxInfo(scale=scale, pad_w=pad_w, pad_h=pad_h, orig_w=orig_w, orig_h=orig_h)
        return tensor, info

    # ------------------------------------------------------------------
    # NMS / end-to-end auto-detection
    # ------------------------------------------------------------------

    def _is_end2end_output(self, outputs: list[NDArray[Any]]) -> bool:
        """Determine if model output is NMS-free (end-to-end).

        End-to-end patterns:
        - Multi-output: num_dets[1,1] + boxes[1,N,4] + scores[1,N] + labels[1,N]
        - Single output [1, N, 7]: batch_id, x1, y1, x2, y2, class_id, score (YOLOv10)
        - Single output [1, N, 6]: x1, y1, x2, y2, score, class_id

        Standard pattern:
        - [1, 4+num_classes, num_anchors] where num_classes >= 80
        """
        if len(outputs) >= 3:
            return True

        output = outputs[0]
        shape = output.shape
        if len(shape) == 3:
            if shape[-1] <= 10:
                return True
            if shape[1] <= 10 and shape[2] > 100:
                return True
        return False

    # ------------------------------------------------------------------
    # Standard YOLO post-processing (with NMS)
    # ------------------------------------------------------------------

    def _parse_standard_and_nms(
        self,
        outputs: list[NDArray[Any]],
        info: LetterboxInfo,
        classes_of_interest: dict[int, str],
    ) -> list[Detection]:
        output = np.asarray(outputs[0], dtype=np.float32)

        # Handle shape: [1, 84, N] -> transpose to [N, 84], or [1, N, 84] -> squeeze
        if output.ndim == 3:
            output = output[0]  # remove batch dim -> [84, N] or [N, 84]

        # If shape is [num_features, num_anchors] where num_features < num_anchors, transpose
        if output.shape[0] < output.shape[1]:
            output = output.T  # -> [N, 84]

        num_cols = output.shape[1]
        if num_cols < 5:
            log.warning(f"Unexpected detection output columns: {num_cols}")
            return []

        # Extract boxes: cx, cy, w, h -> x1, y1, x2, y2 (in input-space pixels)
        cx, cy, w, h = output[:, 0], output[:, 1], output[:, 2], output[:, 3]
        x1 = cx - w / 2
        y1 = cy - h / 2
        x2 = cx + w / 2
        y2 = cy + h / 2

        # Class scores: columns [4:]
        class_scores = output[:, 4:]
        class_ids = np.argmax(class_scores, axis=1)
        confidences = class_scores[np.arange(len(class_ids)), class_ids]

        # Filter by confidence
        mask = confidences >= self.conf_threshold
        x1, y1, x2, y2 = x1[mask], y1[mask], x2[mask], y2[mask]
        class_ids = class_ids[mask]
        confidences = confidences[mask]

        # Filter by classes of interest
        interest_ids = set(classes_of_interest.keys())
        interest_mask = np.array([cid in interest_ids for cid in class_ids], dtype=bool)
        if not np.any(interest_mask):
            return []
        x1, y1, x2, y2 = x1[interest_mask], y1[interest_mask], x2[interest_mask], y2[interest_mask]
        class_ids = class_ids[interest_mask]
        confidences = confidences[interest_mask]

        # Per-class NMS
        boxes = np.stack([x1, y1, x2, y2], axis=1)
        keep_indices: list[int] = []
        for cid in np.unique(class_ids):
            cls_mask = class_ids == cid
            cls_boxes = boxes[cls_mask]
            cls_scores = confidences[cls_mask]
            cls_indices = np.where(cls_mask)[0]
            kept = self._nms(cls_boxes, cls_scores, self.iou_threshold)
            keep_indices.extend(cls_indices[kept].tolist())

        # Build detections with normalized coordinates
        detections: list[Detection] = []
        for idx in keep_indices:
            bx1, by1, bx2, by2 = self._to_normalized(
                float(boxes[idx, 0]), float(boxes[idx, 1]),
                float(boxes[idx, 2]), float(boxes[idx, 3]),
                info,
            )
            cid = int(class_ids[idx])
            detections.append(Detection(
                class_id=cid,
                class_name=classes_of_interest[cid],
                confidence=float(confidences[idx]),
                bbox=(bx1, by1, bx2, by2),
            ))

        return detections

    # ------------------------------------------------------------------
    # End-to-end YOLO post-processing (NMS-free)
    # ------------------------------------------------------------------

    def _parse_end2end(
        self,
        outputs: list[NDArray[Any]],
        info: LetterboxInfo,
        classes_of_interest: dict[int, str],
    ) -> list[Detection]:
        if len(outputs) >= 4:
            return self._parse_end2end_multi_output(outputs, info, classes_of_interest)
        return self._parse_end2end_single_output(outputs, info, classes_of_interest)

    def _parse_end2end_multi_output(
        self,
        outputs: list[NDArray[Any]],
        info: LetterboxInfo,
        classes_of_interest: dict[int, str],
    ) -> list[Detection]:
        """Parse multi-output end2end: num_dets, boxes, scores, labels."""
        num_dets = int(outputs[0].flatten()[0])
        boxes_raw = np.asarray(outputs[1], dtype=np.float32).reshape(-1, 4)[:num_dets]
        scores = np.asarray(outputs[2], dtype=np.float32).flatten()[:num_dets]
        labels = np.asarray(outputs[3], dtype=np.float32).flatten()[:num_dets].astype(int)

        detections: list[Detection] = []
        interest_ids = set(classes_of_interest.keys())
        for i in range(num_dets):
            if scores[i] < self.conf_threshold:
                continue
            cid = int(labels[i])
            if cid not in interest_ids:
                continue
            bx1, by1, bx2, by2 = self._to_normalized(
                float(boxes_raw[i, 0]), float(boxes_raw[i, 1]),
                float(boxes_raw[i, 2]), float(boxes_raw[i, 3]),
                info,
            )
            detections.append(Detection(
                class_id=cid,
                class_name=classes_of_interest[cid],
                confidence=float(scores[i]),
                bbox=(bx1, by1, bx2, by2),
            ))
        return detections

    def _parse_end2end_single_output(
        self,
        outputs: list[NDArray[Any]],
        info: LetterboxInfo,
        classes_of_interest: dict[int, str],
    ) -> list[Detection]:
        """Parse single-output end2end: [1, N, 6] or [1, N, 7]."""
        output = np.asarray(outputs[0], dtype=np.float32)
        if output.ndim == 3:
            output = output[0]  # [N, cols]

        cols = output.shape[1]
        interest_ids = set(classes_of_interest.keys())
        detections: list[Detection] = []

        for row in output:
            if cols == 7:
                # YOLOv10 format: batch_id, x1, y1, x2, y2, score, class_id
                score, cid = float(row[5]), int(row[6])
                rx1, ry1, rx2, ry2 = float(row[1]), float(row[2]), float(row[3]), float(row[4])
            elif cols == 6:
                # Format: x1, y1, x2, y2, score, class_id
                score, cid = float(row[4]), int(row[5])
                rx1, ry1, rx2, ry2 = float(row[0]), float(row[1]), float(row[2]), float(row[3])
            else:
                continue

            if score < self.conf_threshold or cid not in interest_ids:
                continue

            bx1, by1, bx2, by2 = self._to_normalized(rx1, ry1, rx2, ry2, info)
            detections.append(Detection(
                class_id=cid,
                class_name=classes_of_interest[cid],
                confidence=score,
                bbox=(bx1, by1, bx2, by2),
            ))

        return detections

    # ------------------------------------------------------------------
    # NMS implementation (pure numpy)
    # ------------------------------------------------------------------

    @staticmethod
    def _nms(
        boxes: NDArray[np.float32],
        scores: NDArray[np.float32],
        iou_threshold: float,
    ) -> list[int]:
        """Standard greedy NMS. Returns indices to keep."""
        if len(boxes) == 0:
            return []

        x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        areas = (x2 - x1) * (y2 - y1)
        order = scores.argsort()[::-1]

        keep: list[int] = []
        while order.size > 0:
            i = order[0]
            keep.append(int(i))

            if order.size == 1:
                break

            rest = order[1:]
            xx1 = np.maximum(x1[i], x1[rest])
            yy1 = np.maximum(y1[i], y1[rest])
            xx2 = np.minimum(x2[i], x2[rest])
            yy2 = np.minimum(y2[i], y2[rest])

            inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
            iou = inter / (areas[i] + areas[rest] - inter + 1e-7)
            order = rest[iou <= iou_threshold]

        return keep

    # ------------------------------------------------------------------
    # Coordinate reverse-mapping: input-space pixels -> normalized [0, 1]
    # ------------------------------------------------------------------

    @staticmethod
    def _to_normalized(
        x1: float, y1: float, x2: float, y2: float, info: LetterboxInfo,
    ) -> tuple[float, float, float, float]:
        """Convert input-space pixel coordinates back to normalized [0, 1] relative to original image."""
        x1 = max(0.0, (x1 - info.pad_w) / info.scale / info.orig_w)
        y1 = max(0.0, (y1 - info.pad_h) / info.scale / info.orig_h)
        x2 = min(1.0, (x2 - info.pad_w) / info.scale / info.orig_w)
        y2 = min(1.0, (y2 - info.pad_h) / info.scale / info.orig_h)
        return (x1, y1, x2, y2)
