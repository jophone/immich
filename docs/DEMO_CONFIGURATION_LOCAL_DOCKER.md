# 完整服务启动指南

### 4.1 启动方式选择

- **本地启动（`scripts/local-dev.sh`）**
  - 适合：调试 server/web/ML 代码、快速迭代
  - 特点：自动拉起 PostgreSQL + Redis（系统服务）、ML/API/Web（本地进程）
- **Docker 启动（`scripts/docker-dev.sh`）**
  - 适合：标准化环境、减少主机依赖差异
  - 特点：自动使用 compose 编排服务，适合长期稳定运行

---

### 4.2 启动前准备（通用）

在仓库根目录执行：

```bash
cd /root/immich
```

建议先检查端口占用（两种启动方式都常用这些端口）：

- `3000`（Web）
- `2283`（API）
- `3003`（Machine Learning）
- `5432`（PostgreSQL）

可用命令：

```bash
ss -ltnp | grep -E ':3000|:2283|:3003|:5432' || true
```

---

### 4.3 本地启动全流程（`scripts/local-dev.sh`）

#### 4.3.1 首次启动

```bash
cd /root/immich
./scripts/local-dev.sh up
```

脚本会自动处理以下事项：

1. 准备本地目录（日志、缓存、运行文件）
2. 安装 Node/pnpm（如果缺失）
3. 安装 JS 依赖并构建 SDK（如果缺失）
4. 从 server 镜像提取 build 资源（如果缺失）
5. 启动 PostgreSQL 和 Redis（systemd）
6. 初始化数据库和 `vector` 扩展
7. 安装 machine-learning Python 环境（uv）
8. 启动 ML/API/Web 并做健康检查

#### 4.3.2 常用命令

```bash
./scripts/local-dev.sh up
./scripts/local-dev.sh down
./scripts/local-dev.sh restart
./scripts/local-dev.sh status
```

#### 4.3.3 常用环境变量

```bash
IMMICH_ML_PROFILE=cpu
IMMICH_WEB_PORT=3000
IMMICH_API_PORT=2283
IMMICH_ML_PORT=3003
IMMICH_LOCAL_DEV_HOST=127.0.0.1
IMMICH_LOCAL_DEV_ACCESS_HOST=127.0.0.1
IMMICH_LOCAL_DEV_IMAGE=ghcr.io/immich-app/immich-server:v2
LOCAL_DEV_RESTART=1
```

示例（修改端口）：

```bash
IMMICH_WEB_PORT=3100 IMMICH_API_PORT=2383 IMMICH_ML_PORT=3103 ./scripts/local-dev.sh up
```

#### 4.3.4 日志与状态

- 本地日志目录：`.local-dev/logs/`
- 重点日志：
  - `.local-dev/logs/ml.log`
  - `.local-dev/logs/api.log`
  - `.local-dev/logs/web.log`

查看日志：

```bash
tail -f .local-dev/logs/ml.log
tail -f .local-dev/logs/api.log
tail -f .local-dev/logs/web.log
```

---

### 4.4 Docker 启动全流程（`scripts/docker-dev.sh`）

#### 4.4.1 首次启动

```bash
cd /root/immich
./scripts/docker-dev.sh up
```

脚本会自动：

1. 检查 Docker / Compose 可用性
2. 准备 `docker/.env`（若不存在会由 `docker/example.env` 生成）
3. 检查并处理容器命名冲突
4. 尝试释放必要端口（可由环境变量控制）
5. 启动 compose 服务并做健康检查

#### 4.4.2 常用命令

```bash
./scripts/docker-dev.sh up
./scripts/docker-dev.sh up-build
./scripts/docker-dev.sh down
./scripts/docker-dev.sh restart
./scripts/docker-dev.sh status
./scripts/docker-dev.sh logs
./scripts/docker-dev.sh logs immich-machine-learning
./scripts/docker-dev.sh cleanup-conflicts --all
```

#### 4.4.3 常用环境变量

```bash
IMMICH_DOCKER_COMPOSE_FILE=docker/docker-compose.dev.yml
IMMICH_DOCKER_ENV_FILE=docker/.env
IMMICH_DOCKER_BUILDKIT=1
IMMICH_DOCKER_COMPOSE_BAKE=auto
IMMICH_DOCKER_RUNTIME=auto
IMMICH_DOCKER_ACCESS_HOST=127.0.0.1
IMMICH_DOCKER_WAIT=1
IMMICH_DOCKER_WAIT_ATTEMPTS=360
IMMICH_DOCKER_DOWN_LOCAL_DEV=1
IMMICH_DOCKER_STOP_HOST_POSTGRES=1
IMMICH_DOCKER_CLEAN_RUNNING_CONFLICTS=1
```

示例（慢网络/首次拉取时增加等待）：

```bash
IMMICH_DOCKER_WAIT_ATTEMPTS=1200 ./scripts/docker-dev.sh up
```

---

### 4.5 启动成功验证

无论本地或 Docker，建议都验证以下端点：

