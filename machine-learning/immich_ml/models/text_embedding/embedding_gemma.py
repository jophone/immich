from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any, ClassVar

import numpy as np
from huggingface_hub import snapshot_download
from numpy.typing import NDArray
from tokenizers import Tokenizer

from immich_ml.config import clean_name, log, settings
from immich_ml.models.base import InferenceModel
from immich_ml.models.transforms import serialize_np_array
from immich_ml.schemas import ModelFormat, ModelIdentity, ModelSession, ModelTask, ModelType

# HuggingFace repo for the ONNX version of the model
_ONNX_REPO_ID = "onnx-community/embeddinggemma-300m-ONNX"
# Default local model path for edge device deployment
_DEFAULT_LOCAL_MODEL_PATH = "/root/snap/model/embeddinggemma-300m"


class EmbeddingGemmaEncoder(InferenceModel):
    depends: ClassVar[list[ModelIdentity]] = []
    identity: ClassVar[ModelIdentity] = (ModelType.TEXTUAL, ModelTask.LITE_SEARCH)

    def __init__(
        self,
        model_name: str,
        local_model_path: str | None = None,
        **model_kwargs: Any,
    ) -> None:
        self.local_model_path = local_model_path or _DEFAULT_LOCAL_MODEL_PATH
        super().__init__(model_name, **model_kwargs)

    @property
    def _cache_dir_default(self) -> Path:
        return settings.cache_folder / self.model_task.value / self.model_name

    @property
    def model_dir(self) -> Path:
        return self.cache_dir / "onnx"

    @property
    def tokenizer_path(self) -> Path:
        return self.cache_dir

    def _download(self) -> None:
        local_path = Path(self.local_model_path)
        if local_path.exists():
            log.info(f"Loading EmbeddingGemma from local path: {local_path}")
            # Check if local path has ONNX files
            onnx_dir = local_path / "onnx"
            onnx_file = onnx_dir / "model.onnx" if onnx_dir.exists() else local_path / "model.onnx"
            if onnx_file.exists():
                # Symlink or copy the local model to cache dir
                if self.cache_dir != local_path:
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    # Symlink each file/directory from local path to cache dir
                    for item in local_path.iterdir():
                        target = self.cache_dir / item.name
                        if not target.exists():
                            if item.is_dir():
                                os.symlink(item, target)
                            else:
                                os.symlink(item, target)
                return
            else:
                log.warning(
                    f"Local path {local_path} exists but no ONNX model found. "
                    "Downloading ONNX version from HuggingFace instead."
                )

        log.info(f"Downloading EmbeddingGemma ONNX model from {_ONNX_REPO_ID}...")
        snapshot_download(
            _ONNX_REPO_ID,
            cache_dir=self.cache_dir,
            local_dir=self.cache_dir,
            ignore_patterns=["*.armnn", "*.rknn"],
        )

    def _load(self) -> ModelSession:
        session = self._make_session(self.model_path)

        tokenizer_file = self.tokenizer_path / "tokenizer.json"
        if not tokenizer_file.exists():
            raise FileNotFoundError(
                f"Tokenizer file not found: {tokenizer_file}. "
                "Ensure the model was downloaded correctly."
            )

        log.debug(f"Loading tokenizer for EmbeddingGemma from {tokenizer_file}")
        self.tokenizer = Tokenizer.from_file(str(tokenizer_file))
        log.debug("Loaded tokenizer for EmbeddingGemma")

        return session

    def _predict(self, inputs: str, **kwargs: Any) -> str:
        encoding = self.tokenizer.encode(inputs)
        input_ids = np.array([encoding.ids], dtype=np.int64)
        attention_mask = np.array([encoding.attention_mask], dtype=np.int64)

        input_feed: dict[str, NDArray] = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
        }

        # Check if model expects token_type_ids
        input_names = {inp.name for inp in self.session.get_inputs()}
        if "token_type_ids" in input_names:
            input_feed["token_type_ids"] = np.zeros_like(input_ids)

        outputs = self.session.run(None, input_feed)

        # The model outputs: [logits, sentence_embedding]
        # sentence_embedding is the last output with shape (batch_size, 768)
        sentence_embedding = outputs[-1]
        embedding: NDArray[np.float32] = sentence_embedding[0].astype(np.float32)

        return serialize_np_array(embedding)
