/**
 * background.js - Service Worker 后台脚本
 *
 * 职责分工：
 *   silverKlineAlarm    → 每12小时拉一次 Yahoo Finance 日K原始数据，存入 storage
 *   silverPriceAlarm    → 用户开启自动刷新时，按用户设定频率拉 Swissquote 实时价格
 *   intradayKlineAlarm  → 每5分钟拉一次 Infoway 分时K线数据（1分钟和5分钟）
 *
 * storage key 说明：
 *   rawDailyData        → Yahoo Finance 日K 原始条目数组 [{date,open,high,low,close}, ...]
 *   klineUpdatedAt      → 上次拉取日K的时间戳(ms)
 *   intradayData_1m     → Infoway 1分钟K线数据（最近100根）
 *   intradayData_5m     → Infoway 5分钟K线数据（最近100根）
 *   intradayUpdatedAt   → 上次拉取分时数据的时间戳(ms)
 *   cachedPrice         → 最新 Swissquote 实时报价对象
 *   autoRefresh         → 用户是否开启自动刷新
 *   refreshInterval     → 用户设定的刷新间隔(秒)
 */

const SWISSQUOTE_URL    = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAG/USD';
const YAHOO_FINANCE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1d&range=5y'; // Yahoo Finance 白银期货，5年数据
const INFOWAY_BASE_URL  = 'https://data.infoway.io/common/batch_kline'; // Infoway 分时K线
const INFOWAY_API_KEY   = 'e092659284b84e7a996a46c7cc620f2a-infoway';

const KLINE_ALARM       = 'silverKlineAlarm';     // 每12小时刷新日K线
const PRICE_ALARM       = 'silverPriceAlarm';     // 实时价格自动刷新
const INTRADAY_ALARM    = 'intradayKlineAlarm';   // 每5分钟刷新分时K线

const KLINE_TTL_MS      = 12 * 60 * 60 * 1000;    // 12 小时
const INTRADAY_TTL_MS   = 5 * 60 * 1000;          // 5 分钟
const DATA_VERSION      = 4; // 数据版本号，升版后强制清除旧缓存重拉（V4: 添加 Infoway 分时数据）

// ===== 消息监听（来自 popup）=====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_KLINE') {
    // popup 请求立即拉一次 K 线（首次无缓存时）
    fetchAndStoreKline().then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === 'FETCH_INTRADAY') {
    // popup 请求立即拉一次分时 K 线
    fetchAndStoreIntradayKline().then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === 'CHECK_KLINE_CACHE') {
    // 用户点击日K/周K/月K时，检查缓存是否存在或过期
    checkAndRefreshKlineCache().then((result) => {
      sendResponse(result);
    }).catch(e => {
      sendResponse({ success: false, error: e.message });
    });
    return true;
  }
  if (message.type === 'CHECK_INTRADAY_CACHE') {
    // 用户点击分时图时，检查分时数据缓存
    checkAndRefreshIntradayCache().then((result) => {
      sendResponse(result);
    }).catch(e => {
      sendResponse({ success: false, error: e.message });
    });
    return true;
  }
  if (message.type === 'SET_PRICE_ALARM') {
    // 用户开启/关闭自动刷新
    if (message.enable) {
      setupPriceAlarm(message.intervalSeconds);
    } else {
      chrome.alarms.clear(PRICE_ALARM);
    }
    sendResponse({ success: true });
  }
});

// ===== Alarm 触发 =====
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KLINE_ALARM) {
    // 每12小时刷新 K 线原始数据
    try {
      await fetchAndStoreKline();
    } catch (err) {
      console.error('[KlineAlarm] 拉取失败:', err);
    }
  }

  if (alarm.name === INTRADAY_ALARM) {
    // 每5分钟刷新分时 K 线数据
    try {
      await fetchAndStoreIntradayKline();
    } catch (err) {
      console.error('[IntradayAlarm] 拉取失败:', err);
    }
  }

  if (alarm.name === PRICE_ALARM) {
    // 按用户频率刷新实时价格，更新 badge
    try {
      const price = await fetchSpotPrice();
      await storeAndBadge(price);
    } catch (err) {
      console.error('[PriceAlarm] 拉取失败:', err);
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#f04b5a' });
    }
  }
});

// ===== 拉取 Yahoo Finance 日K 并存 storage =====
async function fetchAndStoreKline() {
  const resp = await fetch(YAHOO_FINANCE_URL, { 
    headers: { 'User-Agent': 'Mozilla/5.0' } 
  });
  
  if (!resp.ok) throw new Error(`Yahoo Finance ${resp.status}`);

  const json = await resp.json();
  
  // 检查响应结构
  if (!json.chart || !json.chart.result || json.chart.result.length === 0) {
    throw new Error('Yahoo Finance 无数据');
  }

  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const quotes = result.indicators?.quote?.[0] || {};
  
  const opens = quotes.open || [];
  const highs = quotes.high || [];
  const lows = quotes.low || [];
  const closes = quotes.close || [];

  // 转换为统一格式：[{date, open, high, low, close}, ...]
  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    // 过滤掉空值（周末和节假日）
    if (closes[i] === null || opens[i] === null) continue;
    
    const date = new Date(timestamps[i] * 1000);
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, ''); // 格式: 20240329
    
    rows.push({
      date: dateStr,
      open: opens[i],
      high: highs[i],
      low: lows[i],
      close: closes[i]
    });
  }

  if (rows.length === 0) {
    throw new Error('Yahoo Finance 解析后无有效数据');
  }

  chrome.storage.local.set({ rawDailyData: rows, klineUpdatedAt: Date.now() });
  console.log(`[KlineAlarm] 已缓存 ${rows.length} 条日K数据（Yahoo Finance）`);
}

