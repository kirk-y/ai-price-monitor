# AI 价格监控系统 — 需求说明文档

## 1. 项目概述

实时监控指定电商店铺的商品价格变化，支持多店铺管理、商品筛选与分类、价格历史追踪，以及定时/手动刷新。

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| 数据库 | SQLite（better-sqlite3） |
| 前端 | 纯 HTML + CSS + JavaScript（无框架） |
| 爬虫 | axios + cheerio |

项目结构单一，前后端不分离，Express 直接 serve 静态文件。

## 3. 部署方式

- 单进程运行，node server.js
- 需要 Node.js 22+
- 默认监听 `127.0.0.1:3000`，通过环境变量 `HOST`、`PORT` 配置
- 本机监听可选 `AUTH_TOKEN`；监听非本机地址时必须配置令牌

## 4. 功能需求

### 4.1 认证

- 可选访问令牌（AUTH_TOKEN 环境变量）；监听非本机地址时为必填
- 启用了令牌时，所有 /api/ 请求需在 header（x-auth-token）中携带
- 前端：页面加载时检测令牌，无令牌时弹出 prompt 输入框；令牌仅存储在 sessionStorage 中
- 令牌错误时 API 返回 401，前端清除令牌并重新弹窗

### 4.2 店铺管理

#### 4.2.1 添加店铺
- 通过店铺 URL 添加
- URL 会被解析域名，提取最后一段作为店铺 ID
- 支持 http/https 协议
- 不允许重复添加（按 ID 去重）
- 添加后自动开始爬取

#### 4.2.2 店铺列表
- 左侧侧边栏展示所有店铺
- 展示店铺名称、商品数量、最近更新时间
- 按状态分组：正常（ok）、错误（error）、获取中（pending）
- 可拖拽排序，排序结果持久化到服务端

#### 4.2.3 删除店铺
- 在单个店铺视图中可删除
- 删除后不可恢复

#### 4.2.4 导入/导出
- 导出所有店铺数据（含价格历史）为 JSON 文件
- 导入 JSON 文件恢复数据
- 导出/导入店铺列表（仅 URL 列表）

### 4.3 商品展示

#### 4.3.1 商品网格
- 双列/响应式网格布局
- 每个商品卡片展示：名称、价格、库存状态、购买链接
- 无货商品半透明显示

#### 4.3.2 分类标签
- 页面顶部展示分类标签栏
- 分类依据服务端 classifyProducts 和可配置的本地正则规则自动归类，不依赖外部 Python 脚本
- 点击分类标签筛选商品
- 显示每个分类的商品数量

#### 4.3.3 搜索与筛选
- 包含关键词（包含）——商品名称必须包含所有输入词
- 排除关键词（排除）——商品名称不能包含任何输入词
- 价格区间滑块（双端滑块）
- 关键词输入支持回车确认，以 Chip 标签展示
- 推荐关键词提示（从 filter-config 中读取）

#### 4.3.4 商品标签
- 用户可对商品打标签（如：已购买、感兴趣等）
- 标签存储在服务端 product-labels 中
- 标签列支持筛选

### 4.4 价格追踪

#### 4.4.1 价格历史
- 点击商品查看价格历史折线图
- 图表使用 Chart.js（UMD 版本）
- 显示历史价格曲线和最新价格标注
- 左右箭头切换同一店铺的上下商品
- 点击模态框外部或按 ESC 关闭

#### 4.4.2 历史数据导入/导出
- 按店铺维度导出价格历史 JSON
- 全部历史数据统一导出
- 支持导入历史数据

### 4.5 刷新机制

#### 4.5.1 手动刷新
- 单个店铺刷新：在店铺视图中刷新
- 全局刷新：点击"全局刷新"按钮，按更新时间升序逐个刷新所有正常店铺
- 刷新过程中显示进度条动画
- 可随时点击"停止刷新"中断

#### 4.5.2 自动刷新
- 服务端定时器随机选择一个正常店铺刷新
- 刷新间隔可配置：随机区间模式（minMinutes ~ maxMinutes）或固定间隔模式（fixedMinutes）
- 默认随机 60~360 分钟
- 服务端启动时立刻执行一次自动刷新

#### 4.5.3 刷新流程
- 客户端发送 POST /api/stores/:id/refresh
- 服务端将店铺状态设为 pending，立即返回
- 服务端异步执行爬虫（scraper.js）
- 爬虫获取商品列表，解析店铺名称，存储到数据库
- 客户端轮询 /api/stores/summary（每 1.5 秒，最多 30 次）
- 检测到状态变为 ok 后，加载商品数据和标签，更新 UI

### 4.6 设置

