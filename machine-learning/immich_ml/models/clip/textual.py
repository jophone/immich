import json
from abc import abstractmethod
from functools import cached_property
from pathlib import Path
from shutil import copyfile
from typing import Any

import numpy as np
from numpy.typing import NDArray
from tokenizers import Encoding, Tokenizer

from immich_ml.config import log
from immich_ml.models.base import InferenceModel
from immich_ml.models.constants import WEBLATE_TO_FLORES200
from immich_ml.models.transforms import clean_text, serialize_np_array
from immich_ml.schemas import ModelFormat, ModelSession, ModelTask, ModelType


TokenInput = dict[str, NDArray[np.int32]] | dict[str, NDArray[np.int64]]


class BaseCLIPTextualEncoder(InferenceModel):
    depends = []
    identity = (ModelType.TEXTUAL, ModelTask.SEARCH)

    def _predict(self, inputs: str, language: str | None = None) -> str:
        tokens: TokenInput = self.tokenize(inputs, language=language)
        res: NDArray[np.float32] = self.session.run(None, tokens)[0][0]
        return serialize_np_array(res)

    def _load(self) -> ModelSession:
        session = super()._load()
        log.debug(f"Loading tokenizer for CLIP model '{self.model_name}'")
        self.tokenizer = self._load_tokenizer()
        tokenizer_kwargs: dict[str, Any] | None = self.text_cfg.get("tokenizer_kwargs")
        self.canonicalize = tokenizer_kwargs is not None and tokenizer_kwargs.get("clean") == "canonicalize"
        self.is_nllb = self.model_name.startswith("nllb")
        log.debug(f"Loaded tokenizer for CLIP model '{self.model_name}'")

        return session

    @abstractmethod
    def _load_tokenizer(self) -> Tokenizer:
        pass

    @abstractmethod
    def tokenize(self, text: str, language: str | None = None) -> TokenInput:
        pass

    @property
    def model_cfg_path(self) -> Path:
        return self.cache_dir / "config.json"

    @property
    def tokenizer_file_path(self) -> Path:
        return self.model_dir / "tokenizer.json"

    @property
    def tokenizer_cfg_path(self) -> Path:
        return self.model_dir / "tokenizer_config.json"

    @cached_property
    def model_cfg(self) -> dict[str, Any]:
        log.debug(f"Loading model config for CLIP model '{self.model_name}'")
        model_cfg: dict[str, Any] = json.load(self.model_cfg_path.open())
        log.debug(f"Loaded model config for CLIP model '{self.model_name}'")
        return model_cfg

    @property
    def text_cfg(self) -> dict[str, Any]:
        text_cfg: dict[str, Any] = self.model_cfg["text_cfg"]
        return text_cfg

    @cached_property
    def tokenizer_file(self) -> dict[str, Any]:
        log.debug(f"Loading tokenizer file for CLIP model '{self.model_name}'")
        tokenizer_file: dict[str, Any] = json.load(self.tokenizer_file_path.open())
        log.debug(f"Loaded tokenizer file for CLIP model '{self.model_name}'")
        return tokenizer_file

    @cached_property
    def tokenizer_cfg(self) -> dict[str, Any]:
        log.debug(f"Loading tokenizer config for CLIP model '{self.model_name}'")
        tokenizer_cfg: dict[str, Any] = json.load(self.tokenizer_cfg_path.open())
        log.debug(f"Loaded tokenizer config for CLIP model '{self.model_name}'")
        return tokenizer_cfg


class OpenClipTextualEncoder(BaseCLIPTextualEncoder):
    def _load_tokenizer(self) -> Tokenizer:
        context_length: int = self.text_cfg.get("context_length", 77)
        pad_token: str = self.tokenizer_cfg["pad_token"]

        tokenizer: Tokenizer = Tokenizer.from_file(self.tokenizer_file_path.as_posix())

        pad_id: int = tokenizer.token_to_id(pad_token)
        tokenizer.enable_padding(length=context_length, pad_token=pad_token, pad_id=pad_id)
        tokenizer.enable_truncation(max_length=context_length)

        return tokenizer

    def tokenize(self, text: str, language: str | None = None) -> dict[str, NDArray[np.int32]]:
        text = clean_text(text, canonicalize=self.canonicalize)
        if self.is_nllb and language is not None:
            flores_code = WEBLATE_TO_FLORES200.get(language)
            if flores_code is None:
                no_country = language.split("-")[0]
                flores_code = WEBLATE_TO_FLORES200.get(no_country)
                if flores_code is None:
                    log.warning(f"Language '{language}' not found, defaulting to 'en'")
                    flores_code = "eng_Latn"
            text = f"{flores_code}{text}"
        tokens: Encoding = self.tokenizer.encode(text)
        return {"text": np.array([tokens.ids], dtype=np.int32)}


