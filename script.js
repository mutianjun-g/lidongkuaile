/* =====================================================================
 *  万圣节礼物 · 祝福语爱心动画（WebGL 版）
 *
 *  流程：弹窗 → 点“确定” → 祝福语飞入聚成粉色爱心 → 心跳 →
 *        快速汇聚到一点 → 炸开成一面发光的 3D 文字墙
 *
 *  文字墙交互：单指/鼠标按住拖动 = 倾斜角度；双指拉伸/滚轮 = 放大缩小
 *
 *  所有文字都是 WebGL 里的“带透视的小平面”，一次绘制完成，所以很流畅。
 * ===================================================================== */
(() => {
  'use strict';

  /* ===================== 可自由修改的配置 ===================== */
  // 祝福语写在 index.html 的 <div id="messages"> 一个标签里，一行一条或用 | 隔开（同一句重复写几次，出现的机会就更大）
  // 用户上传/自定义的内容可能混进 <br>、<p>、不间断空格、零宽字符、超长句子等，这里统一清洗，避免把渲染搞坏
  const MAX_CHARS = 14;            // 单条最长字数，更长的会按标点/长度自动拆成几条
  const MAX_ENTRIES = 300;         // 最多使用多少条（含重复）
  function cleanMessages(raw) {
    const lines = String(raw || '')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/<\s*br\s*\/?\s*>|<\/\s*(p|div|li|tr|h\d)\s*>/gi, '\n')     // 换行类标签 → 换行
      .replace(/<[^>]*>/g, '')                                              // 其余标签直接丢掉
      .split(/[\n\r|]+/);
    const out = [];
    for (let line of lines) {
      line = line.replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF\u00A0\u3000]/g, ' ')   // 零宽字符、特殊空格
        .replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      const chars = Array.from(line);
      if (chars.length <= MAX_CHARS) { out.push(line); continue; }
      // 太长：先按标点拆，再把短的拼起来，最后还超长的硬切
      let cur = '';
      const flush = () => { if (cur) out.push(cur); cur = ''; };
      const parts = line.match(/[^，。！？；、,.!?;~…]+[，。！？；、,.!?;~…]*|[，。！？；、,.!?;~…]+/g) || [line];   // 按标点切开（不用后行断言，兼容旧版 iOS）
      for (const part of parts) {
        const pc = Array.from(part);
        if (Array.from(cur).length + pc.length <= MAX_CHARS) { cur += part; continue; }
        flush();
        for (let i = 0; i < pc.length; i += MAX_CHARS) {
          const seg = pc.slice(i, i + MAX_CHARS).join('');
          if (i + MAX_CHARS < pc.length) out.push(seg); else cur = seg;
        }
      }
      flush();
    }
    return out.map(s => s.trim()).filter(Boolean).slice(0, MAX_ENTRIES);
  }
  let MESSAGES = cleanMessages(document.getElementById('messages')?.textContent);
  if (!MESSAGES.length) MESSAGES = ['祝你天天开心'];   // 万一一条都没写，给个兜底

  // 背景音乐（点击“确定”后自动播放，循环）
  const BGM_URL = 'https://lf26-music-east.douyinstatic.com/obj/ies-music-hj/7696841236178733873.mp3';

  // 时间线（秒）
  const T_PEN_IN = 1.0;   // 神笔飞入到起笔点
  const T_DRAW   = 6.5;   // 神笔勾画爱心（越大越慢）
  const T_SPRAY  = 0.8;   // 每个字从笔尖喷出、落到位置的时长
  const T_PAUSE  = 0.3;   // 爱心画完后，笔停在原地的短暂时间（笔不离场，随后直接开始收）
  const T_LOOP   = 1.6;   // 汇聚第一段：笔沿着爱心轮廓再走一圈，路过的字被笔“带走”，在笔后面拖成一条尾巴
  const T_SWOOP  = 0.6;   // 汇聚第二段：笔拖着整条字带划向屏幕中心
  const T_GRAB   = 0.55;  // 字被笔带走后，从原位置过渡到尾巴里的时长（必须短于 T_LOOP 才不显得“吸”）
  const T_TAIL   = 0.3;   // 字跟在笔后面的最大滞后（越大，拖出的尾巴越长）
  const T_SHRINK = T_LOOP + T_SWOOP + T_TAIL + 0.1;   // 汇聚到一点的总时长
  const T_BURST  = 4.0;   // 从中心炸开成 3D 空间

  // 爱心阶段的粉色（全程不变色，只有深浅差异）
  const HEART_COLORS = [
    "#ff4d88", "#ff5c96", "#e91e63", "#ff6f9f", "#f0467f", "#d6336c", "#ff4081", "#f2578f",
    "#ff4d88", "#ff5c96", "#e91e63", "#ff4081"
  ];

  const AUTO_ROTATE = 0.07;                // 空闲时的自动旋转速度（弧度/秒）
  const ZOOM_MIN = 0.55, ZOOM_MAX = 2.8;   // 缩放范围
  const STROKE_W = 4.4;                    // 笔画粗细（心形坐标单位，约 1 单位 = 十几个像素）
  /* =========================================================== */

  const T_END = T_PEN_IN + T_DRAW;                       // 爱心画完的时刻
  const A1 = T_END + T_SPRAY, B1 = T_END + T_PAUSE, C1 = B1 + T_SHRINK, D1 = C1 + T_BURST;
  const FOV = 60 * Math.PI / 180;
  const NEAR = 24;

  const $ = id => document.getElementById(id);
  const canvas = $('stage'), mask = $('mask'), dialog = $('dialog'), tip = $('tip');
  const bgDark = $('bgDark'), bgLight = $('bgLight'), glowEl = $('glow'), pen = $('pen');

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeOutQuart = t => 1 - Math.pow(1 - t, 4);
  const easeInOutCubic = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const hex2rgb = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  const HEART_RGB = HEART_COLORS.map(hex2rgb);

  function hsl2rgb(h, s, l, out, o) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    out[o] = f(h + 1 / 3); out[o + 1] = f(h); out[o + 2] = f(h - 1 / 3);
  }

  /* ===================== WebGL 初始化 ===================== */
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' });

  // —— 取消按钮（即使没有 WebGL 也要能响应）——
  const cancelTips = ["再考虑一下嘛～", "真的不要吗？🥺", "里面有好多好多祝福呢", "点一下确定就知道啦～"];
  let cancelCount = 0;
  $('cancel').addEventListener('click', () => {
    tip.textContent = cancelTips[cancelCount++ % cancelTips.length];
    dialog.classList.remove('shake');
    void dialog.offsetWidth;
    dialog.classList.add('shake');
  });

  if (!gl) {
    $('ok').addEventListener('click', () => { tip.textContent = '当前浏览器不支持 WebGL，请换 Chrome / Edge / Safari 试试'; });
    return;
  }

  function makeShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, makeShader(gl.VERTEX_SHADER, `
    attribute vec4 aPos; attribute vec2 aUV; attribute vec4 aCol; attribute vec4 aGlow;
    varying vec2 vUV; varying vec4 vCol; varying vec4 vGlow;
    void main(){ gl_Position = aPos; vUV = aUV; vCol = aCol; vGlow = aGlow; }
  `));
  // 贴图通道约定：R = 文字本体，A = 文字+光晕的覆盖度
  // vCol.rgb = 文字颜色, vCol.a = 透明度, vGlow.rgb = 光晕颜色, vGlow.a = 光晕强度(0~1)
  gl.attachShader(prog, makeShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D uTex;
    varying vec2 vUV; varying vec4 vCol; varying vec4 vGlow;
    void main(){
      vec4 t = texture2D(uTex, vUV);
      float g = vGlow.a * 0.85;
      float cov = t.a * (t.r + (1.0 - t.r) * g);
      vec3 col = mix(vGlow.rgb, vCol.rgb, t.r);
      float a = cov * vCol.a;
      gl_FragColor = vec4(col * a, a);
    }
  `));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.bindAttribLocation(prog, 1, 'aUV');
  gl.bindAttribLocation(prog, 2, 'aCol');
  gl.bindAttribLocation(prog, 3, 'aGlow');
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  /* ===================== 精灵图集 =====================
   * 两张图集：
   *   flat —— 爱心阶段用：小字号、无光晕，文字清晰锐利
   *   glow —— 文字墙阶段用：大字号、带柔和光晕
   */
  const AW = 2048;
  const FONT_FAMILY = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  const GLOW_FONT = 56, FLAT_FONT = 36;
  let atlasGlow = null, atlasFlat = null;

  function heartPoint(t) {   // 心形曲线，原点在心形几何中心，y 向下
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    return [x, y - 2.5];
  }

  /* ---- 心形笔画路径：按“弧长”均匀采样 ----
   * 心形曲线按角度均匀取点时，尖角和凹口处会挤成一团，所以爱心看起来不均匀。
   * 这里先把整条曲线按弧长切成等距的小段：s=0 是底部尖角，沿左侧向上、绕过两个圆弧、
   * 下到中间凹口、再沿右侧回到底部。文字沿 s 均匀分布，笔也沿 s 匀速前进。
   * 同时记录每一点的法线，让笔画有均匀的粗细（而不是像以前那样把心形整体缩放）。 */
  const HP_N = 800;
  const HP = { x: new Float32Array(HP_N + 1), y: new Float32Array(HP_N + 1), nx: new Float32Array(HP_N + 1), ny: new Float32Array(HP_N + 1), len: new Float32Array(HP_N + 1), total: 0 };
  (function buildHeartPath() {
    for (let i = 0; i <= HP_N; i++) {
      const [x, y] = heartPoint(Math.PI + i / HP_N * Math.PI * 2);
      HP.x[i] = x; HP.y[i] = y;
      HP.len[i] = i ? HP.len[i - 1] + Math.hypot(x - HP.x[i - 1], y - HP.y[i - 1]) : 0;
    }
    HP.total = HP.len[HP_N];
    for (let i = 0; i <= HP_N; i++) {
      // 尖角/凹口处切线会突然反向，只在方向连续时才取前后平均
      const ip = i > 0 ? i - 1 : HP_N - 1, inx = i < HP_N ? i + 1 : 1;
      let bx = HP.x[i] - HP.x[ip], by = HP.y[i] - HP.y[ip], fx = HP.x[inx] - HP.x[i], fy = HP.y[inx] - HP.y[i];
      let bl = Math.hypot(bx, by) || 1, fl = Math.hypot(fx, fy) || 1;
      bx /= bl; by /= bl; fx /= fl; fy /= fl;
      let tx = bx, ty = by;
      if (bx * fx + by * fy > 0) { tx = bx + fx; ty = by + fy; }
      const tl = Math.hypot(tx, ty) || 1;
      HP.nx[i] = ty / tl; HP.ny[i] = -tx / tl;
    }
  })();

  // 取路径上进度为 s(0~1) 的点：out = [x, y, 法线x, 法线y]
  function heartPath(s, out) {
    s = clamp(s);
    const target = s * HP.total;
    let lo = 0, hi = HP_N;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (HP.len[mid] <= target) lo = mid; else hi = mid; }
    const seg = HP.len[hi] - HP.len[lo] || 1, f = (target - HP.len[lo]) / seg;
    out[0] = HP.x[lo] + (HP.x[hi] - HP.x[lo]) * f;
    out[1] = HP.y[lo] + (HP.y[hi] - HP.y[lo]) * f;
    const nx = HP.nx[lo] + (HP.nx[hi] - HP.nx[lo]) * f, ny = HP.ny[lo] + (HP.ny[hi] - HP.ny[lo]) * f, nl = Math.hypot(nx, ny) || 1;
    out[2] = nx / nl; out[3] = ny / nl;
    return out;
  }
  // 笔画在两个尖角处收细，像毛笔收锋
  function strokeTaper(s) {
    const d = Math.min(s, 1 - s, Math.abs(s - 0.5));
    return 0.3 + 0.7 * clamp(d / 0.07);
  }
  // 让心形刚好放进屏幕（含笔画粗细）
  const heartScaleNow = () => Math.min(W / (2 * (16 + STROKE_W / 2) + 6), H / (2 * (14.5 + STROKE_W / 2) + 6));

  // 把一批小图按行排进图集，返回图集高度（2 的幂）
  function layoutItems(items) {
    let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      if (x + it.w > AW) { x = 0; y += rowH; rowH = 0; }
      it.x = x; it.y = y; x += it.w; rowH = Math.max(rowH, it.h);
    }
    let AH = 256; while (AH < y + rowH) AH *= 2;
    return AH;
  }

  // 祝福语太多时图集会超出手机 GPU 允许的最大贴图尺寸（贴图失效 = 画面全是拉长的条纹），
  // 所以先估算高度，超了就只保留前面不重复的一部分
  function fitMessages() {
    const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048, 4096);
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${GLOW_FONT}px ${FONT_FAMILY}`;
    const uniq = Array.from(new Set(MESSAGES));
    const height = list => layoutItems(list.map(t => ({ w: Math.min(AW, Math.ceil(m.measureText(t).width) + 80), h: Math.ceil(GLOW_FONT * 1.3) + 80 })).concat([{ w: 220, h: 220 }, { w: 96, h: 96 }]));
    while (uniq.length > 6 && height(uniq) > limit) uniq.pop();
    if (uniq.length < new Set(MESSAGES).size) { const keep = new Set(uniq); MESSAGES = MESSAGES.filter(t => keep.has(t)); }
  }

  function buildAtlas(font, pad, glow) {
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${font}px ${FONT_FAMILY}`;
    const texts = Array.from(new Set(MESSAGES)); texts.push('♥');
    const items = texts.map(txt => {
      const draw = txt === '♥' ? '\u2665\uFE0E' : txt;       // ♥ 强制用文字样式，避免在 iOS 上变成红色 emoji
      return { kind: 'text', txt, draw, w: Math.min(AW, Math.ceil(m.measureText(draw).width) + pad * 2), h: Math.ceil(font * 1.3) + pad * 2 };
    });
    if (glow) items.push({ kind: 'heart', w: 220, h: 220 }, { kind: 'dot', w: 96, h: 96 });
    const AH = layoutItems(items);

    const c = document.createElement('canvas'); c.width = AW; c.height = AH;
    const g = c.getContext('2d');
    const map = {};
    for (const it of items) {
      g.save();
      g.beginPath(); g.rect(it.x, it.y, it.w, it.h); g.clip();
      if (it.kind === 'text') {
        g.font = `${font}px ${FONT_FAMILY}`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = 'rgb(255,0,0)';                    // R：文字本体
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2 + font * 0.04;
        if (glow) {
          g.shadowColor = 'rgb(0,255,0)';                // G：光晕（宽 + 窄两层，像雾一样柔和）
          g.shadowBlur = 30; g.fillText(it.draw, cx, cy); g.fillText(it.draw, cx, cy);
          g.shadowBlur = 10; g.fillText(it.draw, cx, cy);
        } else {
          g.fillText(it.draw, cx, cy);
        }
      } else if (it.kind === 'heart') {
        g.fillStyle = 'rgb(255,0,0)'; g.shadowColor = 'rgb(255,0,0)'; g.shadowBlur = 20;
        g.beginPath();
        for (let i = 0; i <= 80; i++) {
          const [hx, hy] = heartPoint(i / 80 * Math.PI * 2);
          const px = it.x + it.w / 2 + hx * 5.2, py = it.y + it.h / 2 + hy * 5.2;
          i ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.closePath(); g.fill();
      } else {
        const gr = g.createRadialGradient(it.x + 48, it.y + 48, 0, it.x + 48, it.y + 48, 44);
        gr.addColorStop(0, 'rgba(255,0,0,1)'); gr.addColorStop(.35, 'rgba(255,0,0,.6)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
        g.fillStyle = gr; g.fillRect(it.x, it.y, it.w, it.h);
      }
      g.restore();
      const key = it.kind === 'text' ? it.txt : it.kind;
      map[key] = { w: it.w, h: it.h, u0: (it.x + 1) / AW, v0: (it.y + 1) / AH, u1: (it.x + it.w - 1) / AW, v1: (it.y + it.h - 1) / AH };
    }

    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return { map, tex, font };
  }

  /* ===================== 顶点缓冲 ===================== */
  const FLOATS = 14;                       // pos4 + uv2 + col4 + glow4
  const vbuf = gl.createBuffer(), ibuf = gl.createBuffer();
  let vdata, idata, depth, ids = [], maxQ = 0, nq = 0;

  function allocBuffers(n) {
    maxQ = n;
    vdata = new Float32Array(n * 4 * FLOATS);
    idata = new Uint16Array(n * 6);
    depth = new Float32Array(n);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, vdata.byteLength, gl.DYNAMIC_DRAW);
    const S = FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 16);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, 40);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idata.byteLength, gl.DYNAMIC_DRAW);
  }

  /* ===================== 相机（可拖动倾斜 / 缩放） ===================== */
  let W, H, DPR, F, FZ, D;
  let yaw = 0, pitch = 0, vYaw = 0, vPitch = 0, zoom = 1, zoomTarget = 1;
  let cY = 1, sY = 0, cP = 1, sP = 0;
  let tX = 0, tY = 0, tZ = 0;

  function camXform(x, y, z) {
    const x1 = x * cY + z * sY, z1 = -x * sY + z * cY;
    tX = x1; tY = y * cP - z1 * sP; tZ = y * sP + z1 * cP;
  }

  /* 压入一个带 3D 变换的小平面（四边形）。成功返回 true */
  const QX = new Float32Array(4), QY = new Float32Array(4), QW = new Float32Array(4);
  const SU = [-1, 1, 1, -1], SV = [-1, -1, 1, 1];
  function pushQuad(x, y, z, hw, hh, ry, rx, rz, spr, cr, cg, cb, ca, gr, gg, gb, ga, fadeAmt) {
    if (nq >= maxQ) return false;
    let ux = hw, uy = 0, uz = 0, vx = 0, vy = hh, vz = 0;
    if (ry !== 0 || rx !== 0 || rz !== 0) {
      const cz = Math.cos(rz), sz = Math.sin(rz), cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
      let a = hw * cz, b = hw * sz, b2 = b * cx, c2 = b * sx;
      ux = a * cy + c2 * sy; uy = b2; uz = -a * sy + c2 * cy;
      a = -hh * sz; b = hh * cz; b2 = b * cx; c2 = b * sx;
      vx = a * cy + c2 * sy; vy = b2; vz = -a * sy + c2 * cy;
    }
    camXform(x, y, z);   const Cx = tX, Cy = tY, Cz = tZ;
    camXform(ux, uy, uz); const Ux = tX, Uy = tY, Uz = tZ;
    camXform(vx, vy, vz); const Vx = tX, Vy = tY, Vz = tZ;

    const zc0 = D - Cz;
    if (zc0 < NEAR * 3) return false;
    for (let i = 0; i < 4; i++) {
      const X = Cx + SU[i] * Ux + SV[i] * Vx, Y = Cy + SU[i] * Uy + SV[i] * Vy, Z = Cz + SU[i] * Uz + SV[i] * Vz;
      const zc = D - Z;
      if (zc < NEAR) return false;
      QW[i] = zc;
      QX[i] = (X * FZ / zc) / (W / 2) * zc;
      QY[i] = -(Y * FZ / zc) / (H / 2) * zc;
    }

    // 景深：太近、太远的渐隐
    let a = ca;
    if (fadeAmt > 0) {
      const near = clamp((zc0 - 0.1 * F) / (0.2 * F)), far = clamp((2.6 * F - zc0) / (1.2 * F));
      a *= 1 - fadeAmt * (1 - near * far);
      if (a < 0.004) return false;
    }

    const o = nq * 4 * FLOATS;
    const us = [spr.u0, spr.u1, spr.u1, spr.u0], vs = [spr.v0, spr.v0, spr.v1, spr.v1];
    for (let i = 0; i < 4; i++) {
      const p = o + i * FLOATS;
      vdata[p] = QX[i]; vdata[p + 1] = QY[i]; vdata[p + 2] = 0; vdata[p + 3] = QW[i];
      vdata[p + 4] = us[i]; vdata[p + 5] = vs[i];
      vdata[p + 6] = cr; vdata[p + 7] = cg; vdata[p + 8] = cb; vdata[p + 9] = a;
      vdata[p + 10] = gr; vdata[p + 11] = gg; vdata[p + 12] = gb; vdata[p + 13] = ga;
    }
    depth[nq] = zc0;
    ids.push(nq);
    nq++;
    return true;
  }

  /* ===================== 场景布局 ===================== */
  let texts = [], dusts = [], hearts = [], startTime = 0, lastNow = 0, rafId = 0, running = false;

  // 3D 空间里的目标位置与朝向：有倾斜的、有翻到背面的、有远有近的，拖动时可以从各个角度欣赏
  // 初始视野里已经占用的屏幕矩形：新来的字必须避开它们，所以字和字之间不会互相压着
  let placed = [];

  function sceneTarget(p, avoid) {
    const r = Math.random();
    // 朝向克制一些：基本正对观众、轻微倾斜，不再出现一堆歪七扭八的字
    p.tyaw = rand(-0.5, 0.5); p.tpitch = rand(-0.28, 0.28); p.troll = rand(-0.12, 0.12);
    let done = false;
    if (avoid) {                       // 在初始视野里“找空位”放字（大字先放）
      const wEff = Math.max(8, p.spr.w - 70) * p.tSize / atlasGlow.font, hEff = p.tSize * 1.2;
      for (let tries = 0; tries < 28 && !done; tries++) {
        const z = (p.hero ? rand(-0.35, 0.1) : rand(-0.8, 0.25)) * F, zc = F - z, f = F / zc;
        const cx = rand(-0.5, 0.5) * W, cy = rand(-0.5, 0.5) * H;
        const hw = wEff * f / 2, hh = hEff * f / 2, m = 14 + p.tSize * 0.4;
        if (Math.abs(cx) + hw > W * 0.56 || Math.abs(cy) + hh > H * 0.56) continue;
        let ok = true;
        for (let k = 0; k < placed.length; k++) {
          const o = placed[k];
          if (Math.abs(cx - o.cx) < hw + o.hw + m && Math.abs(cy - o.cy) < hh + o.hh + m) { ok = false; break; }
        }
        if (!ok) continue;
        placed.push({ cx, cy, hw, hh });
        p.tx = cx / f; p.ty = cy / f; p.tz = z;
        done = true;
      }
    }
    if (!done && p.free && Math.random() < 0.5) {             // 光点、柔光爱心：一半随意散在初始视野里
      const z = rand(-0.9, 0.3) * F, zc = F - z;
      p.tx = rand(-0.55, 0.55) * W * zc / F; p.ty = rand(-0.55, 0.55) * H * zc / F; p.tz = z;
      done = true;
    }
    if (!done) {                               // 其余字分布在周围，旋转时才会看到（朝向中心，转到哪都比较好读）
      for (let tries = 0; tries < 12; tries++) {              // 尽量放在初始画面之外，避免挤进已经排好的画面里
        const u = rand(-1, 1), th = rand(0, Math.PI * 2), s = Math.sqrt(1 - u * u), rho = F * rand(0.5, 1.15);
        p.tx = rho * s * Math.cos(th) * 1.25; p.ty = rho * u * 0.9; p.tz = rho * s * Math.sin(th);
        const zc = F - p.tz;
        if (p.tz > 0.4 * F) continue;                         // 太靠近镜头的会变成一大团虚影，不要
        if (zc < NEAR * 3 || Math.abs(p.tx * F / zc) > W * 0.6 || Math.abs(p.ty * F / zc) > H * 0.6) break;
      }
      p.tyaw = Math.atan2(-p.tx, -p.tz) + rand(-0.4, 0.4);
      p.tpitch = Math.asin(clamp(p.ty / Math.hypot(p.tx, p.ty, p.tz), -1, 1)) * 0.6 + rand(-0.2, 0.2);
    }
    // 少量翻到背面（文字镜像）；不再有侧立的字，避免出现一条条竖线
    if (r < 0.07) p.tyaw += (Math.random() < .5 ? -1 : 1) * Math.PI * rand(0.88, 1.0);
  }

  function build() {
    const small = Math.min(W, H) < 560;
    const heartScale = heartScaleNow();
    const maxHW = heartScale * 9;            // 爱心阶段单条文字的最大宽度（像素）
    const hp = [0, 0, 0, 0];
    const nHeart = small ? 480 : 760, nExtra = small ? 50 : 100;   // 额外的字让最终的文字空间更密、更有层次
    const showProb = small ? 0.1 : 0.09;   // 爱心里几百个字太密了，3D 场景里只保留一部分，其余在炸开瞬间淡出
    const sizeK = clamp(Math.min(W, H) / 720, 0.7, 1.25);
    texts = []; dusts = []; hearts = [];

    for (let i = 0; i < nHeart + nExtra; i++) {
      const inHeart = i < nHeart;
      const text = Math.random() < 0.1 ? '♥' : MESSAGES[(Math.random() * MESSAGES.length) | 0];
      const p = {
        text, spr: atlasGlow.map[text], sprF: atlasFlat.map[text], inHeart,
        show: !inHeart || Math.random() < showProb,
        phase: Math.random() * Math.PI * 2,
        cDelay: Math.random() * 0.25, bDelay: Math.random() * 0.3,
        pc: HEART_RGB[(Math.random() * HEART_RGB.length) | 0], hb: (Math.random() * 8) | 0,
        tSize: 0
      };
      // 大小悬殊：少量超大的“主角”字、一些中等字、大量小字，拉开远近层次
      const rs = Math.random();
      p.hero = rs < 0.03;
      p.tSize = (p.hero ? rand(60, 100) : rs < 0.25 ? rand(30, 46) : rand(15, 26)) * sizeK;
      p.tSize = Math.min(p.tSize, W * 0.7 * GLOW_FONT / Math.max(8, p.spr.w - 80));   // 文字空间里单条也不超过屏幕宽度的 70%
      p.white = p.hero ? 0.4 : 0;              // 主角字的核心更接近白热，发光更强
      if (inHeart) {
        // 沿笔画路径“分层均匀”摆放：s 按弧长等距（每个字占一小段），
        // 横向偏移用低差异序列，保证笔画宽度方向也铺得均匀，不会这里一堆那里一个洞
        const s = (i + rand(0.08, 0.92)) / nHeart;                // 0~1：笔画进度
        const off = ((i * 0.7548776662466927) % 1) - 0.5 + rand(-0.05, 0.05);   // -0.5~0.5：笔画宽度方向
        heartPath(s, hp);
        const w = STROKE_W * strokeTaper(s);
        p.s = s;
        // 汇聚阶段：笔划到这个字的时刻（反推缓动曲线）、字跟在笔后面的滞后、在笔尖周围的散布
        p.tg = T_LOOP * Math.acos(1 - 2 * s) / Math.PI;
        p.lag = rand(0.04, T_TAIL);
        p.ox = rand(-16, 16); p.oy = rand(-16, 16);
        p.hx = (hp[0] + hp[2] * off * w) * heartScale + rand(-3, 3);
        p.hy = (hp[1] + hp[3] * off * w) * heartScale + rand(-3, 3);
        penPos(p.tg, _sw);                                        // 笔划到这个字时笔尖的位置
        p.ex = p.hx - _sw[0]; p.ey = p.hy - _sw[1];               // 字相对笔尖的偏移：被带走时从这个偏移平滑过渡，不会“跳”
        p.hSize = text === '♥' ? rand(8, 13) : rand(9, 15);
        // 句子越长字越小，保证每条在爱心笔画里的宽度不超过 maxW，不会横着溢出一大片
        p.hSize = Math.max(5, Math.min(p.hSize, maxHW * FLAT_FONT / Math.max(8, p.sprF.w - 8)));
        // 笔尖经过这个位置的时间（反推缓动曲线），字从笔尖“喷”出来
        p.tApp = T_PEN_IN + T_DRAW * Math.acos(1 - 2 * s) / Math.PI + rand(0, 0.1);
        p.sx = hp[0] * heartScale + rand(-12, 12);
        p.sy = hp[1] * heartScale + rand(-12, 12);
      } else {
        p.hSize = 8;
      }
      texts.push(p);
    }
    // 大字先找位置，小字再填缝，只有会留在 3D 场景里的字才参与“避让”
    placed = [];
    texts.slice().sort((a, b) => b.tSize - a.tSize).forEach(p => sceneTarget(p, p.show && p.text !== '♥'));
    texts.sort(() => Math.random() - 0.5);

    // 漂浮的光点 & 柔光的大爱心
    const nDust = small ? 110 : 220, nSoft = small ? 12 : 22;
    for (let i = 0; i < nDust; i++) {
      const p = { phase: Math.random() * 6.28, size: rand(5, 18), a0: rand(0.25, 0.7), free: true };
      sceneTarget(p); dusts.push(p);
    }
    for (let i = 0; i < nSoft; i++) {
      const giant = i < 5;                 // 几颗巨大的、朦胧的爱心垫在最远处，当“背景”，增加纵深
      const p = { phase: Math.random() * 6.28, size: (giant ? rand(380, 620) : rand(70, 190)) * sizeK, a0: giant ? rand(0.12, 0.2) : rand(0.25, 0.5), free: true };
      sceneTarget(p);
      if (giant) {
        const z = rand(-1.0, -0.45) * F, zc = F - z;
        p.tz = z; p.tx = rand(-0.5, 0.5) * W * zc / F; p.ty = rand(-0.4, 0.4) * H * zc / F;
      }
      hearts.push(p);
    }

    const need = texts.length + dusts.length + hearts.length + 4;
    if (need > maxQ) allocBuffers(need);
  }

  /* ===================== 每帧渲染 ===================== */
  const pal = new Float32Array(8 * 6);   // 8 档色相：文字色(3) + 光晕色(3)
  const heartCol = new Float32Array(3);
  const CORE_L = 0.9, GLOW_L = 0.6;

  function updateCamera(t, dt) {
    const interactive = t > C1 + 1;
    if (interactive && !pointers.size) {             // 松手后带惯性，空闲时缓慢自转
      const ramp = clamp((t - C1 - 1) / 4);
      yaw += (vYaw + AUTO_ROTATE * ramp) * dt;
      pitch += vPitch * dt;
      const damp = Math.exp(-2.2 * dt);
      vYaw *= damp; vPitch *= damp;
      pitch -= pitch * Math.min(1, dt * 0.25);
    }
    pitch = clamp(pitch, -1.25, 1.25);
    zoom += (zoomTarget - zoom) * Math.min(1, dt * 9);
    // 炸开时的“冲进去”：镜头从略近的位置缓缓拉回，文字从身边呼啸而过，更有冲击力
    const rush = t > C1 ? 0.5 * (1 - easeOutCubic(clamp((t - C1) / 4.2))) : 0;
    FZ = F * zoom * (1 + rush); D = F;
    cY = Math.cos(yaw); sY = Math.sin(yaw); cP = Math.cos(pitch); sP = Math.sin(pitch);
  }

  /* ===================== 神笔 ===================== */
  const easeInOutSine = t => (1 - Math.cos(Math.PI * t)) / 2;
  const _pp = [0, 0, 0, 0];
  // 笔尖在心形笔画中心线上、进度为 s 的屏幕位置；sigma<1 表示整体向中心收拢
  function tipAt(s, sigma) {
    heartPath(s, _pp);
    const k = heartScaleNow() * sigma;
    return [W / 2 + _pp[0] * k, H / 2 + _pp[1] * k];
  }

  /* 汇聚阶段笔尖的轨迹（相对屏幕中心，单位像素），tau = 汇聚开始后的秒数：
   *   第一段：紧贴轮廓把爱心再走一圈（笔一路走，字一路被带走）；
   *   第二段：拖着整条字带划过一道弧线，落到屏幕中心。
   * out = [x, y, 散布系数(1=尾巴有一定宽度, 0=收成一点)] */
  const _sw = [0, 0, 1];
  function penPos(tau, out) {
    const k0 = heartScaleNow();
    if (tau <= T_LOOP) {
      const s = easeInOutSine(clamp(tau / T_LOOP));
      heartPath(s, _pp);
      const k = k0 * (1 - 0.1 * s);                    // 一圈下来略微向内收一点
      out[0] = _pp[0] * k; out[1] = _pp[1] * k; out[2] = 1;
    } else {
      heartPath(1, _pp);
      const ex = _pp[0] * k0 * 0.9, ey = _pp[1] * k0 * 0.9;
      const e = easeInOutSine(clamp((tau - T_LOOP) / T_SWOOP));
      out[0] = ex * (1 - e) + Math.sin(Math.PI * e) * k0 * 5;   // 一道弧线，而不是直线
      out[1] = ey * (1 - e);
      out[2] = 1 - e;
    }
    return out;
  }

  function updatePen(t) {
    const tEnd = T_END;
    let x, y, op = 1, rot = 0, sc = 1;
    if (t < T_PEN_IN) {                                // 1 飞入：从右下角划着弧线来到起笔点
      const k = easeOutCubic(t / T_PEN_IN), [x0, y0] = tipAt(0, 1);
      x = lerp(W + 80, x0, k); y = lerp(H + 60, y0, k) - Math.sin(k * Math.PI) * H * 0.12;
      op = clamp(t / (T_PEN_IN * 0.5)); rot = lerp(25, 0, k);
    } else if (t < tEnd) {                             // 2 勾画爱心
      const u = (t - T_PEN_IN) / T_DRAW;
      [x, y] = tipAt(easeInOutSine(u), 1);
      rot = Math.sin(t * 2.6) * 4 + Math.sin(t * 7) * 1.2;      // 笔在手里轻轻晃动
    } else if (t < B1) {                               // 3 画完：笔不离场，停在收笔处，紧接着开始收
      [x, y] = tipAt(1, 1);
      rot = Math.sin(t * 2.6) * 4 * (1 - clamp((t - tEnd) / T_PAUSE));
    } else if (t < C1) {                               // 4 笔沿轮廓再走一圈带走字，再拖着它们划向中心，落点后淡出
      const tau = t - B1;
      penPos(tau, _sw);
      x = W / 2 + _sw[0]; y = H / 2 + _sw[1];
      rot = Math.sin(t * 9) * 3 * _sw[2];
      const tDone = T_LOOP + T_SWOOP;
      op = 1 - clamp((tau - tDone) / 0.2);
      sc = lerp(1, 0.85, clamp((tau - T_LOOP) / T_SWOOP));
      if (op <= 0) { if (pen.style.opacity !== '0') pen.style.opacity = '0'; return; }
    } else {
      if (pen.style.opacity !== '0') pen.style.opacity = '0';
      return;
    }
    pen.style.opacity = op.toFixed(3);
    pen.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${sc})`;
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const t = (now - startTime) / 1000;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000)); lastNow = now;
    updateCamera(t, dt);
    const flat = t < C1;                      // 爱心阶段用清晰的“平面图集”，文字墙阶段用“光晕图集”
    const atlas = flat ? atlasFlat : atlasGlow;

    // 整体色调：以粉色为主，缓慢地在粉紫之间流动
    const baseHue = 310 + 25 * Math.sin(0.1 * Math.max(0, t - C1) + 0.93);   // 335(粉) ↔ 285(粉紫)
    for (let b = 0; b < 8; b++) {
      const hue = baseHue + (b - 3.5) * 4;
      hsl2rgb(hue, 1, CORE_L, pal, b * 6);
      hsl2rgb(hue, 1, GLOW_L, pal, b * 6 + 3);
    }
    hsl2rgb(baseHue + 10, 0.8, 0.58, heartCol, 0);

    nq = 0; ids.length = 0;
    const fadeAmt = clamp((t - C1) / 2);

    // ---------- 祝福语 ----------
    for (let i = 0; i < texts.length; i++) {
      const p = texts[i];
      let x, y, z = 0, size, alpha = 1, neon = 0, ry = 0, rx = 0, rz = 0;

      if (t < C1) {                                   // 1 神笔勾画（字从笔尖喷出落位）→ 2 笔带着字汇聚到中心
        if (!p.inHeart) continue;
        const k = clamp((t - p.tApp) / T_SPRAY);
        if (k <= 0) continue;
        const e = easeOutCubic(k), wob = (1 - e) * 10;
        x = lerp(p.sx, p.hx, e) + Math.sin(p.phase + t * 3) * wob;
        y = lerp(p.sy, p.hy, e) + Math.cos(p.phase + t * 3) * wob;
        size = p.hSize * lerp(0.3, 1, e);
        alpha = clamp(k * 5);
        if (t >= B1) {
          // 笔沿轮廓走到哪里，那里的字就被带走：先紧贴笔尖（位置与被带走前一致，不会跳），
          // 再渐渐松开成一条跟在笔后面的“尾巴”；笔没到的地方保持原样，所以中心的点要等笔划到才会汇成
          const tau = t - B1, kg = clamp((tau - p.tg) / T_GRAB);
          if (kg > 0) {
            const m = kg * kg * (3 - 2 * kg);                    // 平滑 0→1
            penPos(tau - p.lag * m, _sw);                         // 笔在 lag*m 秒之前所在的位置（字跟在后面）
            x = _sw[0] + lerp(p.ex, p.ox * _sw[2], m);
            y = _sw[1] + lerp(p.ey, p.oy * _sw[2], m);
            size = lerp(p.hSize, p.hSize * (0.45 + 0.2 * _sw[2]), m);
          }
        }
      } else {                                        // 4 炸开成文字墙，之后轻轻漂浮
        const k = clamp(((t - C1) / T_BURST) * (1 + p.bDelay) - p.bDelay);
        if (!p.inHeart && k <= 0) continue;
        const e = easeOutQuart(k), er = easeOutCubic(k);
        const ia = clamp((t - C1 - 1) / 3);
        x = lerp(0, p.tx, e) + Math.sin(p.phase + t * 0.5) * 7 * ia;
        y = lerp(0, p.ty, e) + Math.cos(p.phase * 1.3 + t * 0.4) * 6 * ia;
        z = lerp(0, p.tz, e) + Math.sin(p.phase * 0.7 + t * 0.35) * 0.012 * F * ia;
        ry = p.tyaw * er + Math.sin(p.phase + t * 0.45) * 0.14 * ia;
        rx = p.tpitch * er + Math.cos(p.phase + t * 0.35) * 0.06 * ia;
        rz = p.troll * er;
        size = lerp(p.inHeart ? p.hSize * 0.45 : 5, p.tSize, er);
        alpha = !p.inHeart ? clamp(k * 5) : p.show ? 1 : 1 - clamp(k * 5);
        if (alpha <= 0.003) continue;
        neon = easeInOutCubic(clamp(k * 1.3));
      }

      // 颜色：爱心阶段是固定的粉色，炸开后过渡为发光的霓虹粉
      let cr = p.pc[0], cg = p.pc[1], cb = p.pc[2];
      let gr = cr, gg = cg, gb = cb, ga = 0;
      if (neon > 0) {
        const o = p.hb * 6;
        cr = lerp(cr, pal[o], neon); cg = lerp(cg, pal[o + 1], neon); cb = lerp(cb, pal[o + 2], neon);
        gr = pal[o + 3]; gg = pal[o + 4]; gb = pal[o + 5]; ga = neon;
        if (p.white) {                                 // 主角字：核心泛白、光晕更足
          const w = p.white * neon;
          cr = lerp(cr, 1, w); cg = lerp(cg, 0.96, w); cb = lerp(cb, 1, w);
          ga = neon * 1.25;
        }
        alpha *= 1 - 0.16 * neon * (0.5 + 0.5 * Math.sin(p.phase * 2 + t * 1.5));   // 轻微闪烁，像霓虹灯在呼吸
      }
      const spr = flat ? p.sprF : p.spr;
      const sc = size / atlas.font;
      pushQuad(x, y, z, spr.w * sc / 2, spr.h * sc / 2, ry, rx, rz, spr, cr, cg, cb, alpha, gr, gg, gb, ga, fadeAmt);
    }

    // ---------- 光点 & 柔光爱心（炸开后淡入） ----------
    if (t > C1 + 0.4) {
      const ap = clamp((t - C1 - 0.6) / 2.5), e = easeOutQuart(clamp((t - C1) / T_BURST));
      for (const p of dusts) {
        const tw = 0.6 + 0.4 * Math.sin(p.phase + t * 1.6);
        const x = p.tx * e + Math.sin(p.phase + t * 0.3) * 14, y = p.ty * e + Math.cos(p.phase + t * 0.25) * 12, z = p.tz * e;
        const s = p.size / 2;
        pushQuad(x, y, z, s, s, 0, 0, 0, atlas.map.dot, 1, 0.92, 1, p.a0 * tw * ap, 0, 0, 0, 1, fadeAmt);
      }
      for (const p of hearts) {
        const x = p.tx * e + Math.sin(p.phase + t * 0.3) * 18, y = p.ty * e + Math.cos(p.phase + t * 0.22) * 14, z = p.tz * e;
        const s = p.size / 2 * (1 + 0.05 * Math.sin(p.phase + t * 1.8));
        const spr = atlas.map.heart;
        pushQuad(x, y, z, s, s * spr.h / spr.w, Math.sin(p.phase + t * 0.5) * 0.35, Math.cos(p.phase + t * 0.4) * 0.2, Math.sin(p.phase + t * 0.3) * 0.2,
          spr, heartCol[0], heartCol[1], heartCol[2], p.a0 * ap, 0, 0, 0, 1, fadeAmt);
      }
    }

    // ---------- 提交绘制（由远到近排序，保证半透明叠加正确） ----------
    if (!flat) ids.sort((a, b) => depth[b] - depth[a]);
    for (let i = 0; i < ids.length; i++) {
      const b = ids[i] * 4, o = i * 6;
      idata[o] = b; idata[o + 1] = b + 1; idata[o + 2] = b + 2; idata[o + 3] = b; idata[o + 4] = b + 2; idata[o + 5] = b + 3;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (ids.length) {
      gl.bindTexture(gl.TEXTURE_2D, atlas.tex);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vdata.subarray(0, nq * 4 * FLOATS));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, idata.subarray(0, ids.length * 6));
      gl.drawElements(gl.TRIANGLES, ids.length * 6, gl.UNSIGNED_SHORT, 0);
    }

    updatePen(t);

    canvas.className = t > C1 + 1 ? (pointers.size ? 'grabbing' : 'grab') : '';
  }

  /* ===================== 尺寸 / 启动 / 交互 ===================== */
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    F = H * 0.5 / Math.tan(FOV / 2);
    FZ = F * zoom; D = F;
  }

  function start() {
    cancelAnimationFrame(rafId);
    bgDark.classList.remove('on');
    bgLight.classList.remove('off'); bgLight.classList.add('on');   // 画爱心阶段的粉色柔光背景淡入
    clearTimeout(start.lightTimer); clearTimeout(start.fxTimer);
    for (const id of ['flash']) $(id).classList.remove('go');
    yaw = pitch = vYaw = vPitch = 0; zoom = zoomTarget = 1; pointers.clear();
    resize();
    if (!atlasGlow) { fitMessages(); atlasGlow = buildAtlas(GLOW_FONT, 40, true); atlasFlat = buildAtlas(FLAT_FONT, 4, false); }
    build();
    startTime = lastNow = performance.now();
    running = true;
    rafId = requestAnimationFrame(frame);
    // 炸开的瞬间让背景由白渐变为深色
    clearTimeout(start.bgTimer);
    start.bgTimer = setTimeout(() => bgDark.classList.add('on'), (C1 + 0.1) * 1000);
    // 汇聚到点的瞬间：闪光 + 冲击波
    start.fxTimer = setTimeout(() => { for (const id of ['flash']) $(id).classList.add('go'); }, (C1 - 0.05) * 1000);
    // 深色背景完全盖住之后，把浅色背景层停掉（省性能）
    start.lightTimer = setTimeout(() => bgLight.classList.add('off'), (C1 + 0.1 + 2.4) * 1000);
  }

  // —— 背景音乐：点击“确定”（用户手势）后自动播放，循环 ——
  const bgm = new Audio(BGM_URL);
  bgm.loop = true; bgm.preload = 'auto'; bgm.volume = 0.8;
  function playBgm() {
    const r = bgm.play();
    if (r && r.catch) r.catch(err => console.warn('背景音乐播放失败：', err));
  }

  $('ok').addEventListener('click', () => {
    playBgm();
    mask.classList.add('hide');
    setTimeout(() => mask.classList.add('gone'), 600);   // 渐隐后彻底移除，不再参与合成
    start();
  });
  // —— 单指拖动 = 倾斜；双指拉伸 = 缩放（鼠标 / 触摸 / 触控笔通用）——
  const pointers = new Map();
  let pinchDist = 0, lastMoveT = 0;
  const canInteract = () => running && (performance.now() - startTime) / 1000 > C1 + 1;
  const pinchDistance = () => { const a = [...pointers.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };

  canvas.addEventListener('pointerdown', e => {
    if (!canInteract()) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    vYaw = vPitch = 0; lastMoveT = e.timeStamp;
    if (pointers.size === 2) pinchDist = pinchDistance();
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size >= 2) {
      const d = pinchDistance();
      if (pinchDist > 0) zoomTarget = clamp(zoomTarget * d / pinchDist, ZOOM_MIN, ZOOM_MAX);
      pinchDist = d;
    } else {
      const k = 0.0055, dts = Math.max(0.008, (e.timeStamp - lastMoveT) / 1000);
      yaw += dx * k; pitch = clamp(pitch - dy * k, -1.25, 1.25);
      vYaw = clamp(lerp(vYaw, dx * k / dts, 0.5), -3, 3);
      vPitch = clamp(lerp(vPitch, -dy * k / dts, 0.5), -3, 3);
      lastMoveT = e.timeStamp;
    }
  });
  const endPointer = e => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (pointers.size >= 2) pinchDist = pinchDistance();
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', e => {
    if (!canInteract()) return;
    e.preventDefault();
    zoomTarget = clamp(zoomTarget * (e.deltaY > 0 ? 0.92 : 1.08), ZOOM_MIN, ZOOM_MAX);
  }, { passive: false });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!running) { resize(); return; }
      const elapsed = performance.now() - startTime;
      resize(); build();
      startTime = performance.now() - elapsed;
    }, 150);
  });

  resize();
  allocBuffers(1);
  // 暴露给调试用（不影响正常使用）
  window.__heart = {
    get t() { return (performance.now() - startTime) / 1000; },
    timeline: { A1, B1, C1, D1 },
    set(y, p, z) { yaw = y; pitch = p; zoomTarget = z; }
  };
})();




