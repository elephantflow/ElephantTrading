# ElephantTrading · 资产价格追踪

> 黄金(XAU/USD)、美元指数(DXY)、欧元(EUR/USD)、日元(USD/JPY) 每日价格跟踪与趋势分析

🌐 **在线访问**：[https://elephantflow.github.io/ElephantTrading](https://elephantflow.github.io/ElephantTrading)

---

## 功能

- 📈 **价格曲线**：时间序列图表，支持1M/3M/6M/1Y视图
- 📊 **移动均线**：MA7 / MA30 趋势线
- 🔍 **趋势分析**：自动判断上涨/下跌/震荡，生成文字摘要
- ⚠️ **异常告警**：单日涨跌超阈值时记录告警
- 🔄 **自动更新**：GitHub Actions 每2小时抓取最新数据

## 数据来源

| 资产 | 数据源 |
|------|--------|
| XAU/USD 黄金 | [Stooq](https://stooq.com) |
| EUR/USD 欧元 | [Frankfurter (ECB)](https://www.frankfurter.app) |
| USD/JPY 日元 | [Frankfurter (ECB)](https://www.frankfurter.app) |
| DXY 美元指数 | 由官方权重公式计算（EUR/JPY/GBP/CAD/SEK/CHF） |

DXY 计算公式：`50.14348112 × EUR^(-0.576) × JPY^(0.136) × GBP^(-0.119) × CAD^(0.091) × SEK^(0.042) × CHF^(0.036)`

## 本地运行

```bash
# 初始化历史数据（首次）
node scripts/init_history.js

# 手动更新最新价格
node scripts/fetch_prices.js
```

## 结构

```
ElephantTrading/
├── index.html                          # 主页面
├── data/
│   ├── prices.json                     # 历史价格数据
│   └── alerts.json                     # 异常告警记录
├── scripts/
│   ├── fetch_prices.js                 # 每2小时数据抓取
│   └── init_history.js                 # 一次性历史初始化
└── .github/workflows/
    ├── update-prices.yml               # 定时抓取 Action
    └── deploy-pages.yml                # GitHub Pages 部署
```
