/**
 * 轻量级图表绘制引擎
 * 支持：分时折线图、K线图（日/周/月 + 分钟级）
 * 颜色规则：红涨绿跌（A股惯例）
 * K线交互：滚轮/双指缩放，拖拽/单指平移
 */

class SilverChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._initCanvas();

    // 颜色表（红涨绿跌）
    this.colors = {
      bg:       '#22252e',
      grid:     'rgba(255,255,255,0.06)',
      axis:     '#4a4e5c',
      text:     '#8b90a4',
      teal:     '#4ecdc4',
      up:       '#f04b5a',   // 上涨 → 红
      down:     '#26d17a',   // 下跌 → 绿
      upFill:   'rgba(240,75,90,0.28)',
      downFill: 'rgba(38,209,122,0.22)',
      zero:     'rgba(78,205,196,0.5)',
    };

    // K线缩放/平移状态
    // _zoom:    每屏显示根数 = n/_zoom，值越大K线越宽（放大）
    // _offsetX: 从第几根开始显示（浮点，支持亚像素）
    this._zoom           = 1;   // 1 = 全部数据刚好铺满屏幕
    this._offsetX        = 0;   // 初始右对齐，在 drawKline 里设置
    this._klineData      = null;
    this._dragging       = false;
    this._dragStartX     = 0;
    this._dragStartOffset = 0;
    this._lastTouchDist  = 0;
    this._lastTouchX     = 0;

    this._bindKlineEvents();
  }

  _initCanvas() {
    const w = this.canvas.parentElement.clientWidth || 420;
    const h = 260;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.scale(this.dpr, this.dpr);
    this.width = w;
    this.height = h;
  }

  // ===== K线交互事件绑定 =====
  _bindKlineEvents() {
    const c = this.canvas;

    // wheel 事件处理三种场景：
    //   1. 触控板捆合/展开（ctrlKey=true）→ 缩放
    //   2. 触控板双指左右滑动（ctrlKey=false, 有 deltaX）→ 平移
    //   3. 鼠标滚轮（ctrlKey=false, deltaX≈0）→ 缩放
    c.addEventListener('wheel', (e) => {
      if (!this._klineData) return;
      e.preventDefault();

      if (e.ctrlKey) {
        // 触控板框合缩放：deltaY > 0 是缩小，< 0 是放大
        const ratio = e.deltaY > 0 ? 0.85 : 1 / 0.85;
        this._applyZoom(ratio, e.offsetX);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || (Math.abs(e.deltaX) > 2 && Math.abs(e.deltaY) < 30)) {
        // 触控板左右滑动：用 deltaX 平移
        this._offsetX += e.deltaX / this._getGap();
        this._clampOffset();
        this._redrawKline();
      } else {
        // 鼠标滚轮垂直滚动 → 缩放
        const ratio = e.deltaY > 0 ? 0.85 : 1 / 0.85;
        this._applyZoom(ratio, e.offsetX);
      }
    }, { passive: false });

    c.addEventListener('mousedown', (e) => {
      if (!this._klineData) return;
      this._dragging = true;
      this._dragStartX = e.clientX;
      this._dragStartOffset = this._offsetX;
      c.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._dragging || !this._klineData) return;
      const dx = e.clientX - this._dragStartX;
      this._offsetX = this._dragStartOffset - dx / this._getGap();
      this._clampOffset();
      this._redrawKline();
    });
    window.addEventListener('mouseup', () => {
      this._dragging = false;
      this.canvas.style.cursor = 'default';
    });

    // 触摸屏：单指平移 / 双指捆合缩放
    c.addEventListener('touchstart', (e) => {
      if (!this._klineData) return;
      if (e.touches.length === 1) {
        this._dragStartX = e.touches[0].clientX;
        this._dragStartOffset = this._offsetX;
      } else if (e.touches.length === 2) {
        this._lastTouchDist = this._touchDist(e);
        this._lastTouchX = (e.touches[0].clientX + e.touches[1].clientX) / 2
          - this.canvas.getBoundingClientRect().left;
      }
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (!this._klineData) return;
      e.preventDefault();
      if (e.touches.length === 1) {
        const dx = e.touches[0].clientX - this._dragStartX;
        this._offsetX = this._dragStartOffset - dx / this._getGap();
        this._clampOffset();
        this._redrawKline();
      } else if (e.touches.length === 2) {
        const dist = this._touchDist(e);
        this._applyZoom(dist / (this._lastTouchDist || dist), this._lastTouchX);
        this._lastTouchDist = dist;
      }
    }, { passive: false });
  }

  _touchDist(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _applyZoom(ratio, pivotX) {
    const n = this._klineData.length;
    const padL = 52, plotW = this.width - 52 - 54;
    const oldGap = this._getGap();
    // pivotX 下对应的数据索引（缩放前）
    const pivotBar = (pivotX - padL) / oldGap + this._offsetX;
    // zoom 范围：最小=1（全览），最大=n/3（每屏至少3根）
    const minZoom = 1;
    const maxZoom = Math.max(n / 3, 4);
    this._zoom = Math.min(Math.max(this._zoom * ratio, minZoom), maxZoom);
    // 缩放后保持 pivotBar 位置不变
    const newGap = this._getGap();
    this._offsetX = pivotBar - (pivotX - padL) / newGap;
    this._clampOffset();
    this._redrawKline();
  }

  _getGap() {
    const n = this._klineData ? this._klineData.length : 1;
    return (this.width - 52 - 54) / (n / this._zoom);
  }

  // 可见根数（浮点）
  _visibleCount() {
    const n = this._klineData ? this._klineData.length : 1;
    return n / this._zoom;
  }

  _clampOffset() {
    if (!this._klineData) return;
    const n = this._klineData.length;
    const vc = this._visibleCount();
    // offsetX 范围：[0, n - vc]，确保不会超出数据边界
    this._offsetX = Math.max(0, Math.min(this._offsetX, Math.max(0, n - vc)));
  }

  _redrawKline() {
    if (this._klineData) this.drawKline(this._klineData, true);
  }

  // 绘制分时折线图（带涨跌幅双Y轴）
  drawRealtime(data, refPrice) {
    const ctx = this.ctx;
    const { width: W, height: H } = this;
    ctx.clearRect(0, 0, W, H);

    const padL = 52, padR = 54, padT = 12, padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    if (!data || data.length === 0) return;

    const prices = data.map(d => d.price);
    const maxP = Math.max(...prices);
    const minP = Math.min(...prices);

    // 确保有足够范围
    const range = Math.max(maxP - minP, refPrice * 0.005);
    const pMin = Math.min(minP, refPrice) - range * 0.1;
    const pMax = Math.max(maxP, refPrice) + range * 0.1;

    const scaleX = (i) => padL + (i / (data.length - 1 || 1)) * plotW;
    const scaleY = (p) => padT + plotH - ((p - pMin) / (pMax - pMin)) * plotH;

    // 背景
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, W, H);

    // 网格线（水平5条）
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }

    // 左Y轴价格标签
    ctx.fillStyle = this.colors.text;
    ctx.font = `${9 * this.dpr / this.dpr}px -apple-system, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const p = pMin + (pMax - pMin) * (1 - i / 4);
      const y = padT + (plotH / 4) * i;
      ctx.fillText(p.toFixed(2), padL - 4, y);
    }

    // 右Y轴涨跌幅标签
    ctx.textAlign = 'left';
    const pctRange = ((pMax - pMin) / refPrice) * 100;
    for (let i = 0; i <= 4; i++) {
      const pct = pctRange * (1 - i / 2) / 2;
      const y = padT + (plotH / 4) * i;
      const pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      ctx.fillStyle = pct > 0 ? this.colors.up : pct < 0 ? this.colors.down : this.colors.teal;
      ctx.fillText(pctStr, padL + plotW + 4, y);
    }

    // 零轴（基准价）
    if (refPrice >= pMin && refPrice <= pMax) {
      const yRef = scaleY(refPrice);
      ctx.strokeStyle = this.colors.zero;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, yRef);
      ctx.lineTo(padL + plotW, yRef);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 填充区域
    ctx.beginPath();
    ctx.moveTo(scaleX(0), scaleY(prices[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(scaleX(i), scaleY(prices[i]));
    }
    ctx.lineTo(scaleX(data.length - 1), padT + plotH);
    ctx.lineTo(scaleX(0), padT + plotH);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    const lastPrice = prices[prices.length - 1];
    const isUp = lastPrice >= refPrice;
    if (isUp) {
      grad.addColorStop(0, 'rgba(240,75,90,0.30)');
      grad.addColorStop(1, 'rgba(240,75,90,0.02)');
    } else {
      grad.addColorStop(0, 'rgba(38,209,122,0.22)');
      grad.addColorStop(1, 'rgba(38,209,122,0.02)');
    }
    ctx.fillStyle = grad;
    ctx.fill();

    // 折线
    ctx.beginPath();
    ctx.moveTo(scaleX(0), scaleY(prices[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(scaleX(i), scaleY(prices[i]));
    }
    ctx.strokeStyle = isUp ? this.colors.up : this.colors.down;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // X轴时间标签
    ctx.fillStyle = this.colors.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const timeLabels = ['00:00', '06:00', '12:00', '18:00', '24:00'];
    for (let i = 0; i < 5; i++) {
      const x = padL + (plotW / 4) * i;
      ctx.fillText(timeLabels[i], x, padT + plotH + 6);
    }
  }

    // 绘制K线图（支持缩放平移）
  drawKline(data, keepState = false) {
    if (!data || data.length === 0) return;
    if (!keepState) {
      this._zoom    = 1;
      // 默认右对齐：显示最新（最右侧）数据
      // zoom=1 时可见根数 = n，offsetX=0 即全览；
      // 放大后 visibleCount < n，右对齐 offset = n - visibleCount
      const vc = data.length / this._zoom; // zoom=1 时等于 n
      this._offsetX = Math.max(0, data.length - vc); // = 0，全览
    }
    this._klineData = data;

    const ctx = this.ctx;
    const { width: W, height: H } = this;
    ctx.clearRect(0, 0, W, H);

    const padL = 52, padR = 54, padT = 12, padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const n = data.length;

    // 可见数据窗口
    const gap          = this._getGap();
    const visibleCount = Math.ceil(plotW / gap) + 2;
    const startIdx     = Math.max(0, Math.floor(this._offsetX));
    const endIdx       = Math.min(n - 1, startIdx + visibleCount);
    const visible      = data.slice(startIdx, endIdx + 1);
    if (visible.length === 0) return;

    // 可见区间价格范围
    const allH = visible.map(d => d.high);
    const allL = visible.map(d => d.low);
    const maxP = Math.max(...allH);
    const minP = Math.min(...allL);
    const range = maxP - minP || maxP * 0.02;
    const pMax = maxP + range * 0.08;
    const pMin = minP - range * 0.08;

    const scaleY = (p) => padT + plotH - ((p - pMin) / (pMax - pMin)) * plotH;

    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, W, H);

    // 水平网格
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    }

    // 左Y轴价格
    ctx.fillStyle = this.colors.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '9px -apple-system, monospace';
    for (let i = 0; i <= 4; i++) {
      const p = pMin + (pMax - pMin) * (1 - i / 4);
      ctx.fillText(p.toFixed(2), padL - 4, padT + (plotH / 4) * i);
    }

    // K线实体（红涨绿跌）
    const candleW = Math.max(1, Math.floor(gap * 0.65));
    for (let i = 0; i < visible.length; i++) {
      const d      = visible[i];
      const barIdx = (startIdx + i) - this._offsetX;
      const x      = padL + barIdx * gap + gap / 2;
      const isUp   = d.close >= d.open;
      const color  = isUp ? this.colors.up : this.colors.down;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, scaleY(d.high));
      ctx.lineTo(x, scaleY(d.low));
      ctx.stroke();

      const yOpen  = scaleY(d.open);
      const yClose = scaleY(d.close);
      const bodyY  = Math.min(yOpen, yClose);
      const bodyH  = Math.max(Math.abs(yClose - yOpen), 1);
      ctx.fillStyle = color;
      ctx.fillRect(x - candleW / 2, bodyY, candleW, bodyH);
    }

    // X轴日期标签（5个均匀，防重叠）
    ctx.fillStyle = this.colors.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '9px -apple-system, monospace';
    const labelStep = Math.max(1, Math.floor(visible.length / 4));
    const usedX = new Set();
    for (let li = 0; li <= 4; li++) {
      const idx    = Math.min(li * labelStep, visible.length - 1);
      const barIdx = (startIdx + idx) - this._offsetX;
      const x      = padL + barIdx * gap + gap / 2;
      const xi     = Math.round(x);
      if (usedX.has(xi)) continue;
      usedX.add(xi);
      ctx.fillText(visible[idx]?.date || '', x, padT + plotH + 6);
    }

    // 右Y轴涨跌幅（红涨绿跌）
    ctx.textAlign = 'left';
    const firstClose = visible[0]?.close || pMin;
    for (let i = 0; i <= 4; i++) {
      const p   = pMin + (pMax - pMin) * (1 - i / 4);
      const y   = padT + (plotH / 4) * i;
      const pct = ((p - firstClose) / firstClose) * 100;
      ctx.fillStyle = pct > 0 ? this.colors.up : pct < 0 ? this.colors.down : this.colors.teal;
      ctx.fillText((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', padL + plotW + 4, y);
    }
  }

  // 清空图表
  clear() {
    this._klineData = null;
    this._zoom      = 1;
    this._offsetX   = 0;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.fillStyle = '#22252e';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }
}
