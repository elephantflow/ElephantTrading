#!/usr/bin/env node
/**
 * init_history.js - v2
 * 初始化过去一年历史数据，包含 CNY 计价字段
 * - XAU/USD: stooq
 * - 汇率: frankfurter.app (含CNY)
 * - DXY: 公式计算
 * - xauusd_cny_g: 黄金 CNY/克
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/prices.json');
const TROY_OZ_TO_G = 31.1034768;

function httpsGet(url) {
  return execSync(`curl -sL --max-time 30 -H "User-Agent: ElephantTrading/1.0" '${url}'`, { encoding: 'utf8' });
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function getDateRange(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) dates.push(formatDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
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

async function fetchFrankfurter(startDate, endDate) {
  // 获取 USD 为基准的多货币汇率（含CNY）
  const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=USD&to=EUR,JPY,GBP,CAD,SEK,CHF,CNY`;
  console.log(`Fetching frankfurter (USD base, incl CNY): ${startDate} to ${endDate}`);
  const raw = httpsGet(url);
  const json = JSON.parse(raw);
  return json.rates || {};
}

async function fetchGoldHistory(startDate, endDate) {
  const d1 = startDate.replace(/-/g, '');
  const d2 = endDate.replace(/-/g, '');
  const url = `https://stooq.com/q/d/l/?s=xauusd&d1=${d1}&d2=${d2}&i=d`;
  console.log(`Fetching gold history...`);
  const raw = httpsGet(url);
  const lines = raw.trim().split('\n');
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 5 && parts[4] && parts[4] !== 'null') {
      result[parts[0]] = parseFloat(parseFloat(parts[4]).toFixed(2));
    }
  }
  return result;
}

async function main() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);

  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);

  console.log(`Fetching data from ${startStr} to ${endStr}...`);

  const [fxRates, goldPrices] = await Promise.all([
    fetchFrankfurter(startStr, endStr),
    fetchGoldHistory(startStr, endStr),
  ]);

  const allDates = getDateRange(startDate, endDate);
  const records = [];

  for (const date of allDates) {
    const fx = fxRates[date];
    const gold = goldPrices[date];

    if (!fx && !gold) continue;

    const dxy = fx ? calcDXY(fx) : null;
    const eurusd = fx && fx.EUR ? parseFloat((1 / fx.EUR).toFixed(5)) : null;
    const usdjpy = fx && fx.JPY ? parseFloat(fx.JPY.toFixed(3)) : null;
    const gbpusd = fx && fx.GBP ? parseFloat((1 / fx.GBP).toFixed(5)) : null;

    // CNY 汇率（来自 frankfurter，基于 ECB/市场汇率）
    // CNY rate = CNY per USD (frankfurter returns CNY units per 1 USD)
    const cny_per_usd = fx && fx.CNY ? parseFloat(fx.CNY.toFixed(6)) : null;
    const cny_per_eur = (eurusd && cny_per_usd) ? parseFloat((eurusd * cny_per_usd).toFixed(6)) : null;
    const cny_per_jpy = (usdjpy && cny_per_usd) ? parseFloat((cny_per_usd / usdjpy).toFixed(6)) : null;
    const cny_per_gbp = (gbpusd && cny_per_usd) ? parseFloat((gbpusd * cny_per_usd).toFixed(6)) : null;

    // 黄金 CNY/克
    const xauusd_cny_g = (gold && cny_per_usd)
      ? parseFloat((gold * cny_per_usd / TROY_OZ_TO_G).toFixed(2))
      : null;

    records.push({
      date, xauusd: gold || null, dxy, eurusd, usdjpy, gbpusd,
      cny_per_usd, cny_per_eur, cny_per_jpy, cny_per_gbp, xauusd_cny_g
    });
  }

  console.log(`Total records: ${records.length}`);

  let existing = [];
  if (fs.existsSync(DATA_FILE)) {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }

  // 合并：新记录优先，但保留今日中行抓取数据
  const map = {};
  for (const r of existing) map[r.date] = r;
  for (const r of records) {
    if (map[r.date]) {
      // 合并：保留中行抓取的 cny_ 字段（更精确），其余覆盖
      const merged = { ...r };
      for (const k of ['cny_per_usd','cny_per_eur','cny_per_jpy','cny_per_gbp','xauusd_cny_g']) {
        if (map[r.date][k] !== null && map[r.date][k] !== undefined) merged[k] = map[r.date][k];
      }
      map[r.date] = merged;
    } else {
      map[r.date] = r;
    }
  }

  const merged = Object.values(map).sort((a, b) => a.date.localeCompare(b.date));

  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2));
  console.log(`✅ Saved ${merged.length} records to ${DATA_FILE}`);

  console.log('\nLatest 2 records:');
  merged.slice(-2).forEach(r => console.log(JSON.stringify(r)));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
