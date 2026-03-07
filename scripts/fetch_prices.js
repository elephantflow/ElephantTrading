#!/usr/bin/env node
/**
 * fetch_prices.js
 * 每2小时由 cron 调用，抓取最新价格并追加/更新到 prices.json
 * 使用 curl 发起请求（绕过 Node.js SSL 兼容性问题）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/prices.json');
const ALERT_FILE = path.join(__dirname, '../data/alerts.json');

const ALERT_THRESHOLDS = { xauusd: 1.5, dxy: 0.8, eurusd: 0.8, usdjpy: 0.8 };

function curlGet(url) {
  try {
    const out = execSync(`curl -sL --max-time 15 -H "User-Agent: ElephantTrading/1.0" "${url}"`, { encoding: 'utf8' });
    return out;
  } catch (e) {
    throw new Error(`curl failed: ${e.message}`);
  }
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function calcDXY(rates) {
  const { EUR, JPY, GBP, CAD, SEK, CHF } = rates;
  if (!EUR || !JPY || !GBP || !CAD || !SEK || !CHF) return null;
  const eurusd = 1 / EUR;
  const gbpusd = 1 / GBP;
  const dxy = 50.14348112
    * Math.pow(1 / eurusd, 0.576)
    * Math.pow(JPY, 0.136)
    * Math.pow(1 / gbpusd, 0.119)
    * Math.pow(CAD, 0.091)
    * Math.pow(SEK, 0.042)
    * Math.pow(CHF, 0.036);
  return parseFloat(dxy.toFixed(3));
}

async function fetchLatestPrices() {
  const prices = { xauusd: null, dxy: null, eurusd: null, usdjpy: null, gbpusd: null };

  // 1. 黄金 - metals.live
  try {
    const raw = curlGet('https://metals.live/api/v1/spot');
    const json = JSON.parse(raw);
    const item = Array.isArray(json) ? json[0] : json;
    if (item && item.gold) prices.xauusd = parseFloat(parseFloat(item.gold).toFixed(2));
    console.log('Gold (metals.live):', prices.xauusd);
  } catch (e) {
    console.warn('metals.live failed:', e.message);
  }

  // 黄金备选 - stooq
  if (!prices.xauusd) {
    try {
      const raw = curlGet('https://stooq.com/q/d/l/?s=xauusd&i=d');
      const lines = raw.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[lines.length - 1].split(',');
        if (parts[4] && parts[4] !== 'null') {
          prices.xauusd = parseFloat(parseFloat(parts[4]).toFixed(2));
          console.log('Gold (stooq):', prices.xauusd);
        }
      }
    } catch (e) {
      console.warn('stooq gold failed:', e.message);
    }
  }

  // 2. 汇率 + DXY - frankfurter.app
  try {
    const raw = curlGet('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF');
    const json = JSON.parse(raw);
    if (json.rates) {
      const r = json.rates;
      prices.eurusd = r.EUR ? parseFloat((1 / r.EUR).toFixed(5)) : null;
      prices.usdjpy = r.JPY ? parseFloat(r.JPY.toFixed(3)) : null;
      prices.gbpusd = r.GBP ? parseFloat((1 / r.GBP).toFixed(5)) : null;
      prices.dxy = calcDXY(r);
      console.log('FX (frankfurter):', { eurusd: prices.eurusd, usdjpy: prices.usdjpy, dxy: prices.dxy });
    }
  } catch (e) {
    console.warn('frankfurter failed:', e.message);
  }

  return prices;
}

function detectAlerts(newRecord, history) {
  if (history.length === 0) return [];
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

  const prices = await fetchLatestPrices();
  const today = formatDate(new Date());
  const newRecord = { date: today, ...prices };
  console.log('Record:', JSON.stringify(newRecord));

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
  if (idx >= 0) {
    for (const k of ['xauusd', 'dxy', 'eurusd', 'usdjpy', 'gbpusd']) {
      if (newRecord[k] !== null) history[idx][k] = newRecord[k];
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
