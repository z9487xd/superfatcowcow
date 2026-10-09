/* 超肥牛牛 ── 操作台 UI (canvas 渲染 + 操作流程) */
(function () {
  'use strict';
  var E = window.SFCC_ENGINE, CFG = window.SFCC_CONFIG;
  var IS_PROJECTOR = /[?&]mode=projector/.test(location.search);

  var G = {
    state: null,
    undo: [],
    roundStartSnap: null,
    pure: false,
    projectorWin: null,
    anim: null,             // {cowCell, highlight:[]}
    declare: null,          // {activeCard:null, poison:false}  剩餘牌一律從 E.remainingCards(state) 取, 不在 UI 另存
    wizardState: null,
    flipSel: {}             // playerId -> [cards]
  };

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('map'), ctx = canvas.getContext('2d');

  var DEV_LABEL = { sample_box: '樣本箱', silencer: '消音器', decoy: '誘餌槽', echo: '回聲器' };
  var DEV_ICON = { sample_box: '🧪', silencer: '🔇', decoy: '🍖', echo: '📡' };
  var DEV_TINT = { sample_box: '#1f6f5c', silencer: '#2f5580', decoy: '#8a4a22', echo: '#6a3a99' };
  var FAC_LABEL = { breeder: '飼養者', butcher: '屠夫', runner: '逃亡者' };
  var FAC_COLOR = { breeder: ['#5ef0cf', '#1aa386'], butcher: ['#ff8a96', '#d23246'], runner: ['#86bcff', '#2a6fd6'] };
  var CARD_LABEL = { move: '移動', env: '環境', interact: '互動', lure: '誘導', reset: '重製' };
  var CARD_ICON = { move: '👣', env: '🧱', interact: '✋', lure: '📣', reset: '🔄' };
  var FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif';
  var EMOJI = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

  // ================= 渲染 (操作台與投影共用) =================
  // 版面幾何 (drawMap 與點擊換算共用, 保證一致)
  function boardGeom(W, H, N) {
    var pad = Math.round(Math.min(W, H) * 0.035);
    var cs = (Math.min(W, H) - pad * 2) / N;
    return { cs: cs, ox: (W - cs * N) / 2, oy: (H - cs * N) / 2 };
  }

  function font(px, weight) { return (weight || 700) + ' ' + Math.max(8, Math.round(px)) + 'px ' + FONT; }
  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function badge(c, x, y, h, text, bg, fg, align) {
    c.font = font(h * 0.62, 800);
    var w = c.measureText(text).width + h * 0.6;
    var bx = align === 'right' ? x - w : x;
    rrect(c, bx, y, w, h, h / 2); c.fillStyle = bg; c.fill();
    c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, bx + w / 2, y + h / 2 + h * 0.03);
    return w;
  }

  // 噪點熱度: 暗石板 → 琥珀 → 磚紅; 毒: 暗 → 紫  (壓低彩度, 讓數字與棋子跳出來)
  function heatColor(t, poison) {
    if (poison) return lerpColor([36, 30, 54], [112, 56, 170], t);
    if (t < 0.5) return lerpColor([32, 38, 50], [104, 74, 40], t * 2);
    return lerpColor([104, 74, 40], [146, 50, 42], (t - 0.5) * 2);
  }

  function drawMap(cv, state, opts) {
    opts = opts || {};
    var c = cv.getContext('2d');
    var W = cv.width, H = cv.height, N = state.N;
    var g = boardGeom(W, H, N), cs = g.cs, ox = g.ox, oy = g.oy;
    var gap = cs * 0.035, tr = cs * 0.06;        // 房間間距、圓角
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);

    // 底座: 外框陰影 + 深色地板
    var bx0 = ox - gap, by0 = oy - gap, bw0 = cs * N + gap * 2;
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = cs * 0.3; c.shadowOffsetY = cs * 0.06;
    rrect(c, bx0 - cs * 0.04, by0 - cs * 0.04, bw0 + cs * 0.08, bw0 + cs * 0.08, tr * 2);
    var frameG = c.createLinearGradient(0, by0, 0, by0 + bw0);
    frameG.addColorStop(0, '#2c3546'); frameG.addColorStop(1, '#1a202b');
    c.fillStyle = frameG; c.fill();
    c.restore();
    rrect(c, bx0, by0, bw0, bw0, tr * 1.4);
    c.fillStyle = '#0a0d13'; c.fill();

    var maxNoise = 1;
    for (var i = 0; i < state.rooms.length; i++) if (state.rooms[i].noise > maxNoise) maxNoise = state.rooms[i].noise;
    var scale = Math.max(10, maxNoise);
    var cowCell = opts.cowCell != null ? opts.cowCell : state.cow.cell;
    var late = []; // 噪點數字最後才畫, 不被預告線/準星蓋住

    // ---- 房間 ----
    for (var r = 0; r < N; r++) for (var cc = 0; cc < N; cc++) {
      var idx = r * N + cc, room = state.rooms[idx];
      var x = ox + cc * cs + gap, y = oy + r * cs + gap, w = cs - gap * 2;
      var t = room.noise > 0 ? Math.min(1, 0.15 + room.noise / scale) : 0;

      rrect(c, x, y, w, w, tr);
      if (room.noise > 0) {
        var hg = c.createRadialGradient(x + w / 2, y + w * 0.42, w * 0.08, x + w / 2, y + w / 2, w * 0.78);
        hg.addColorStop(0, heatColor(Math.min(1, t * 1.12), room.poison));
        hg.addColorStop(1, heatColor(t * 0.55, room.poison));
        c.fillStyle = hg;
      } else {
        var fg = c.createLinearGradient(0, y, 0, y + w);
        fg.addColorStop(0, '#1d2431'); fg.addColorStop(1, '#161b25');
        c.fillStyle = fg;
      }
      c.fill();
      // 木地板紋 (很淡, 只給質感)
      c.save(); rrect(c, x, y, w, w, tr); c.clip();
      c.strokeStyle = 'rgba(255,255,255,0.028)'; c.lineWidth = Math.max(1, cs * 0.006);
      for (var pk = 1; pk < 4; pk++) { c.beginPath(); c.moveTo(x, y + w * pk / 4); c.lineTo(x + w, y + w * pk / 4); c.stroke(); }
      c.strokeStyle = 'rgba(255,255,255,0.05)'; c.lineWidth = Math.max(1, cs * 0.008);
      c.beginPath(); c.moveTo(x + tr, y + 1); c.lineTo(x + w - tr, y + 1); c.stroke(); // 上緣受光
      c.restore();
      if (room.device) { rrect(c, x, y, w, w, tr); c.lineWidth = Math.max(1.5, cs * 0.014); c.strokeStyle = DEV_TINT[room.device]; c.stroke(); }
      if (room.poison && room.noise > 0) { // 毒: 細斜紋
        c.save(); rrect(c, x, y, w, w, tr); c.clip();
        c.strokeStyle = 'rgba(220,170,255,0.12)'; c.lineWidth = cs * 0.025;
        for (var sx = -w; sx < w; sx += cs * 0.12) { c.beginPath(); c.moveTo(x + sx, y + w); c.lineTo(x + sx + w, y); c.stroke(); }
        c.restore();
      }
      if (opts.legalCells && opts.legalCells.indexOf(idx) >= 0) {
        rrect(c, x, y, w, w, tr); c.fillStyle = 'rgba(58,208,122,0.16)'; c.fill();
        c.lineWidth = Math.max(2, cs * 0.022); c.strokeStyle = 'rgba(90,240,150,0.9)';
        rrect(c, x + 2, y + 2, w - 4, w - 4, tr * 0.8); c.stroke();
      }
      if (opts.highlight && opts.highlight.indexOf(idx) >= 0) { rrect(c, x, y, w, w, tr); c.fillStyle = 'rgba(255,50,60,0.4)'; c.fill(); }
      if (room.isExit) {
        c.save(); rrect(c, x, y, w, w, tr); c.clip();
        c.fillStyle = 'rgba(255,216,77,0.09)';
        for (var hz = -w; hz < w * 1.2; hz += cs * 0.16) { c.beginPath(); c.moveTo(x + hz, y + w); c.lineTo(x + hz + cs * 0.08, y + w); c.lineTo(x + hz + w + cs * 0.08, y); c.lineTo(x + hz + w, y); c.closePath(); c.fill(); }
        c.restore();
        c.save(); c.shadowColor = '#ffd84d'; c.shadowBlur = cs * 0.1;
        c.lineWidth = Math.max(2, cs * 0.025); c.strokeStyle = '#ffd84d';
        rrect(c, x + cs * 0.015, y + cs * 0.015, w - cs * 0.03, w - cs * 0.03, tr * 0.8); c.stroke();
        c.restore();
      }

      // 上排: 裝置 (左) / 出口或座標 (右)
      var th = cs * 0.105, ty0 = y + cs * 0.075;
      c.textBaseline = 'middle';
      var devRight = x + cs * 0.05;
      if (room.device) {
        var dtxt = DEV_LABEL[room.device] + (room.device === 'sample_box' ? ' ' + room.boxRemaining : '');
        if (room.isExit) dtxt = room.device === 'sample_box' ? String(room.boxRemaining) : ''; // 擠不下就只留圖示
        var empty = room.device === 'sample_box' && !room.boxRemaining;
        c.font = font(th * 0.8, 700);
        var tagH = th * 1.25, tagX = x + cs * 0.035, tagY = ty0 - tagH / 2;
        var tagW = tagH * 1.05 + (dtxt ? c.measureText(dtxt).width + tagH * 0.35 : 0);
        rrect(c, tagX, tagY, tagW, tagH, tagH * 0.32);
        c.fillStyle = empty ? 'rgba(90,30,38,0.92)' : DEV_TINT[room.device]; c.fill();
        c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.18)'; c.stroke();
        c.textAlign = 'left';
        c.font = Math.round(th * 0.85) + 'px ' + EMOJI; c.fillText(DEV_ICON[room.device], tagX + tagH * 0.16, ty0 + 1);
        c.font = font(th * 0.8, 700);
        c.fillStyle = empty ? '#ffb3bb' : '#ffffff';
        if (dtxt) c.fillText(dtxt, tagX + tagH * 1.05, ty0 + 1);
        devRight = tagX + tagW;
      }
      if (room.isExit) badge(c, x + w - cs * 0.04, ty0 - th * 0.55, th * 1.1, '出口', '#ffd84d', '#2a2000', 'right');
      else if (!room.device) {
        c.fillStyle = 'rgba(150,170,195,0.38)'; c.font = font(cs * 0.075, 600);
        c.textAlign = 'right'; c.fillText(E.cellName(idx, N), x + w - cs * 0.05, ty0);
      }

      // 中央: 噪點數字 (牛在此格時改到右上角小徽章, 避免被牛蓋住)
      var cyMid = y + w * 0.42;
      if (room.noise > 0) late.push((function (room, idx, x, y, w, cyMid) { return function () {
        c.textAlign = 'center'; c.textBaseline = 'middle';
        if (idx === cowCell) badge(c, x + w - cs * 0.04, y + cs * 0.2, cs * 0.14, (room.poison ? '☣' : '') + room.noise, room.poison ? '#7d3cc7' : '#b2491c', '#fff', 'right');
        else {
          softText(c, String(room.noise), x + w / 2, cyMid, cs * 0.23, room.poison ? '#f0d9ff' : '#ffffff', 800);
          if (room.poison) softText(c, '☣ 毒', x + w / 2, cyMid + cs * 0.17, cs * 0.085, '#e2b8ff', 700);
        }
      }; })(room, idx, x, y, w, cyMid));
      // 屍體 (左) / 掉落樣本 (右)
      if (room.corpses > 0) {
        c.textAlign = 'left'; c.textBaseline = 'middle';
        c.font = Math.round(cs * 0.11) + 'px ' + EMOJI; c.fillText('💀', x + cs * 0.05, cyMid);
        if (room.corpses > 1) softText(c, '×' + room.corpses, x + cs * 0.2, cyMid, cs * 0.08, '#ffb3bb', 700);
      }
      if (room.dropped > 0) badge(c, x + w - cs * 0.04, cyMid - cs * 0.06, cs * 0.12, '◈' + room.dropped, '#1b6b48', '#c8ffe0', 'right');
    }

    // ---- 牆 ----
    var wallW = Math.max(3, cs * 0.045);
    function wallSeg(x1, y1, x2, y2) {
      c.save();
      c.lineCap = 'round';
      c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = wallW; c.shadowOffsetY = wallW * 0.3;
      c.strokeStyle = '#3b3326'; c.lineWidth = wallW + Math.max(2, wallW * 0.5);
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      c.restore();
      c.lineCap = 'round'; c.strokeStyle = '#efe4c9'; c.lineWidth = wallW;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      c.fillStyle = '#c9b48a';
      [[x1, y1], [x2, y2]].forEach(function (pt) { c.beginPath(); c.arc(pt[0], pt[1], wallW * 0.62, 0, Math.PI * 2); c.fill(); });
    }
    for (var rr = 0; rr < N; rr++) for (var col = 0; col < N; col++) {
      var id2 = rr * N + col, x2 = ox + col * cs, y2 = oy + rr * cs;
      if (col + 1 < N && state.walls.has(E.edgeKey(id2, id2 + 1))) wallSeg(x2 + cs, y2 + gap, x2 + cs, y2 + cs - gap);
      if (rr + 1 < N && state.walls.has(E.edgeKey(id2, id2 + N))) wallSeg(x2 + gap, y2 + cs, x2 + cs - gap, y2 + cs);
    }
    c.lineWidth = Math.max(3, cs * 0.032); c.strokeStyle = '#8a7a5c';
    rrect(c, ox - gap, oy - gap, cs * N + gap * 2, cs * N + gap * 2, tr * 1.4); c.stroke();
    c.lineWidth = 1; c.strokeStyle = 'rgba(255,240,210,0.25)';
    rrect(c, ox - gap + c.lineWidth * 2, oy - gap + 2, cs * N + gap * 2 - 4, cs * N + gap * 2 - 4, tr * 1.3); c.stroke();

    if (opts.wallCells && opts.actorCell != null) {
      for (var wi = 0; wi < opts.wallCells.length; wi++) drawEdgeHighlight(c, state, opts.actorCell, opts.wallCells[wi], ox, oy, cs, N);
    }

    // ---- 預告線 / 牛路徑 ----
    var pv = opts.previewOverride !== undefined ? opts.previewOverride : state.preview;
    if (pv && pv.path && !opts.hidePreview && !pv.stay) {
      if (pv.splashCells) for (var s = 0; s < pv.splashCells.length; s++) {
        var sp = E.rc(pv.splashCells[s], N);
        rrect(c, ox + sp.c * cs + gap, oy + sp.r * cs + gap, cs - gap * 2, cs - gap * 2, tr);
        c.fillStyle = 'rgba(255,60,60,0.14)'; c.fill();
      }
      if (pv.target != null) {
        var tp = E.rc(pv.target, N), tx = ox + tp.c * cs + cs / 2, tyy = oy + tp.r * cs + cs / 2;
        c.strokeStyle = 'rgba(255,80,80,0.9)'; c.lineWidth = Math.max(2, cs * 0.02);
        c.setLineDash(pv.reached ? [] : [cs * 0.05, cs * 0.04]);
        c.beginPath(); c.arc(tx, tyy, cs * 0.36, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
        for (var q = 0; q < 4; q++) {
          var ang = q * Math.PI / 2;
          c.beginPath(); c.moveTo(tx + Math.cos(ang) * cs * 0.3, tyy + Math.sin(ang) * cs * 0.3);
          c.lineTo(tx + Math.cos(ang) * cs * 0.42, tyy + Math.sin(ang) * cs * 0.42); c.stroke();
        }
      }
      if (pv.path.length > 1) {
        var pts = pv.path.map(function (pc) { var pp = E.rc(pc, N); return [ox + pp.c * cs + cs / 2, oy + pp.r * cs + cs / 2]; });
        c.save();
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.shadowColor = 'rgba(255,40,40,0.8)'; c.shadowBlur = cs * 0.08;
        c.strokeStyle = 'rgba(255,70,70,0.95)'; c.lineWidth = Math.max(3, cs * 0.035);
        c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
        for (var p = 1; p < pts.length; p++) c.lineTo(pts[p][0], pts[p][1]);
        c.stroke();
        c.restore();
        c.fillStyle = '#fff';
        for (var a = 1; a < pts.length; a++) {
          var mx = (pts[a - 1][0] + pts[a][0]) / 2, my = (pts[a - 1][1] + pts[a][1]) / 2;
          var an = Math.atan2(pts[a][1] - pts[a - 1][1], pts[a][0] - pts[a - 1][0]), ah = cs * 0.06;
          c.beginPath();
          c.moveTo(mx + Math.cos(an) * ah, my + Math.sin(an) * ah);
          c.lineTo(mx + Math.cos(an + 2.5) * ah, my + Math.sin(an + 2.5) * ah);
          c.lineTo(mx + Math.cos(an - 2.5) * ah, my + Math.sin(an - 2.5) * ah);
          c.closePath(); c.fill();
        }
        var last = pts[pts.length - 1];
        c.fillStyle = '#ff3b3b'; c.beginPath(); c.arc(last[0], last[1], cs * 0.05, 0, Math.PI * 2); c.fill();
        c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();
      }
    }

    late.forEach(function (f) { f(); });

    // ---- 玩家名牌 (同格由下往上排, 一行放不下就換行、再不夠就縮字) ----
    var byCell = {};
    for (var pi = 0; pi < state.players.length; pi++) {
      var pl = state.players[pi];
      if (pl.leftGame) continue;
      (byCell[pl.cell] = byCell[pl.cell] || []).push(pl);
    }
    for (var key in byCell) {
      var base = E.rc(Number(key), N);
      layoutTokens(c, byCell[key], ox + base.c * cs + gap, oy + base.r * cs + gap, cs - gap * 2, cs, opts.currentActorId);
    }

    // ---- 牛 ----
    var cp2 = E.rc(cowCell, N);
    drawCow(c, ox + cp2.c * cs + cs / 2, oy + cp2.r * cs + cs * 0.42, cs, state.cow.fatness, state.cow.doses.length);
  }

  // 淡陰影文字 (取代粗黑描邊)
  function softText(c, txt, x, y, px, fill, weight) {
    c.save();
    c.font = font(px, weight || 800);
    c.shadowColor = 'rgba(0,0,0,0.65)'; c.shadowBlur = px * 0.18; c.shadowOffsetY = px * 0.05;
    c.fillStyle = fill; c.fillText(txt, x, y);
    c.restore();
  }

  function tokenLabel(plr) { return plr.name + (plr.samples > 0 ? ' ◈' + plr.samples : ''); }
  function layoutTokens(c, arr, x, y, w, cs, actorId) {
    var pad = cs * 0.04, gapX = cs * 0.025, maxW = w - pad * 2;
    for (var fs = cs * 0.095; fs >= cs * 0.065; fs *= 0.92) {
      var h = fs * 1.55, rows = [[]], rowW = [0];
      c.font = font(fs, 700);
      var widths = arr.map(function (p) { return Math.min(maxW, c.measureText(tokenLabel(p)).width + fs * 0.9); });
      for (var i = 0; i < arr.length; i++) {
        var ri = rows.length - 1;
        if (rows[ri].length && rowW[ri] + gapX + widths[i] > maxW) { rows.push([]); rowW.push(0); ri++; }
        rowW[ri] += (rows[ri].length ? gapX : 0) + widths[i]; rows[ri].push(i);
      }
      var totalH = rows.length * h + (rows.length - 1) * cs * 0.02;
      if (totalH <= w * 0.5 || fs * 0.92 < cs * 0.065) {
        var yy = y + w - pad - totalH;
        rows.forEach(function (row, ri2) {
          var xx = x + (w - rowW[ri2]) / 2;
          row.forEach(function (k) { drawToken(c, arr[k], xx, yy, widths[k], h, fs, arr[k].id === actorId); xx += widths[k] + gapX; });
          yy += h + cs * 0.02;
        });
        return;
      }
    }
  }
  function drawToken(c, plr, x, y, w, h, fs, isTurn) {
    var col = FAC_COLOR[plr.faction] || ['#ccc', '#888'];
    c.save();
    if (isTurn) { c.shadowColor = '#ffc83d'; c.shadowBlur = h * 0.8; rrect(c, x - 2, y - 2, w + 4, h + 4, h / 2 + 2); c.fillStyle = '#ffc83d'; c.fill(); c.shadowBlur = 0; }
    rrect(c, x, y, w, h, h / 2);
    if (plr.echo) {
      c.fillStyle = 'rgba(10,14,20,0.85)'; c.fill();
      c.setLineDash([h * 0.22, h * 0.16]); c.lineWidth = Math.max(1.5, h * 0.08); c.strokeStyle = col[0]; c.stroke(); c.setLineDash([]);
    } else {
      c.fillStyle = col[1]; c.fill();
      c.lineWidth = Math.max(1, h * 0.06); c.strokeStyle = 'rgba(255,255,255,0.55)'; c.stroke();
    }
    c.restore();
    c.save(); rrect(c, x, y, w, h, h / 2); c.clip();
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = font(fs, 700);
    c.fillStyle = plr.echo ? col[0] : '#ffffff';
    c.fillText(tokenLabel(plr), x + w / 2, y + h / 2 + fs * 0.05);
    c.restore();
  }
  // 牛: 圓滾滾的乳牛頭身, 肥度越高越大顆; 中毒時臉發紫
  function drawCow(c, x, y, cs, fat, doses) {
    var R = cs * Math.min(0.32, 0.16 + fat * 0.019);
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath(); c.ellipse(x, y + R * 1.02, R * 0.95, R * 0.22, 0, 0, Math.PI * 2); c.fill();
    // 光暈
    var halo = c.createRadialGradient(x, y, R * 0.5, x, y, R * 1.6);
    halo.addColorStop(0, 'rgba(255,138,61,0.3)'); halo.addColorStop(1, 'rgba(255,138,61,0)');
    c.fillStyle = halo; c.beginPath(); c.arc(x, y, R * 1.6, 0, Math.PI * 2); c.fill();
    // 身體
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = R * 0.4; c.shadowOffsetY = R * 0.1;
    c.beginPath(); c.ellipse(x, y + R * 0.18, R * 1.05, R * 0.9, 0, 0, Math.PI * 2);
    c.fillStyle = doses ? '#efe2ff' : '#fbf7f0'; c.fill();
    c.shadowBlur = 0; c.shadowOffsetY = 0;
    // 斑點 (固定位置)
    c.save();
    c.beginPath(); c.ellipse(x, y + R * 0.18, R * 1.05, R * 0.9, 0, 0, Math.PI * 2); c.clip();
    c.fillStyle = '#2a2320';
    [[-0.7, 0.55, 0.38], [0.75, 0.35, 0.3], [0.2, 0.95, 0.25], [-0.15, -0.55, 0.2]].forEach(function (s) {
      c.beginPath(); c.ellipse(x + s[0] * R, y + s[1] * R, s[2] * R * 1.2, s[2] * R, 0.6, 0, Math.PI * 2); c.fill();
    });
    c.restore();
    c.lineWidth = Math.max(2, R * 0.06); c.strokeStyle = '#3a2a22';
    c.beginPath(); c.ellipse(x, y + R * 0.18, R * 1.05, R * 0.9, 0, 0, Math.PI * 2); c.stroke();
    // 角
    c.fillStyle = '#ffe2a8'; c.strokeStyle = '#3a2a22'; c.lineWidth = Math.max(1.5, R * 0.04);
    [-1, 1].forEach(function (sd) {
      c.beginPath();
      c.moveTo(x + sd * R * 0.45, y - R * 0.55);
      c.quadraticCurveTo(x + sd * R * 0.95, y - R * 0.75, x + sd * R * 0.85, y - R * 1.15);
      c.quadraticCurveTo(x + sd * R * 0.7, y - R * 0.8, x + sd * R * 0.3, y - R * 0.7);
      c.closePath(); c.fill(); c.stroke();
    });
    // 耳朵
    c.fillStyle = '#f2b8a8';
    [-1, 1].forEach(function (sd) {
      c.beginPath(); c.ellipse(x + sd * R * 0.98, y - R * 0.38, R * 0.28, R * 0.14, sd * 0.5, 0, Math.PI * 2); c.fill(); c.stroke();
    });
    // 眼睛
    c.fillStyle = '#1a1210';
    c.beginPath(); c.arc(x - R * 0.33, y - R * 0.18, R * 0.11, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(x + R * 0.33, y - R * 0.18, R * 0.11, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff';
    c.beginPath(); c.arc(x - R * 0.3, y - R * 0.22, R * 0.04, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(x + R * 0.36, y - R * 0.22, R * 0.04, 0, Math.PI * 2); c.fill();
    // 鼻子
    c.fillStyle = doses ? '#c79cf0' : '#ffa8b4';
    c.beginPath(); c.ellipse(x, y + R * 0.32, R * 0.55, R * 0.34, 0, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = '#7a3442';
    c.beginPath(); c.ellipse(x - R * 0.2, y + R * 0.32, R * 0.07, R * 0.1, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(x + R * 0.2, y + R * 0.32, R * 0.07, R * 0.1, 0, 0, Math.PI * 2); c.fill();
    c.restore();
    // 肥度徽章
    var bh = Math.max(12, cs * 0.12);
    c.font = font(bh * 0.66, 800);
    var label = '肥 ' + fat + (doses ? '  ☣' + doses : '');
    var bw = c.measureText(label).width + bh * 0.8;
    rrect(c, x - bw / 2, y + R * 1.02, bw, bh, bh / 2);
    c.fillStyle = doses ? '#7d3cc7' : '#ff8a3d'; c.fill();
    c.lineWidth = 1.5; c.strokeStyle = 'rgba(26,10,0,0.6)'; c.stroke();
    c.fillStyle = '#1a0a00'; if (doses) c.fillStyle = '#fff';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, x, y + R * 1.02 + bh / 2 + 1);
  }

  function drawEdgeHighlight(c, state, a, b, ox, oy, cs, N) {
    var pa = E.rc(a, N), pb = E.rc(b, N);
    var has = state.walls.has(E.edgeKey(a, b));
    var x1, y1, x2, y2;
    if (pb.c === pa.c + 1) { x1 = x2 = ox + (pa.c + 1) * cs; y1 = oy + pa.r * cs; y2 = y1 + cs; }
    else if (pb.c === pa.c - 1) { x1 = x2 = ox + pa.c * cs; y1 = oy + pa.r * cs; y2 = y1 + cs; }
    else if (pb.r === pa.r + 1) { y1 = y2 = oy + (pa.r + 1) * cs; x1 = ox + pa.c * cs; x2 = x1 + cs; }
    else { y1 = y2 = oy + pa.r * cs; x1 = ox + pa.c * cs; x2 = x1 + cs; }
    c.save();
    c.lineCap = 'round'; c.lineWidth = Math.max(5, cs * 0.06);
    c.shadowColor = has ? '#ff5050' : '#50e080'; c.shadowBlur = cs * 0.12;
    c.strokeStyle = has ? 'rgba(255,90,90,0.95)' : 'rgba(90,230,130,0.95)';
    c.setLineDash([cs * 0.12, cs * 0.08]);
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    c.restore();
    // 標示 拆 / 築
    badge(c, (x1 + x2) / 2 - cs * 0.07, (y1 + y2) / 2 - cs * 0.07, cs * 0.14, has ? '拆' : '築', has ? '#7a1f28' : '#1d6b3c', '#fff');
  }

  function lerpColor(a, b, t) {
    t = Math.max(0, Math.min(1, t));
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' + Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }

  // canvas 依容器大小與螢幕 DPR 調整解析度 (地圖永遠完整塞進可見區域)
  function fitCanvas() {
    var wrap = $('mapWrap');
    var w = wrap.clientWidth, h = wrap.clientHeight;
    var size = Math.max(200, Math.floor(Math.min(w, h) - 8));
    var dpr = window.devicePixelRatio || 1;
    var px = Math.round(size * dpr);
    if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
    canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  }

  // ================= 主渲染 =================
  function render() {
    if (!G.state) return;
    var st = G.state;
    skipEmptyActors(st);
    var opts = {};
    if (G.anim) { opts.cowCell = G.anim.cowCell; opts.highlight = G.anim.highlight; opts.hidePreview = true; }
    if (G.declare && G.declare.activeCard) applyTargetingOpts(opts);
    var actor = (st.phase === 'declare') ? E.currentActor(st) : null;
    if (actor) opts.currentActorId = actor.id;
    renderSidebar();
    renderControls();          // 控制列先排好, 地圖再依剩下的空間定尺寸
    fitCanvas();
    drawMap(canvas, st, opts);
    postToProjector(opts);
  }

  // 沒牌可宣告的人 (中途走出出口 / 舊存檔) 直接跳過, 絕不卡在宣告階段
  function skipEmptyActors(st) {
    if (st.phase !== 'declare') return;
    var actor = E.currentActor(st), moved = false;
    while (actor && E.remainingCards(st, actor.id).length === 0 && !transferMates(st, actor).length) { E.advanceActor(st); G.declare = null; moved = true; actor = E.currentActor(st); }
    if (!actor && st.phase === 'declare') st.phase = 'resolve';
    if (moved) autosave();
  }

  function applyTargetingOpts(opts) {
    var st = G.state, actor = E.currentActor(st);
    if (!actor) return;
    var card = G.declare.activeCard;
    if (card === 'move') { opts.legalCells = cellsWithin(actor.cell, 2); }
    else if (card === 'lure') { opts.legalCells = cellsWithin(actor.cell, 3); }
    else if (card === 'env') { opts.actorCell = actor.cell; opts.wallCells = legalEnvTargets(actor.cell); }
    else if (card === 'interact' && st.rooms[actor.cell].device === 'echo') { opts.legalCells = neighborCells(actor.cell); }
  }
  function cellsWithin(from, k) {
    var d = E.bfsDist(G.state, from), out = [];
    for (var i = 0; i < d.length; i++) if (d[i] <= k) out.push(i);
    return out;
  }
  function neighborCells(from) { return E.neighbors(from, G.state.N).map(function (n) { return n.cell; }); }

  // 飼養者免費交付 (v8): 輪到自己時, 同房間另一位活著的飼養者可以接收全部樣本
  // 同陣營交付 (v12): 輪到自己時, 同房間、同陣營、活著的隊友可以接收任意數量的樣本
  function transferMates(st, actor) {
    if (!actor || actor.dead || actor.leftGame || actor.samples < 1) return [];
    return st.players.filter(function (p) { return E.canTransfer(st, actor, p) && !p.dead && !p.leftGame && p.cell === actor.cell; });
  }

  function renderSidebar() {
    var st = G.state;
    $('roundNo').textContent = st.round + ' / ' + st.rounds;
    $('cowFat').textContent = st.cow.fatness + '/' + st.config.fatnessWin;
    $('cowSteps').textContent = st.cow.fatness + st.config.cowMoveBonus + (st.config.cowLateBonus && st.cow.fatness >= (st.config.cowLateFat || 5) ? st.config.cowLateBonus : 0);
    $('cowPoison').textContent = st.cow.doses.length + '/' + st.config.poisonDoseLimit;
    $('cowPoison').parentNode.title = st.cow.doses.length ? '各劑剩餘回合: ' + st.cow.doses.map(function (d) { return d.left; }).join(', ') : '';

    var bf = st.factions.breeder;
    $('progBreeder').textContent = bf.disqualified ? '失格 ✗'
      : st.config.breederWinAny === 2 ? '累計 ' + (bf.pool || 0) + '/' + E.breederPoolTarget(st) + (bf.won ? ' ✔勝' : '')
      : st.config.breederWinAny ? (bf.won ? '已達成 ✔勝' : breederLeader(st))
      : (bf.deadWithEnough + '/' + bf.total + ' 帶滿死亡' + (bf.won ? ' ✔勝' : ''));
    setBar('barBreeder', bf.won ? 1 : breederBest(st) / st.config.breederSampleThreshold);
    setBar('barButcher', st.cow.doses.length / st.config.poisonDoseLimit);
    $('progButcher').textContent = st.cow.doses.length + '/' + st.config.poisonDoseLimit + (st.factions.butcher.won ? ' ✔勝' : '');
    var runners = st.players.filter(function (p) { return p.faction === 'runner'; });
    var escaped = runners.filter(function (p) { return p.leftGame; }).length;
    $('progRunner').textContent = escaped + '/' + runners.length + ' 逃出' + (st.factions.runner.won ? ' ✔勝' : '') + ' · 門檻 ◈' + st.config.runnerSampleThreshold;
    setBar('barRunner', runners.length ? escaped / runners.length : 0);
    setBar('barRound', st.round / st.rounds);
    setBar('barFat', st.cow.fatness / st.config.fatnessWin);
    setBar('barPoison', st.cow.doses.length / st.config.poisonDoseLimit);

    // 隊列
    var q = $('queue'); q.innerHTML = '';
    if (st.phase === 'declare' && st.queue.length) {
      for (var i = 0; i < st.queue.length; i++) {
        var p = st.players[st.queue[i]];
        var span = document.createElement('span');
        span.className = 'qtag ' + (i < st.queueIndex ? 'done' : i === st.queueIndex ? 'now' : '');
        span.textContent = (i + 1) + '. ' + p.name + (p.echo ? '(殘)' : '');
        q.appendChild(span);
      }
    } else { q.innerHTML = '<span class="qtag">尚未進入宣告</span>'; }

    // 玩家
    var box = $('players'); box.innerHTML = '';
    var actor = st.phase === 'declare' ? E.currentActor(st) : null;
    st.players.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'pcard ' + p.faction + (p.echo ? ' dead' : '') + (actor && actor.id === p.id ? ' turn' : '');
      var fc = 'f-' + p.faction;
      var hand = p.echo ? ['move', 'lure', 'interact'].map(function (k) { return '<span class="chip ' + (p.echoUsed[k] ? 'used' : '') + '">' + CARD_LABEL[k] + '</span>'; }).join('')
        : Object.keys(p.hand).map(function (k) { return '<span class="chip ' + (p.hand[k] ? '' : 'used') + '">' + CARD_LABEL[k] + '</span>'; }).join('');
      d.innerHTML = '<div class="top"><span class="nm ' + fc + '">' + escapeHtml(p.name) + '</span>' +
        '<span class="pill bg-' + p.faction + '">' + FAC_LABEL[p.faction] + '</span>' +
        (p.echo ? '<span class="pill mute">殘響</span>' : '') +
        (p.leftGame ? '<span class="pill gone">已離場</span>' : '') + '</div>' +
        '<div class="meta"><span>📍' + E.cellName(p.cell, st.N) + '</span><span>◈' + p.samples + ' 樣本</span></div>' +
        '<div class="hand">' + hand + '</div>';
      d.querySelector('.nm').title = '點一下改名';
      d.querySelector('.nm').onclick = function () { startRename(d, p); };
      box.appendChild(d);
    });

    // 樣本箱
    var bx = $('boxes'); bx.innerHTML = '';
    st.rooms.forEach(function (room, idx) {
      if (room.device === 'sample_box') {
        var s = document.createElement('span'); s.className = 'chip' + (room.boxRemaining ? '' : ' empty');
        s.textContent = E.cellName(idx, st.N) + ': ' + room.boxRemaining;
        bx.appendChild(s);
      }
    });

    // 日誌
    var lg = $('log'); lg.innerHTML = '';
    var recent = st.log.slice(-120);
    for (var j = recent.length - 1; j >= 0; j--) {
      var line = document.createElement('div'); line.className = 'l';
      line.innerHTML = '<b>[' + recent[j].round + ']</b> ' + escapeHtml(recent[j].text);
      lg.appendChild(line);
    }
  }
  function breederBest(st) {
    return st.players.reduce(function (m, p) { return p.faction === 'breeder' && !p.dead && !p.leftGame ? Math.max(m, p.samples) : m; }, 0);
  }
  function breederLeader(st) {
    var best = null;
    st.players.forEach(function (p) { if (p.faction === 'breeder' && !p.dead && !p.leftGame && (!best || p.samples > best.samples)) best = p; });
    var need = st.config.breederSampleThreshold;
    return best ? best.name + ' ◈' + best.samples + '/' + need : '門檻 ◈' + need;
  }
  function setBar(id, frac) { var el = $(id); if (el) el.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; }

  function startRename(card, p) {
    var nm = card.querySelector('.nm');
    var inp = document.createElement('input'); inp.className = 'rename'; inp.maxLength = 8; inp.value = p.name;
    nm.replaceWith(inp); inp.focus(); inp.select();
    var done = false;
    function commit(save) {
      if (done) return; done = true;
      var v = inp.value.trim();
      if (save && v && v !== p.name) { pushUndo(); p.name = v; autosave(); }
      render();
    }
    inp.onkeydown = function (e) { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') { e.stopPropagation(); commit(false); } };
    inp.onblur = function () { commit(true); };
  }
  function escapeHtml(s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // 相位橫幅
  function banner(txt) { $('phaseBanner').textContent = txt; }

  // 建立一顆按鈕並掛上事件
  function addBtn(parent, label, cls, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  // ================= 控制列 (依相位) =================
  function renderControls() {
    var st = G.state, body = $('ctrlBody'), title = $('ctrlTitle'), hint = $('ctrlHint');
    body.innerHTML = '';
    $('controls').classList.toggle('hidden', G.pure);

    if (st.gameOver) { title.textContent = '遊戲結束'; hint.textContent = ''; banner('遊戲結束'); showEnd(); return; }

    if (st.phase === 'flip') {
      title.textContent = '第 ' + st.round + ' 回合 — 翻牌登錄';
      hint.textContent = '全場翻牌後，把出牌敲進去。';
      banner('第 ' + st.round + ' 回合 · 翻牌登錄');
      addBtn(body, '📝 開啟登錄面板', 'primary', openFlip);
    } else if (st.phase === 'declare') {
      var actor = E.currentActor(st);
      if (!actor) { st.phase = 'resolve'; renderControls(); return; }
      title.textContent = '宣告: ' + actor.name + ' (' + FAC_LABEL[actor.faction] + ')' + (actor.echo ? ' 殘響' : '');
      banner('依序宣告 · 輪到 ' + actor.name);
      renderDeclareControls(body, hint, actor);
    } else if (st.phase === 'resolve' || st.phase === 'resolved') {
      title.textContent = '第 ' + st.round + ' 回合 — 結算';
      hint.textContent = '所有人宣告完畢，執行噪點結算與牛的行動。';
      banner('結算 · 牛要動了');
      if (st.phase === 'resolve') addBtn(body, '🐂 結算並演出牛的行動', 'primary', doResolve);
      else {
        if (st.round >= st.rounds) addBtn(body, '查看結果', 'primary', showEnd);
        else addBtn(body, '▶ 進入第 ' + (st.round + 1) + ' 回合', 'primary', nextRound);
      }
    }
  }

  function renderDeclareControls(body, hint, actor) {
    var st = G.state;
    if (!G.declare) G.declare = { activeCard: null, poison: false };
    var dec = G.declare;
    var remaining = E.remainingCards(st, actor.id);
    var mates = transferMates(st, actor);
    if (dec.activeCard && remaining.indexOf(dec.activeCard) < 0) dec.activeCard = null;
    // 丟在地上: 選要丟幾個
    if (dec.giveTo === 'drop' && actor.samples > 0) {
      hint.textContent = '要丟幾個樣本在 ' + E.cellName(actor.cell, st.N) + '？（' + actor.name + ' 身上有 ' + actor.samples + ' 個；任何人打互動卡都能撿）';
      for (var d = 1; d <= actor.samples; d++) (function (n) {
        addBtn(body, (n === actor.samples ? '全部 ' : '') + '◈' + n, 'drop-btn', function () { doDrop(n); });
      })(d);
      addBtn(body, '取消', 'ghost', function () { dec.giveTo = null; render(); });
      return;
    }
    // 交付中: 選要給幾個
    var giveTo = dec.giveTo != null && mates.some(function (m) { return m.id === dec.giveTo; }) ? st.players[dec.giveTo] : null;
    if (giveTo) {
      hint.textContent = '要交給 ' + giveTo.name + ' 幾個樣本？（' + actor.name + ' 身上有 ' + actor.samples + ' 個）';
      for (var k = 1; k <= actor.samples; k++) (function (n) {
        addBtn(body, (n === actor.samples ? '全部 ' : '') + '◈' + n, 'give-btn', function () { doGive(giveTo.id, n); });
      })(k);
      addBtn(body, '取消', 'ghost', function () { dec.giveTo = null; render(); });
      return;
    }
    // 尚未宣告的卡
    remaining.forEach(function (card, i) {
      var b = addBtn(body, '', 'card-btn c-' + card + (dec.activeCard === card ? ' sel' : ''), function () {
        dec.activeCard = dec.activeCard === card ? null : card; dec.poison = false; render();
      });
      b.innerHTML = '<span class="k">' + (i + 1) + '</span><span class="ic">' + CARD_ICON[card] + '</span>' + CARD_LABEL[card];
    });
    // 交付: 不用出牌, 出牌前後都可以 (選牌設定目標時先藏起來)
    if (!dec.activeCard) mates.forEach(function (m) {
      var b = addBtn(body, '', 'give-btn', function () { dec.giveTo = m.id; render(); });
      b.innerHTML = '🤝 交付給 <b>' + escapeHtml(m.name) + '</b>';
      b.title = '把樣本交給同房間的隊友 (可以選數量；不用出牌、不加噪點)';
    });
    if (!dec.activeCard && st.config.dropAllowed && !actor.dead && !actor.leftGame && actor.samples > 0) {
      var db = addBtn(body, '⬇ 丟在地上', 'drop-btn', function () { dec.giveTo = 'drop'; render(); });
      db.title = '把樣本丟在所在房間 (可以選數量；不用出牌、不加噪點；任何人打互動卡都能撿)';
    }

    if (!remaining.length) {
      hint.textContent = '牌已出完。同房有隊友，可以把樣本交給他，或直接換下一位。';
      addBtn(body, '下一位 ▶', 'primary', doEndTurn);
      return;
    }
    if (!dec.activeCard) {
      hint.textContent = '點一張牌 (或按數字鍵) 開始設定目標。剩餘: ' + remaining.map(function (c) { return CARD_LABEL[c]; }).join('、') +
        (mates.length ? '。可以先交付樣本，也可以出完牌再交付。' : '');
      return;
    }
    var card = dec.activeCard;
    if (card === 'move') hint.textContent = '點綠色格移動 (最多 2 格；點自己所在格 = 原地不動)。';
    else if (card === 'lure') {
      hint.textContent = '點綠色範圍內一格製造噪點 (3 格內，可點自己)。';
      if (!actor.echo && actor.faction === 'butcher' && actor.samples > 0) {
        var lbl = document.createElement('label'); lbl.className = 'check';
        lbl.innerHTML = '<input type="checkbox" id="poisonChk"> ☣ 投入 1 樣本下毒';
        body.appendChild(lbl);
        $('poisonChk').checked = dec.poison;
        $('poisonChk').onchange = function () { dec.poison = this.checked; };
      }
    }
    else if (card === 'env') {
      var legal = legalEnvTargets(actor.cell);
      hint.textContent = legal.length
        ? '點相鄰房間切換那面牆 (紅「拆」/ 綠「築」)。造成封死或切斷地圖會被擋。'
        : '這個位置每一面牆都動不了 (拆不到、築了會封死或切斷地圖)。請按「作廢這張牌」。';
    }
    else if (card === 'interact') {
      var room = st.rooms[actor.cell];
      if (room.device === 'echo') hint.textContent = '回聲器: 點一個相鄰房間，把本房噪點複製過去。';
      else if (actor.echo) { hint.textContent = '殘響的互動只能操作回聲器。這裡沒有回聲器，沒有效果（仍 +1 噪點）。'; addBtn(body, '✔ 確認互動', 'primary', function () { doDeclare('interact', {}); }); }
      else { hint.textContent = '互動: ' + (room.device ? DEV_LABEL[room.device] : '本房沒有裝置 (無效，仍 +1 噪點)') + (room.dropped ? '，並撿起 ' + room.dropped + ' 個掉落樣本' : '') + '。'; addBtn(body, '✔ 確認互動', 'primary', function () { doDeclare('interact', {}); }); }
    }
    else if (card === 'reset') { hint.textContent = '重製: 回合末收回所有打出的牌，自己 +3 噪點。'; addBtn(body, '✔ 確認重製', 'primary', function () { doDeclare('reset', {}); }); }
    // 逃生門: 任何牌在現場都可能沒有合法目標 → 允許作廢, 不讓整場卡死
    addBtn(body, '✖ 作廢這張牌', 'danger', function () { doForfeit(card); });
  }

  // 環境卡: 目前位置真正合法的相鄰牆 (拆一定合法; 築要檢查封死/切斷)
  function legalEnvTargets(from) {
    var st = G.state, out = [];
    neighborCells(from).forEach(function (nb) {
      if (st.walls.has(E.edgeKey(from, nb))) { out.push(nb); return; }
      E.addWall(st, from, nb);
      var ok = !E.isSealed(st, from) && !E.isSealed(st, nb) && E.isConnected(st);
      E.removeWall(st, from, nb);
      if (ok) out.push(nb);
    });
    return out;
  }

  function finishCardStep() {
    var st = G.state, actor = E.currentActor(st);
    G.declare = actor ? { activeCard: null, poison: false } : null;
    if (actor && E.remainingCards(st, actor.id).length === 0 && !transferMates(st, actor).length) {
      E.advanceActor(st);
      G.declare = null;
      if (st.phase === 'resolve') banner('全員宣告完畢');
    }
    autosave();
    render();
  }

  function doDeclare(card, params) {
    var st = G.state, actor = E.currentActor(st);
    if (!actor) return;
    pushUndo();
    try {
      E.declareCard(st, actor.id, card, params);
    } catch (e) { G.undo.pop(); toast('不合法：' + e.message); return; }
    finishCardStep();
  }

  function doGive(toId, n) {
    var st = G.state, actor = E.currentActor(st);
    if (!actor) return;
    var to = st.players[toId];
    pushUndo();
    try { E.giveSamples(st, actor.id, toId, n); }
    catch (e) { G.undo.pop(); toast('不合法：' + e.message); return; }
    toast(actor.name + ' 把 ◈' + n + ' 交給 ' + to.name + '（現在 ◈' + to.samples + '）', true);
    if (G.declare) G.declare.giveTo = null;
    finishCardStep();
  }
  function doDrop(n) {
    var st = G.state, actor = E.currentActor(st);
    if (!actor) return;
    pushUndo();
    try { E.dropSamples(st, actor.id, n); }
    catch (e) { G.undo.pop(); toast('不合法：' + e.message); return; }
    toast(actor.name + ' 把 ◈' + n + ' 丟在 ' + E.cellName(actor.cell, st.N), true);
    if (G.declare) G.declare.giveTo = null;
    finishCardStep();
  }
  // 牌出完、選擇不交付 → 換下一位
  function doEndTurn() {
    var st = G.state, actor = E.currentActor(st);
    if (!actor || E.remainingCards(st, actor.id).length) return;
    pushUndo();
    E.advanceActor(st);
    G.declare = null;
    if (st.phase === 'resolve') banner('全員宣告完畢');
    autosave(); render();
  }

  function doForfeit(card) {
    var st = G.state, actor = E.currentActor(st);
    if (!actor) return;
    pushUndo();
    try { E.forfeitCard(st, actor.id, card); }
    catch (e) { G.undo.pop(); toast(e.message); return; }
    toast(actor.name + ' 的「' + CARD_LABEL[card] + '」已作廢', true);
    finishCardStep();
  }

  var toastTimer = null;
  function toast(msg, info) {
    var t = $('toast');
    t.textContent = msg; t.className = info ? 'info' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'hidden'; }, 3200);
  }

  // 地圖點擊
  canvas.addEventListener('click', function (ev) {
    if (!G.state || G.state.phase !== 'declare' || !G.declare || !G.declare.activeCard || G.anim) return;
    var cellIdx = clickToCell(ev);
    if (cellIdx == null) return;
    var st = G.state, actor = E.currentActor(st), card = G.declare.activeCard;
    if (card === 'move') doDeclare('move', { dest: cellIdx });
    else if (card === 'lure') doDeclare('lure', { target: cellIdx, poison: G.declare.poison });
    else if (card === 'env') {
      if (!E.areAdjacent(actor.cell, cellIdx, st.N)) { toast('請點自己房間的相鄰房間'); return; }
      var op = st.walls.has(E.edgeKey(actor.cell, cellIdx)) ? 'remove' : 'add';
      doDeclare('env', { wallCell: cellIdx, op: op });
    }
    else if (card === 'interact' && st.rooms[actor.cell].device === 'echo') {
      if (!E.areAdjacent(actor.cell, cellIdx, st.N)) { toast('回聲器需點相鄰房間'); return; }
      doDeclare('interact', { echoTarget: cellIdx });
    }
  });

  function clickToCell(ev) {
    var rect = canvas.getBoundingClientRect();
    var x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    var y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    var N = G.state.N, g = boardGeom(canvas.width, canvas.height, N);
    var c = Math.floor((x - g.ox) / g.cs), r = Math.floor((y - g.oy) / g.cs);
    if (r < 0 || c < 0 || r >= N || c >= N) return null;
    return r * N + c;
  }

  // ================= 結算 + 牛逐格動畫 =================
  function doResolve() {
    var st = G.state;
    pushUndo();
    var startCell = st.cow.cell;
    var mv = E.resolveRound(st);
    autosave();
    if (mv && mv.path && mv.path.length > 1) animateCow(startCell, mv, function () { afterResolve(mv); });
    else { render(); afterResolve(mv); }
  }
  function animateCow(startCell, mv, done) {
    var i = 0, path = mv.path;
    G.anim = { cowCell: path[0], highlight: [] };
    render();
    var timer = setInterval(function () {
      if (!G.anim) { clearInterval(timer); return; } // 動畫中被復原
      i++;
      if (i >= path.length) {
        clearInterval(timer);
        // 波及一次亮
        G.anim = { cowCell: path[path.length - 1], highlight: mv.killedCells.slice() };
        render();
        setTimeout(function () { if (!G.anim) return; G.anim = null; render(); done(); }, 700);
        return;
      }
      G.anim.cowCell = path[i];
      G.anim.highlight = [path[i]];
      render();
    }, 600);
  }
  function afterResolve(mv) {
    var st = G.state;
    if (st.gameOver) { render(); showEnd(); return; }
    render();
  }
  function nextRound() {
    var st = G.state;
    pushUndo();
    E.startRound(st);
    G.roundStartSnap = E.snapshot(st);
    G.declare = null;
    autosave();
    render();
    openFlip();
  }

  // ================= 翻牌登錄 =================
  function openFlip() {
    var st = G.state; if (st.phase !== 'flip') return;
    $('flipTitle').textContent = '第 ' + st.round + ' 回合 — 翻牌登錄';
    G.flipSel = {};
    var grid = $('flipGrid');
    var cards = ['move', 'env', 'interact', 'lure', 'reset'];
    var html = '<tr><th>玩家</th>' + cards.map(function (c) { return '<th>' + CARD_LABEL[c] + '</th>'; }).join('') + '<th>需/已</th></tr>';
    st.players.forEach(function (p) {
      if (p.leftGame) return;
      var need = E.expectedCardCount(st, p);
      var avail = E.handList(p);
      html += '<tr data-pid="' + p.id + '"' + (need === 0 ? ' class="done"' : '') + '><td><b>' + escapeHtml(p.name) + '</b> <span class="pill bg-' + p.faction + '">' + FAC_LABEL[p.faction] + '</span>' + (p.echo ? ' <span class="pill mute">殘響</span>' : '') + '</td>';
      cards.forEach(function (c) {
        if (avail.indexOf(c) >= 0) html += '<td><button class="cbtn" data-pid="' + p.id + '" data-card="' + c + '">' + CARD_ICON[c] + ' ' + CARD_LABEL[c] + '</button></td>';
        else html += '<td><span style="opacity:.2">—</span></td>';
      });
      html += '<td><span class="need" data-pid="' + p.id + '">0/' + need + '</span></td></tr>';
      G.flipSel[p.id] = [];
    });
    grid.innerHTML = html;
    Array.prototype.forEach.call(grid.querySelectorAll('.cbtn'), function (b) {
      b.onclick = function () { toggleFlip(Number(b.dataset.pid), b.dataset.card, b); };
    });
    updateFlipDone();
    $('flipOverlay').classList.remove('hidden');
  }
  function toggleFlip(pid, card, btn) {
    var st = G.state, p = st.players[pid];
    var need = E.expectedCardCount(st, p);
    var sel = G.flipSel[pid];
    var at = sel.indexOf(card);
    if (at >= 0) { sel.splice(at, 1); btn.classList.remove('on'); }
    else {
      if (sel.length >= need) { return; } // 已達張數上限 (擋掉同回合超額/兩張同名不可能, 因每格一鍵)
      sel.push(card); btn.classList.add('on');
    }
    var need2 = document.querySelector('.need[data-pid="' + pid + '"]');
    if (need2) need2.textContent = sel.length + '/' + need;
    var tr = document.querySelector('#flipGrid tr[data-pid="' + pid + '"]');
    if (tr) tr.classList.toggle('done', sel.length === need);
    updateFlipDone();
  }
  function updateFlipDone() {
    var st = G.state, ok = true, hint = [];
    st.players.forEach(function (p) {
      if (p.leftGame) return;
      var need = E.expectedCardCount(st, p);
      if ((G.flipSel[p.id] || []).length !== need) { ok = false; }
    });
    $('flipDone').disabled = !ok;
    $('flipHint').textContent = ok ? '全部登錄完成，可進入宣告。' : '尚有玩家未點滿應出張數。';
  }
  $('flipDone').onclick = function () {
    var st = G.state;
    pushUndo();
    try {
      st.players.forEach(function (p) {
        if (p.leftGame) return;
        E.registerFlip(st, p.id, G.flipSel[p.id]);
      });
      E.buildQueue(st);
    } catch (e) { $('flipHint').textContent = '登錄錯誤: ' + e.message; G.undo.pop(); return; }
    G.declare = null;
    $('flipOverlay').classList.add('hidden');
    autosave(); render();
  };

  // ================= 開場設定精靈 =================
  function initWizard() {
    buildNameRows();
    wizardRebuild(true);
    $('wCount').onchange = function () { buildNameRows(); wizardRebuild(true); };
    $('wRounds').onchange = function () { wizardRebuild(true); };
    $('wRegen').onclick = function () { wizardRebuild(true); };
    $('wReroll').onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.facSel'), function (s) { s.value = 'auto'; });
      wizardRebuild(true);
    };
    $('wStart').onclick = startFromWizard;
  }
  // 改人數時保留已輸入的名字; 預設帶入上一局的名單
  function loadRoster() { try { return JSON.parse(localStorage.getItem('sfcc_roster')) || []; } catch (e) { return []; } }
  function buildNameRows() {
    var count = clamp(parseInt($('wCount').value, 10) || 8, 7, 14);
    $('wCount').value = count;
    var box = $('wNames');
    var typed = Array.prototype.map.call(box.querySelectorAll('.nm'), function (i) { return i.value; });
    var facs = Array.prototype.map.call(box.querySelectorAll('.facSel'), function (x) { return x.value; });
    var roster = typed.length ? typed : loadRoster();
    box.innerHTML = '';
    for (var i = 0; i < count; i++) {
      var div = document.createElement('div'); div.className = 'namerow';
      div.innerHTML = '<span class="num">' + (i + 1) + '</span><input class="nm" maxlength="8" placeholder="玩家' + (i + 1) + '">' +
        '<select class="facSel"><option value="auto">自動</option>' +
        '<option value="breeder">飼養者</option><option value="butcher">屠夫</option><option value="runner">逃亡者</option></select>';
      div.querySelector('.nm').value = roster[i] || '';
      if (facs[i]) div.querySelector('.facSel').value = facs[i];
      box.appendChild(div);
    }
    // 打字即時更新地圖預覽上的名牌
    Array.prototype.forEach.call(box.querySelectorAll('.nm'), function (inp, k) {
      inp.oninput = function () { if (G.wizardState && G.wizardState.players[k]) { G.wizardState.players[k].name = inp.value.trim() || ('玩家' + (k + 1)); drawWizardMap(); } };
    });
  }
  function nameInputs() { return Array.prototype.map.call(document.querySelectorAll('#wNames .nm'), function (i, k) { return i.value.trim() || ('玩家' + (k + 1)); }); }
  function readWizardForm() {
    var names = nameInputs();
    var facs = Array.prototype.map.call(document.querySelectorAll('#wNames .facSel'), function (s) { return s.value; });
    return names.map(function (n, i) { return { name: n, faction: facs[i] === 'auto' ? null : facs[i] }; });
  }
  function wizardRebuild(regen) {
    var players = readWizardForm();
    var rounds = clamp(parseInt($('wRounds').value, 10) || 12, 4, 20);
    try {
      G.wizardState = E.newGame({ players: players, rounds: rounds, seed: (Math.random() * 1e9) | 0 });
    } catch (e) { alert(e.message); return; }
    // 回填陣營到下拉 (顯示自動分配結果)
    var sels = document.querySelectorAll('#wNames .facSel');
    G.wizardState.players.forEach(function (p, i) { if (sels[i] && sels[i].value === 'auto') sels[i].dataset.assigned = p.faction; });
    drawWizardMap();
    validateFactions();
  }
  function drawWizardMap() { if (G.wizardState) drawMap($('wMap'), G.wizardState, { hidePreview: true }); }
  function validateFactions() {
    var st = G.wizardState; if (!st) return;
    var cnt = { breeder: 0, butcher: 0, runner: 0 };
    st.players.forEach(function (p) { cnt[p.faction]++; });
    var tbl = CFG.FACTION_TABLE[st.count];
    var ok = tbl && cnt.breeder === tbl.breeder && cnt.butcher === tbl.butcher && cnt.runner === tbl.runner;
    $('wStart').textContent = ok ? '開始遊戲 ▶' : '開始遊戲 ▶ (陣營數與建議不同)';
  }
  function startFromWizard() {
    // 以表單覆寫陣營 (操作員手動指定者)
    var facs = Array.prototype.map.call(document.querySelectorAll('#wNames .facSel'), function (s) { return s.value; });
    var names = nameInputs();
    try { localStorage.setItem('sfcc_roster', JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#wNames .nm'), function (i) { return i.value.trim(); }))); } catch (e) {}
    G.wizardState.players.forEach(function (p, i) {
      p.name = names[i];
      if (facs[i] !== 'auto') p.faction = facs[i];
    });
    // 重算飼養者總數
    G.wizardState.factions.breeder.total = G.wizardState.players.filter(function (p) { return p.faction === 'breeder'; }).length;
    G.state = G.wizardState;
    G.undo = [];
    $('wizard').classList.add('hidden');
    E.startRound(G.state);
    G.roundStartSnap = E.snapshot(G.state);
    autosave();
    render();
    openFlip();
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ================= Undo / 手動 / 參數 =================
  function pushUndo() { if (!G.state) return; G.undo.push(E.snapshot(G.state)); if (G.undo.length > 200) G.undo.shift(); }
  function undo() {
    if (!G.undo.length || G.anim) return;
    G.state = E.restore(G.undo.pop());
    G.declare = null; G.anim = null;
    autosave(); render();
    if (G.state.phase === 'flip') { /* 手動可再開 */ }
  }
  function undoToRoundStart() {
    if (!G.roundStartSnap) return;
    pushUndo();
    G.state = E.restore(G.roundStartSnap);
    G.declare = null; G.anim = null;
    autosave(); render();
  }

  function openManual() {
    var st = G.state; var body = $('manualBody');
    var roomOpts = st.rooms.map(function (r, i) { return '<option value="' + i + '">' + E.cellName(i, st.N) + (r.device ? ' (' + DEV_LABEL[r.device] + ')' : '') + '</option>'; }).join('');
    var playerOpts = st.players.map(function (p) { return '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>'; }).join('');
    body.innerHTML =
      '<h2>房間</h2><div class="grid2">' +
      '<label>選房間<select id="mRoom">' + roomOpts + '</select></label>' +
      '<label>噪點<input type="number" id="mNoise" value="0"></label>' +
      '<label>毒<input type="checkbox" id="mPoison"></label>' +
      '<label>屍體數<input type="number" id="mCorpse" value="0"></label>' +
      '<label>掉落樣本<input type="number" id="mDrop" value="0"></label>' +
      '</div><button class="small" id="mRoomApply">套用房間</button>' +
      '<h2>玩家</h2><div class="grid2">' +
      '<label>選玩家<select id="mPlayer">' + playerOpts + '</select></label>' +
      '<label>位置<select id="mPCell">' + roomOpts + '</select></label>' +
      '<label>樣本<input type="number" id="mSamples" value="0"></label>' +
      '<label>陣營<select id="mFac"><option value="breeder">飼養者</option><option value="butcher">屠夫</option><option value="runner">逃亡者</option></select></label>' +
      '<label>殘響<input type="checkbox" id="mEcho"></label>' +
      '</div><button class="small" id="mPlayerApply">套用玩家</button>' +
      '<h2>牛</h2><div class="grid2">' +
      '<label>肥度<input type="number" id="mFat" value="' + st.cow.fatness + '" min="1" max="9"></label>' +
      '<label>位置<select id="mCowCell">' + roomOpts + '</select></label>' +
      '<label>毒劑數<input type="number" id="mDoses" value="' + st.cow.doses.length + '" min="0"></label>' +
      '</div><button class="small" id="mCowApply">套用牛</button>';

    var syncRoom = function () { var r = st.rooms[+$('mRoom').value]; $('mNoise').value = r.noise; $('mPoison').checked = r.poison; $('mCorpse').value = r.corpses; $('mDrop').value = r.dropped; };
    $('mRoom').onchange = syncRoom; syncRoom();
    var syncP = function () { var p = st.players[+$('mPlayer').value]; $('mPCell').value = p.cell; $('mSamples').value = p.samples; $('mFac').value = p.faction; $('mEcho').checked = p.echo; };
    $('mPlayer').onchange = syncP; syncP();
    $('mCowCell').value = st.cow.cell;

    $('mRoomApply').onclick = function () { pushUndo(); var r = st.rooms[+$('mRoom').value]; r.noise = Math.max(0, +$('mNoise').value | 0); r.poison = $('mPoison').checked && r.noise > 0; r.corpses = Math.max(0, +$('mCorpse').value | 0); r.dropped = Math.max(0, +$('mDrop').value | 0); E.computePreview(st); autosave(); render(); };
    $('mPlayerApply').onclick = function () { pushUndo(); var p = st.players[+$('mPlayer').value]; p.cell = +$('mPCell').value; p.samples = Math.max(0, +$('mSamples').value | 0); p.faction = $('mFac').value; var wasEcho = p.echo; p.echo = $('mEcho').checked; p.dead = p.echo; if (wasEcho !== p.echo) { p.echoUsed = {}; if (!p.echo) { p.hand = E.fullHand(); p.resetPending = false; } } E.computePreview(st); autosave(); render(); };
    $('mCowApply').onclick = function () { pushUndo(); st.cow.fatness = clamp(+$('mFat').value | 0, 1, 9); st.cow.cell = +$('mCowCell').value; var dd = Math.max(0, +$('mDoses').value | 0); st.cow.doses = []; for (var i = 0; i < dd; i++) st.cow.doses.push({ left: st.config.poisonDuration }); E.computePreview(st); autosave(); render(); };
    $('manualOverlay').classList.remove('hidden');
  }

  var PARAM_FIELDS = [
    ['rounds', '回合總數'], ['breederSampleThreshold', '飼養者樣本門檻'], ['breederWinAny', '飼養者: 任一人帶滿死亡即勝 (1=是, 0=全體)'], ['teamTransfer', '同陣營交付 (1=可, 0=不可)'], ['dropAllowed', '可以丟樣本在地上 (1=可, 0=不可)'], ['runnerSampleThreshold', '逃亡者樣本門檻'],
    ['poisonDoseLimit', '毒劑門檻'], ['poisonDuration', '毒效期(回合)'], ['boxSize', '每箱樣本'], ['boxTake', '每次取樣'],
    ['moveNoise', '移動噪點'], ['envNoise', '環境噪點'], ['interactNoise', '互動噪點'], ['lureTargetNoise', '誘導目標噪點'],
    ['lureSelfNoise', '誘導自身噪點'], ['resetNoise', '重製噪點'], ['carryNoisePerSample', '攜帶噪點/樣本'],
    ['corpseNoise', '屍體噪點'], ['decoyNoise', '誘餌槽噪點'], ['fatnessSmash', '撞牆門檻'], ['fatnessSplash', '波及門檻'],
    ['fatnessWin', '牛勝肥度'], ['cowMoveBonus', '牛移動加成(肥度+N)']
  ];
  function openParams() {
    var st = G.state, body = $('paramBody'); body.innerHTML = '';
    PARAM_FIELDS.forEach(function (f) {
      var lbl = document.createElement('label');
      lbl.innerHTML = f[1] + '<input type="number" id="pf_' + f[0] + '" value="' + st.config[f[0]] + '">';
      body.appendChild(lbl);
    });
    body.querySelectorAll('input').forEach(function (inp) {
      inp.onchange = function () {
        pushUndo();
        var key = inp.id.slice(3); st.config[key] = +inp.value;
        if (key === 'rounds') st.rounds = +inp.value;
        E.computePreview(st); autosave(); render();
      };
    });
    $('paramOverlay').classList.remove('hidden');
  }

  // ================= 結束畫面 =================
  function showEnd() {
    var st = G.state, body = $('endBody');
    var WIN_LABEL = { cow: '🐂 牛牛', breeder: '🧪 飼養者', butcher: '🔪 屠夫', runner: '🏃 逃亡者' };
    var wl = st.winners.length ? st.winners.map(function (w) { return '<span class="w ' + w + '">' + WIN_LABEL[w] + '</span>'; }) : ['<span class="w none">無陣營達成</span>'];
    var deaths = st.players.filter(function (p) { return p.echo; }).length;
    var html = '<div class="winlist"><b>獲勝</b> ' + wl.join('') + '</div>';
    var endLine = st.log.filter(function (l) { return l.text.indexOf('★ 遊戲結束') === 0; }).pop();
    var why = st.cow.dead ? '牛毒發身亡' : st.cow.fatness >= st.config.fatnessWin ? '牛肥度達到 ' + st.config.fatnessWin
      : st.log.some(function (l) { return l.text.indexOf('時間到') === 0; }) ? '時間到，沒有陣營達成，牛獲勝'
      : endLine ? endLine.text.replace(/^★ 遊戲結束: /, '').replace(/ — 獲勝.*$/, '') : '';
    if (why) html += '<p class="sub" style="font-size:17px;color:var(--ink)">' + escapeHtml(why) + '</p>';
    html += '<p class="sub">牛最終肥度 <b style="color:var(--cow)">' + st.cow.fatness + '</b> · 成為殘響 ' + deaths + ' 人 · 共 ' + st.round + ' 回合</p>';
    html += '<h2>每個人</h2><div>';
    st.players.forEach(function (p) {
      var status = p.leftGame ? '已離場' + (p.faction === 'runner' ? '(逃脫)' : '') : p.echo ? '殘響' : '存活';
      html += '<div class="endrow' + (st.winners.indexOf(p.faction) >= 0 ? ' win' : '') + '"><span><span class="f-' + p.faction + '">' + escapeHtml(p.name) + '</span> · ' + FAC_LABEL[p.faction] + '</span><span>' + status + ' · ◈' + (p.echo && p.deathSamples != null ? p.deathSamples + '(死時)' : p.samples) + '</span></div>';
    });
    html += '</div>';
    body.innerHTML = html;
    $('endOverlay').classList.remove('hidden');
  }
  $('endRestart').onclick = function () { localStorage.removeItem('sfcc_save'); location.reload(); };

  // ================= 存檔 =================
  function autosave() { try { localStorage.setItem('sfcc_save', E.snapshot(G.state)); } catch (e) {} }
  function tryRestore() {
    try {
      var s = localStorage.getItem('sfcc_save');
      if (!s) return false;
      G.state = E.restore(s);
      G.roundStartSnap = s;
      return true;
    } catch (e) { return false; }
  }

  // ================= 投影視窗 =================
  function postToProjector(opts) {
    if (!G.projectorWin || G.projectorWin.closed) return;
    try { G.projectorWin.postMessage({ type: 'state', snap: E.snapshot(G.state), opts: sanitizeOpts(opts) }, '*'); } catch (e) {}
  }
  function sanitizeOpts(o) { return { cowCell: o.cowCell, highlight: o.highlight, hidePreview: o.hidePreview, currentActorId: o.currentActorId }; }
  function openProjector() {
    G.projectorWin = window.open(location.pathname + '?mode=projector', 'sfcc_projector', 'width=1280,height=800');
  }

  // ================= 純顯示模式 =================
  function togglePure() { G.pure = !G.pure; document.body.classList.toggle('projector', G.pure); render(); }

  // ================= 鍵盤 =================
  document.addEventListener('keydown', function (e) {
    if (IS_PROJECTOR) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (anyOverlayOpen() && e.key !== 'Escape') return;
    var st = G.state;
    if (e.key === 'Escape') { closeOverlays(); return; }
    if (!st || G.anim) return; // 牛動畫播放中不接受按鍵
    if (e.key === 'Enter') {
      if (st.phase === 'flip') openFlip();
      else if (st.phase === 'resolve') doResolve();
      else if (st.phase === 'declare') { var a1 = E.currentActor(st); if (a1 && !E.remainingCards(st, a1.id).length) doEndTurn(); }
      else if (st.phase === 'resolved') { st.round >= st.rounds ? showEnd() : nextRound(); }
      e.preventDefault();
    } else if (e.key === 'u' || e.key === 'U') undo();
    else if (e.key === 'v' || e.key === 'V') togglePure();
    else if (st.phase === 'declare' && G.declare) {
      // 數字鍵選牌
      var n = parseInt(e.key, 10);
      var a0 = E.currentActor(st), rem = a0 ? E.remainingCards(st, a0.id) : [];
      if (!isNaN(n) && n >= 1 && n <= rem.length) {
        var card = rem[n - 1];
        G.declare.activeCard = G.declare.activeCard === card ? null : card; G.declare.poison = false; render();
      }
    }
  });
  function anyOverlayOpen() { return ['wizard', 'flipOverlay', 'manualOverlay', 'paramOverlay', 'endOverlay'].some(function (id) { return !$(id).classList.contains('hidden'); }); }
  function closeOverlays() { ['flipOverlay', 'manualOverlay', 'paramOverlay'].forEach(function (id) { $(id).classList.add('hidden'); }); }

  // 控制列按鈕
  $('btnUndo').onclick = undo;
  $('btnUndoRound').onclick = undoToRoundStart;
  $('btnManual').onclick = openManual;
  $('btnParams').onclick = openParams;
  $('btnProjector').onclick = openProjector;
  $('btnPure').onclick = togglePure;
  $('manualClose').onclick = function () { $('manualOverlay').classList.add('hidden'); };
  $('paramClose').onclick = function () { $('paramOverlay').classList.add('hidden'); };
  // 追加「新局」按鈕
  (function () {
    var b = document.createElement('button'); b.className = 'ghost'; b.textContent = '＋ 新局';
    b.onclick = function () { if (confirm('開新的一局? 目前進度會清除。')) { localStorage.removeItem('sfcc_save'); location.reload(); } };
    $('ctrlBody2').appendChild(b);
  })();

  // ================= 啟動 =================
  function boot() {
    if (IS_PROJECTOR) {
      document.body.classList.add('projector');
      $('wizard').classList.add('hidden');
      banner('投影中…');
      window.addEventListener('message', function (ev) {
        if (!ev.data || ev.data.type !== 'state') return;
        try {
          var st = E.restore(ev.data.snap);
          G.projLast = { st: st, opts: ev.data.opts || {} };
          fitCanvas();
          drawMap(canvas, st, G.projLast.opts);
          banner(bannerTextFor(st, G.projLast.opts));
        } catch (e) {}
      });
      window.addEventListener('resize', function () { if (G.projLast) { fitCanvas(); drawMap(canvas, G.projLast.st, G.projLast.opts); } });
      try { if (window.opener) window.opener.postMessage({ type: 'ready' }, '*'); } catch (e) {}
      return;
    }
    // 操作台
    window.addEventListener('message', function (ev) { if (ev.data && ev.data.type === 'ready') postToProjector({}); });
    if (tryRestore()) {
      $('wizard').classList.add('hidden');
      render();
      if (G.state.phase === 'flip') openFlip();
    } else {
      initWizard();
    }
    window.addEventListener('resize', function () { if (G.state) render(); });
    // 控制列高度變了 (換階段、換行) 也要重新塞地圖
    if (window.ResizeObserver) {
      var lastH = 0;
      new ResizeObserver(function () { var h = $('mapWrap').clientHeight; if (h !== lastH) { lastH = h; if (G.state && !G.anim) { fitCanvas(); drawMap(canvas, G.state, lastOpts()); } } }).observe($('mapWrap'));
    }
  }
  function lastOpts() {
    var opts = {};
    if (G.declare && G.declare.activeCard) applyTargetingOpts(opts);
    var actor = (G.state.phase === 'declare') ? E.currentActor(G.state) : null;
    if (actor) opts.currentActorId = actor.id;
    return opts;
  }
  function bannerTextFor(st, o) {
    if (st.gameOver) return '遊戲結束';
    if (st.phase === 'flip') return '第 ' + st.round + ' 回合 · 翻牌';
    if (st.phase === 'declare') { var a = st.players[st.queue[st.queueIndex]]; return '依序宣告 · ' + (a ? a.name : ''); }
    return '結算 · 牛要動了';
  }

  boot();
})();
