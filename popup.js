/**
 * popup.js - 主控制逻辑
 *
 * 数据分层设计：
 *   实时层  Swissquote  → 面板数据 + 分时图（每次手动/自动刷新都调这个）
 *   K 线层  Stooq 日K   → 由 background 每12小时拉取一次，存到 storage.rawDailyData
 *               日K/周K/月K 全部由 rawDailyData 在前端聚合生成，不再发请求
 */

// ===== 全局状态 =====
let chart        = null;
let currentTab   = 'realtime';
let priceTimer   = null;   // popup 内实时刷新定时器
let isLoading    = false;
let lastPrice    = null;   // 最新实时报价 {bid,ask,mid,prevClose,changePct,...}
let dailyRows    = [];     // rawDailyData 缓存（不重复请求）

// ===== 常量 =====
const SWISSQUOTE_URL = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAG/USD';
const INTRADAY_KEY   = 'silverIntradayData';
const TODAY_KEY      = 'silverIntradayDate';

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  chart = new SilverChart('priceChart');

  // 1. 加载设置
  const settings = await loadSettings();
  applySettings(settings);

  // 2. 绑定事件
  bindEvents();

  // 3. 加载 K 线缓存（如没有则请求 background 拉取）
  await ensureKlineData();

  // 4. 拉取实时价格（面板 + 分时图）
  await fetchAndRenderPrice();
});

// ===== 设置管理 =====
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['autoRefresh', 'refreshInterval', 'cachedPrice'], (result) => {
      resolve({
        autoRefresh:     result.autoRefresh !== undefined ? result.autoRefresh : false,
        refreshInterval: result.refreshInterval || 30,
        cachedPrice:     result.cachedPrice || null,
      });
    });
  });
}

function applySettings(settings) {
  document.getElementById('autoRefreshToggle').checked = settings.autoRefresh;
  document.getElementById('refreshInterval').value     = settings.refreshInterval;

  // 先用上次缓存快速展示面板
  if (settings.cachedPrice) {
    lastPrice = settings.cachedPrice;
    renderPricePanel(settings.cachedPrice);
  }

  if (settings.autoRefresh) {
    startPriceAutoRefresh(settings.refreshInterval);
    // 应用设置时通知 background 启动自动刷新
    chrome.runtime.sendMessage({ type: 'SET_PRICE_ALARM', enable: true, intervalSeconds: settings.refreshInterval });
  }
}

function saveSettings() {
  const autoRefresh     = document.getElementById('autoRefreshToggle').checked;
  const refreshInterval = parseInt(document.getElementById('refreshInterval').value);
  chrome.storage.local.set({ autoRefresh, refreshInterval });
}

// ===== 事件绑定 =====
function bindEvents() {
  // 手动刷新按钮：只刷实时价格
  document.getElementById('refreshBtn').addEventListener('click', () => {
    fetchAndRenderPrice();
  });

  // 返回按钮
  document.getElementById('backBtn').addEventListener('click', () => window.close());

  // 图表标签切换
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderChart(currentTab);
    });
  });

  // 自动刷新开关
  document.getElementById('autoRefreshToggle').addEventListener('change', (e) => {
    saveSettings();
    const interval = parseInt(document.getElementById('refreshInterval').value);
    if (e.target.checked) {
      startPriceAutoRefresh(interval);
      chrome.runtime.sendMessage({ type: 'SET_PRICE_ALARM', enable: true, intervalSeconds: interval });
    } else {
      stopPriceAutoRefresh();
      chrome.runtime.sendMessage({ type: 'SET_PRICE_ALARM', enable: false });
    }
  });

  // 刷新频率变化
  document.getElementById('refreshInterval').addEventListener('change', () => {
    saveSettings();
    const toggle   = document.getElementById('autoRefreshToggle');
    const interval = parseInt(document.getElementById('refreshInterval').value);
    if (toggle.checked) {
      stopPriceAutoRefresh();
      startPriceAutoRefresh(interval);
      chrome.runtime.sendMessage({ type: 'SET_PRICE_ALARM', enable: true, intervalSeconds: interval });
    }
  });
}

// ===== 实时价格自动刷新（popup 内定时器）=====
function startPriceAutoRefresh(intervalSeconds) {
  stopPriceAutoRefresh();
  priceTimer = setInterval(() => fetchAndRenderPrice(true), intervalSeconds * 1000);
  updateStatus('online', `自动刷新中（每${intervalSeconds}秒）`);
}

function stopPriceAutoRefresh() {
  if (priceTimer) { clearInterval(priceTimer); priceTimer = null; }
}

