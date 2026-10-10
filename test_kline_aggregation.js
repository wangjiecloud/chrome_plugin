#!/usr/bin/env node

/**
 * 测试周K和月K聚合逻辑
 */

// 模拟从 Yahoo Finance 获取的数据格式
const sampleDailyData = [
  { date: '20260301', open: 70.5, high: 72.0, low: 69.5, close: 71.0 },
  { date: '20260302', open: 71.0, high: 73.0, low: 70.5, close: 72.5 },
  { date: '20260303', open: 72.5, high: 74.0, low: 72.0, close: 73.0 },
  { date: '20260304', open: 73.0, high: 74.5, low: 72.5, close: 73.5 },
  { date: '20260305', open: 73.5, high: 75.0, low: 73.0, close: 74.0 },
  { date: '20260308', open: 74.0, high: 75.5, low: 73.5, close: 74.5 }, // 下一周
  { date: '20260309', open: 74.5, high: 76.0, low: 74.0, close: 75.0 },
  { date: '20260310', open: 75.0, high: 76.5, low: 74.5, close: 75.5 },
  { date: '20260401', open: 76.0, high: 77.0, low: 75.5, close: 76.5 }, // 4月
  { date: '20260402', open: 76.5, high: 78.0, low: 76.0, close: 77.0 },
];

// 复制修复后的逻辑
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
  return Array.from(weekMap.values());
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
  return Array.from(monthMap.values());
}

// 测试
console.log('='.repeat(60));
console.log('测试周K和月K聚合逻辑');
console.log('='.repeat(60));

console.log(`\n📊 原始日K数据 (${sampleDailyData.length} 条):`);
sampleDailyData.forEach(d => {
  console.log(`  ${d.date}: 开 $${d.open}, 高 $${d.high}, 低 $${d.low}, 收 $${d.close}`);
});

const weeklyData = getWeeklyKline(sampleDailyData);
console.log(`\n📈 周K数据 (${weeklyData.length} 条):`);
weeklyData.forEach(w => {
  const weekKey = getISOWeek(w.date);
  console.log(`  ${weekKey} (${w.date}): 开 $${w.open}, 高 $${w.high}, 低 $${w.low}, 收 $${w.close}`);
});

const monthlyData = getMonthlyKline(sampleDailyData);
console.log(`\n📅 月K数据 (${monthlyData.length} 条):`);
monthlyData.forEach(m => {
  const monthKey = m.date.slice(0, 6);
  console.log(`  ${monthKey} (${m.date}): 开 $${m.open}, 高 $${m.high}, 低 $${m.low}, 收 $${m.close}`);
});

console.log('\n✅ 聚合逻辑测试完成！');
console.log('='.repeat(60));
