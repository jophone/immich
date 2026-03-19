这是一份本项目的 web 前端代码分析报告。

# 1. 技术栈与架构概览
Immich 项目的 web 目录是一个现代化的高性能前端项目，主要采用了以下技术栈：
* **框架**：SvelteKit（基于 Svelte 5 的 Runes 语法，支持细粒度响应式更新）。
* **构建与路由**：Vite 7 和 SvelteKit 的基于文件的路由系统。
* **样式**：Tailwind CSS 4，用于实现高度可定制的 UI 组件和响应式布局。
* **状态管理**：使用 Svelte 5 的 `$state` 和自定义 store（如 `timelineManager`）进行状态流转。
* **国际化**：使用了 `svelte-i18n` 以支持多语言显示（如截图中的中文 “照片”、”探索“ 以及日期本地化显示）。

项目采用了经典的管理面板布局（SideNav + AppBar + Main Content）。

---

# 2. 界面关键元素与代码级对应关系

核心区域由四个独立的部分构成。这些元素在代码中的具体位置如下：

## 左侧导航栏（Navigation Sidebar）
* **代码路径**: user-sidebar.svelte
* **分析**: 
  主要负责侧边栏导航逻辑。代码中使用 `<NavbarItem>` 和 `<NavbarGroup>` 组件渲染出了截图里的内容。
  * **路由入口**: 图标与文案对应了 "Photos" (照片), "Explore" (发现), "Albums" (相册), "Trash" (回收站) 等。
  * **底部存储信息（Storage space）**：在底部引入了 `<BottomInfo />`，其包含 `storage-space.svelte` 以计算展示截图中的 "520.2 GiB of 2.1 TiB used" 及进度条。
  * **服务器状态监控**：底部左下角的绿点 "Server Online v2.5.6" 由 `server-status.svelte` 进行 WebSocket 实时状态监测与呈现。

## 顶部操作栏（Top App Bar）
* **代码路径**: navigation-bar.svelte
* **分析**:
  该组件负责全局操作项：
  * **左侧Logo**: 返回主页的品牌 Logo。
  * **全局搜索**：中间的搜索框，关联 `search-bar` 模块以支持高级图库检索。
  * **功能按钮组**：包含截图右上角的「Upload (上传)」按钮组件（触发 `<UploadCover>` 面板组件），以及基于 `theme-button.svelte` 的月亮标志（日/夜间主题切换）、通知 Bell 和右上角的用户头像区（`account-info-panel.svelte`）。

### 1. 搜索选项（Search Options）过滤面板
* **代码路径**: SearchFilterModal.svelte
* **分析**: 整个“搜索选项”的弹出窗口是由该文件控制的。它使用 `<Modal title={$t('search_options')}>` 渲染顶部标题并管理弹窗结构，同时内部通过 `filter` 这个反应式（`$state`）对象汇集了底下所有子组件的表单状态。

#### 1.1. 内容区块细分
面板中堆叠的每一个独立功能项，都被细分在图库顶部搜索栏的内部组件目录下：search-bar。

* **人物 (People)** 选项（刘亦菲、迪丽热巴头像等）：
  * **代码**: `.../search-bar/search-people-section.svelte`
  * 调用了图库模型对人脸进行选择组合的过滤功能。
  
* **按类型查找 & 通过描述的场景查找 (Text Section)**：
  * **代码**: `.../search-bar/search-text-section.svelte`
  * 包含了四个 Radio 单选（以文搜图、文件名或扩展名、描述、文本识别），并附有对应的输入框。截图中的占位符提示词 `"海滩上的日出"` 在代码中对应着 `$t('sunrise_on_the_beach')` 多语言键值。

* **类别 (Category)**：
  * **代码**: `.../search-bar/search-category-section.svelte`
  * 通过 `getCategorySummaries()` 拉取用户当前分类汇总并映射为 `Combobox` 选项；如果 URL/历史状态中的 `category` 已失效，会自动清空，避免提交无效过滤值。

* **地点 (Location)**：
  * **代码**: `.../search-bar/search-location-section.svelte`
  * 负责国家 (Country)、省份 (State)、城市 (City) 的过滤下拉框渲染逻辑。

* **相机 (Camera)**：
  * **代码**: `.../search-bar/search-camera-section.svelte`
  * 提取并过滤影像 Exif 数据中的相机品牌 (Make)、型号 (Model)、镜头型号 (Lens Model)。

* **开始日期与结束日期 (Date Range)**：
  * **代码**: `.../search-bar/search-date-section.svelte`
  * 提供带有日期选择器能力的输入组件（开始时间和结束时间的界定：`takenAfter` 和 `takenBefore`）。

* **媒体类型 (Media Type)** 全部 / 图片 / 视频：
  * **代码**: `.../search-bar/search-media-section.svelte`
  * 处理文件类型的单选按钮组合(`MediaType.Image` / `MediaType.Video`)。

* **显示选项 (Display Options)** 归档/收藏夹/不在任何相册中：
  * **代码**: `.../search-bar/search-display-section.svelte`
  * 为复选框组配置选项，用于过滤图片的特定状态属性（如：`isArchive`, `isFavorite`, `isNotInAlbum`）。

---