#### 4.6.1 关键词管理
- 维护推荐关键词列表（换行分隔）
- 关键词用于前端搜索建议提示
- 关键词使用频率统计

#### 4.6.2 刷新间隔配置
- 模式切换：随机区间 / 固定间隔
- 随机区间最小/最大值（分钟）
- 固定间隔值（分钟）

### 4.7 UI 细节

- **主题切换**：亮色/暗色模式，存储在 localStorage
- **布局**：三栏式 — 左栏（店铺列表 + 全局刷新按钮）、中栏（分类标签 + 商品网格）、右栏（搜索/筛选 + 价格范围 + 标签列）
- **响应式**：左栏可收起（通过 toggle 按钮）
- **商品详情弹窗**：点击商品弹出模态框展示价格历史
- **设置弹窗**：点击"设置"按钮弹出
- **添加店铺弹窗**：点击"+ 添加店铺"弹出

## 5. 数据库表结构

### stores 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PRIMARY KEY | 店铺 ID（从 URL 提取） |
| url | TEXT | 店铺 URL |
| name | TEXT | 店铺名称（爬虫获取） |
| addedAt | TEXT ISO | 添加时间 |
| lastUpdated | TEXT ISO | 最近更新时间 |
| status | TEXT | ok / error / pending |
| error | TEXT | 错误信息 |
| products | TEXT JSON | 商品列表 JSON |

### history 表（价格历史）
| 字段 | 类型 | 说明 |
|------|------|------|
| productKey | TEXT PRIMARY KEY | storeId:productId |
| data | TEXT JSON | 历史价格数组 [{ price, updatedAt }] |

### labels 表（商品标签）
| 字段 | 类型 | 说明 |
|------|------|------|
| productKey | TEXT PRIMARY KEY | storeId:productId |
| label | TEXT | 用户自定义标签 |
| updatedAt | TEXT | 更新时间 |

## 6. API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/stores | 获取所有店铺（含完整商品数据） |
| GET | /api/stores/summary | 获取店铺摘要（不含商品列表，含 productCount） |
| GET | /api/stores/:id | 获取单个店铺（含商品数据） |
| POST | /api/stores | 添加新店铺 |
| DELETE | /api/stores/:id | 删除店铺 |
| POST | /api/stores/:id/refresh | 触发店铺刷新 |
| GET | /api/stores/export | 导出全部数据 |
| POST | /api/stores/import | 导入全部数据 |
| GET | /api/stores/export-list | 导出店铺 URL 列表 |
| POST | /api/stores/import-single | 从 URL 列表导入店铺 |
| GET | /api/stores/:id/export | 导出单个店铺数据 |
| GET | /api/stores/:id/history/export | 导出单个店铺价格历史 |
| POST | /api/stores/:id/history/import | 导入单个店铺价格历史 |
| GET | /api/stores/export-list | 导出店铺列表 |
| GET | /api/products/:storeId/:productId/history | 获取单个商品价格历史 |
| GET | /api/history/export | 导出全部价格历史 |
| POST | /api/history/import | 导入全部价格历史 |
| GET | /api/product-labels | 获取所有商品标签 |
| PUT | /api/product-labels/:productKey | 更新商品标签 |
| GET | /api/label-changes | 获取标签变更 |
| GET | /api/filter-config | 获取筛选配置（推荐关键词、使用频率） |
| PUT | /api/filter-config | 更新筛选配置 |
| GET | /api/refresh-config | 获取刷新间隔配置 |
| PUT | /api/refresh-config | 更新刷新间隔配置 |
| GET | /api/store-order | 获取店铺排序 |
| PUT | /api/store-order | 更新店铺排序 |

所有 /api/ 路由共用限流器：1000 次 / 15 分钟。
部分写入操作（添加/删除/刷新/导入）额外使用严格限流器：10 次 / 60 秒。

## 7. 爬虫逻辑

- 目标：解析电商店铺页面，提取商品列表
- 输入：店铺 URL
- 输出：{ shopName: string, products: Array }
- 每个商品包含：id, name, price, stock, purchaseUrl, updatedAt
- 返回 30 页数据（每页数量由接口决定）
- 包含错误处理，爬取失败时状态设为 error 并记录错误信息

## 8. 前端架构说明

- 单文件 app.js，约 1670 行
- 使用 DOMContentLoaded 事件初始化
- 页面状态由全局变量管理（storeSummaries, stores, productsDirty 等）
- 渲染函数以 innerHTML 直接操作 DOM
- 无路由系统，通过切换 activeStoreId + render() 实现视图切换
- 全部视图：所有商品（全部）、单个店铺商品、"最新"视图（按更新时间排序）、"最优"视图（按标签等筛选）
