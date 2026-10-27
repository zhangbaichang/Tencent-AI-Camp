// =====================================================================
//  audio.js — 像素沙盒 · 专业音频系统 (Web Audio API)
//  架构：Master -> [SFX | Music | Ambient] 总线 (类 FMOD/Wwise VCA)
//  程序化合成：无需任何二进制音频素材，契合像素风；后续可一键替换为采样
//  (把 _tone/_noise 换成 AudioBufferSourceNode 即可)。
// =====================================================================
(function () {
  'use strict';

  const Sound = {
    ctx: null,
    master: null,
    buses: {},
    noiseBuf: null,
    muted: false,
    _unlocked: false,
    _vol: { master: 0.9, sfx: 0.9, music: 0.28, ambient: 0.5 },
    _musicAccum: 0,
    _step: 0,
    _drone: null,

    // ---- 初始化 / 解锁 ----
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();

      // 总线层级
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this._vol.master;
      this.master.connect(this.ctx.destination);
      for (const name of ['sfx', 'music', 'ambient']) {
        const g = this.ctx.createGain();
        g.gain.value = this._vol[name];
        g.connect(this.master);
        this.buses[name] = g;
      }

      // 1 秒白噪声缓冲（复用于所有打击/沙沙声）
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      // 首次用户手势后恢复 AudioContext（浏览器自动播放策略）
      const unlock = () => {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
        this._unlocked = true;
        this._startAmbient();
      };
      window.addEventListener('pointerdown', unlock);
      window.addEventListener('keydown', unlock);
      window.addEventListener('touchstart', unlock);
    },

    resume() {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      this._unlocked = true;
      this._startAmbient();
    },

    _now() { return this.ctx ? this.ctx.currentTime : 0; },

    // ---- 基础声部：单音 ----
    _tone(o) {
      if (!this.ctx) return;
      const t0 = this._now() + (o.when || 0);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = o.type || 'square';
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t0 + (o.dur || 0.1));
      const vol = (o.vol == null ? 0.1 : o.vol);
      const atk = o.attack == null ? 0.005 : o.attack;
      const dur = o.dur || 0.1;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      if (o.pan && this.ctx.createStereoPanner) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, o.pan));
        osc.connect(g); g.connect(p); p.connect(this.buses[o.bus || 'sfx']);
      } else {
        osc.connect(g); g.connect(this.buses[o.bus || 'sfx']);
      }
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },

    // ---- 基础声部：噪声 ----
    _noise(o) {
      if (!this.ctx || !this.noiseBuf) return;
      const t0 = this._now() + (o.when || 0);
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const g = this.ctx.createGain();
      const vol = o.vol == null ? 0.1 : o.vol;
      const dur = o.dur || 0.1;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      let node = src;
      if (o.filter) {
        const f = this.ctx.createBiquadFilter();
        f.type = o.filter;
        f.frequency.value = o.filterFreq || 1000;
        if (o.filterQ) f.Q.value = o.filterQ;
        src.connect(f); node = f;
      }
      if (o.pan && this.ctx.createStereoPanner) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, o.pan));
        node.connect(g); g.connect(p); p.connect(this.buses[o.bus || 'sfx']);
      } else {
        node.connect(g); g.connect(this.buses[o.bus || 'sfx']);
      }
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    },

    _arp(notes, type, step, vol, pan) {
      notes.forEach((f, i) => {
        this._tone({ freq: f, type: type, dur: step * 1.4, vol: vol, when: i * step, pan: pan });
      });
    },

    // 根据方块类型推断材质（用于挖掘声：土/木/石/金属）
    _mat(tile) {
      const b = (typeof BLOCKS !== 'undefined' && BLOCKS[tile]) || null;
      const name = b ? (b.name || '') : '';
      const metal = /矿|铁|铜|金|银|锡|铅|锌|煤|钢/.test(name) || (tile >= 7 && tile <= 14);
      let noise = 1000, bass = 180;
      if (/木|植|叶|草|花|树/.test(name)) { noise = 800; bass = 150; }
      else if (/石|沙|土|砖|混|泥/.test(name)) { noise = 700; bass = 130; }
      else if (metal) { noise = 1800; bass = 200; }
      return { noise, bass, metal };
    },

    // ---- 事件分发 ----
    play(name, opts) {
      opts = opts || {};
      this.resume();
      if (!this.ctx) return;
      const pan = opts.pan || 0;

      switch (name) {
        case 'jump':
          this._tone({ freq: 300, slideTo: 540, type: 'square', dur: 0.12, vol: 0.10, pan });
          break;
        case 'dig':
          this._noise({ dur: 0.05, vol: 0.06, filter: 'bandpass', filterFreq: 1500, filterQ: 1, pan });
          break;
        case 'break': {
          const m = this._mat(opts.tile);
          this._noise({ dur: 0.12, vol: 0.18, filter: 'lowpass', filterFreq: m.noise, pan });
          this._tone({ freq: m.bass, slideTo: m.bass * 0.5, type: 'square', dur: 0.12, vol: 0.12, pan });
          if (m.metal) this._tone({ freq: 1300, type: 'triangle', dur: 0.14, vol: 0.10, pan });
          break;
        }
        case 'place':
          this._tone({ freq: 240, slideTo: 150, type: 'triangle', dur: 0.10, vol: 0.12, pan });
          this._noise({ dur: 0.05, vol: 0.06, filter: 'lowpass', filterFreq: 1200, pan });
          break;
        case 'leaf': // 树叶飘落的沙沙声
          this._noise({ dur: 0.18, vol: 0.07, filter: 'bandpass', filterFreq: 2600, filterQ: 0.8, pan });
          this._noise({ dur: 0.14, vol: 0.04, filter: 'highpass', filterFreq: 3500, when: 0.08, pan });
          break;
        case 'torch':
          this._noise({ dur: 0.25, vol: 0.10, filter: 'bandpass', filterFreq: 900, filterQ: 1.2, pan });
          this._noise({ dur: 0.18, vol: 0.05, filter: 'highpass', filterFreq: 3000, pan });
          break;
        case 'drop':
          this._tone({ freq: 170, slideTo: 110, type: 'triangle', dur: 0.12, vol: 0.12, pan });
          this._noise({ dur: 0.06, vol: 0.05, filter: 'lowpass', filterFreq: 900, pan });
          break;
        case 'hurt':
          this._tone({ freq: 220, slideTo: 80, type: 'sawtooth', dur: 0.18, vol: 0.14, pan });
          this._noise({ dur: 0.10, vol: 0.10, filter: 'lowpass', filterFreq: 700, pan });
          break;
        case 'pickup':
          this._tone({ freq: 700, slideTo: 1150, type: 'sine', dur: 0.10, vol: 0.09, pan });
          this._tone({ freq: 1050, type: 'sine', dur: 0.07, vol: 0.05, when: 0.05, pan });
          break;
        case 'craft':
          this._arp([523, 659, 784], 'triangle', 0.09, 0.07, pan);
          break;
        case 'smelt':
          this._arp([392, 523, 659], 'triangle', 0.12, 0.07, pan);
          this._noise({ dur: 0.5, vol: 0.05, filter: 'lowpass', filterFreq: 500, pan });
          break;
        case 'attack':
          this._noise({ dur: 0.14, vol: 0.14, filter: 'bandpass', filterFreq: 1200, filterQ: 0.8, pan });
          this._tone({ freq: 320, slideTo: 120, type: 'square', dur: 0.12, vol: 0.12, pan });
          break;
        case 'battle':
          this._tone({ freq: 110, type: 'sawtooth', dur: 0.3, vol: 0.08, pan });
          this._tone({ freq: 116, type: 'sawtooth', dur: 0.3, vol: 0.06, pan });
          break;
        case 'click':
          this._tone({ freq: 800, type: 'square', dur: 0.03, vol: 0.045, pan });
          break;
        case 'discover':
          this._arp([523, 659, 784, 1047], 'triangle', 0.12, 0.10, pan);
          break;
        case 'enemyDie':
          this._tone({ freq: 420, slideTo: 70, type: 'sawtooth', dur: 0.4, vol: 0.14, pan });
          this._noise({ dur: 0.25, vol: 0.12, filter: 'lowpass', filterFreq: 1200, pan });
          break;
        case 'day':
          this._arp([523, 659, 784], 'triangle', 0.14, 0.09, 0);
          break;
        case 'night':
          this._arp([440, 523, 622], 'sine', 0.2, 0.08, 0);
          break;
        case 'death':
          this._tone({ freq: 400, slideTo: 40, type: 'sawtooth', dur: 0.8, vol: 0.16 });
          break;
        case 'splash': // 舀水/倒水：低频噗通 + 水花噪声
          this._tone({ freq: 180, slideTo: 90, type: 'sine', dur: 0.18, vol: 0.10, pan });
          this._noise({ dur: 0.12, vol: 0.08, filter: 'lowpass', filterFreq: 900, pan });
          break;
        case 'lava': // 岩浆：低沉咕嘟 + 带通噪声
          this._tone({ freq: 90, slideTo: 60, type: 'sawtooth', dur: 0.22, vol: 0.10, pan });
          this._noise({ dur: 0.2, vol: 0.10, filter: 'bandpass', filterFreq: 600, filterQ: 1.2, pan });
          break;
        default:
          this._tone({ freq: 200, type: 'sawtooth', dur: 0.1, vol: 0.08, pan });
      }
    },

    // ---- 环境 drone (昼夜响应) ----
    _startAmbient() {
      if (!this.ctx || this._drone) return;
      const t0 = this._now();
      const root = 65.4; // C2
      const o1 = this.ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = root;
      const o2 = this.ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = root * 1.5;   // 五度
      const o3 = this.ctx.createOscillator(); o3.type = 'triangle'; o3.frequency.value = root * 2.005;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
      const g = this.ctx.createGain(); g.gain.value = 0.0;
      o1.connect(lp); o2.connect(lp); o3.connect(lp); lp.connect(g); g.connect(this.buses.ambient);
      o1.start(t0); o2.start(t0); o3.start(t0);
      // 缓慢 LFO 调制滤波，营造呼吸感
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.05;
      const lfoG = this.ctx.createGain(); lfoG.gain.value = 150;
      lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start(t0);
      this._drone = { g: g };
    },

    // ---- 每帧推进：昼夜因子 + 生成式音乐 ----
    update(dt, time) {
      if (!this.ctx || !this._unlocked) return;
      const t = (typeof time === 'number') ? time : 0;
      const night = (t > 0.5 && t < 0.95) ? 1 : 0;
      if (this._drone) {
        const target = night ? 0.09 : 0.035;
        this._drone.g.gain.setTargetAtTime(target, this._now(), 1.5);
      }
      // 生成式音乐：用短和弦进行循环，避免"一直一个调"的单调感
      // 夜晚更慢更稀更柔，白天稍密稍亮
      this._musicAccum += dt;
      const stepDur = night ? 900 : 620; // ms/步（夜晚明显放慢）
      if (this._musicAccum >= stepDur) {
        this._musicAccum -= stepDur;
        this._step++;

        // 和弦进行（每 4 步换一个和弦，循环）——夜晚小调色彩，白天大调色彩
        const NIGHT_PROG = [
          [146.8, 174.6, 220.0], // Dm
          [130.8, 164.8, 196.0], // Cm
          [110.0, 130.8, 164.8], // Am
          [146.8, 174.6, 220.0],
        ];
        const DAY_PROG = [
          [130.8, 164.8, 196.0], // C
          [146.8, 185.0, 220.0], // Dm
          [174.6, 220.0, 261.6], // F
          [196.0, 246.9, 293.7], // G
        ];
        const prog = night ? NIGHT_PROG : DAY_PROG;
        const chord = prog[Math.floor(this._step / 4) % prog.length];

        // 每步只点 1 个音（带随机休止），不再每步必响
        const playNote = night ? (Math.random() < 0.5) : (Math.random() < 0.7);
        if (playNote) {
          if (this._step % 4 === 0) {
            // 低八度根基偶尔点一下，营造呼吸感
            this._tone({ freq: chord[0] / 2, type: 'triangle', dur: night ? 1.4 : 0.9, vol: night ? 0.05 : 0.04, bus: 'music' });
          } else {
            const n = chord[Math.floor(Math.random() * chord.length)];
            this._tone({ freq: n, type: 'sine', dur: night ? 0.9 : 0.5, vol: night ? 0.045 : 0.05, bus: 'music' });
          }
        }
      }
    },

    // ---- 控制 ----
    setBus(name, v) { if (this.buses[name]) this.buses[name].gain.value = v; },
    toggleMute() {
      this.muted = !this.muted;
      if (this.master) this.master.gain.value = this.muted ? 0 : this._vol.master;
      return this.muted;
    },
  };

  if (typeof window !== 'undefined') window.Sound = Sound;
  if (typeof module !== 'undefined') module.exports = Sound;
})();