```bash
curl -fsS http://127.0.0.1:3003/ping
curl -fsS http://127.0.0.1:2283/api/server/ping
curl -fsS http://127.0.0.1:3000/api/server/ping
```

期望返回 `pong`。

---

### 4.6 常见启动故障与处理

#### Q1：本地启动 `restart` 退出码是 1，但看起来服务还在下载模型

常见于预加载大模型。`local-dev.sh` 对 ML 健康检查等待窗口较短，模型下载可能超过该窗口，脚本就会判定失败退出，但 ML 进程可能仍在继续工作。

处理建议：

1. 先观察 `.local-dev/logs/ml.log` 是否持续有 `Downloading` / `Loading` 日志
2. 分批预加载（一次 1~2 个大模型）
3. 下载完成后再执行 `./scripts/local-dev.sh status`

#### Q2：日志里大量出现 `Handling signal: winch`

通常是 Gunicorn 收到终端窗口信号，常见且一般无害；重点看是否仍有模型下载/加载进度日志。

#### Q3：Docker 启动报端口冲突

执行：

```bash
./scripts/docker-dev.sh cleanup-conflicts --all
./scripts/docker-dev.sh up
```

必要时手动释放端口占用进程。

#### Q4：修改模型后报 `Unknown CLIP model`

说明模型名不在支持列表或拼写不匹配。请使用支持的模型名（例如参考 `server/src/constants.ts` 中的 `CLIP_MODEL_INFO`）。

# Immich 模型配置指南（本地启动 + Docker 启动）

本文说明：

1. 如何预加载模型（文搜图 / 人脸 / OCR）
2. 如何设置默认模型
3. 如何设置模型缓存路径

> 适用脚本：`scripts/local-dev.sh`、`scripts/docker-dev.sh`

---

## 1) 如何预加载模型

Immich 机器学习服务支持用环境变量在启动时预下载模型到缓存目录。

### 1.1 预加载变量一览

- `MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL`：文搜图文本编码模型（textual）
- `MACHINE_LEARNING_PRELOAD__CLIP__VISUAL`：文搜图图像编码模型（visual）
- `MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__DETECTION`：人脸检测模型
- `MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__RECOGNITION`：人脸识别模型
- `MACHINE_LEARNING_PRELOAD__OCR__DETECTION`：OCR 检测模型
- `MACHINE_LEARNING_PRELOAD__OCR__RECOGNITION`：OCR 识别模型

多个模型用英文逗号分隔。

### 1.1.1 外部相册项目如何避免关心模型名

当前算法服务支持“请求不传模型名”。外部相册项目调用 `/predict` 时可以省略 `entries.*.*.modelName`，调用 `/classify`、`/detect` 时也可以省略 `model_name`。算法服务会按以下优先级自动选择模型：

1. 显式默认模型环境变量：`MACHINE_LEARNING_DEFAULT__...`
2. 对应预加载列表里的第一个模型
3. Immich 内置默认值

例如你预加载：

```dotenv
MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL=ViT-B-16-SigLIP2__webli,ViT-B-32__openai
MACHINE_LEARNING_PRELOAD__CLIP__VISUAL=ViT-B-16-SigLIP2__webli,ViT-B-32__openai
```

如果调用方不传 `modelName`，默认会使用第一个 `ViT-B-16-SigLIP2__webli`。

如果你想预加载多个模型，但对外固定另一个默认模型，可以额外设置：

```dotenv
MACHINE_LEARNING_DEFAULT__CLIP__TEXTUAL=ViT-B-32__openai
MACHINE_LEARNING_DEFAULT__CLIP__VISUAL=ViT-B-32__openai
MACHINE_LEARNING_DEFAULT__FACIAL_RECOGNITION__DETECTION=buffalo_l
MACHINE_LEARNING_DEFAULT__FACIAL_RECOGNITION__RECOGNITION=buffalo_l
MACHINE_LEARNING_DEFAULT__OCR__DETECTION=PP-OCRv5_mobile
MACHINE_LEARNING_DEFAULT__OCR__RECOGNITION=PP-OCRv5_mobile
MACHINE_LEARNING_DEFAULT__CLASSIFICATION=YOLO26l-cls
MACHINE_LEARNING_DEFAULT__DETECTION=yolov8l
```

可用下面的接口检查算法服务当前对外默认值：

```bash
curl -s http://127.0.0.1:3003/models
```

### 1.2 本地启动（`scripts/local-dev.sh`）

一次性预加载示例：

```bash
cd /root/immich

CLIP_MODELS='ViT-B-16-SigLIP2__webli,ViT-B-16-SigLIP-i18n-256__webli,nllb-clip-base-siglip__v1'
FACE_MODELS='buffalo_l'
OCR_MODELS='PP-OCRv5_mobile'

MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL="$CLIP_MODELS" \
MACHINE_LEARNING_PRELOAD__CLIP__VISUAL="$CLIP_MODELS" \
MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__DETECTION="$FACE_MODELS" \
MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__RECOGNITION="$FACE_MODELS" \
MACHINE_LEARNING_PRELOAD__OCR__DETECTION="$OCR_MODELS" \
MACHINE_LEARNING_PRELOAD__OCR__RECOGNITION="$OCR_MODELS" \
./scripts/local-dev.sh restart
```

