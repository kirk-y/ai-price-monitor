# AI 价格监控

AI 价格监控是一个面向 [链动小铺](https://pay.ldxp.cn) 的本地商品价格监控工具。它可以集中管理多个店铺，定时抓取商品价格和库存，记录价格历史，并按商品分类进行筛选和最低价比较。

项目默认只在本机运行，数据保存在本地 SQLite 数据库中，不需要单独部署数据库。

## 主要功能

- 多店铺管理：添加、隐藏、恢复、删除和排序店铺，支持导入、导出店铺列表。
- 商品筛选：按一级分类、二级分类、关键词、排除词和价格区间筛选商品。
- 分类管理：添加或删除二级分类、调整所属一级分类、控制显示状态和拖拽排序。
- 辅助分类：使用本地规则分类，也可以连接 OpenAI 兼容的大模型接口重新分类商品。
- 价格历史：查看单个商品的价格走势，并记录采集时的价格和库存状态。
- 历史最低价：按店铺或全部店铺统计各分类在每个时间点的有货最低价。
- 数据迁移：支持完整数据、店铺列表、单店数据和价格历史的导入与导出。
- 本地安全：默认仅监听 `127.0.0.1`；对外提供服务时可以启用访问令牌。

## 普通用户：使用便携版

便携版已经包含 Node.js 和项目依赖，适合直接发送给其他 Windows 用户。

1. 下载并解压 `AI-price-monitor-windows-x64-v版本号.7z`。
2. 进入解压后的目录。
3. 双击 `start-price-monitor.bat`。
4. 浏览器会自动打开 `http://127.0.0.1:3000`。
5. 点击“添加店铺”，输入形如 `https://pay.ldxp.cn/shop/店铺ID` 的店铺地址。

使用期间请保留后台服务窗口。需要停止服务时，关闭对应的 Node.js 服务窗口即可。

### 便携版数据位置

所有持久化数据位于便携目录的 `data` 文件夹，主要数据库文件为：

```text
data/stores.db
```

升级便携版时，请保留旧版本的 `data` 文件夹和 `.env` 文件，再替换其余程序文件。也可以先在“设置 → 导出数据”中创建完整备份。

## 开发者：从源码运行

### 环境要求

- Windows、Linux 或 macOS
- Node.js 22 或更高版本
- npm

### 安装与启动

```bash
git clone https://github.com/kirk-y/ai-price-monitor.git
cd ai-price-monitor
npm install
npm start
```

启动后访问：

```text
http://127.0.0.1:3000
```

Windows 用户也可以先运行 `setup.bat` 安装依赖，再运行 `start.bat`。

## 配置

复制 `.env.example` 为 `.env`，按需修改：

```dotenv
PORT=3000
HOST=127.0.0.1
# AUTH_TOKEN=请替换为高强度随机令牌
```

| 配置项 | 说明 |
| --- | --- |
| `PORT` | Web 服务端口，默认 `3000`。 |
| `HOST` | 监听地址，默认 `127.0.0.1`，仅本机可访问。 |
| `AUTH_TOKEN` | 可选访问令牌。监听非本机地址时必须设置。 |
| `DB_PATH` | 可选数据库路径，默认使用 `data/stores.db`。 |

不要在未设置 `AUTH_TOKEN` 的情况下将服务暴露到局域网或公网。程序也会拒绝在无令牌时监听非本机地址。

## 使用大模型辅助分类

在“设置 → 大模型分类”中填写：

- OpenAI 兼容的 Chat Completions 接口地址
- API Key
- 模型名称

程序只允许模型从当前分类集合中选择分类，并将结果保存为商品标签。API Key 会保存在本地数据库配置中，请不要在多人共用或不可信的设备上使用敏感密钥。

## 数据备份与恢复

设置中提供以下方式：

- 完整数据导入、导出
- 店铺列表导入、导出
- 单个店铺数据导出
- 全部或单店价格历史导入、导出

完整导入会替换当前数据，操作前建议先创建备份。价格历史导入采用去重逻辑，可以重复导入同一份历史文件。

## 生成 Windows 发布版

先安装项目依赖和 [7-Zip](https://www.7-zip.org/)，然后在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-portable.ps1
```

构建结果位于 `release` 目录，包括：

- 可直接运行的便携目录
- ZIP 压缩包
- 7Z 压缩包
- 对应的 SHA-256 校验文件

`release` 已加入 `.gitignore`，不会被提交到 Git。

## 测试

```bash
npm test
```

## 技术栈

- 后端：Node.js、Express、better-sqlite3
- 前端：原生 JavaScript、HTML、CSS、Chart.js
- 数据采集：Axios、Cheerio
- 数据存储：SQLite

## 项目地址

[github.com/kirk-y/ai-price-monitor](https://github.com/kirk-y/ai-price-monitor)
