/*
 * color.js
 * - Color: small helpers for converting between color formats.
 * - ColorPicker: the full-spectrum color wheel shown in the Color panel.
 *   Outer ring = hue (which color). Inner square = how vivid (left/right)
 *   and how bright (up/down).
 */
(function () {
  'use strict';

  const Color = {
    // h: 0-360, s: 0-1, v: 0-1  ->  [r, g, b] 0-255
    hsvToRgb(h, s, v) {
      const f = (n) => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
      };
      return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
    },
    rgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      let h = 0;
      if (d) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      return [h, max ? d / max : 0, max];
    },
    rgbToHex(r, g, b) {
      return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    },
    // Accepts "#RGB", "#RRGGBB", with or without "#". Returns null if invalid.
    hexToRgb(hex) {
      if (typeof hex !== 'string') return null;
      let m = hex.trim().replace(/^#/, '');
      if (/^[0-9a-f]{3}$/i.test(m)) m = m.split('').map((c) => c + c).join('');
      if (!/^[0-9a-f]{6}$/i.test(m)) return null;
      const n = parseInt(m, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    },
    normalizeHex(hex) {
      const rgb = Color.hexToRgb(hex);
      return rgb ? Color.rgbToHex(rgb[0], rgb[1], rgb[2]) : null;
    },
  };

  const EYEDROPPER_ICON =
    '<svg viewBox="0 0 24 24"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3-3a2.1 2.1 0 0 1 3 3l-3 3 .5.5a1.4 1.4 0 0 1-2 2L11 6.5a1.4 1.4 0 0 1 2-2z"/></svg>';

  class ColorPicker {
    /**
     * @param {HTMLElement} root  element to build the picker inside
     * @param {{onChange?:Function, onEyedropper?:Function}} opts
     */
    constructor(root, opts) {
      this.opts = opts || {};
      this.h = 0; this.s = 0; this.v = 0;
      this.hex = '#000000';
      this.prevHex = '#000000';

      root.innerHTML = `
        <canvas class="cp-wheel"></canvas>
        <div class="cp-row">
          <div class="cp-compare">
            <button class="cp-prev" title="Previous color (tap to go back to it)"></button>
            <div class="cp-cur" title="Current color"></div>
          </div>
          <label class="cp-hex">Hex <input type="text" maxlength="7" spellcheck="false" autocomplete="off"></label>
          <button class="cp-eye" title="Pick a color from your drawing">${EYEDROPPER_ICON}</button>
        </div>
        <div class="cp-label">Recent colors</div>
        <div class="cp-recent"></div>`;

      this.canvas = root.querySelector('.cp-wheel');
      this.prevEl = root.querySelector('.cp-prev');
      this.curEl = root.querySelector('.cp-cur');
      this.hexInput = root.querySelector('.cp-hex input');
      this.recentEl = root.querySelector('.cp-recent');

      // Wheel geometry (in CSS pixels)
      this.S = 240;
      this.c = this.S / 2;
      this.R = this.S / 2 - 2;          // outer edge of hue ring
      this.rIn = this.R - 24;           // inner edge of hue ring
      this.half = (this.rIn - 8) / Math.SQRT2; // half the side of the inner square
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.canvas.width = this.S * this.dpr;
      this.canvas.height = this.S * this.dpr;
      this.ctx = this.canvas.getContext('2d');
      this.ring = this._makeRing();

      this._bindEvents(root);
      this._draw();
    }

    // The hue ring never changes, so draw it once and reuse it.
    _makeRing() {
      const ring = document.createElement('canvas');
      ring.width = ring.height = this.S * this.dpr;
      const g = ring.getContext('2d');
      g.scale(this.dpr, this.dpr);
      const mid = (this.R + this.rIn) / 2;
      g.lineWidth = this.R - this.rIn;
      if (g.createConicGradient) {
        const grad = g.createConicGradient(0, this.c, this.c);
        for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
        g.strokeStyle = grad;
        g.beginPath();
        g.arc(this.c, this.c, mid, 0, Math.PI * 2);
        g.stroke();
      } else {
        // Older browsers: draw the ring as 360 tiny slices.
        for (let a = 0; a < 360; a++) {
          g.strokeStyle = `hsl(${a},100%,50%)`;
          g.beginPath();
          g.arc(this.c, this.c, mid, (a - 0.6) * Math.PI / 180, (a + 0.6) * Math.PI / 180);
          g.stroke();
        }
      }
      return ring;
    }

    _draw() {
      const g = this.ctx;
      const { S, c, half } = this;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.canvas.width, this.canvas.height);
      g.drawImage(this.ring, 0, 0);
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // Saturation / brightness square for the current hue
      const x0 = c - half, y0 = c - half, side = half * 2;
      const [hr, hg, hb] = Color.hsvToRgb(this.h, 1, 1);
      g.fillStyle = `rgb(${hr},${hg},${hb})`;
      g.fillRect(x0, y0, side, side);
      const white = g.createLinearGradient(x0, 0, x0 + side, 0);
      white.addColorStop(0, '#fff');
      white.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = white;
      g.fillRect(x0, y0, side, side);
      const black = g.createLinearGradient(0, y0, 0, y0 + side);
      black.addColorStop(0, 'rgba(0,0,0,0)');
      black.addColorStop(1, '#000');
      g.fillStyle = black;
      g.fillRect(x0, y0, side, side);

      // Markers
      const ang = this.h * Math.PI / 180;
      const mid = (this.R + this.rIn) / 2;
      this._marker(c + Math.cos(ang) * mid, c + Math.sin(ang) * mid, 9);
      this._marker(x0 + this.s * side, y0 + (1 - this.v) * side, 7);
      void S;
    }

    _marker(x, y, r) {
      const g = this.ctx;
      g.lineWidth = 3;
      g.strokeStyle = '#fff';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(0,0,0,.6)';
      g.beginPath(); g.arc(x, y, r + 1.5, 0, Math.PI * 2); g.stroke();
    }

    _bindEvents(root) {
      let mode = null;
      const local = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (this.S / r.width), y: (e.clientY - r.top) * (this.S / r.height) };
      };
      const update = (e) => {
        const p = local(e);
        if (mode === 'hue') {
          let deg = Math.atan2(p.y - this.c, p.x - this.c) * 180 / Math.PI;
          if (deg < 0) deg += 360;
          this.h = deg;
        } else if (mode === 'sv') {
          const side = this.half * 2, x0 = this.c - this.half, y0 = this.c - this.half;
          this.s = Math.min(1, Math.max(0, (p.x - x0) / side));
          this.v = Math.min(1, Math.max(0, 1 - (p.y - y0) / side));
        }
        this._emit();
      };
      this.canvas.addEventListener('pointerdown', (e) => {
        const p = local(e);
        const d = Math.hypot(p.x - this.c, p.y - this.c);
        if (d >= this.rIn - 6 && d <= this.R + 8) mode = 'hue';
        else if (Math.abs(p.x - this.c) <= this.half + 8 && Math.abs(p.y - this.c) <= this.half + 8) mode = 'sv';
        else return;
        e.preventDefault();
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        update(e);
      });
      this.canvas.addEventListener('pointermove', (e) => { if (mode) update(e); });
      const stop = () => { mode = null; };
      this.canvas.addEventListener('pointerup', stop);
      this.canvas.addEventListener('pointercancel', stop);

      this.prevEl.addEventListener('click', () => this.setHex(this.prevHex));
      this.hexInput.addEventListener('input', () => {
        const v = this.hexInput.value.trim();
        if (/^#?[0-9a-f]{6}$/i.test(v)) this.setHex(v, false, true);
      });
      this.hexInput.addEventListener('change', () => {
        const hex = Color.normalizeHex(this.hexInput.value);
        if (hex) this.setHex(hex); else this.hexInput.value = this.hex;
      });
      this.hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.hexInput.blur(); });
      root.querySelector('.cp-eye').addEventListener('click', () => {
        if (this.opts.onEyedropper) this.opts.onEyedropper();
      });
    }

    _emit(keepInput) {
      const [r, g, b] = Color.hsvToRgb(this.h, this.s, this.v);
      this.hex = Color.rgbToHex(r, g, b);
      this._refresh(keepInput);
      if (this.opts.onChange) this.opts.onChange(this.hex);
    }

    _refresh(keepInput) {
      this.curEl.style.background = this.hex;
      this.prevEl.style.background = this.prevHex;
      if (!keepInput) this.hexInput.value = this.hex;
      this._draw();
    }

    /** Set the color from a hex string. silent = don't call onChange. */
    setHex(hex, silent, keepInput) {
      const rgb = Color.hexToRgb(hex);
      if (!rgb) return;
      const [h, s, v] = Color.rgbToHsv(rgb[0], rgb[1], rgb[2]);
      // Keep the current hue for greys/black so the ring marker doesn't jump.
      if (s > 0 && v > 0) this.h = h;
      this.s = s; this.v = v;
      this.hex = Color.rgbToHex(rgb[0], rgb[1], rgb[2]);
      this._refresh(keepInput);
      if (!silent && this.opts.onChange) this.opts.onChange(this.hex);
    }

    /** Remember the color at the moment the panel opens, for the "previous" swatch. */
    markPrevious() {
      this.prevHex = this.hex;
      this._refresh();
    }

    setRecent(list) {
      this.recentEl.innerHTML = '';
      if (!list.length) {
        this.recentEl.innerHTML = '<div class="cp-empty">Colors you draw with will show up here.</div>';
        return;
      }
      list.forEach((hex) => {
        const b = document.createElement('button');
        b.style.background = hex;
        b.title = hex;
        b.addEventListener('click', () => this.setHex(hex));
        this.recentEl.appendChild(b);
      });
    }
  }

  window.Color = Color;
  window.ColorPicker = ColorPicker;
})();