查看下载进度：

```bash
tail -f .local-dev/logs/ml.log
```

查看缓存结果：

```bash
du -sh .local-dev/model-cache/* | sort -h
```

### 1.3 Docker 启动（`scripts/docker-dev.sh`）

在 `docker/.env` 里新增或修改：

```dotenv
MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL=ViT-B-16-SigLIP2__webli,ViT-B-16-SigLIP-i18n-256__webli,nllb-clip-base-siglip__v1
MACHINE_LEARNING_PRELOAD__CLIP__VISUAL=ViT-B-16-SigLIP2__webli,ViT-B-16-SigLIP-i18n-256__webli,nllb-clip-base-siglip__v1
MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__DETECTION=buffalo_l
MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__RECOGNITION=buffalo_l
MACHINE_LEARNING_PRELOAD__OCR__DETECTION=PP-OCRv5_mobile
MACHINE_LEARNING_PRELOAD__OCR__RECOGNITION=PP-OCRv5_mobile
```

然后重启 Docker 栈：

```bash
cd /root/immich
./scripts/docker-dev.sh restart
```

查看日志：

```bash
./scripts/docker-dev.sh logs immich-machine-learning
```

### 1.4 模型名从哪里来

- CLIP 可用模型名可参考 `server/src/constants.ts` 的 `CLIP_MODEL_INFO`
- 人脸/OCR 模型建议使用管理后台可选项中的模型名（或当前系统配置中的模型名）

---

## 2) 如何设置默认模型

### 2.1 推荐方式：管理后台（适用于本地/Docker）

路径：

`Administration -> Settings -> Machine Learning Settings`

关键项：

- Smart Search（CLIP，文搜图）
- Facial Recognition（人脸）
- OCR

保存后会写入系统配置数据库，重启服务后仍生效。

> 重要：更换 CLIP 文搜图模型后，必须重新执行 Smart Search 全量任务（All），否则历史向量仍是旧模型生成。

### 2.2 代码默认值（仅对“新初始化配置”有意义）

`server/src/config.ts` 中当前默认值为：

- `machineLearning.clip.modelName = 'ViT-B-32__openai'`
- `machineLearning.facialRecognition.modelName = 'buffalo_l'`
- `machineLearning.ocr.modelName = 'PP-OCRv5_mobile'`

如果你修改这里，需要重启对应服务；已有实例一般还是以数据库中的系统配置为准。

---

## 3) 如何设置模型缓存路径

### 3.1 本地启动缓存路径

默认路径：

`/root/immich/.local-dev/model-cache`

这是 `scripts/local-dev.sh` 中的默认目录（脚本里会将其传给 `MACHINE_LEARNING_CACHE_FOLDER`）。

#### 方式 A（推荐，不改脚本）：软链接迁移到其他磁盘

```bash
cd /root/immich
./scripts/local-dev.sh down

mkdir -p /data/immich-model-cache
rsync -a .local-dev/model-cache/ /data/immich-model-cache/
rm -rf .local-dev/model-cache
ln -s /data/immich-model-cache .local-dev/model-cache

./scripts/local-dev.sh up
```

#### 方式 B：直接改脚本路径

修改 `scripts/local-dev.sh` 中 `MODEL_CACHE_DIR` 的定义为目标目录。

### 3.2 Docker 启动缓存路径

默认容器内缓存路径是 `/cache`（机器学习镜像默认值）。

- 如只改“容器内路径”，可在 `docker/.env` 设置：

```dotenv
MACHINE_LEARNING_CACHE_FOLDER=/cache
```

- 如要改“宿主机落盘路径”，需要改 compose 的 volume 映射（推荐把容器路径仍保持 `/cache`）。

例如在 `docker/docker-compose.dev.yml` 的 `immich-machine-learning` 服务中，把：

```yaml
volumes:
  - model_cache:/cache
```

改成绑定宿主机目录：

```yaml
volumes:
  - /data/immich-model-cache:/cache
```

然后重启：

```bash
./scripts/docker-dev.sh down
./scripts/docker-dev.sh up
```

---

## 常见问题

### Q1：预加载后看起来“卡住”

这是常见现象：服务在同步下载/加载模型时，`/ping` 可能暂时无响应。日志中会看到 `Downloading ...`、`Loading ...`。

建议：

1. 先分批预加载（一次 1~2 个大模型）
2. 观察 `ml.log` 和缓存目录体积增长
3. 下载完成后再进行性能测试

### Q2：预加载变量是否长期生效

- 本地脚本：你在命令前临时传入的环境变量仅当次生效
- Docker：写进 `docker/.env` 后每次重启都会生效

---
