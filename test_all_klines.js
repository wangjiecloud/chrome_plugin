#!/usr/bin/env node

/**
 * 完整测试：日K、周K、月K、分钟K、小时K
 */

// 模拟5年的日K数据（简化版）
const generateDailyData = () => {
  const data = [];
  let basePrice = 70;
  const startDate = new Date('2021-03-29');
  
  for (let i = 0; i < 1258; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    
    // 跳过周末
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
    const open = basePrice + (Math.random() - 0.5) * 2;
    const high = open + Math.random() * 3;
    const low = open - Math.random() * 3;
    const close = low + Math.random() * (high - low);
    
    data.push({ date: dateStr, open, high, low, close });
    basePrice = close; // 下一天基于当天收盘
  }
  
  return data.slice(0, 100); // 取100条测试
};

// 模拟分时数据（当日秒级）
const generateIntradayData = () => {
  const data = [];
  let price = 75;
  
  for (let h = 9; h < 16; h++) {
    for (let m = 0; m < 60; m += 5) {
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      price += (Math.random() - 0.5) * 0.5;
      data.push({ time, price });
    }
  }
  
  return data;
};

// === 聚合函数 ===

function getISOWeek(dateStr) {
  const year = parseInt(dateStr.slice(0, 4));
  const month = parseInt(dateStr.slice(4, 6)) - 1;
  const day = parseInt(dateStr.slice(6, 8));
  const d = new Date(year, month, day);
  
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
  const weekNum = Math.floor((d - startOfWeek1) / 604800000) + 1;
  return `${d.getFullYear()}-W${String(weekNum).padStart(2,'0')}`;
}

function formatDate(dateStr, type) {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(4, 6);
  const day = dateStr.slice(6, 8);
  
  if (type === 'daily')   return `${month}/${day}`;
  if (type === 'weekly')  return `${year.slice(2)}/${month}`;
  if (type === 'monthly') return `${year.slice(2)}/${month}`;
  return dateStr;
}

function getWeeklyKline(dailyRows) {
  const weekMap = new Map();
  for (const r of dailyRows) {
    const key = getISOWeek(r.date);
    if (!weekMap.has(key)) {
      weekMap.set(key, { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close });
    } else {
      const w = weekMap.get(key);
      w.high  = Math.max(w.high, r.high);
      w.low   = Math.min(w.low,  r.low);
      w.close = r.close;
      w.date  = r.date;
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

function getMonthlyKline(dailyRows) {
  const monthMap = new Map();
  for (const r of dailyRows) {
    const key = r.date.slice(0, 6);
    if (!monthMap.has(key)) {
      monthMap.set(key, { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close });
    } else {
      const m = monthMap.get(key);
      m.high  = Math.max(m.high, r.high);
      m.low   = Math.min(m.low,  r.low);
      m.close = r.close;
      m.date  = r.date;
    }
  }
  return Array.from(monthMap.values()).map(r => ({ 
    date: formatDate(r.date, 'monthly'),
    open: r.open, 
    high: r.high, 
    low: r.low, 
    close: r.close 
  }));
}

function getIntradayKline(raw, minutes) {
  if (raw.length === 0) return [];

  const buckets = new Map();
  for (const p of raw) {
    const parts = p.time.split(':');
    const h = parseInt(parts[0]), m = parseInt(parts[1]);
    const totalMin = h * 60 + m;
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

// === 测试 ===

console.log('='.repeat(70));
console.log('完整K线聚合测试');
console.log('='.repeat(70));

const dailyData = generateDailyData();
const intradayData = generateIntradayData();

console.log(`\n📊 原始数据:`);
console.log(`  日K数据: ${dailyData.length} 条`);
console.log(`  分时数据: ${intradayData.length} 条`);

// 测试日K
console.log(`\n📈 日K数据 (前5条):`);
dailyData.slice(0, 5).forEach(d => {
  console.log(`  ${d.date}: O=$${d.open.toFixed(2)}, H=$${d.high.toFixed(2)}, L=$${d.low.toFixed(2)}, C=$${d.close.toFixed(2)}`);
});

// 测试周K
const weeklyData = getWeeklyKline(dailyData);
console.log(`\n📅 周K数据 (${weeklyData.length} 条，前5条):`);
weeklyData.slice(0, 5).forEach(w => {
  console.log(`  ${w.date}: O=$${w.open.toFixed(2)}, H=$${w.high.toFixed(2)}, L=$${w.low.toFixed(2)}, C=$${w.close.toFixed(2)}`);
});

// 测试月K
const monthlyData = getMonthlyKline(dailyData);
console.log(`\n📆 月K数据 (${monthlyData.length} 条，前5条):`);
monthlyData.slice(0, 5).forEach(m => {
  console.log(`  ${m.date}: O=$${m.open.toFixed(2)}, H=$${m.high.toFixed(2)}, L=$${m.low.toFixed(2)}, C=$${m.close.toFixed(2)}`);
});

// 测试1分钟K
const min1Data = getIntradayKline(intradayData, 1);
console.log(`\n⏱️  1分钟K (${min1Data.length} 条，前5条):`);
min1Data.slice(0, 5).forEach(k => {
  console.log(`  ${k.date}: O=$${k.open.toFixed(2)}, H=$${k.high.toFixed(2)}, L=$${k.low.toFixed(2)}, C=$${k.close.toFixed(2)}`);
});

// 测试5分钟K
const min5Data = getIntradayKline(intradayData, 5);
console.log(`\n⏱️  5分钟K (${min5Data.length} 条，前5条):`);
min5Data.slice(0, 5).forEach(k => {
  console.log(`  ${k.date}: O=$${k.open.toFixed(2)}, H=$${k.high.toFixed(2)}, L=$${k.low.toFixed(2)}, C=$${k.close.toFixed(2)}`);
});

// 测试1小时K
const hour1Data = getIntradayKline(intradayData, 60);
console.log(`\n⏰ 1小时K (${hour1Data.length} 条):`);
hour1Data.forEach(k => {
  console.log(`  ${k.date}: O=$${k.open.toFixed(2)}, H=$${k.high.toFixed(2)}, L=$${k.low.toFixed(2)}, C=$${k.close.toFixed(2)}`);
});

// 测试4小时K
const hour4Data = getIntradayKline(intradayData, 240);
console.log(`\n⏰ 4小时K (${hour4Data.length} 条):`);
hour4Data.forEach(k => {
  console.log(`  ${k.date}: O=$${k.open.toFixed(2)}, H=$${k.high.toFixed(2)}, L=$${k.low.toFixed(2)}, C=$${k.close.toFixed(2)}`);
});

// 验证数据结构
console.log(`\n🔍 数据结构验证:`);
const sampleWeekly = weeklyData[0];
console.log(`  周K示例:`, JSON.stringify(sampleWeekly, null, 2));
console.log(`  ✓ date: ${typeof sampleWeekly.date} (${sampleWeekly.date})`);
console.log(`  ✓ open: ${typeof sampleWeekly.open}`);
console.log(`  ✓ high: ${typeof sampleWeekly.high}`);
console.log(`  ✓ low: ${typeof sampleWeekly.low}`);
console.log(`  ✓ close: ${typeof sampleWeekly.close}`);

console.log(`\n✅ 所有K线类型测试完成！`);
console.log('='.repeat(70));