class MClipTextualEncoder(OpenClipTextualEncoder):
    def tokenize(self, text: str, language: str | None = None) -> dict[str, NDArray[np.int32]]:
        text = clean_text(text, canonicalize=self.canonicalize)
        tokens: Encoding = self.tokenizer.encode(text)
        return {
            "input_ids": np.array([tokens.ids], dtype=np.int32),
            "attention_mask": np.array([tokens.attention_mask], dtype=np.int32),
        }


class ChineseClipTextualEncoder(BaseCLIPTextualEncoder):
    _DEFAULT_TOKENIZER_NAME = "hfl/chinese-roberta-wwm-ext"
    _DEFAULT_CONTEXT_LENGTH = 52
    _DEFAULT_PAD_TOKEN = "[PAD]"
    _DEPLOY_MODEL_NAME = "vit-B-16.txt.fp16.onnx"
    _RN50_FP16_MODEL_NAME = "chinese_clip_rn50_fp16"
    _RN50_FP32_FALLBACK = "chinese_clip_rn50_fp32"
    _RN50_FP32_ONNX = "rn50.txt.fp32.onnx"

    def model_path_for_format(self, model_format: ModelFormat) -> Path:
        if model_format == ModelFormat.ONNX:
            if self.model_name == self._RN50_FP16_MODEL_NAME:
                fp32_fallback_path = self.cache_dir.parent / self._RN50_FP32_FALLBACK / self.model_type.value / self._RN50_FP32_ONNX
                if fp32_fallback_path.is_file():
                    log.warning(
                        "Model '%s' ONNX is incompatible with ORT, using '%s' weights as fallback",
                        self._RN50_FP16_MODEL_NAME,
                        self._RN50_FP32_FALLBACK,
                    )
                    return fp32_fallback_path

            deploy_model_path = self.model_dir / "deploy" / self._DEPLOY_MODEL_NAME
            if deploy_model_path.is_file():
                return deploy_model_path

            deploy_onnx = sorted((self.model_dir / "deploy").glob("*.onnx"))
            if deploy_onnx:
                return deploy_onnx[0]

            flat_onnx = sorted(self.model_dir.glob("*.onnx"))
            if flat_onnx:
                return flat_onnx[0]
        return super().model_path_for_format(model_format)

    def _load(self) -> ModelSession:
        self._ensure_onnx_extra_file_alias()
        session = InferenceModel._load(self)
        log.debug(f"Loading tokenizer for CLIP model '{self.model_name}'")
        self.tokenizer = self._load_tokenizer()
        self.canonicalize = False
        self.is_nllb = False
        log.debug(f"Loaded tokenizer for CLIP model '{self.model_name}'")
        return session

    def _load_tokenizer(self) -> Tokenizer:
        tokenizer_name = self.text_cfg.get("tokenizer_name", self._DEFAULT_TOKENIZER_NAME)
        context_length = int(self.text_cfg.get("context_length", self._DEFAULT_CONTEXT_LENGTH))
        pad_token = self.text_cfg.get("pad_token", self._DEFAULT_PAD_TOKEN)

        if self.tokenizer_file_path.is_file():
            tokenizer: Tokenizer = Tokenizer.from_file(self.tokenizer_file_path.as_posix())
        else:
            tokenizer = Tokenizer.from_pretrained(tokenizer_name)

        pad_id = tokenizer.token_to_id(pad_token)
        if pad_id is None:
            pad_id = 0
            pad_token = ""

        tokenizer.enable_padding(length=context_length, pad_token=pad_token, pad_id=pad_id)
        tokenizer.enable_truncation(max_length=context_length)
        return tokenizer

    def tokenize(self, text: str, language: str | None = None) -> dict[str, NDArray[np.int64]]:
        text = clean_text(text)
        tokens: Encoding = self.tokenizer.encode(text)
        return {"text": np.array([tokens.ids], dtype=np.int64)}

    @property
    def model_cfg_path(self) -> Path:
        return self.cache_dir / "config.json"

    @property
    def text_cfg(self) -> dict[str, Any]:
        if self.model_cfg_path.is_file():
            return self.model_cfg.get("text_cfg", {})
        return {
            "context_length": self._DEFAULT_CONTEXT_LENGTH,
            "tokenizer_name": self._DEFAULT_TOKENIZER_NAME,
            "pad_token": self._DEFAULT_PAD_TOKEN,
        }

    def _ensure_onnx_extra_file_alias(self) -> None:
        if self.model_format != ModelFormat.ONNX:
            return

        extra_file = self.model_path.with_name(f"{self.model_path.name}.extra_file")
        if not extra_file.is_file() or extra_file.name[:1].isupper():
            return

        alias_file = extra_file.with_name(extra_file.name[:1].upper() + extra_file.name[1:])
        if alias_file.is_file():
            return

        copyfile(extra_file, alias_file)
        log.info("Created ONNX extra_file alias for Chinese-CLIP model at %s", alias_file)
