/* 超肥牛牛 ── 遊戲引擎 (純邏輯，無 DOM)
 *
 * 座標: cell = r * N + c   (r 由上到下 0..N-1, c 由左到右 0..N-1)
 * 方向 (順時針, 北為起): N(上) E(右) S(下) W(左)
 * 牆: 存在於相鄰兩房之間, 以 edgeKey(a,b) 記錄於 state.walls (Set)
 *     最外框固定不可動、不可撞穿 (以邊界判定, 永不在 walls 內)
 *
 * 解決的規則不一致 (見 README「設計決策」):
 *  - 結算噪點順序: 文件列「攜帶→屍體→衰減」, 但屍體噪點「不衰減」。
 *    若照字面先加屍體再衰減, 在 −2 地圖上屍體永遠淨值 0, 與「永久拉回牛」矛盾。
 *    → 本引擎先「衰減既有噪點」, 再加入每回合流量來源(攜帶+屍體), 使其當回合不被衰減。
 */
(function (root) {
  'use strict';

  var CFG = root.SFCC_CONFIG || (typeof require !== 'undefined' ? require('./config.js') : null);

  // ---- RNG (可注入, 供測試決定性) ----
  function mulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      var x = t;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ---- 幾何 / 座標 ----
  var DIRS = [
    { name: 'N', dr: -1, dc: 0 },
    { name: 'E', dr: 0, dc: 1 },
    { name: 'S', dr: 1, dc: 0 },
    { name: 'W', dr: 0, dc: -1 }
  ]; // 順時針: 北 東 南 西

  function rc(cell, N) { return { r: Math.floor(cell / N), c: cell % N }; }
  function cell(r, c, N) { return r * N + c; }
  function inBounds(r, c, N) { return r >= 0 && c >= 0 && r < N && c < N; }
  function edgeKey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
  function isOuterRing(cell, N) {
    var p = rc(cell, N);
    return p.r === 0 || p.c === 0 || p.r === N - 1 || p.c === N - 1;
  }

  function neighbors(cellIdx, N) {
    var p = rc(cellIdx, N), out = [];
    for (var i = 0; i < DIRS.length; i++) {
      var nr = p.r + DIRS[i].dr, nc = p.c + DIRS[i].dc;
      if (inBounds(nr, nc, N)) out.push({ cell: cell(nr, nc, N), dir: DIRS[i].name, dr: DIRS[i].dr, dc: DIRS[i].dc });
    }
    return out; // 順時針順序
  }

  // ---- 牆存取 ----
  function hasWall(state, a, b) { return state.walls.has(edgeKey(a, b)); }
  function addWall(state, a, b) { state.walls.add(edgeKey(a, b)); }
  function removeWall(state, a, b) { state.walls.delete(edgeKey(a, b)); }
  function passable(state, a, b) { return !hasWall(state, a, b); } // a,b 必須相鄰

  function passableNeighbors(state, cellIdx) {
    var ns = neighbors(cellIdx, state.N), out = [];
    for (var i = 0; i < ns.length; i++) if (passable(state, cellIdx, ns[i].cell)) out.push(ns[i]);
    return out;
  }

  // ---- BFS 最短可通行步數 (供隊列排序、平手取最近、繞路) ----
  function bfsDist(state, from) {
    var N = state.N, total = N * N, dist = new Array(total).fill(Infinity);
    dist[from] = 0;
    var q = [from], head = 0;
    while (head < q.length) {
      var cur = q[head++];
      var ns = passableNeighbors(state, cur);
      for (var i = 0; i < ns.length; i++) {
        if (dist[ns[i].cell] === Infinity) { dist[ns[i].cell] = dist[cur] + 1; q.push(ns[i].cell); }
      }
    }
    return dist;
  }

  // 四面是否皆牆 (環境卡限制: 不可封死)
  function isSealed(state, cellIdx) {
    var ns = neighbors(cellIdx, state.N);
    // 外框方向天然是牆; 若某方向出界也算牆
    var openDirs = 0;
    for (var i = 0; i < 4; i++) {
      var p = rc(cellIdx, state.N);
      var nr = p.r + DIRS[i].dr, nc = p.c + DIRS[i].dc;
      if (!inBounds(nr, nc, state.N)) continue;
      var nb = cell(nr, nc, state.N);
      if (passable(state, cellIdx, nb)) openDirs++;
    }
    return openDirs === 0;
  }

  // 全圖連通 (任兩房至少一條通路)
  function isConnected(state) {
    var N = state.N, total = N * N;
    var dist = bfsDist(state, 0);
    for (var i = 0; i < total; i++) if (dist[i] === Infinity) return false;
    return true;
  }

  // ================= 地圖生成 =================
  // 起始全內牆 → 隨機 DFS 生成生成樹 (保證連通) → 隨機再打通部分牆 (製造環路)
  function generateWalls(N, rng, extraOpen) {
    // 生成樹保證連通後, 只再打通這比例的剩餘內牆製造環路。
    // 比例越低 → 牆越多 → 繞路/撞牆越有意義 (核心機制)。
    extraOpen = extraOpen == null ? 0.22 : extraOpen;
    var walls = new Set();
    var total = N * N;
    // 全內牆
    for (var i = 0; i < total; i++) {
      var p = rc(i, N);
      if (p.c + 1 < N) walls.add(edgeKey(i, cell(p.r, p.c + 1, N)));
      if (p.r + 1 < N) walls.add(edgeKey(i, cell(p.r + 1, p.c, N)));
    }
    // DFS carve
    var visited = new Array(total).fill(false);
    var start = Math.floor(rng() * total);
    var stack = [start];
    visited[start] = true;
    while (stack.length) {
      var cur = stack[stack.length - 1];
      var p2 = rc(cur, N);
      var cand = [];
      for (var d = 0; d < 4; d++) {
        var nr = p2.r + DIRS[d].dr, nc = p2.c + DIRS[d].dc;
        if (inBounds(nr, nc, N)) { var nb = cell(nr, nc, N); if (!visited[nb]) cand.push(nb); }
      }
      if (cand.length) {
        var pick = cand[Math.floor(rng() * cand.length)];
        walls.delete(edgeKey(cur, pick));
        visited[pick] = true;
        stack.push(pick);
      } else stack.pop();
    }
    // 再隨機打通額外牆 (製造環路, 只移除故不破壞連通)
    var wl = Array.from(walls);
    for (var w = 0; w < wl.length; w++) if (rng() < extraOpen) walls.delete(wl[w]);
    return walls;
  }

  // ================= 建立初始狀態 =================
  function newGame(opts) {
    opts = opts || {};
    var rng = opts.rng || mulberry32((Math.random() * 1e9) | 0);
    var players = opts.players; // [{name, faction?}]  faction 可留空由系統分配
    var count = players.length;
    if (count < 7 || count > 14) throw new Error('人數需 7–14');

    var table = CFG.tableFor(count);
    var N = table.N;
    // 預設值 ← 依人數的修正 ← 呼叫者明確指定 (後者優先)
    var config = deepMerge(deepMerge(deepCopy(CFG.DEFAULT_CONFIG), table.overrides || {}), opts.config || {});
    if (opts.rounds) config.rounds = opts.rounds;

    var state = {
      config: config,
      N: N,
      decay: table.decay,
      table: table,
      count: count,
      rounds: config.rounds,
      round: 0,
      phase: 'setup',
      walls: generateWalls(N, rng),
      rooms: [],
      cow: null,
      players: [],
      factions: {
        breeder: { disqualified: false, won: false, total: 0, deadWithEnough: 0, deadCount: 0 },
        butcher: { won: false },
        runner: { won: false }
      },
      exitCells: [],
      lastExitCells: [],
      queue: [],
      queueIndex: 0,
      flips: {},          // playerId -> [cardName,...] 本回合登錄的牌
      declared: {},       // playerId -> [cardName,...] 本回合已宣告(結算)的牌 —— 存在 state 裡, Undo/還原後才不會跟 UI 脫節
      preview: null,      // 預告線
      log: [],
      winners: [],
      gameOver: false,
      _rng: null,         // 生成後不再需要
      seed: opts.seed || null
    };

    // 房間
    for (var i = 0; i < N * N; i++) {
      state.rooms.push({ noise: 0, poison: false, device: null, boxRemaining: 0, corpses: 0, dropped: 0, isExit: false });
    }

    // 牛在中央
    var ccenter = cell(Math.floor(N / 2), Math.floor(N / 2), N);
    state.cow = { cell: ccenter, fatness: 1, doses: [], target: null };

    // 裝置隨機分配 (避開牛起點, 一房最多一個)
    var avail = [];
    for (var c2 = 0; c2 < N * N; c2++) if (c2 !== ccenter) avail.push(c2);
    shuffle(avail, rng);
    var di = 0;
    var devKinds = ['sample_box', 'silencer', 'decoy', 'echo'];
    for (var dk = 0; dk < devKinds.length; dk++) {
      var kind = devKinds[dk], n = table.devices[kind] || 0;
      for (var k = 0; k < n; k++) {
        var cellD = avail[di++];
        state.rooms[cellD].device = kind;
        if (kind === 'sample_box') state.rooms[cellD].boxRemaining = config.boxSize;
      }
    }

    // 玩家起點: 隨機分散外圈, 不同房
    var ring = [];
    for (var rc2 = 0; rc2 < N * N; rc2++) if (isOuterRing(rc2, N)) ring.push(rc2);
    shuffle(ring, rng);

    // 陣營分配
    var factionList = opts.assignFactions === false ? players.map(function (p) { return p.faction; })
      : assignFactions(count, rng);

    for (var pi = 0; pi < count; pi++) {
      var faction = players[pi].faction || factionList[pi];
      state.players.push({
        id: pi,
        name: players[pi].name || ('P' + (pi + 1)),
        faction: faction,
        cell: ring[pi],
        samples: 0,
        hand: fullHand(),
        echo: false,
        dead: false,
        leftGame: false,
        seat: pi,
        resetPending: false,
        echoUsed: {},          // 殘響用過的 move/lure
        deathSamples: null     // 死亡當下的樣本 (飼養者判定)
      });
    }
    state.factions.breeder.total = state.players.filter(function (p) { return p.faction === 'breeder'; }).length;

    logLine(state, 0, '開局: ' + count + ' 人, 地圖 ' + N + '×' + N + ', 噪點衰減 −' + table.decay);
    return state;
  }

  function fullHand() { return { move: true, env: true, interact: true, lure: true, reset: true }; }

  function assignFactions(count, rng) {
    var tbl = CFG.FACTION_TABLE[count];
    var arr = [];
    for (var i = 0; i < tbl.breeder; i++) arr.push('breeder');
    for (var j = 0; j < tbl.butcher; j++) arr.push('butcher');
    for (var k = 0; k < tbl.runner; k++) arr.push('runner');
    return shuffle(arr, rng);
  }

  // ================= 出口刷新 =================
  function refreshExits(state) {
    var t = state.table;
    var toRefresh = 0;
    if (t.exitSchedule.indexOf(state.round) >= 0) toRefresh = 1;
    if (t.exits === 2 && t.exitSchedule2.indexOf(state.round) >= 0) toRefresh += 1;
    if (toRefresh === 0 && state.exitCells.length > 0) return; // 本回合不刷新, 保留現有出口
    if (toRefresh === 0) return;

    // 外圈候選, 避開現有出口位置 (位置與上次不同)
    var ring = [];
    for (var i = 0; i < state.N * state.N; i++) if (isOuterRing(i, state.N)) ring.push(i);
    var rng = state._rngLive || Math.random;
    var forbid = state.exitCells.slice();
    // 逐一刷新
    for (var t2 = 0; t2 < toRefresh; t2++) {
      var pool = ring.filter(function (x) { return forbid.indexOf(x) < 0; });
      if (pool.length === 0) pool = ring.slice();
      var pickIdx = Math.floor((rng ? rng() : Math.random()) * pool.length);
      var picked = pool[pickIdx];
      forbid.push(picked);
    }
    // 重建出口集合: 一個出口局每次換一格; 兩出口局各自維護
    // 簡化: 依 exits 數量取 forbid 的最後 exits 個為現行出口
    var newExits = forbid.slice(-t.exits);
    // 清掉舊出口標記
    for (var e = 0; e < state.rooms.length; e++) state.rooms[e].isExit = false;
    state.lastExitCells = state.exitCells.slice();
    state.exitCells = newExits.slice(0, t.exits);
    for (var ee = 0; ee < state.exitCells.length; ee++) state.rooms[state.exitCells[ee]].isExit = true;

    logLine(state, state.round, '出口刷新: ' + state.exitCells.map(function (x) { return cellName(x, state.N); }).join(', '));

    // 出口刷新時剛好有人站在上面, 足額樣本則立刻離開
    for (var pi = 0; pi < state.players.length; pi++) {
      var pl = state.players[pi];
      if (!pl.dead && !pl.leftGame && !pl.echo && state.exitCells.indexOf(pl.cell) >= 0) tryLeaveViaExit(state, pl);
    }
  }

  function cellName(cellIdx, N) {
    var p = rc(cellIdx, N);
    return String.fromCharCode(65 + p.c) + (p.r + 1); // A1, B3...
  }

  // ================= 回合流程 =================
  function startRound(state) {
    if (state.gameOver) return;
    state.round += 1;
    state.phase = 'flip';
    // 給每個活人補回合開始的手牌狀態 (殘響手牌另計, 見 flip 檢查)
    // 出口刷新 (在回合開始時)
    if (!state._rngLive) state._rngLive = mulberry32(((state.seed || 12345) + state.round * 7919) >>> 0);
    refreshExits(state);
    state.flips = {};
    state.declared = {};
    state.queue = [];
    state.queueIndex = 0;
    computePreview(state);
    logLine(state, state.round, '=== 第 ' + state.round + ' 回合開始 ===');
  }

  // 本回合該玩家應出幾張牌
  function cardsThisRound(state, player) {
    if (player.echo) return 1;
    return 1; // 佔位, 真正張數由 handSizeExpected 決定
  }

  // 登錄翻牌: 存下該玩家本回合要打的卡別 (只承諾卡別)
  function registerFlip(state, playerId, cards) {
    var p = state.players[playerId];
    if (p.dead && !p.echo) throw new Error('已出局');
    if (p.leftGame) throw new Error('已離場');
    // 驗證: 不可重複卡別, 必須在手上
    var seen = {};
    for (var i = 0; i < cards.length; i++) {
      var cd = cards[i];
      if (seen[cd]) throw new Error('不可同回合打出兩張同名卡: ' + cd);
      seen[cd] = true;
      if (p.echo) {
        if (ECHO_CARDS.indexOf(cd) < 0) throw new Error('殘響只能打 移動/誘導/互動');
        if (p.echoUsed[cd]) throw new Error('殘響本循環已用過: ' + cd);
      } else {
        if (!p.hand[cd]) throw new Error('手上沒有此牌: ' + cd);
      }
    }
    state.flips[playerId] = cards.slice();
  }

  // 依規則計算本回合玩家「可出」張數 (供 UI 限制)。殘響 1 張, 一般人依剩餘手牌 2 或 1。
  function expectedCardCount(state, player) {
    if (player.echo) return 1;
    var remaining = handList(player).length;
    return Math.min(2, remaining);
  }
  // 殘響的手牌 (v12.2): 移動、誘導、互動 (互動只能操作回聲器)。用過任兩張就全部收回。
  var ECHO_CARDS = ['move', 'lure', 'interact'];
  function handList(player) {
    if (player.echo) {
      var out = [];
      ECHO_CARDS.forEach(function (c) { if (!player.echoUsed[c]) out.push(c); });
      return out;
    }
    return Object.keys(player.hand).filter(function (k) { return player.hand[k]; });
  }

  // 所有人登錄完 → 建立宣告隊列
  function buildQueue(state) {
    var dist = bfsDist(state, state.cow.cell);
    var actors = state.players.filter(function (p) {
      return !p.leftGame && state.flips[p.id] && state.flips[p.id].length > 0;
    });
    actors.sort(function (a, b) {
      var da = dist[a.cell], db = dist[b.cell];
      if (da !== db) return da - db;                    // 離牛最近先
      var na = state.rooms[a.cell].noise, nb = state.rooms[b.cell].noise;
      if (na !== nb) return nb - na;                    // 噪點高先
      return a.seat - b.seat;                           // 席位序
    });
    state.queue = actors.map(function (p) { return p.id; });
    state.queueIndex = 0;
    state.phase = 'declare';
    computePreview(state);
    return state.queue;
  }

  // 該玩家本回合翻開、但還沒宣告的牌 (唯一真相來源: state.flips − state.declared)
  function remainingCards(state, playerId) {
    var flipped = state.flips[playerId] || [];
    var done = (state.declared && state.declared[playerId]) || [];
    var p = state.players[playerId];
    if (p && p.leftGame) return []; // 中途走出出口 → 剩下的牌不用打
    return flipped.filter(function (c) {
      if (done.indexOf(c) >= 0) return false;
      // 舊版存檔沒有 declared 紀錄: 活人手上已經沒有的牌 = 這回合已經打掉了
      if (p && !p.echo && !p.hand[c]) return false;
      return true;
    });
  }

  function currentActor(state) {
    if (state.queueIndex >= state.queue.length) return null;
    return state.players[state.queue[state.queueIndex]];
  }

  function advanceActor(state) {
    state.queueIndex += 1;
    if (state.queueIndex >= state.queue.length) {
      state.phase = 'resolve';
    }
    computePreview(state);
  }

  // ================= 卡牌結算 (宣告階段, 即時) =================
  // move: {path:[cells]}  或  {dest:cell}
  function declareMove(state, player, params) {
    ensureHas(state, player, 'move');
    var dest = params.dest != null ? params.dest : (params.path && params.path.length ? params.path[params.path.length - 1] : player.cell);
    var path = params.path;
    if (!path) path = shortestPath(state, player.cell, dest);
    // 驗證: <=2 步、逐步可通行、殘響不可穿牆(本就檢查)
    if (!path || path.length === 0 || path[0] !== player.cell) throw new Error('移動路徑非法');
    if (path.length - 1 > 2) throw new Error('移動最多 2 格');
    for (var i = 1; i < path.length; i++) {
      if (!areAdjacent(path[i - 1], path[i], state.N) || !passable(state, path[i - 1], path[i]))
        throw new Error('移動被牆擋住或非相鄰');
    }
    var start = player.cell;
    addNoise(state, start, state.config.moveNoise, false); // 起點 +1
    player.cell = dest;
    consume(state, player, 'move');
    logLine(state, state.round, name(player) + ' 移動 ' + cellName(start, state.N) + '→' + cellName(dest, state.N));
    // 走進出口?
    if (!player.echo && state.exitCells.indexOf(dest) >= 0) tryLeaveViaExit(state, player);
  }

  function declareEnv(state, player, params) {
    ensureHas(state, player, 'env');
    if (player.echo) throw new Error('殘響不能動牆');
    var a = player.cell, b = params.wallCell; // 要動的相鄰房
    if (!areAdjacent(a, b, state.N)) throw new Error('只能動自己房間的相鄰牆');
    var op = params.op; // 'add' | 'remove'
    // 外框不可動 (b 必在界內, areAdjacent 已保證)
    // 試做 → 驗證封死/切斷 → 不合法則還原
    var had = hasWall(state, a, b);
    if (op === 'add') {
      if (had) throw new Error('該面已是牆');
      addWall(state, a, b);
      if (isSealed(state, a) || isSealed(state, b) || !isConnected(state)) {
        removeWall(state, a, b);
        throw new Error('環境卡不可造成封死或切斷地圖');
      }
    } else {
      if (!had) throw new Error('該面沒有牆');
      removeWall(state, a, b);
      // 移除牆不會封死或切斷, 一定合法
    }
    addNoise(state, a, state.config.envNoise, false); // 自己 +2
    consume(state, player, 'env');
    logLine(state, state.round, name(player) + ' 環境: ' + (op === 'add' ? '築牆' : '拆牆') + ' ' + cellName(a, state.N) + '|' + cellName(b, state.N));
  }

  // 回聲器: 把這格目前的噪點複製到相鄰房間 (毒不複製); v15: 複製後這格砍半 (無條件捨去)。echoHalveSource = 0 回到不砍半
  function echoCopy(state, from, to) {
    var room = state.rooms[from], n = room.noise;
    state.rooms[to].noise += n;
    var txt = '回聲: 複製 ' + n + ' 噪點到 ' + cellName(to, state.N);
    if (state.config.echoHalveSource) {
      room.noise = Math.floor(n / 2);
      if (room.noise <= 0) { room.noise = 0; room.poison = false; }
      txt += '，本格剩 ' + room.noise;
    }
    return txt;
  }

  function declareInteract(state, player, params) {
    ensureHas(state, player, 'interact');
    var room = state.rooms[player.cell];
    if (player.echo) {
      // 殘響的互動: 只能操作回聲器; 不能撿樣本、不能用其他裝置 (沒效果, 照樣 +1)
      addNoise(state, player.cell, state.config.interactNoise, false);
      var emsg = '殘響: 無效 (只能操作回聲器)';
      if (room.device === 'echo') {
        var etgt = params.echoTarget;
        if (etgt == null || !areAdjacent(player.cell, etgt, state.N)) throw new Error('回聲器需指定相鄰房間');
        emsg = '殘響' + echoCopy(state, player.cell, etgt);
      }
      consume(state, player, 'interact');
      logLine(state, state.round, name(player) + ' 互動 @' + cellName(player.cell, state.N) + ': ' + emsg);
      return;
    }
    addNoise(state, player.cell, state.config.interactNoise, false); // 無論如何 +1
    var msg = [];
    // 撿起掉落樣本 (與使用裝置可同時)
    if (room.dropped > 0) {
      player.samples += room.dropped;
      msg.push('撿起 ' + room.dropped + ' 樣本');
      room.dropped = 0;
    }
    // 飼養者交付 (breederTransfer): 把身上全部樣本交給同房的另一位活著的飼養者, 取代使用裝置
    if (params.giveTo != null) {
      var rcv = state.players[params.giveTo];
      if (state.config.breederTransfer !== 1) throw new Error('目前規則不允許用互動卡交付');
      if (player.faction !== 'breeder' || !rcv || rcv.faction !== 'breeder' || rcv.id === player.id) throw new Error('只能交給另一位飼養者');
      if (rcv.dead || rcv.leftGame || rcv.cell !== player.cell) throw new Error('對方必須活著且在同一房間');
      if (player.samples < 1) throw new Error('身上沒有樣本可交付');
      rcv.samples += player.samples;
      msg.push('交付 ' + player.samples + ' 樣本給 ' + name(rcv));
      player.samples = 0;
    }
    // 使用裝置
    else if (room.device === 'sample_box') {
      var take = Math.min(state.config.boxTake, room.boxRemaining);
      if (take > 0) { room.boxRemaining -= take; player.samples += take; msg.push('取得 ' + take + ' 樣本'); }
      else msg.push('樣本箱已空');
    } else if (room.device === 'silencer') {
      // v14: 自己這格 + 上下左右四格 (隔著牆也算) 噪點歸 0, 毒也清掉。silencerRadius = 0 回到只清自己這格
      var cleared = [player.cell];
      if (state.config.silencerRadius) neighbors(player.cell, state.N).forEach(function (nb) { cleared.push(nb.cell); });
      cleared.forEach(function (c) { state.rooms[c].noise = 0; state.rooms[c].poison = false; });
      msg.push('消音: ' + cleared.map(function (c) { return cellName(c, state.N); }).join('、') + ' 噪點歸 0');
    } else if (room.device === 'decoy') {
      addNoise(state, player.cell, state.config.decoyNoise, false); msg.push('誘餌槽 +' + state.config.decoyNoise);
    } else if (room.device === 'echo') {
      var tgt = params.echoTarget;
      if (tgt == null || !areAdjacent(player.cell, tgt, state.N)) throw new Error('回聲器需指定相鄰房間');
      msg.push(echoCopy(state, player.cell, tgt));
    } else if (!room.device && room.dropped === 0 && !(msg.length)) {
      msg.push('無裝置, 無效 (仍 +1 噪點)');
    }
    consume(state, player, 'interact');
    logLine(state, state.round, name(player) + ' 互動 @' + cellName(player.cell, state.N) + ': ' + msg.join('; '));
  }

  function declareLure(state, player, params) {
    ensureHas(state, player, 'lure');
    var tgt = params.target;
    var dist = bfsDist(state, player.cell);
    if (dist[tgt] === Infinity || dist[tgt] > 3) throw new Error('誘導目標需在 3 格內');
    var poison = !!params.poison;
    if (poison) {
      if (player.echo) throw new Error('殘響不能下毒');
      if (player.faction !== 'butcher') throw new Error('只有屠夫能下毒');
      if (player.samples < 1) throw new Error('身上沒有樣本, 不能投毒');
      player.samples -= 1;
    }
    addNoise(state, tgt, state.config.lureTargetNoise, poison);  // 目標 +3 (毒)
    addNoise(state, player.cell, state.config.lureSelfNoise, false); // 自己 +1
    consume(state, player, 'lure');
    logLine(state, state.round, name(player) + ' 誘導 →' + cellName(tgt, state.N) + ' +' + state.config.lureTargetNoise + (poison ? ' (毒)' : ''));
  }

  function declareReset(state, player, params) {
    ensureHas(state, player, 'reset');
    if (player.echo) throw new Error('殘響沒有重製');
    addNoise(state, player.cell, state.config.resetNoise, false); // 自己 +3
    player.resetPending = true; // 回合結束時收回所有打出的牌
    consume(state, player, 'reset');
    logLine(state, state.round, name(player) + ' 重製 (回合末恢復手牌)');
  }

  // 同陣營交付 (teamTransfer = 1, v12): 輪到自己宣告時, 把身上任意數量的樣本交給同房間、同陣營、活著的隊友。
  // 不用出牌、不產生噪點。amount 省略 = 全部。(舊開關 breederTransfer = 2: 只有飼養者之間能交付)
  function canTransfer(state, p, rcv) {
    var c = state.config;
    if (!p || !rcv || rcv.id === p.id || rcv.faction !== p.faction) return false;
    return !!c.teamTransfer || (c.breederTransfer === 2 && p.faction === 'breeder');
  }
  function giveSamples(state, fromId, toId, amount) {
    var p = state.players[fromId], rcv = state.players[toId];
    if (!p || p.dead || p.leftGame) throw new Error('只有活著的玩家能交付');
    if (!rcv || rcv.id === p.id || rcv.faction !== p.faction) throw new Error('只能交給同陣營的隊友');
    if (!canTransfer(state, p, rcv)) throw new Error('目前規則不允許交付');
    if (rcv.dead || rcv.leftGame) throw new Error('對方必須活著');
    if (rcv.cell !== p.cell) throw new Error('對方必須在同一房間');
    if (p.samples < 1) throw new Error('身上沒有樣本可交付');
    var n = amount == null ? p.samples : amount;
    if (n !== Math.floor(n) || n < 1 || n > p.samples) throw new Error('交付數量要在 1 到 ' + p.samples + ' 之間');
    rcv.samples += n;
    p.samples -= n;
    logLine(state, state.round, name(p) + ' 交付 ' + n + ' 樣本給 ' + name(rcv));
    computePreview(state);
  }

  // 丟在地上 (dropAllowed = 1, v12): 輪到自己宣告時, 把身上任意數量的樣本丟在所在房間。
  // 不用出牌、不產生噪點。任何人打互動卡都能撿起來 (跟屍體旁掉落的樣本一樣)。
  function dropSamples(state, playerId, amount) {
    var p = state.players[playerId];
    if (!state.config.dropAllowed) throw new Error('目前規則不允許丟樣本');
    if (!p || p.dead || p.leftGame) throw new Error('只有活著的玩家能丟樣本');
    if (p.samples < 1) throw new Error('身上沒有樣本');
    var n = amount == null ? p.samples : amount;
    if (n !== Math.floor(n) || n < 1 || n > p.samples) throw new Error('數量要在 1 到 ' + p.samples + ' 之間');
    p.samples -= n;
    state.rooms[p.cell].dropped += n;
    logLine(state, state.round, name(p) + ' 把 ' + n + ' 樣本丟在 ' + cellName(p.cell, state.N));
    computePreview(state);
  }

  var DECLARE = { move: declareMove, env: declareEnv, interact: declareInteract, lure: declareLure, reset: declareReset };

  function declareCard(state, playerId, cardName, params) {
    var p = state.players[playerId];
    var fn = DECLARE[cardName];
    if (!fn) throw new Error('未知卡: ' + cardName);
    if (remainingCards(state, playerId).indexOf(cardName) < 0) throw new Error('這張牌本回合沒翻開或已宣告過: ' + cardName);
    fn(state, p, params || {});
    markDeclared(state, playerId, cardName);
    computePreview(state); // 每結算一張即時重算預告線
  }

  function markDeclared(state, playerId, cardName) {
    if (!state.declared) state.declared = {};
    (state.declared[playerId] = state.declared[playerId] || []).push(cardName);
  }

  // 操作員後門: 這張牌在當下完全沒有合法目標 (例: 環境卡每面牆都會造成封死/切斷)
  // → 照樣打出 (消耗掉), 但無效果、不產生噪點。避免整場卡死。
  function forfeitCard(state, playerId, cardName) {
    var p = state.players[playerId];
    if (remainingCards(state, playerId).indexOf(cardName) < 0) throw new Error('這張牌本回合沒翻開或已宣告過: ' + cardName);
    if (p.echo) { if (!p.echoUsed[cardName]) consume(state, p, cardName); }
    else if (p.hand[cardName]) consume(state, p, cardName);
    markDeclared(state, playerId, cardName);
    logLine(state, state.round, name(p) + ' 的「' + cardName + '」無合法目標, 作廢 (無效果)');
    computePreview(state);
  }

  function ensureHas(state, player, cardName) {
    if (player.echo) {
      if (player.echoUsed[cardName]) throw new Error('殘響本循環已用: ' + cardName);
    } else if (!player.hand[cardName]) throw new Error('手上沒有此牌: ' + cardName);
  }
  function consume(state, player, cardName) {
    if (player.echo) {
      player.echoUsed[cardName] = true;
      // 用過任兩張就全部收回
      if (Object.keys(player.echoUsed).filter(function (k) { return player.echoUsed[k]; }).length >= 2) player.echoUsed = {};
    } else {
      player.hand[cardName] = false;
    }
  }

  function addNoise(state, cellIdx, amount, poison) {
    var room = state.rooms[cellIdx];
    room.noise += amount;
    if (poison && amount > 0) room.poison = true;
    if (room.noise <= 0) { room.noise = 0; room.poison = false; }
  }

  // 只有逃亡者能從出口離開 (其他陣營走到出口沒有任何效果, 避免主祭被出口「彈出」遊戲)
  function tryLeaveViaExit(state, player) {
    if (player.faction !== 'runner') return;
    if (player.samples >= state.config.runnerSampleThreshold) {
      player.leftGame = true;
      var won = player.faction === 'runner';
      logLine(state, state.round, name(player) + ' 帶 ' + player.samples + ' 樣本走出出口, 離場' + (won ? ' — 逃亡者勝利!' : ''));
      if (won && !state.factions.runner.won) {
        state.factions.runner.won = true;
        state.winners.push('runner');
      }
      // 任一陣營達成 → 遊戲立刻結束 (firstWinEnds; 0 = 舊規則: 勝利鎖定、遊戲繼續)
      if (state.config.firstWinEnds && state.winners.length) { endGame(state, name(player) + ' 逃出'); return; }
      checkAllEcho(state);
    }
  }

  // ================= 牛的演算法 (核心) =================
  // 傳回 {stay, target, reached, path, killedCells, splashCells, smashed, ate, evolved, poisonedThisMeal}
  // 不改動 state (供預告線); 真正套用在 applyCowMove
  function computeCowMove(state) {
    var cowCell = state.cow.cell;
    var fatness = state.cow.fatness;
    var cfg = state.config;
    var result = {
      stay: false, target: null, reached: false, path: [cowCell],
      killedCells: [], splashCells: [], smashed: [], ate: 0, evolvedTo: null, poisonedThisMeal: false
    };

    // 1. 選目標
    var target = selectCowTarget(state);
    if (target == null) { result.stay = true; return result; }
    result.target = target;

    var steps = fatness + cfg.cowMoveBonus + (cfg.cowLateBonus && fatness >= (cfg.cowLateFat || 5) ? cfg.cowLateBonus : 0);
    var path;

    if (fatness < cfg.fatnessSmash) {
      // 肥度 1..3: 最短可通行, 繞牆
      var full = shortestPathMinTurns(state, cowCell, target);
      if (!full) {
        // 目標完全無法到達 → 移動到最接近目標的可達格, 再朝目標撞穿一面相鄰牆, 本回合移動結束
        var distC = bfsDist(state, cowCell);
        var bestCell = cowCell, bestE = eucl2(cowCell, target, state.N), bestPD = 0;
        for (var ci = 0; ci < state.rooms.length; ci++) {
          if (distC[ci] === Infinity) continue;
          var e = eucl2(ci, target, state.N);
          if (e < bestE || (e === bestE && distC[ci] < bestPD)) { bestCell = ci; bestE = e; bestPD = distC[ci]; }
        }
        var pth = (bestCell === cowCell) ? [cowCell] : shortestPathMinTurns(state, cowCell, bestCell);
        pth = pth.slice(0, steps + 1);
        result.path = pth;
        var endCell = pth[pth.length - 1];
        var smashed = smashTowardTarget(state, endCell, target);
        if (smashed) result.smashed.push(smashed);
        result.reached = false;
        result.sealedStop = true;
        // 沿途仍會殺人 → 交給下方共用殺人邏輯
        path = pth;
        return finishKillsAndEat(state, result, path, fatness, cfg, false);
      }
      path = full.slice(0, steps + 1); // 含起點
      result.reached = (path[path.length - 1] === target);
    } else {
      // 肥度 4+: 幾何最短直線, 撞穿路徑上的牆 (外框除外)
      var straight = straightSmashPath(state, cowCell, target, steps, result.smashed);
      path = straight.path;
      result.reached = (path[path.length - 1] === target);
    }

    result.path = path;
    return finishKillsAndEat(state, result, path, fatness, cfg, true);
  }

  function eucl2(a, b, N) {
    var pa = rc(a, N), pb = rc(b, N);
    return (pa.r - pb.r) * (pa.r - pb.r) + (pa.c - pb.c) * (pa.c - pb.c);
  }

  // 共用: 依 path 計算殺人格/波及格, 及 (可選) 進食進化中毒
  function finishKillsAndEat(state, result, path, fatness, cfg, allowEat) {
    // 4. 殺人: 路徑經過每格加終點, 起點不算
    var killSet = {};
    for (var i = 1; i < path.length; i++) killSet[path[i]] = true;
    // 肥度 >= splash: 路徑每格四方相鄰也殺 (不含起點, 波及不撞牆)
    if (fatness >= cfg.fatnessSplash) {
      for (var j = 1; j < path.length; j++) {
        var ns = neighbors(path[j], state.N);
        for (var k = 0; k < ns.length; k++) result.splashCells.push(ns[k].cell);
      }
      for (var s = 0; s < result.splashCells.length; s++) killSet[result.splashCells[s]] = true;
    }
    result.killedCells = Object.keys(killSet).map(Number);

    // 5. 進食: 只有抵達目標才吃
    if (allowEat && result.reached && result.target != null) {
      var room = state.rooms[result.target];
      result.ate = room.noise;
      result.poisonedThisMeal = room.poison && room.noise > 0;
      if (result.ate >= fatness) result.evolvedTo = fatness + 1;
    }
    return result;
  }

  function selectCowTarget(state) {
    var maxNoise = 0;
    for (var i = 0; i < state.rooms.length; i++) if (state.rooms[i].noise > maxNoise) maxNoise = state.rooms[i].noise;
    if (maxNoise === 0) return null; // 全場 0 → 原地不動
    var cands = [];
    for (var j = 0; j < state.rooms.length; j++) if (state.rooms[j].noise === maxNoise) cands.push(j);
    if (cands.length === 1) return cands[0];
    // 平手取最近 (可通行步數)
    var dist = bfsDist(state, state.cow.cell);
    var minD = Infinity;
    for (var c = 0; c < cands.length; c++) if (dist[cands[c]] < minD) minD = dist[cands[c]];
    var nearest = cands.filter(function (x) { return dist[x] === minD; });
    if (nearest.length === 1) return nearest[0];
    // 仍平手: 以牛為中心從正北順時針取第一個
    return clockwiseFirst(state.cow.cell, nearest, state.N);
  }

  // 以 origin 為中心, 從正北(bearing 0)順時針, 取 bearing 最小者; 同 bearing 取近者
  function clockwiseFirst(origin, cells, N) {
    var o = rc(origin, N);
    function bearing(cellIdx) {
      var p = rc(cellIdx, N);
      var dc = p.c - o.c, dr = p.r - o.r; // 北: dr<0
      // atan2 以北為 0 順時針: angle = atan2(dc, -dr)
      var a = Math.atan2(dc, -dr);
      if (a < 0) a += 2 * Math.PI;
      return a;
    }
    var best = null, bestB = Infinity, bestDist = Infinity;
    for (var i = 0; i < cells.length; i++) {
      var b = bearing(cells[i]);
      var p = rc(cells[i], N);
      var d = Math.abs(p.c - o.c) + Math.abs(p.r - o.r);
      if (b < bestB - 1e-9 || (Math.abs(b - bestB) < 1e-9 && d < bestDist)) {
        best = cells[i]; bestB = b; bestDist = d;
      }
    }
    return best;
  }

  function areAdjacent(a, b, N) {
    var pa = rc(a, N), pb = rc(b, N);
    return Math.abs(pa.r - pb.r) + Math.abs(pa.c - pb.c) === 1;
  }

  // 最短可通行路徑 (單純 BFS, 供移動卡驗證)
  function shortestPath(state, from, to) {
    var prev = {}; prev[from] = -1;
    var q = [from], head = 0;
    while (head < q.length) {
      var cur = q[head++];
      if (cur === to) break;
      var ns = passableNeighbors(state, cur);
      for (var i = 0; i < ns.length; i++) {
        if (prev[ns[i].cell] === undefined) { prev[ns[i].cell] = cur; q.push(ns[i].cell); }
      }
    }
    if (prev[to] === undefined) return null;
    var path = [], cur2 = to;
    while (cur2 !== -1) { path.unshift(cur2); cur2 = prev[cur2]; }
    return path;
  }

  // 最短路徑, 多條等長取「轉彎最少」, 仍平手取順時針優先
  function shortestPathMinTurns(state, from, to) {
    if (from === to) return [from];
    var dist = bfsDist(state, from);
    if (dist[to] === Infinity) return null;
    // 反向重建: 從 to 往 from, 每步選 dist-1 的相鄰; 記錄 (轉彎數, 順時針序) 最小
    // 用前向 DP: best[cell][incomingDir] = {turns, prevCell, prevDir}
    var DIRIDX = { N: 0, E: 1, S: 2, W: 3 };
    // 依 dist 分層處理
    var byDist = [];
    for (var i = 0; i < dist.length; i++) {
      if (dist[i] === Infinity) continue;
      (byDist[dist[i]] = byDist[dist[i]] || []).push(i);
    }
    // state: map cell -> array[4] of {turns, prev, prevDir} 最佳
    var bestAt = {}; // cell -> {dirIdx: {turns, prev}}
    bestAt[from] = {}; bestAt[from][-1] = { turns: 0, prev: null, prevDirName: null };
    for (var d = 1; d < byDist.length; d++) {
      var layer = byDist[d] || [];
      for (var li = 0; li < layer.length; li++) {
        var cellC = layer[li];
        var ns = neighbors(cellC, state.N); // 順時針
        // 找所有 dist-1 且可通行的前驅
        for (var ni = 0; ni < ns.length; ni++) {
          var pcell = ns[ni].cell;
          if (dist[pcell] !== d - 1 || !passable(state, cellC, pcell)) continue;
          if (!bestAt[pcell]) continue;
          // 進入 cellC 的方向 = 從 pcell 指向 cellC
          var enterDir = dirFromTo(pcell, cellC, state.N);
          var enterIdx = DIRIDX[enterDir];
          // 對 pcell 的每個既有狀態, 計算 turns
          var pStates = bestAt[pcell];
          for (var key in pStates) {
            var ps = pStates[key];
            var prevDirName = ps.prevDirName;
            var turns = ps.turns + (prevDirName && prevDirName !== enterDir ? 1 : 0);
            var existing = (bestAt[cellC] = bestAt[cellC] || {})[enterIdx];
            var better = false;
            if (!existing) better = true;
            else if (turns < existing.turns) better = true;
            else if (turns === existing.turns) {
              // 順時針優先: 進入方向序較小者 (但同 enterIdx 相同, 這裡比 prev 的 clockwise)
              // 以進入方向 index 較小者優先已由外層迴圈順序保證; 這裡保留先到者
              better = false;
            }
            if (better) bestAt[cellC][enterIdx] = { turns: turns, prev: pcell, prevDirName: enterDir };
          }
        }
      }
    }
    // 於 to 取 turns 最小 (順時針: 進入方向序小者優先)
    var tstates = bestAt[to];
    if (!tstates) return null;
    var chosen = null, chosenIdx = 99;
    for (var kk in tstates) {
      var st = tstates[kk];
      if (chosen === null || st.turns < chosen.turns ||
        (st.turns === chosen.turns && Number(kk) < chosenIdx)) {
        chosen = st; chosenIdx = Number(kk);
      }
    }
    // 反向重建路徑
    var path = [to], cur = to, curState = chosen;
    while (curState && curState.prev !== null) {
      path.unshift(curState.prev);
      var prevCell = curState.prev;
      // 找 prevCell 上通往 cur 的狀態
      var enterDir = dirFromTo(prevCell, cur, state.N);
      cur = prevCell;
      var pd = bestAt[prevCell];
      // 取能延續此路徑的狀態 (turns 最小)
      var pick = null, pickIdx = 99;
      for (var kk2 in pd) {
        var stp = pd[kk2];
        if (pick === null || stp.turns < pick.turns || (stp.turns === pick.turns && Number(kk2) < pickIdx)) { pick = stp; pickIdx = Number(kk2); }
      }
      curState = pick;
    }
    return path;
  }

  function dirFromTo(a, b, N) {
    var pa = rc(a, N), pb = rc(b, N);
    if (pb.r === pa.r - 1) return 'N';
    if (pb.r === pa.r + 1) return 'S';
    if (pb.c === pa.c + 1) return 'E';
    if (pb.c === pa.c - 1) return 'W';
    return null;
  }

  // 肥度 4+ 幾何最短直線: 逐步取「最減少歐氏距離」的方向, 撞穿沿路牆
  function straightSmashPath(state, from, target, steps, smashedOut) {
    var path = [from];
    var cur = from;
    var tp = rc(target, state.N);
    for (var s = 0; s < steps; s++) {
      if (cur === target) break;
      var cp = rc(cur, state.N);
      var cands = [];
      for (var d = 0; d < DIRS.length; d++) {
        var nr = cp.r + DIRS[d].dr, nc = cp.c + DIRS[d].dc;
        if (!inBounds(nr, nc, state.N)) continue;
        var nb = cell(nr, nc, state.N);
        var dist2 = (nr - tp.r) * (nr - tp.r) + (nc - tp.c) * (nc - tp.c);
        cands.push({ cell: nb, dist2: dist2, dirIdx: d });
      }
      // 取歐氏距離最小; 平手取順時針(北E S W 序小)
      cands.sort(function (a, b) { return a.dist2 - b.dist2 || a.dirIdx - b.dirIdx; });
      var next = cands[0];
      if (!next) break;
      // 撞穿牆 (外框不可能, 因 next 在界內)
      if (hasWall(state, cur, next.cell)) { removeWall(state, cur, next.cell); if (smashedOut) smashedOut.push(edgeKey(cur, next.cell)); }
      cur = next.cell;
      path.push(cur);
    }
    return { path: path };
  }

  // 目標封死時撞穿一面朝目標的相鄰牆
  function smashTowardTarget(state, from, target) {
    var cp = rc(from, state.N), tp = rc(target, state.N);
    var best = null, bestDist = Infinity, bestIdx = 99;
    for (var d = 0; d < DIRS.length; d++) {
      var nr = cp.r + DIRS[d].dr, nc = cp.c + DIRS[d].dc;
      if (!inBounds(nr, nc, state.N)) continue;
      var nb = cell(nr, nc, state.N);
      if (!hasWall(state, from, nb)) continue; // 只撞有牆的方向
      var dist2 = (nr - tp.r) * (nr - tp.r) + (nc - tp.c) * (nc - tp.c);
      if (dist2 < bestDist || (dist2 === bestDist && d < bestIdx)) { best = nb; bestDist = dist2; bestIdx = d; }
    }
    if (best != null) { removeWall(state, from, best); return edgeKey(from, best); }
    return null;
  }

  // 套用牛的行動到 state (含殺人/進食/進化/中毒), 傳回 move 結果供 UI 動畫
  function applyCowMove(state) {
    var mv = computeCowMove(state);
    if (mv.stay) {
      logLine(state, state.round, '牛: 全場噪點 0, 原地不動');
      return mv;
    }
    // 殺人
    var killedPlayers = [];
    for (var pi = 0; pi < state.players.length; pi++) {
      var pl = state.players[pi];
      if (pl.dead || pl.leftGame) continue;
      if (mv.killedCells.indexOf(pl.cell) >= 0) killedPlayers.push(pl);
    }
    for (var kp = 0; kp < killedPlayers.length; kp++) killPlayer(state, killedPlayers[kp]);
    mv.killedPlayers = killedPlayers.map(function (p) { return p.id; });

    // 移動牛
    var end = mv.path[mv.path.length - 1];
    state.cow.cell = end;

    // 進食/進化
    if (mv.reached) {
      var room = state.rooms[mv.target];
      var ate = room.noise;
      var hadPoison = room.poison && room.noise > 0;
      room.noise = 0; room.poison = false; // 吃光 (屍體/掉落樣本不受影響, 見下)
      if (mv.evolvedTo) {
        state.cow.fatness = mv.evolvedTo;
        logLine(state, state.round, '牛進食 ' + ate + ' → 肥度 ' + state.cow.fatness);
      } else {
        logLine(state, state.round, '牛進食 ' + ate + ' (不足肥度, 不進化)');
      }
      // 中毒
      if (hadPoison) {
        state.cow.doses.push({ left: state.config.poisonDuration });
        logLine(state, state.round, '牛中毒! 目前 ' + state.cow.doses.length + ' 劑');
      }
    } else {
      logLine(state, state.round, '牛半路停下 @' + cellName(end, state.N) + ' (不吃不長)');
    }

    // 走到出口的人 (被牛帶到? 不會; 但出口在路徑上與人無關)
    // 勝負判定
    checkButcherVictory(state);   // 毒死優先: 同一餐毒死又長到肥度上限 → 牛已死, 不算牛贏
    checkCowVictory(state);
    checkAllEcho(state);
    // 牛的同一次行動 (移動/輾死/進食/中毒) 視為同一刻: 這一刻達成的陣營一起贏, 然後遊戲結束
    if (state.config.firstWinEnds && state.winners.length) endGame(state, '陣營達成');

    logLine(state, state.round, '牛移動 ' + mv.path.map(function (x) { return cellName(x, state.N); }).join('→') +
      (mv.killedPlayers.length ? ', 輾死 ' + mv.killedPlayers.map(function (id) { return name(state.players[id]); }).join('、') : ''));
    return mv;
  }

  function killPlayer(state, player) {
    if (player.dead) return;
    player.dead = true;
    player.echo = true;
    player.echoUsed = {};
    // 樣本掉落原地 + 屍體
    var room = state.rooms[player.cell];
    room.dropped += player.samples;
    player.deathSamples = player.samples;
    player.samples = 0;
    room.corpses += 1;
    // 飼養者判定
    if (player.faction === 'breeder' && state.config.breederWinAny === 2) {
      // 合力模式 (測試中): 飼養者死時身上樣本累計 (含撿隊友屍體重複計) 達 breederPoolTarget → 全隊勝, 不失格
      var fp = state.factions.breeder;
      fp.deadCount += 1;
      fp.pool = (fp.pool || 0) + player.deathSamples;
      if (!fp.won && fp.pool >= breederPoolTarget(state)) { fp.won = true; state.winners.push('breeder'); logLine(state, state.round, '飼養者累計獻祭 ' + fp.pool + ' 樣本 — 飼養者勝利!'); }
    } else if (player.faction === 'breeder' && state.config.breederWinAny) {
      var fa = state.factions.breeder;
      fa.deadCount += 1;
      if (player.deathSamples >= state.config.breederSampleThreshold) {
        fa.deadWithEnough += 1;
        if (!fa.won) { fa.won = true; state.winners.push('breeder'); logLine(state, state.round, '飼養者 ' + name(player) + ' 身懷足額樣本死亡 — 飼養者勝利!'); }
      }
    } else if (player.faction === 'breeder') {
      var f = state.factions.breeder;
      f.deadCount += 1;
      if (player.deathSamples >= state.config.breederSampleThreshold) f.deadWithEnough += 1;
      else { f.disqualified = true; logLine(state, state.round, '飼養者 ' + name(player) + ' 死時樣本不足, 陣營失格!'); }
      if (!f.disqualified && f.deadCount === f.total && f.total > 0) {
        f.won = true; state.winners.push('breeder');
        logLine(state, state.round, '全體飼養者身懷足額樣本死亡 — 飼養者勝利!');
      }
    }
    logLine(state, state.round, name(player) + ' 被輾死, 成為殘響 (掉落 ' + player.deathSamples + ' 樣本)');
  }

  function breederPoolTarget(state) {
    var c = state.config;
    return c.breederPoolTarget || c.breederSampleThreshold * state.factions.breeder.total;
  }

  function checkCowVictory(state) {
    if (state.cow.dead) return;
    if (state.cow.fatness >= state.config.fatnessWin) {
      if (state.winners.indexOf('cow') < 0) state.winners.push('cow');
      endGame(state, '牛肥度達 ' + state.config.fatnessWin);
    }
  }
  function checkButcherVictory(state) {
    if (state.cow.doses.length >= state.config.poisonDoseLimit) {
      state.cow.dead = true;
      if (!state.factions.butcher.won) { state.factions.butcher.won = true; state.winners.push('butcher'); }
      if (state.winners.indexOf('cow') < 0) { /* 牛死不算牛勝 */ }
      logLine(state, state.round, '牛毒發身亡 — 屠夫勝利!');
      endGame(state, '牛毒發身亡 (' + state.cow.doses.length + ' 劑)');
    }
  }
  function checkAllEcho(state) {
    var anyAlive = state.players.some(function (p) { return !p.echo && !p.leftGame; });
    // leftGame 的逃亡者算離場; 若全部人都殘響或離場
    var anyActiveNonEcho = state.players.some(function (p) { return !p.echo && !p.leftGame; });
    if (!anyActiveNonEcho) {
      if (!state.cow.dead && state.winners.indexOf('cow') < 0) state.winners.push('cow');
      endGame(state, '全體成為殘響/離場');
    }
  }

  function endGame(state, reason) {
    if (state.gameOver) return;
    state.gameOver = true;
    state.phase = 'end';
    logLine(state, state.round, '★ 遊戲結束: ' + reason + ' — 獲勝: ' + (state.winners.length ? state.winners.join(', ') : '無'));
  }

  // ================= 回合結算 (牛移動前的噪點階段) =================
  // 解決不一致: 先衰減既有噪點, 再加入攜帶/屍體流量, 使其當回合不被衰減。
  function settleNoisePhase(state) {
    // 3. 全場噪點衰減 (先做, 見檔首說明)
    for (var i = 0; i < state.rooms.length; i++) {
      var room = state.rooms[i];
      if (room.noise > 0) {
        room.noise = Math.max(0, room.noise - state.decay);
        if (room.noise === 0) room.poison = false;
      }
    }
    // 1. 樣本攜帶噪點 (活人, 非殘響 — 殘響不持有樣本)
    for (var pi = 0; pi < state.players.length; pi++) {
      var pl = state.players[pi];
      if (pl.dead || pl.leftGame) continue;
      if (pl.samples > 0) addNoise(state, pl.cell, pl.samples * state.config.carryNoisePerSample, false);
    }
    // 2. 屍體噪點
    for (var r = 0; r < state.rooms.length; r++) {
      if (state.rooms[r].corpses > 0) addNoise(state, r, state.rooms[r].corpses * state.config.corpseNoise, false);
    }
  }

  // 完整結算一回合 (在所有人宣告完畢後呼叫)。傳回牛移動結果供 UI 逐格動畫。
  function resolveRound(state) {
    if (state.gameOver) return null;
    settleNoisePhase(state);
    var mv = applyCowMove(state);
    // 毒劑計時 -1, 排出到期 (牛已毒死/遊戲已結束就不再排出, 結束畫面才會顯示正確的劑數)
    for (var d = state.gameOver ? -1 : state.cow.doses.length - 1; d >= 0; d--) {
      state.cow.doses[d].left -= 1;
      if (state.cow.doses[d].left <= 0) { state.cow.doses.splice(d, 1); }
    }
    // 回合末: 重製者收回手牌
    for (var pi = 0; pi < state.players.length; pi++) {
      var pl = state.players[pi];
      if (pl.resetPending && !pl.echo) { pl.hand = fullHand(); pl.resetPending = false; }
    }
    // 結束條件: 回合數
    if (!state.gameOver && state.round >= state.rounds) {
      // 時間到: 沒有任何陣營達成 → 牛獲勝 (timeoutCowWins, 沒有平手)
      if (state.config.timeoutCowWins && !state.winners.length) { state.winners.push('cow'); logLine(state, state.round, '時間到, 沒有陣營達成 — 牛獲勝!'); }
      endGame(state, '第 ' + state.rounds + ' 回合結算完畢');
    }
    if (!state.gameOver) state.phase = 'resolved';
    return mv;
  }

  // ================= 預告線 (假設無人再行動的牛路徑) =================
  function computePreview(state) {
    if (state._noPreview) return state.preview; // 模擬器試算用: 跳過
    // 在 state 的複本上算, 不改真 state (撞牆會改牆)
    // 「若本回合無人再行動」= 照樣會發生攜帶/屍體噪點與衰減 → 先在複本上結算再算牛,
    // 否則預告線會跟實際走法不同 (模擬測得約 13% 回合不準)。
    var clone = cloneState(state);
    clone._noPreview = true;
    if (state.phase !== 'resolved' && state.phase !== 'end') settleNoisePhase(clone);
    var mv = computeCowMove(clone);
    state.preview = {
      stay: mv.stay, target: mv.target, reached: mv.reached,
      path: mv.path, splashCells: mv.splashCells, killedCells: mv.killedCells, smashed: mv.smashed
    };
    return state.preview;
  }

  // ================= 宣告隊列顯示 =================
  function computeQueue(state) {
    var dist = bfsDist(state, state.cow.cell);
    var actors = state.players.filter(function (p) { return !p.leftGame; });
    actors.sort(function (a, b) {
      var da = dist[a.cell], db = dist[b.cell];
      if (da !== db) return da - db;
      var na = state.rooms[a.cell].noise, nb = state.rooms[b.cell].noise;
      if (na !== nb) return nb - na;
      return a.seat - b.seat;
    });
    return actors.map(function (p) { return p.id; });
  }

  // ================= 工具 =================
  function name(p) { return p.name + (p.echo ? '(殘)' : ''); }
  function logLine(state, round, text) { state.log.push({ round: round, text: text, t: Date.now() }); }

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  function deepMerge(base, over) {
    for (var k in over) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) base[k] = deepMerge(base[k] || {}, over[k]);
      else base[k] = over[k];
    }
    return base;
  }

  // 深複製 state (處理 Set walls)
  function cloneState(state) {
    var walls = state.walls;
    var arr = Array.from(walls);
    var copy = JSON.parse(JSON.stringify(Object.assign({}, state, { walls: arr })));
    copy.walls = new Set(arr);
    return copy;
  }
  function snapshot(state) {
    var arr = Array.from(state.walls);
    return JSON.stringify(Object.assign({}, state, { walls: arr }));
  }
  function restore(str) {
    var o = JSON.parse(str);
    o.walls = new Set(o.walls);
    return o;
  }

  var api = {
    // 生成/流程
    newGame: newGame, startRound: startRound, registerFlip: registerFlip, buildQueue: buildQueue,
    declareCard: declareCard, forfeitCard: forfeitCard, giveSamples: giveSamples, dropSamples: dropSamples, remainingCards: remainingCards, advanceActor: advanceActor, resolveRound: resolveRound,
    // 查詢
    currentActor: currentActor, expectedCardCount: expectedCardCount, handList: handList,
    computeQueue: computeQueue, computePreview: computePreview, computeCowMove: computeCowMove,
    selectCowTarget: selectCowTarget, bfsDist: bfsDist, shortestPath: shortestPath,
    shortestPathMinTurns: shortestPathMinTurns, isConnected: isConnected, isSealed: isSealed,
    refreshExits: refreshExits,
    canTransfer: canTransfer,
    // 牆/座標工具
    rc: rc, cell: cell, neighbors: neighbors, hasWall: hasWall, addWall: addWall, removeWall: removeWall,
    edgeKey: edgeKey, cellName: cellName, isOuterRing: isOuterRing, areAdjacent: areAdjacent,
    generateWalls: generateWalls, clockwiseFirst: clockwiseFirst,
    // 狀態序列化
    cloneState: cloneState, snapshot: snapshot, restore: restore,
    // 直接暴露內部供測試組裝狀態
    addNoise: addNoise, killPlayer: killPlayer, applyCowMove: applyCowMove, settleNoisePhase: settleNoisePhase,
    mulberry32: mulberry32, DIRS: DIRS, fullHand: fullHand, breederPoolTarget: breederPoolTarget
  };

  root.SFCC_ENGINE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