// ===== K 线缓存保障 =====
/**
 * 确保内存中有 rawDailyData。
 * 若 storage 里有就直接读入；若没有就请求 background 拉取一次。
 */
async function ensureKlineData() {
  const { rawDailyData, klineUpdatedAt } = await getStorage(['rawDailyData', 'klineUpdatedAt']);
  if (rawDailyData && rawDailyData.length > 0) {
    dailyRows = rawDailyData;
    return;
  }
  // 无缓存：请求 background 拉取
  updateStatus('loading', 'K 线数据加载中...');
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_KLINE' }, () => resolve());
  });
  // 再读一次
  const result = await getStorage(['rawDailyData']);
  dailyRows = result.rawDailyData || [];
}

// ===== 实时价格拉取 + 面板渲染 + 分时图更新 =====
/**
 * 每次手动刷新 / 自动刷新均调用此函数。
 * 只调 Swissquote，不再调 Stooq。
 */
async function fetchAndRenderPrice(silent = false) {
  if (isLoading) return;
  isLoading = true;

  if (!silent) {
    setRefreshBtnSpinning(true);
    updateStatus('loading', '正在获取行情...');
  }

  try {
    // 1. 拉取实时价格
    const spot = await fetchSpotPrice();

    // 2. 用缓存日K 推算昨收、今日最高最低
    const { prevClose, high, low } = calcFromDailyRows(spot.mid);
    const changePct = prevClose > 0 ? (spot.mid - prevClose) / prevClose * 100 : 0;

    const now = new Date();
    const timeStr = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(n => String(n).padStart(2,'0')).join(':');

    lastPrice = {
      buyPrice:  spot.ask.toFixed(4),
      sellPrice: spot.bid.toFixed(4),
      mid:       spot.mid.toFixed(4),
      high:      high.toFixed(4),
      low:       low.toFixed(4),
      changePct: changePct.toFixed(2),
      queryTime: timeStr,
      prevClose,
    };

    // 3. 面板数据
    renderPricePanel(lastPrice);

    // 4. 分时点入库
    appendIntradayPoint(spot.mid);

    // 5. 如当前在分时图就更新
    if (currentTab === 'realtime') renderRealtimeChart();

    // 6. 缓存实时价格
    chrome.storage.local.set({ cachedPrice: lastPrice });
    updateStatus('online', '数据已更新');
    updateLastTime();

  } catch (err) {
    console.error('拉取实时价格失败:', err);
    updateStatus('error', `获取失败: ${err.message}`);
  } finally {
    isLoading = false;
    setRefreshBtnSpinning(false);
  }
}

/**
 * 调用 Swissquote 获取当前买卖价。
 * 返回 { bid, ask, mid, ts }
 */
async function fetchSpotPrice() {
  const resp = await fetch(SWISSQUOTE_URL, {
    headers: { 'Accept': 'application/json', 'Origin': 'https://www.swissquote.com' }
  });
  if (!resp.ok) throw new Error(`Swissquote ${resp.status}`);
  const json = await resp.json();
  const entry = json[0];
  if (!entry) throw new Error('Swissquote 无数据');
  const quote = entry.spreadProfilePrices.find(p => p.spreadProfile === 'standard') || entry.spreadProfilePrices[0];
  const bid = quote.bid, ask = quote.ask;
  return { bid, ask, mid: (bid + ask) / 2, ts: entry.ts };
}

/**
 * 从缓存的 dailyRows 中推算：
 *   prevClose → 昨日收盘价
 *   high / low  → 今日最高最低（日K最后一条）与当前价取大小
 */
function calcFromDailyRows(currentMid) {
  if (dailyRows.length === 0) {
    return { prevClose: currentMid, high: currentMid, low: currentMid };
  }
  const last = dailyRows[dailyRows.length - 1];
  const prev = dailyRows.length >= 2 ? dailyRows[dailyRows.length - 2] : last;
  return {
    prevClose: prev.close,
    high: Math.max(last.high, currentMid),
    low:  Math.min(last.low,  currentMid),
  };
}

// ===== 分时数据管理（localStorage 日内累积）=====
function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function loadIntradayData() {
  try {
    if (localStorage.getItem(TODAY_KEY) !== getTodayStr()) {
      localStorage.setItem(TODAY_KEY, getTodayStr());
      localStorage.setItem(INTRADAY_KEY, '[]');
      return [];
    }
    return JSON.parse(localStorage.getItem(INTRADAY_KEY) || '[]');
  } catch { return []; }
}

