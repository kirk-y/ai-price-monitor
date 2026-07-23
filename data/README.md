# 数据目录说明

## 数据库
- `stores.db` — SQLite 数据库，所有数据存储于此

### 表结构

**stores** — 店铺及商品数据
| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 店铺标识（URL最后一段） |
| url | TEXT | 店铺链接 |
| name | TEXT | 店铺名称 |
| addedAt | TEXT | 添加时间 (ISO 8601) |
| lastUpdated | TEXT | 最后更新时间 |
| status | TEXT | ok / pending / error |
| error | TEXT | 错误信息 |
| products | TEXT | JSON 数组，每项包含 goods_key, name, price, stock, purchaseUrl, id |

**price_history** — 价格历史
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增ID |
| product_key | TEXT | 店铺ID:商品goods_key，如 `plus123:abc123` |
| price | REAL | 价格 |
| date | TEXT | 记录时间 (ISO 8601) |

索引: `idx_price_history_product_key` (product_key)；唯一索引 `idx_price_history_unique` (product_key, price, date)，保证历史导入幂等。

**config** — 配置
| 列 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | 配置键，如 `filterConfig` |
| value | TEXT | JSON 值 |

### price_history 保留策略
每商品最多保留 200 条记录，超出时自动删除最旧条目。

## 历史文件
- `stores.json` — 旧版 JSON 存储文件（SQLite 首次启动时会自动迁移后保留，可安全删除）