#### 1.2. 底部操作栏 (Footer Actions)
在截图的最下方。
* **“清空全部 (Clear all)” & “搜索 (Search)” 按钮**
  * **代码位置**: 再次回到主组件容器底部的 SearchFilterModal.svelte。
  * 由包裹在 `<ModalFooter>` 内的两个 `<Button>` 组成。一个触发表单 `onreset` 重置 `filter` 默认参数，另一个拦截 `onsubmit` 拼装最终组合的 Payload，向后端发起复杂的混合搜索请求 (`SmartSearchDto` 或 `MetadataSearchDto`)。

## 核心照片流（Photos Gallery / Timeline）
* **代码路径**: +page.svelte 和 timeline
* **分析**:
  核心的 “照片流” 视图。
  * **时间线网格**：其底层调用 Timeline.svelte 进行列表的虚拟滚动（Virtual Scroll）渲染，保证几万张图片加载时的性能。
  * **日期分组头部**：截图中显示的 “2月25日周三” 等标题是由 `Month.svelte` 和对应的 `DayGroup` 状态管理器（利用 `getDateLocaleString` 进行中文本地化格式转换）来渲染的。
  * **照片卡片**：每张图片对应使用 `AssetLayout.svelte` 根据布局引擎排版。

## 右侧滚动时间轴（Timeline Scrubber）
* **代码路径**: Scrubber.svelte
* **分析**:
  截图最右侧屏幕边缘显示的纯白色年份小字 “2026” 以及时间点滚动条，即被称为 `Scrubber` （拖动指示器）。当页面滚动时，会监听虚拟滚动的进度，在时间轴上动态高亮当前浏览图片所在的年份和月份。

## 照片详情页面

Immich 的**资产详情面板（Asset Viewer & Detail Panel）**的部分，界面的核心主要分为左侧的全屏大图视图以及右侧的信息（Info）抽屉。

以下为基于图片内容的关键元素以及它们在代码库中的对应位置分布：

### 1. 全局图库查看器核心组件（Asset Viewer）
整个包含左侧图片和右侧面板的容器与逻辑控制中心是 `AssetViewer` 组件。
* **文件路径**: asset-viewer.svelte
* **分析**: 这是最外层的状态容器组件。它负责协调媒体资源（照片或视频）的展示、顶部的控制栏（诸如分享、放大、喜爱、删除等操作按钮）以及控制右侧 “Info” 弹出面板的隐藏与显示。

---

### 2. 顶部工具栏（Asset Viewer Nav Bar）
截图中位于最上方的操作图标组合（包括分享、缩放、复制、详情(ℹ️)、收藏、编辑器、删除等按键）。
* **文件路径**：asset-viewer-nav-bar.svelte

---

### 3. 右侧信息抽屉（Detail Panel）核心大类
右侧被称为 `DetailPanel`，用于按区域显示这堆元数据信息。
* **主容器文件路径**: detail-panel.svelte

下面是对截图里细分元素的进一步代码定位：

#### 3.1 头部区块（Info Header）
* **显示内容**：顶部的 “X” 关闭按钮与大字体的 “Info” 标题。
* **代码实现**：处于 `detail-panel.svelte` 的靠前部分，渲染了 `IconButton` 执行 `assetViewerManager.closeDetailPanel()` 并且通过多语言支持渲染 `<p>{$t('info')}</p>`。

#### 3.2 描述区块（Description）
* **显示内容**："Add a description"（添加描述）输入框。
* **代码实现**：作为一个解耦的子组件进行调用。文件为 detail-panel-description.svelte。

#### 3.3 人物区块（People）
* **显示内容**："People +" 显示人脸识别及标注信息。
* **代码实现**：这部分逻辑写在了 `detail-panel.svelte` 自身中。通过 `asset.people` 属性获取人员信息，展示侧边人物微缩图 `ImageThumbnail`，同时由一个条件控制（`showEditFaces`）唤起专门的面部编辑面板 `<PersonSidePanel>`。

#### 3.4 详细属性区块（Details）
该区块包含所有物理元数据。代码全部写在 `detail-panel.svelte` 的 `<div class="px-4 py-4">`（Details 节区）及相关特化子组件中：

* **区块标题 "Details"**：`{$t('details')}`。
* **时间与日期**："2026年2月25日 周三 10:43:01"。 
  * 由外层 `detail-panel.svelte` 解析 `asset.exifInfo?.dateTimeOriginal` 传入本地时区格式器（如 `$locale` ）以呈现图中特定语言和格式以及后面的编辑笔图标。
* **文件规格**："IMG_7548.JPG | 1 MP | 960 x 1280 | 117.2 KiB"。 
  * 读取原文件数据展示 `asset.originalFileName`。
  * `1 MP` 及尺寸利用 `getMegapixel()` 及 `getDimensions(asset.exifInfo)` 算出。
  * `117.2 KiB` 调用了底层工具方法 `getByteUnitString()`。
* **位置信息**："Add a location" 提示及铅笔图标。
  * 此元素的具体渲染逻辑以及后续查看/编辑地点被抽离到了独立的组件 detail-panel-location.svelte 里。

# 总结
Immich 的 Web 前端组件层级非常清晰：路由级别的页面 (`routes/`) 负责加载数据，并注入给可复用的布局组件（`Timeline.svelte`等），结合全局 Store 进行通信。SvelteKit 配合虚拟滚动技术赋予了该应用原生 App 级别的相册渲染性能。