function appendIntradayPoint(midPrice) {
  try {
    const today = getTodayStr();
    if (localStorage.getItem(TODAY_KEY) !== today) {
      localStorage.setItem(TODAY_KEY, today);
      localStorage.setItem(INTRADAY_KEY, '[]');
    }
    const points = JSON.parse(localStorage.getItem(INTRADAY_KEY) || '[]');
    const now = new Date();
    // 存入秒级时间，方便后续按不同粒度聚合
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    const last = points[points.length - 1];
    // 同一秒内只更新，不新增
    if (last && last.time === timeStr) {
      last.price = midPrice;
    } else {
      points.push({ time: timeStr, price: midPrice });
    }
    localStorage.setItem(INTRADAY_KEY, JSON.stringify(points.slice(-86400)));
  } catch (e) { console.warn('分时写入失败:', e); }
}

// ===== K 线数据聚合（全部来自内存 dailyRows，不再请求）=====

/** 日K：直接返回 dailyRows，日期格式化 */
function getDailyKline() {
  return dailyRows.map(r => ({ ...r, date: formatDate(r.date, 'daily') }));
}

/** 周K：按年周号聚合 dailyRows */
function getWeeklyKline() {
  const weekMap = new Map();
  for (const r of dailyRows) {
    const key = getISOWeek(r.date);
    if (!weekMap.has(key)) {
      weekMap.set(key, { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, rows: [r] });
    } else {
      const w = weekMap.get(key);
      w.high  = Math.max(w.high, r.high);
      w.low   = Math.min(w.low,  r.low);
      w.close = r.close;
      w.date  = r.date; // 使用这一周最后一个交易日作为标签
      w.rows.push(r);
    }
  }
  return Array.from(weekMap.values()).map(r => ({ 
    date: formatDate(r.date, 'weekly'),
    open: r.open, 
    high: r.high, 
    low: r.low, 
    close: r.close 
  }));
}

/** 月K：按年月聚合 dailyRows */
function getMonthlyKline() {
  const monthMap = new Map();
  for (const r of dailyRows) {
    // r.date 格式为 YYYYMMDD，取前6位作为月份键 YYYYMM
    const key = r.date.slice(0, 6);
    if (!monthMap.has(key)) {
      monthMap.set(key, { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close });
    } else {
      const m = monthMap.get(key);
      m.high  = Math.max(m.high, r.high);
      m.low   = Math.min(m.low,  r.low);
      m.close = r.close;
      m.date  = r.date; // 使用这个月最后一个交易日作为标签
    }
  }
  return Array.from(monthMap.values()).map(r => ({ ...r, date: formatDate(r.date, 'monthly') }));
}

/**
 * 分钟/小时 K 线：按固定时间窗口聚合当日秒级 intraday 数据
 * @param {number} minutes - K 线宽度（分钟），如 1 / 5 / 60 / 240
 */
function getIntradayKline(minutes) {
  const raw = loadIntradayData(); // [{time:'HH:MM:SS', price}, ...]
  if (raw.length === 0) return [];

  const buckets = new Map();
  for (const p of raw) {
    // 解析 HH:MM:SS 或 HH:MM
    const parts = p.time.split(':');
    const h = parseInt(parts[0]), m = parseInt(parts[1]);
    const totalMin = h * 60 + m;
    // 对齐到 minutes 的整倍
    const bucket = Math.floor(totalMin / minutes) * minutes;
    const bh = Math.floor(bucket / 60);
    const bm = bucket % 60;
    const key = `${String(bh).padStart(2,'0')}:${String(bm).padStart(2,'0')}`;

    if (!buckets.has(key)) {
      buckets.set(key, { date: key, open: p.price, high: p.price, low: p.price, close: p.price });
    } else {
      const b = buckets.get(key);
      b.high  = Math.max(b.high,  p.price);
      b.low   = Math.min(b.low,   p.price);
      b.close = p.price;
    }
  }
  return Array.from(buckets.values());
}

/** 返回 "YYYY-Www" 形式的ISO周键 */
function getISOWeek(dateStr) {
  // dateStr 格式为 YYYYMMDD，需要转换为 Date 对象
  const year = parseInt(dateStr.slice(0, 4));
  const month = parseInt(dateStr.slice(4, 6)) - 1; // 月份从0开始
  const day = parseInt(dateStr.slice(6, 8));
  const d = new Date(year, month, day);
  
  // 计算ISO周数
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
  const weekNum = Math.floor((d - startOfWeek1) / 604800000) + 1;
  return `${d.getFullYear()}-W${String(weekNum).padStart(2,'0')}`;
}

