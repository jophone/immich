from __future__ import annotations

import ast
from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
import orjson
from numpy.typing import NDArray
from PIL import Image

from immich_ml.config import clean_name, log, settings
from immich_ml.models.transforms import decode_pil
from immich_ml.sessions.ort import OrtSession


class YoloClassificationModel:
    def __init__(
        self,
        model_name: str,
        cache_dir: Path | str | None = None,
        session: OrtSession | None = None,
    ) -> None:
        self.model_name = clean_name(model_name)
        self.cache_dir = Path(cache_dir) if cache_dir is not None else self._cache_dir_default
        self.session: OrtSession | None = session
        self.loaded = session is not None
        self.input_name = "images"
        self.input_height = 224
        self.input_width = 224

    def load(self) -> None:
        if self.loaded:
            return

        model_path = self.model_path
        if not model_path.is_file():
            raise FileNotFoundError(f"Classification model file not found: '{model_path}'")

        log.info(f"Loading local classification model '{self.model_name}' from {model_path}")
        session = OrtSession(model_path)
        input_node = session.get_inputs()[0]
        self.session = session
        self.input_name = input_node.name or "images"
        _, _, height, width = _normalize_input_shape(input_node.shape)
        self.input_height = height
        self.input_width = width
        self.loaded = True

    def predict(self, inputs: Image.Image | bytes) -> dict[str, float]:
        self.load()
        session = self.session
        if session is None:
            raise RuntimeError(f"Classification model '{self.model_name}' is not loaded")

        image = decode_pil(inputs)
        tensor = self._preprocess(image)
        outputs = session.run(None, {self.input_name: tensor})
        probabilities = _to_probabilities(outputs[0])

        if probabilities.shape[0] != len(self.labels):
            raise ValueError(
                f"Classification output size {probabilities.shape[0]} does not match labels size {len(self.labels)}"
            )

        return {label: float(probabilities[index]) for index, label in enumerate(self.labels)}

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
        model_subdir = "yolo26-l" if model_slug == "yolo26l-cls" else model_slug
        repo_root = Path(__file__).resolve().parents[4]
        candidates = [
            repo_root / "model-cache" / model_subdir,
            settings.cache_folder / model_subdir,
            settings.cache_folder / "classification" / self.model_name,
        ]

        for candidate in candidates:
            if candidate.is_dir():
                return candidate

        return candidates[0]

    @cached_property
    def labels(self) -> list[str]:
        labels_path = self._resolve_labels_path()
        if labels_path is not None:
            suffix = labels_path.suffix.lower()

            if suffix == ".json":
                parsed = orjson.loads(labels_path.read_bytes())
                return _parse_labels_map(parsed, self.model_name)

            labels = [line.strip() for line in labels_path.read_text().splitlines() if line.strip()]
            if not labels:
                raise ValueError(f"Labels file is empty for model '{self.model_name}'")
            return labels

        labels_from_metadata = self._get_labels_from_onnx_metadata()
        if labels_from_metadata:
            return labels_from_metadata

        raise FileNotFoundError(
            f"Labels not found for classification model '{self.model_name}'. "
            "Provide labels.txt/labels.json or ONNX metadata field 'names'."
        )

    def _resolve_labels_path(self) -> Path | None:
        for candidate in (self.cache_dir / "labels.txt", self.cache_dir / "labels.json"):
            if candidate.is_file():
                return candidate
        return None

    def _get_labels_from_onnx_metadata(self) -> list[str]:
        session = self.session
        if session is None:
            return []

        names_value = session.session.get_modelmeta().custom_metadata_map.get("names")
        if not names_value:
            return []

        parsed: Any
        try:
            parsed = orjson.loads(names_value)
        except orjson.JSONDecodeError:
            try:
                parsed = ast.literal_eval(names_value)
            except (ValueError, SyntaxError):
                return []

        return _parse_labels_map(parsed, self.model_name)

    def _preprocess(self, image: Image.Image) -> NDArray[np.float32]:
        image = image.resize((self.input_width, self.input_height), resample=Image.Resampling.BILINEAR)
        image_np = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        image_np = image_np.transpose(2, 0, 1)
        return np.expand_dims(np.ascontiguousarray(image_np), 0)


def _normalize_input_shape(shape: list[Any] | tuple[Any, ...]) -> tuple[int, int, int, int]:
    dims = list(shape)
    if len(dims) != 4:
        raise ValueError(f"Unsupported classification input shape: {shape}")

    normalized: list[int] = []
    for index, dim in enumerate(dims):
        if isinstance(dim, int) and dim > 0:
            normalized.append(dim)
        elif index == 1:
            normalized.append(3)
        else:
            normalized.append(224)
    return tuple(normalized)  # type: ignore[return-value]


def _to_probabilities(output: NDArray[np.float32]) -> NDArray[np.float32]:
    logits = np.asarray(output, dtype=np.float32).reshape(-1)
    if logits.size == 0:
        raise ValueError("Classification model returned an empty output tensor")

    total = float(np.sum(logits))
    if np.all(logits >= 0) and np.isfinite(total) and np.isclose(total, 1.0, atol=1e-3):
        return logits

    shifted = logits - np.max(logits)
    exp_logits = np.exp(shifted)
    return exp_logits / np.sum(exp_logits)


def _parse_labels_map(parsed: Any, model_name: str) -> list[str]:
    if isinstance(parsed, list):
        return [str(label) for label in parsed]
    if isinstance(parsed, dict):
        try:
            items = sorted(parsed.items(), key=lambda item: int(item[0]))
        except (TypeError, ValueError):
            items = sorted(parsed.items(), key=lambda item: str(item[0]))
        return [str(label) for _, label in items]
    raise ValueError(f"Unsupported labels format for model '{model_name}'")
