#!/usr/bin/env node
/**
 * fetch_prices.js - v3
 * 数据来源：
 * - 黄金 XAU/USD: stooq.com (CSV, real-time format)
 * - 国际汇率 EUR/USD, USD/JPY, GBP/USD: frankfurter.app (ECB)
 * - DXY: 官方权重公式计算
 * - CNY 汇率: 中国银行外汇牌价 (中行折算价, 100外币=x人民币)
 * - 黄金 CNY/g: XAU/USD × CNY_per_USD / 31.1034768
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/prices.json');
const ALERT_FILE = path.join(__dirname, '../data/alerts.json');
const TROY_OZ_TO_G = 31.1034768;

const ALERT_THRESHOLDS = {
  xauusd: 1.5, dxy: 0.8, eurusd: 0.8, usdjpy: 0.8, xauusd_cny_g: 1.5
};

function curlGet(url) {
  return execSync(
    `curl -sL --max-time 15 -H "User-Agent: Mozilla/5.0 (compatible; ElephantTrading/1.0)" "${url}"`,
    { encoding: 'utf8' }
  );
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function calcDXY(rates) {
  const { EUR, JPY, GBP, CAD, SEK, CHF } = rates;
  if (!EUR || !JPY || !GBP || !CAD || !SEK || !CHF) return null;
  const dxy = 50.14348112
    * Math.pow(EUR, 0.576)       // EUR here is USD_per_EUR rate reciprocal
    * Math.pow(JPY, 0.136)
    * Math.pow(GBP, 0.119)
    * Math.pow(CAD, 0.091)
    * Math.pow(SEK, 0.042)
    * Math.pow(CHF, 0.036);
  // Correct formula: rates from frankfurter are X per USD
  // EUR rate = EUR per USD (e.g. 0.865), JPY rate = JPY per USD (e.g. 157.9)
  const eurusd = 1 / EUR;
  const gbpusd = 1 / GBP;
  const dxy2 = 50.14348112
    * Math.pow(1 / eurusd, 0.576)
    * Math.pow(JPY, 0.136)
    * Math.pow(1 / gbpusd, 0.119)
    * Math.pow(CAD, 0.091)
    * Math.pow(SEK, 0.042)
    * Math.pow(CHF, 0.036);
  return parseFloat(dxy2.toFixed(3));
}

async function fetchGold() {
  // stooq real-time CSV
  try {
    const raw = curlGet('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv');
    const lines = raw.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(',');
      if (parts[6] && parts[6] !== 'N/D') {
        return parseFloat(parseFloat(parts[6]).toFixed(2));
      }
    }
  } catch (e) {
    console.warn('stooq real-time gold failed:', e.message);
  }
  return null;
}

async function fetchFX() {
  // EUR/USD, USD/JPY, GBP/USD, DXY via frankfurter
  try {
    const raw = curlGet('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF');
    const json = JSON.parse(raw);
    if (json.rates) {
      const r = json.rates;
      return {
        eurusd: r.EUR ? parseFloat((1 / r.EUR).toFixed(5)) : null,
        usdjpy: r.JPY ? parseFloat(r.JPY.toFixed(3)) : null,
        gbpusd: r.GBP ? parseFloat((1 / r.GBP).toFixed(5)) : null,
        dxy: calcDXY(r),
      };
    }
  } catch (e) {
    console.warn('frankfurter failed:', e.message);
  }
  return {};
}

async function fetchBOCRates() {
  // 中国银行外汇牌价（中行折算价）
  // HTML table: <tr data-currency='美元'><td>美元</td><td>买入</td>...<td>折算价</td>
  try {
    const raw = curlGet('https://www.boc.cn/sourcedb/whpj/');

    function extractRate(currencyName) {
      // Match: data-currency='xxx'><td>xxx</td><td>val</td>...<td>FOLDS_PRICE</td>
      // Table columns: 货币名称 | 现汇买入 | 现钞买入 | 现汇卖出 | 现钞卖出 | 中行折算价
      const re = new RegExp(
        `data-currency='${currencyName}'>[\\s\\S]*?<td>${currencyName}<\\/td>[\\s\\S]*?<td>([\\d.]*)<\\/td>[\\s\\S]*?<td>([\\d.]*)<\\/td>[\\s\\S]*?<td>([\\d.]*)<\\/td>[\\s\\S]*?<td>([\\d.]*)<\\/td>[\\s\\S]*?<td>([\\d.]+)<\\/td>`
      );
      const m = raw.match(re);
      if (m && m[5]) return parseFloat(m[5]);
      
      // fallback: simpler pattern
      const re2 = new RegExp(`<td>${currencyName}<\\/td>(?:[\\s\\S]*?<td>[\\d.]*<\\/td>){4}[\\s\\S]*?<td>([\\d.]+)<\\/td>`);
      const m2 = raw.match(re2);
      if (m2 && m2[1]) return parseFloat(m2[1]);
      
      return null;
    }

    const usdRate = extractRate('美元');
    const eurRate = extractRate('欧元');
    const jpyRate = extractRate('日元');
    const gbpRate = extractRate('英镑');

    console.log('BOC raw rates (per 100):', { usdRate, eurRate, jpyRate, gbpRate });

    return {
      cny_per_usd: usdRate ? parseFloat((usdRate / 100).toFixed(6)) : null,
      cny_per_eur: eurRate ? parseFloat((eurRate / 100).toFixed(6)) : null,
      cny_per_jpy: jpyRate ? parseFloat((jpyRate / 100).toFixed(6)) : null,
      cny_per_gbp: gbpRate ? parseFloat((gbpRate / 100).toFixed(6)) : null,
    };
  } catch (e) {
    console.warn('BOC rates failed:', e.message);
    return {};
  }
}

async function fetchBOCRatesFallback() {
  // 备用：frankfurter CNY rates
  try {
    const raw = curlGet('https://api.frankfurter.app/latest?from=CNY&to=USD,EUR,JPY,GBP');
    const json = JSON.parse(raw);
    if (json.rates) {
      const r = json.rates;
      return {
        cny_per_usd: r.USD ? parseFloat((1 / r.USD).toFixed(6)) : null,
        cny_per_eur: r.EUR ? parseFloat((1 / r.EUR).toFixed(6)) : null,
        cny_per_jpy: r.JPY ? parseFloat((1 / r.JPY).toFixed(6)) : null,
        cny_per_gbp: r.GBP ? parseFloat((1 / r.GBP).toFixed(6)) : null,
      };
    }
  } catch (e) {
    console.warn('frankfurter CNY fallback failed:', e.message);
  }
  return {};
}

function detectAlerts(newRecord, history) {
  if (!history.length) return [];
  const prev = [...history].reverse().find(r => r.date < newRecord.date);
  if (!prev) return [];
  const alerts = [];
  for (const [asset, threshold] of Object.entries(ALERT_THRESHOLDS)) {
    const nv = newRecord[asset], pv = prev[asset];
    if (!nv || !pv) continue;
    const changePct = Math.abs((nv - pv) / pv * 100);
    if (changePct >= threshold) {
      alerts.push({
        asset: asset.toUpperCase(),
        direction: nv > pv ? '📈 上涨' : '📉 下跌',
        changePct: parseFloat(changePct.toFixed(2)),
        from: pv, to: nv,
      });
    }
  }
  return alerts;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Fetching latest prices...`);

  const [gold, fx, bocRatesRaw] = await Promise.all([
    fetchGold(),
    fetchFX(),
    fetchBOCRates(),
  ]);

  // 如果中行抓取失败，用 frankfurter 备用
  let bocRates = bocRatesRaw;
  if (!bocRates.cny_per_usd) {
    console.log('BOC rates missing, trying frankfurter fallback...');
    bocRates = await fetchBOCRatesFallback();
  }

  const today = formatDate(new Date());

  // 黄金人民币/克
  let xauusd_cny_g = null;
  if (gold && bocRates.cny_per_usd) {
    xauusd_cny_g = parseFloat((gold * bocRates.cny_per_usd / TROY_OZ_TO_G).toFixed(2));
  }

  const newRecord = {
    date: today,
    xauusd: gold,
    dxy: fx.dxy || null,
    eurusd: fx.eurusd || null,
    usdjpy: fx.usdjpy || null,
    gbpusd: fx.gbpusd || null,
    cny_per_usd: bocRates.cny_per_usd || null,
    cny_per_eur: bocRates.cny_per_eur || null,
    cny_per_jpy: bocRates.cny_per_jpy || null,
    cny_per_gbp: bocRates.cny_per_gbp || null,
    xauusd_cny_g,
  };

  console.log('Record:', JSON.stringify(newRecord, null, 2));

  let history = [];
  if (fs.existsSync(DATA_FILE)) {
    history = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }

  const alerts = detectAlerts(newRecord, history);
  if (alerts.length > 0) {
    console.log('⚠️  ALERTS:', JSON.stringify(alerts));
    const existing = fs.existsSync(ALERT_FILE) ? JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')) : [];
    existing.push({ timestamp: new Date().toISOString(), date: today, alerts });
    fs.writeFileSync(ALERT_FILE, JSON.stringify(existing.slice(-50), null, 2));
    process.stdout.write('\nALERT_SIGNAL:' + JSON.stringify(alerts) + '\n');
  }

  const idx = history.findIndex(r => r.date === today);
  const allKeys = ['xauusd','dxy','eurusd','usdjpy','gbpusd','cny_per_usd','cny_per_eur','cny_per_jpy','cny_per_gbp','xauusd_cny_g'];
  if (idx >= 0) {
    for (const k of allKeys) {
      if (newRecord[k] !== null && newRecord[k] !== undefined) history[idx][k] = newRecord[k];
    }
  } else {
    history.push(newRecord);
    history.sort((a, b) => a.date.localeCompare(b.date));
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2));
  console.log(`✅ Updated (${history.length} records total)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