/** 日期标签格式化 */
function formatDate(dateStr, type) {
  // dateStr 格式为 "YYYYMMDD"
  if (!dateStr || dateStr.length !== 8) return dateStr;
  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(4, 6);
  const day = dateStr.slice(6, 8);
  
  if (type === 'daily')   return `${month}/${day}`;
  if (type === 'weekly')  return `${year.slice(2)}/${month}`;
  if (type === 'monthly') return `${year.slice(2)}/${month}`;
  return dateStr;
}

// ===== 面板数据渲染 =====
function renderPricePanel(data) {
  const flash = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== String(val)) {
      el.textContent = val;
      el.classList.remove('price-flash');
      void el.offsetWidth;
      el.classList.add('price-flash');
    }
    if (cls) el.className = `price-value ${cls}`;
  };
  flash('buyPrice',  data.buyPrice,  'teal');
  flash('sellPrice', data.sellPrice, 'teal');
  flash('highPrice', data.high,      '');
  flash('lowPrice',  data.low,       '');
  flash('midPrice',  data.mid,       '');
  flash('queryTime', data.queryTime, 'time-value');

  const pct    = parseFloat(data.changePct);
  const pctStr = (pct >= 0 ? '+' : '') + data.changePct + '%';
  const pctEl  = document.getElementById('changePercent');
  pctEl.textContent = pctStr;
  pctEl.className   = `price-value ${pct >= 0 ? 'red' : 'down'}`;
}

// ===== 图表渲染 =====
function renderRealtimeChart() {
  const intraday  = loadIntradayData();
  const refPrice  = lastPrice?.prevClose || (intraday.length > 0 ? intraday[0].price : 0);
  showChartLoading(false);
  if (intraday.length > 0) {
    chart.drawRealtime(intraday, refPrice);
    showChartEmpty(false);
  } else if (lastPrice) {
    const now = new Date();
    const t   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    chart.drawRealtime([{ time: t, price: parseFloat(lastPrice.mid) }], parseFloat(lastPrice.mid));
    showChartEmpty(false);
  } else {
    chart.clear();
    showChartEmpty(true);
  }
}

async function renderChart(tabType) {
  if (!chart) return;
  showChartLoading(true);
  showChartEmpty(false);

  try {
    // 分时图 / 分钟级 K 线：来自当日 intraday 数据
    if (tabType === 'realtime') {
      renderRealtimeChart();
      return;
    }
    if (tabType === '1min' || tabType === '5min' || tabType === '1hour' || tabType === '4hour') {
      const minutesMap = { '1min': 1, '5min': 5, '1hour': 60, '4hour': 240 };
      const klineData = getIntradayKline(minutesMap[tabType]);
      if (klineData.length > 0) {
        chart.drawKline(klineData);
        showChartEmpty(false);
      } else {
        showChartEmpty(true);
      }
      return;
    }

    // 日K / 周K / 月K：来自 rawDailyData
    if (dailyRows.length === 0) {
      const { rawDailyData } = await getStorage(['rawDailyData']);
      dailyRows = rawDailyData || [];
    }

    let klineData;
    if      (tabType === 'daily')   klineData = getDailyKline();
    else if (tabType === 'weekly')  klineData = getWeeklyKline();
    else if (tabType === 'monthly') klineData = getMonthlyKline();

    if (klineData && klineData.length > 0) {
      chart.drawKline(klineData);
      showChartEmpty(false);
    } else {
      showChartEmpty(true);
    }
  } catch (err) {
    console.error('图表渲染失败:', err);
    showChartEmpty(true);
  } finally {
    showChartLoading(false);
  }
}

// ===== UI 辅助 =====
function setRefreshBtnSpinning(spinning) {
  const btn = document.getElementById('refreshBtn');
  if (spinning) btn.classList.add('spinning');
  else btn.classList.remove('spinning');
}

function showChartLoading(show) {
  document.getElementById('chartLoading').style.display = show ? 'flex' : 'none';
}

function showChartEmpty(show) {
  document.getElementById('chartEmpty').style.display = show ? 'flex' : 'none';
}

function updateStatus(type, text) {
  document.getElementById('statusDot').className  = `status-dot ${type}`;
  document.getElementById('statusText').textContent = text;
}

function updateLastTime() {
  const now = new Date();
  const t   = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');
  document.getElementById('lastUpdate').textContent = `更新于 ${t}`;
}

// ===== 工具函数 =====
function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