// ===== 拉取 Swissquote 实时价格 =====
async function fetchSpotPrice() {
  const resp = await fetch(SWISSQUOTE_URL, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`Swissquote ${resp.status}`);
  const json = await resp.json();
  const entry = json[0];
  const quote = entry.spreadProfilePrices.find(p => p.spreadProfile === 'standard') || entry.spreadProfilePrices[0];
  return { bid: quote.bid, ask: quote.ask, ts: entry.ts };
}

// ===== 存实时价格并更新 badge =====
async function storeAndBadge({ bid, ask, ts }) {
  const mid = (bid + ask) / 2;
  // 读取缓存日K，计算昨收、涨跌幅
  const stored = await getStorage(['rawDailyData']);
  const rows = stored.rawDailyData || [];
  let prevClose = mid, changePct = 0;
  if (rows.length >= 1) {
    prevClose = rows[rows.length - 1].close;
    changePct = prevClose > 0 ? (mid - prevClose) / prevClose * 100 : 0;
  }

  const now = new Date();
  const timeStr = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');

  const cachedPrice = { bid, ask, mid, ts, prevClose, changePct, queryTime: timeStr };
  chrome.storage.local.set({ cachedPrice });

  const badgeText = mid >= 1000 ? mid.toFixed(0) : mid.toFixed(1);
  chrome.action.setBadgeText({ text: badgeText });
  chrome.action.setBadgeBackgroundColor({ color: changePct >= 0 ? '#26d17a' : '#f04b5a' });
}

// ===== 设置实时价格 Alarm =====
function setupPriceAlarm(intervalSeconds) {
  chrome.alarms.clear(PRICE_ALARM, () => {
    chrome.alarms.create(PRICE_ALARM, {
      periodInMinutes: Math.max(intervalSeconds / 60, 0.5),
    });
  });
}

// ===== 工具函数 =====
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

// ===== 检查并刷新 K 线缓存 =====
async function checkAndRefreshKlineCache() {
  const { rawDailyData, klineUpdatedAt } = await getStorage(['rawDailyData', 'klineUpdatedAt']);
  
  // 检查缓存是否存在
  if (!rawDailyData || rawDailyData.length === 0) {
    console.log('[CacheCheck] K线缓存不存在，开始拉取...');
    await fetchAndStoreKline();
    return { success: true, refreshed: true, reason: 'no_cache' };
  }
  
  // 检查缓存是否过期（超过 12 小时）
  if (!klineUpdatedAt || Date.now() - klineUpdatedAt > KLINE_TTL_MS) {
    console.log('[CacheCheck] K线缓存已过期，开始刷新...');
    await fetchAndStoreKline();
    return { success: true, refreshed: true, reason: 'expired' };
  }
  
  // 缓存有效
  const ageHours = ((Date.now() - klineUpdatedAt) / (60 * 60 * 1000)).toFixed(1);
  console.log(`[CacheCheck] K线缓存有效，已缓存 ${rawDailyData.length} 条数据，更新于 ${ageHours} 小时前`);
  return { success: true, refreshed: false, dataCount: rawDailyData.length, ageHours: parseFloat(ageHours) };
}

// ===== 插件安装/启动初始化 =====
chrome.runtime.onInstalled.addListener(async () => {
  // 检查数据版本，旧版本缓存强制清除重拉
  const { dataVersion } = await getStorage(['dataVersion']);
  if (dataVersion !== DATA_VERSION) {
    console.log(`[Init] 数据版本升级 ${dataVersion} → ${DATA_VERSION}，清除旧K线缓存重拃`);
    chrome.storage.local.remove(['rawDailyData', 'klineUpdatedAt']);
  }
  chrome.storage.local.set({ autoRefresh: false, refreshInterval: 30, dataVersion: DATA_VERSION });
  chrome.action.setBadgeText({ text: 'Ag' });
  chrome.action.setBadgeBackgroundColor({ color: '#4ecdc4' });
  // 立即拉一次 K 线
  try { await fetchAndStoreKline(); } catch (e) { console.warn('初始化K线失败:', e); }
  // 注册12小时 K 线刷新 alarm
  chrome.alarms.create(KLINE_ALARM, { periodInMinutes: 12 * 60 });
});

// Service Worker 每次启动也检查 K 线是否过期
chrome.runtime.onStartup.addListener(async () => {
  const { klineUpdatedAt } = await getStorage(['klineUpdatedAt']);
  if (!klineUpdatedAt || Date.now() - klineUpdatedAt > KLINE_TTL_MS) {
    try { await fetchAndStoreKline(); } catch (e) { console.warn('启动时K线刷新失败:', e); }
  }
  // 确保 K 线 alarm 存在
  chrome.alarms.get(KLINE_ALARM, alarm => {
    if (!alarm) chrome.alarms.create(KLINE_ALARM, { periodInMinutes: 12 * 60 });
  });
});
