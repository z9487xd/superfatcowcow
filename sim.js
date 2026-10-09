/* 超肥牛牛 ── 自動對局模擬器 (平衡測試用)
 *
 * 讓電腦玩家照各陣營目標打完整局, 統計勝率、結束原因、死亡數等。
 * 用的是跟操作台同一份 engine.js, 規則完全一致。
 *
 *   node sim.js                         8 人, 聰明 bot, 100 場
 *   node sim.js --players 12 --games 200
 *   node sim.js --bot random            亂打 bot (對照組)
 *   node sim.js --set breederSampleThreshold=4 --set poisonDoseLimit=4
 *   node sim.js --rounds 8 --exits 1,3,5,7
 *   node sim.js --reset late            bot 不得已才打重製 (照規則書的 2→2→1)
 *   node sim.js --reset always          bot 每回合都帶重製 (1 張行動 + 重製)
 *   node sim.js --json                  輸出 JSON (給 sim-all 用)
 *   node sim.js --coop 2                飼養者積極會合交付 (0 = 原本, 1 = 會合, 2 = 全力會合)
 *   node sim.js --dumb butcher          指定陣營亂打, 其他陣營照常 (可用逗號列多個)
 *
 * 電腦玩家 (smart bot) 的想法:
 *   翻牌時: 依陣營目標與當下處境挑卡別 (要樣本→移動+互動、屠夫有樣本→誘導…)。
 *   宣告時: 把手上兩張牌的「先後順序 × 每個合法目標」逐一在複本上試算,
 *           含本回合噪點結算與牛的移動, 用陣營評分挑最好的一組。
 *   它只看「這回合結束時」的局面, 不做多回合規劃, 也不跟隊友事先串通;
 *   屠夫靠「把毒下在牛這回合會吃的那格」自然形成合作。
 */
'use strict';
var E = require('./engine.js');
var CFG = require('./config.js');

// ================= 參數 =================
function parseArgs(argv) {
  var o = { players: 8, games: 100, bot: 'smart', set: {}, rounds: null, exits: null, json: false, seed: 1, reset: 'early', coop: 0, dumb: [] };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--players') o.players = +argv[++i];
    else if (a === '--games') o.games = +argv[++i];
    else if (a === '--bot') o.bot = argv[++i];
    else if (a === '--rounds') o.rounds = +argv[++i];
    else if (a === '--exits') o.exits = argv[++i].split(',').map(Number);
    else if (a === '--seed') o.seed = +argv[++i];
    else if (a === '--reset') o.reset = argv[++i];   // early: 手剩3張就重製 (兩回合一循環) / late: 不得已才重製 (2→2→1)
    else if (a === '--json') o.json = true;
    else if (a === '--coop') o.coop = +argv[++i];
    else if (a === '--dumb') o.dumb = argv[++i].split(',');
    else if (a === '--set') { var kv = argv[++i].split('='); o.set[kv[0]] = +kv[1]; }
  }
  return o;
}

// ================= 小工具 =================
function clone(st) { var c = E.cloneState(st); c._noPreview = true; c.log = []; return c; }
function aliveP(p) { return !p.dead && !p.leftGame; }

// 預測: 對 (已含玩家行動的) 狀態跑完本回合噪點結算 + 牛移動
function predict(st) {
  var c = clone(st);
  E.settleNoisePhase(c);
  var mv = E.computeCowMove(c);
  return { c: c, mv: mv };
}

function nearestDist(dist, cells) {
  var best = Infinity;
  for (var i = 0; i < cells.length; i++) if (dist[cells[i]] < best) best = dist[cells[i]];
  return best;
}
function sampleSources(st) {
  var out = [];
  st.rooms.forEach(function (r, i) { if ((r.device === 'sample_box' && r.boxRemaining > 0) || r.dropped > 0) out.push(i); });
  return out;
}

// 飼養者這一位要帶幾個才去死: 一般 = 門檻; 合力模式 = min(補足差額, 平分份額)
function breederNeed(st, q) {
  var cfg = st.config;
  if (cfg.breederWinAny !== 2) return cfg.breederSampleThreshold;
  var fb = st.factions.breeder, tgt = E.breederPoolTarget(st), left = tgt - (fb.pool || 0);
  var aliveB = st.players.filter(function (x) { return x.faction === 'breeder' && !x.dead; }).length;
  return Math.max(1, Math.min(left, aliveB > 1 ? Math.ceil(left / aliveB) : left));
}
function breederReady(st, q) { return q.samples >= breederNeed(st, q); }
// 交付模式: 活著的飼養者中樣本最多者當「主祭」(平手取編號小), 其他人把樣本交給他
function carrierOf(st) {
  var best = null;
  st.players.forEach(function (x) {
    if (x.faction !== 'breeder' || x.dead || x.leftGame) return;
    if (!best || x.samples > best.samples) best = x;
  });
  return best;
}

// ================= 評分 (從某陣營的角度) =================
function scoreFor(faction, st, mv, actorId, rng) {
  var cfg = st.config, s = 0;
  var killedSet = {};
  if (!mv.stay) mv.killedCells.forEach(function (k) { killedSet[k] = true; });
  var sources = sampleSources(st);
  var cowDist = E.bfsDist(st, mv.path[mv.path.length - 1]);

  st.players.forEach(function (q) {
    if (q.faction !== faction) return;
    var me = q.id === actorId ? 1.0 : 0.6;   // 自己的狀況權重較高
    if (q.leftGame) { if (q.faction === 'runner') s += 400; return; }
    if (q.dead) return;
    var killed = killedSet[q.cell];
    var dist = E.bfsDist(st, q.cell);
    if (faction === 'breeder' && (cfg.teamTransfer || cfg.breederTransfer)) {
      var car = carrierOf(st), isCar = car && car.id === q.id, thrT = cfg.breederSampleThreshold;
      me = 1; // 交付模式: 飼養者以全隊為準, 交出樣本不算自己吃虧
      if (killed) { s += q.samples >= thrT ? 300 : -(60 + q.samples * 15); return; }
      var coopW = 1 + (COOP || 0) * 1.5; // --coop: 會合的權重
      if (isCar) {
        s += Math.min(q.samples, thrT) * 14 * me;
        st.players.forEach(function (x) { if (x.faction === 'breeder' && x.id !== q.id && !x.dead && !x.leftGame && x.samples > 0 && q.samples < thrT) s -= Math.min(dist[x.cell], 10) * 1.5 * coopW * me; }); // 往帶著樣本的隊友靠
        if (q.samples >= thrT) s -= cowDist[q.cell] * 6 * me;
        else { s -= Math.min(nearestDist(dist, sources), 8) * 2 * me; if (cowDist[q.cell] <= 1) s -= 15 * me; }
      } else {
        s += q.samples * 6 * me;   // 散在隊友身上的樣本價值較低: 集中到主祭才算數
        if (q.samples > 0 && car) s -= Math.min(dist[car.cell], 10) * Math.max(q.samples, COOP >= 2 ? 3 : 0) * coopW * me; // 帶著樣本去找主祭
        s -= Math.min(nearestDist(dist, sources), 12) * 3 * me;                      // 一直留意下一份樣本
        if (cowDist[q.cell] <= 1) s -= 15 * me;
      }
      return;
    }
    if (faction === 'breeder') {
      var full = breederReady(st, q), bthr = breederNeed(st, q);
      if (killed) {
        if (cfg.breederWinAny === 2) {   // 合力: 達標就贏, 沒達標但有貢獻也有價值
          var fb = st.factions.breeder, pool = fb.pool || 0, tgt = E.breederPoolTarget(st);
          if (pool + q.samples >= tgt) s += 300;
          else if (full) s += 120 + q.samples * 10;
          else s += q.samples >= 2 ? q.samples * 15 - 80 : -400;
          return;
        }
        s += full ? 300 : -400; return;
      }
      cfg = Object.assign({}, cfg, { breederSampleThreshold: bthr });
      s += Math.min(q.samples, cfg.breederSampleThreshold) * 12 * me;
      if (full) s -= cowDist[q.cell] * 6 * me;                     // 靠近牛
      else {
        s -= Math.min(nearestDist(dist, sources), 8) * 2 * me;      // 去拿樣本
        if (cowDist[q.cell] <= 1) s -= 15 * me;
      }
    } else if (faction === 'runner') {
      if (killed) { s -= 120; return; }
      s += Math.min(q.samples, cfg.runnerSampleThreshold) * 12 * me;
      if (q.samples >= cfg.runnerSampleThreshold && st.exitCells.length) s -= nearestDist(dist, st.exitCells) * 10 * me;
      else s -= Math.min(nearestDist(dist, sources), 8) * 2 * me;
      if (cowDist[q.cell] <= 1) s -= 10 * me;
    } else if (faction === 'butcher') {
      if (killed) { s -= 120; return; }
      s += Math.min(q.samples, 2) * 10 * me;
      if (q.samples < 1) s -= Math.min(nearestDist(dist, sources), 8) * 2 * me;
      if (cowDist[q.cell] <= 1) s -= 10 * me;
    }
  });
  // 牛的這一餐
  if (faction === 'butcher' && mv.poisonedThisMeal) s += 250 + 100 * st.cow.doses.length;
  if (mv.evolvedTo) s -= 15;
  return s + rng() * 0.5; // 打破平手
}

// ================= 翻牌: 挑卡別 =================
function chooseCards(st, p, rng, bot, resetPolicy) {
  var hand = E.handList(p), need = E.expectedCardCount(st, p);
  if (need === 0) return [];
  if (bot === 'random' || DUMB.indexOf(p.faction) >= 0) return shuffle(hand.slice(), rng).slice(0, need);
  if (p.echo) return [hand.indexOf('lure') >= 0 ? 'lure' : hand[0]];
  if (hand.length === 1) return hand.slice();

  var cfg = st.config, room = st.rooms[p.cell];
  var dist = E.bfsDist(st, p.cell), sources = sampleSources(st);
  var thr = p.faction === 'breeder' ? breederNeed(st, p) : p.faction === 'runner' ? cfg.runnerSampleThreshold : 2;
  var wantSamples = p.samples < thr;
  var pr = { move: 5, env: 0, interact: 0, lure: 1, reset: 0 };
  var onSource = (room.device === 'sample_box' && room.boxRemaining > 0) || room.dropped > 0;
  if (wantSamples && onSource) pr.interact = 9;
  else if (wantSamples && nearestDist(dist, sources) <= 2) pr.interact = 7;
  if (p.faction === 'butcher' && p.samples > 0) pr.lure = 8;
  if (p.faction === 'breeder' && !wantSamples) pr.lure = 3;
  if (p.faction === 'breeder' && (cfg.teamTransfer || cfg.breederTransfer)) {
    var car = carrierOf(st);
    if (car && car.id !== p.id) {
      wantSamples = true;
      var dCar = dist[car.cell];
      if (COOP && p.samples >= (COOP >= 2 ? 1 : 2) && car.cell !== p.cell) pr.move = 11; // 約好會合: 一定帶移動
      if (car.cell === p.cell && p.samples > 0) pr.interact = 10;                 // 同房: 交付
      else if (p.samples > 0 && dCar <= 2) { pr.move = 9.5; pr.interact = 9; }    // 走過去 + 交付, 同一回合
      else if (p.samples >= (COOP ? 1 : 2) || !sources.length) { pr.move = 8; pr.interact = Math.min(pr.interact, 4); } // 帶著樣本去找主祭
    }
  }
  var pv = predict(st).mv;
  if (!pv.stay && pv.killedCells.indexOf(p.cell) >= 0 && !(p.faction === 'breeder' && !wantSamples)) { pr.move = 10; pr.env = 4; }
  // 重製: 手上剩 3 張以內就搭一張重製 (兩回合一循環最有效率)
  if (hand.indexOf('reset') >= 0 && hand.length <= 3 && resetPolicy !== 'late') pr.reset = 6;
  if (resetPolicy === 'late') pr.reset = -1;
  if (resetPolicy === 'always' && hand.indexOf('reset') >= 0) pr.reset = 100; // 每回合都帶重製 (1 張行動 + 重製)
  var ranked = hand.slice().sort(function (a, b) { return pr[b] - pr[a] || rng() - 0.5; });
  return ranked.slice(0, need);
}

function shuffle(a, rng) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

// ================= 宣告: 每張牌的候選目標 =================
function optionsFor(st, p, card, bot) {
  var out = [], N = st.N;
  if (card === 'move') {
    var d = E.bfsDist(st, p.cell);
    for (var i = 0; i < d.length; i++) if (d[i] <= 2) out.push({ dest: i });
  } else if (card === 'lure') {
    var d2 = E.bfsDist(st, p.cell);
    var canPoison = !p.echo && p.samples > 0 && p.faction === 'butcher';
    for (var j = 0; j < d2.length; j++) if (d2[j] <= 3) {
      out.push({ target: j });
      if (canPoison) out.push({ target: j, poison: true });
    }
  } else if (card === 'env') {
    E.neighbors(p.cell, N).forEach(function (nb) {
      out.push({ wallCell: nb.cell, op: E.hasWall(st, p.cell, nb.cell) ? 'remove' : 'add' });
    });
  } else if (card === 'interact') {
    if (st.rooms[p.cell].device === 'echo') E.neighbors(p.cell, N).forEach(function (nb) { out.push({ echoTarget: nb.cell }); });
    else out.push({});
    if (st.config.breederTransfer && p.faction === 'breeder' && p.samples + st.rooms[p.cell].dropped > 0)
      st.players.forEach(function (x) { if (x.id !== p.id && x.faction === 'breeder' && !x.dead && !x.leftGame && x.cell === p.cell) out.push({ giveTo: x.id }); });
  } else out.push({});
  return out;
}

// 在複本上試打一張牌; 不合法傳回 null
function tryCard(st, pid, card, params) {
  var c = clone(st);
  try { E.declareCard(c, pid, card, params); } catch (e) { return null; }
  return c;
}

// 同陣營交付 (宣告前、後各檢查一次)
//   飼養者: 非主祭跟主祭同房就把樣本全交過去
//   逃亡者: 樣本較少的人把樣本全交給同房、樣本最多的逃亡者 (集中給一個人衝出口)
//   屠夫:   有 2 個以上的人分 1 個給同房、沒有樣本的屠夫 (多一個人能下毒)
function freeGive(st, p, stats) {
  if (DUMB.indexOf(p.faction) >= 0 || p.dead || p.leftGame || p.samples < 1) return;
  var mates = st.players.filter(function (x) { return x.id !== p.id && !x.dead && !x.leftGame && x.cell === p.cell && E.canTransfer(st, p, x); });
  if (!mates.length) return;
  if (p.faction === 'runner') {
    var lead = mates.filter(function (x) { return x.samples > p.samples || (x.samples === p.samples && x.id < p.id); })
      .sort(function (a, b) { return b.samples - a.samples; })[0];
    if (lead) { E.giveSamples(st, p.id, lead.id); stats.transfers++; }
    return;
  }
  if (p.faction === 'butcher') {
    var empty = mates.filter(function (x) { return x.samples === 0; })[0];
    if (empty && p.samples >= 2) { E.giveSamples(st, p.id, empty.id, 1); stats.transfers++; }
    return;
  }
  if (p.faction !== 'breeder') return;
  var car = carrierOf(st);
  var mate = car && car.id !== p.id && car.cell === p.cell ? car
    : st.players.filter(function (x) { return x.faction === 'breeder' && x.id !== p.id && !x.dead && !x.leftGame && x.cell === p.cell && x.samples >= p.samples; })[0];
  if (mate) { E.giveSamples(st, p.id, mate.id); stats.transfers++; }
}

function declareTurn(st, p, rng, bot, stats) {
  freeGive(st, p, stats);
  coopMove(st, p, stats);
  declareTurnCards(st, p, rng, bot, stats);
  freeGive(st, p, stats);
}

// --coop: 像真人一樣「約好會合」。帶著樣本的飼養者 (coop 1: 2 個以上; coop 2: 1 個以上)
// 直接往主祭走; coop 2 時主祭也迎上去。其他牌照常由評分決定。
function coopMove(st, p, stats) {
  if (!COOP || !(st.config.teamTransfer || st.config.breederTransfer === 2) || p.faction !== 'breeder' || p.dead || p.leftGame) return;
  if (E.remainingCards(st, p.id).indexOf('move') < 0 || DUMB.indexOf('breeder') >= 0) return;
  var car = carrierOf(st); if (!car) return;
  var goal = null;
  if (car.id !== p.id) { if (p.samples >= (COOP >= 2 ? 1 : 2)) goal = car.cell; }
  else if (COOP >= 2 && car.samples < st.config.breederSampleThreshold) {
    var dCar = E.bfsDist(st, car.cell), mate = null;
    st.players.forEach(function (x) { if (x.faction === 'breeder' && x.id !== car.id && !x.dead && !x.leftGame && x.samples > 0 && (!mate || dCar[x.cell] < dCar[mate.cell])) mate = x; });
    if (mate && dCar[mate.cell] > 0 && dCar[mate.cell] <= 5) goal = mate.cell;
  }
  if (goal == null || goal === p.cell) return;
  var dGoal = E.bfsDist(st, goal), dMe = E.bfsDist(st, p.cell), best = null;
  for (var i = 0; i < dMe.length; i++) if (dMe[i] <= 2 && (best == null || dGoal[i] < dGoal[best])) best = i;
  if (best == null || dGoal[best] >= dGoal[p.cell]) return;
  try { E.declareCard(st, p.id, 'move', { dest: best }); stats.coopMoves = (stats.coopMoves || 0) + 1; } catch (e) {}
  freeGive(st, p, stats);
}
function declareTurnCards(st, p, rng, bot, stats) {
  var cards = E.remainingCards(st, p.id);
  if (!cards.length || p.leftGame) return; // 會合時走出出口 / 牌已出完
  if (DUMB.indexOf(p.faction) >= 0) bot = 'random';
  if (bot === 'random') {
    cards.forEach(function (card) {
      if (E.remainingCards(st, p.id).indexOf(card) < 0) return; // 已走出出口
      var opts = shuffle(optionsFor(st, p, card, bot), rng);
      for (var i = 0; i < opts.length; i++) { try { E.declareCard(st, p.id, card, opts[i]); return; } catch (e) {} }
      E.forfeitCard(st, p.id, card); stats.forfeits[card] = (stats.forfeits[card] || 0) + 1;
    });
    return;
  }
  var orders = cards.length === 2 ? [[cards[0], cards[1]], [cards[1], cards[0]]] : [cards];
  var best = null;
  orders.forEach(function (ord) {
    var cur = st, plan = [];
    for (var k = 0; k < ord.length; k++) {
      if (cur.players[p.id].leftGame) { var prL = predict(cur), scL = scoreFor(p.faction, prL.c, prL.mv, p.id, rng); if (!best || scL > best.sc) best = { sc: scL, plan: plan.slice() }; break; }
      var card = ord[k], opts = optionsFor(cur, cur.players[p.id], card, bot), pick = null;
      for (var i = 0; i < opts.length; i++) {
        var c = tryCard(cur, p.id, card, opts[i]);
        if (!c) continue;
        var pr = predict(c);
        var sc = scoreFor(p.faction, pr.c, pr.mv, p.id, rng);
        if (!pick || sc > pick.sc) pick = { sc: sc, params: opts[i], st: c };
      }
      if (!pick) { plan.push({ card: card, forfeit: true }); var cf = clone(cur); E.forfeitCard(cf, p.id, card); cur = cf; continue; }
      plan.push({ card: card, params: pick.params }); cur = pick.st;
      if (k === ord.length - 1) { if (!best || pick.sc > best.sc) best = { sc: pick.sc, plan: plan }; }
    }
    if (plan.length && plan[plan.length - 1].forfeit) {
      var pr2 = predict(cur), sc2 = scoreFor(p.faction, pr2.c, pr2.mv, p.id, rng);
      if (!best || sc2 > best.sc) best = { sc: sc2, plan: plan };
    }
  });
  best.plan.forEach(function (step) {
    if (E.remainingCards(st, p.id).indexOf(step.card) < 0) return; // 已走出出口
    if (step.forfeit) { E.forfeitCard(st, p.id, step.card); stats.forfeits[step.card] = (stats.forfeits[step.card] || 0) + 1; }
    else {
      if (step.params.poison) stats.poisonLures++;
      if (step.params.giveTo != null) stats.transfers++;
      E.declareCard(st, p.id, step.card, step.params);
    }
  });
}

// ================= 一整局 =================
var COOP = 0, DUMB = [];
function playGame(o, gi) {
  COOP = o.coop || 0; DUMB = o.dumb || [];
  var rng = E.mulberry32(o.seed * 100003 + gi * 7919);
  var names = []; for (var i = 0; i < o.players; i++) names.push({ name: 'P' + (i + 1) });
  var st = E.newGame({ players: names, rng: rng, seed: (o.seed * 31 + gi) >>> 0, config: o.set, rounds: o.rounds || undefined });
  if (o.exits) { st.table.exitSchedule = o.exits; st.table.exitSchedule2 = o.exits.map(function (x) { return x + 1; }); }
  var stats = {
    forfeits: {}, poisonLures: 0, transfers: 0, kills: 0, cowStay: 0, previewMiss: 0, rounds: 0, resetOnly: 0,
    queueTies: 0, queueSlots: 0, deaths: [], breederDQ: false, maxNoise: 0, samplesTaken: 0, firstDeathRound: null, doses: 0
  };
  var guard = 0;
  E.startRound(st);
  while (!st.gameOver && guard++ < 60) {
    st.log = [];
    // 翻牌
    st.players.forEach(function (p) {
      if (p.leftGame) return;
      var cards = chooseCards(st, p, rng, o.bot, o.reset);
      if (!p.echo && cards.length === 1 && cards[0] === 'reset') stats.resetOnly++;
      E.registerFlip(st, p.id, cards);
    });
    E.buildQueue(st);
    // 隊列平手 (距離相同)
    var dq = E.bfsDist(st, st.cow.cell), seenD = {};
    st.queue.forEach(function (id) { var dd = dq[st.players[id].cell]; stats.queueSlots++; if (seenD[dd]) stats.queueTies++; seenD[dd] = true; });
    // 宣告
    var a;
    while (!st.gameOver && (a = E.currentActor(st))) {
      if (E.remainingCards(st, a.id).length) declareTurn(st, a, rng, o.bot, stats);
      E.advanceActor(st);
    }
    // 預告線 (操作台畫的那條) vs 實際
    var shown = st.preview;
    st.rooms.forEach(function (r) { if (r.noise > stats.maxNoise) stats.maxNoise = r.noise; });
    var before = st.players.filter(function (p) { return !p.dead; }).length;
    var aliveIds = st.players.filter(function (p) { return !p.dead; }).map(function (p) { return p.id; });
    var dosesBefore = st.cow.doses.length;
    var mv = E.resolveRound(st);
    stats.rounds++;
    if (mv && mv.stay) stats.cowStay++;
    if (mv && shown && JSON.stringify(shown.path) !== JSON.stringify(mv.path)) stats.previewMiss++;
    if (mv && mv.poisonedThisMeal) stats.doses++;
    var after = st.players.filter(function (p) { return !p.dead; }).length;
    stats.kills += before - after;
    aliveIds.forEach(function (id) { var p = st.players[id]; if (p.dead) stats.deaths.push({ f: p.faction, s: p.deathSamples, r: st.round }); });
    if (before > after && stats.firstDeathRound == null) stats.firstDeathRound = st.round;
    if (st.factions.breeder.won && !stats.breederWinRound) stats.breederWinRound = st.round;
    if (!st.gameOver) E.startRound(st);
    if (o.stopRound && st.round >= o.stopRound) return { state: st };
  }
  var reason = st.cow.doses.length >= st.config.poisonDoseLimit ? 'poison'
    : st.cow.fatness >= st.config.fatnessWin ? 'fat'
    : !st.players.some(function (p) { return !p.echo && !p.leftGame; }) ? 'allEcho' : 'rounds';
  var boxLeft = 0; st.rooms.forEach(function (r) { if (r.device === 'sample_box') boxLeft += r.boxRemaining; });
  return {
    winners: st.winners.slice(), reason: reason, rounds: st.round, fat: st.cow.fatness,
    breederDQ: st.factions.breeder.disqualified, escaped: st.players.filter(function (p) { return p.leftGame; }).length,
    boxLeft: boxLeft, stats: stats, breederWinRound: stats.breederWinRound || null
  };
}

// ================= 彙總 =================
function runBatch(o) {
  var res = [];
  for (var g = 0; g < o.games; g++) res.push(playGame(o, g));
  var n = res.length;
  function pct(f) { return Math.round(res.filter(f).length / n * 1000) / 10; }
  function avg(f) { return Math.round(res.reduce(function (s, r) { return s + f(r); }, 0) / n * 100) / 100; }
  var forfeits = {};
  res.forEach(function (r) { for (var k in r.stats.forfeits) forfeits[k] = (forfeits[k] || 0) + r.stats.forfeits[k]; });
  return {
    games: n,
    win: {
      cow: pct(function (r) { return r.winners.indexOf('cow') >= 0; }),
      breeder: pct(function (r) { return r.winners.indexOf('breeder') >= 0; }),
      butcher: pct(function (r) { return r.winners.indexOf('butcher') >= 0; }),
      runner: pct(function (r) { return r.winners.indexOf('runner') >= 0; }),
      none: pct(function (r) { return r.winners.length === 0; })
    },
    reason: {
      rounds: pct(function (r) { return r.reason === 'rounds'; }),
      fat: pct(function (r) { return r.reason === 'fat'; }),
      poison: pct(function (r) { return r.reason === 'poison'; }),
      allEcho: pct(function (r) { return r.reason === 'allEcho'; })
    },
    avgRounds: avg(function (r) { return r.rounds; }),
    avgFat: avg(function (r) { return r.fat; }),
    avgKills: avg(function (r) { return r.stats.kills; }),
    firstDeath: avg(function (r) { return r.stats.firstDeathRound || r.rounds + 1; }),
    breederDQ: pct(function (r) { return r.breederDQ; }),
    avgDoses: avg(function (r) { return r.stats.doses; }),
    poisonLures: avg(function (r) { return r.stats.poisonLures; }),
    transfers: avg(function (r) { return r.stats.transfers; }),
    breederWinRound: (function () { var w = res.filter(function (r) { return r.breederWinRound; }); return w.length ? Math.round(w.reduce(function (a, r) { return a + r.breederWinRound; }, 0) / w.length * 10) / 10 : null; })(),
    cowStayRate: Math.round(res.reduce(function (s, r) { return s + r.stats.cowStay; }, 0) / res.reduce(function (s, r) { return s + r.stats.rounds; }, 0) * 1000) / 10,
    previewMissRate: Math.round(res.reduce(function (s, r) { return s + r.stats.previewMiss; }, 0) / res.reduce(function (s, r) { return s + r.stats.rounds; }, 0) * 1000) / 10,
    queueTieRate: Math.round(res.reduce(function (s, r) { return s + r.stats.queueTies; }, 0) / Math.max(1, res.reduce(function (s, r) { return s + r.stats.queueSlots; }, 0)) * 1000) / 10,
    boxLeft: avg(function (r) { return r.boxLeft; }),
    escaped: avg(function (r) { return r.escaped; }),
    maxNoise: avg(function (r) { return r.stats.maxNoise; }),
    resetOnlyPerGame: avg(function (r) { return r.stats.resetOnly; }),
    forfeitsPerGame: Object.keys(forfeits).reduce(function (o2, k) { o2[k] = Math.round(forfeits[k] / n * 100) / 100; return o2; }, {})
  };
}

if (require.main === module) {
  var o = parseArgs(process.argv.slice(2));
  var t0 = Date.now();
  var r = runBatch(o);
  if (o.json) { console.log(JSON.stringify(r)); return; }
  console.log('超肥牛牛 模擬: ' + o.players + ' 人, ' + o.games + ' 場, bot=' + o.bot +
    (Object.keys(o.set).length ? ', ' + JSON.stringify(o.set) : '') + (o.rounds ? ', 回合 ' + o.rounds : '') + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  console.log('勝率 %: 牛 ' + r.win.cow + ' | 飼養者 ' + r.win.breeder + ' | 屠夫 ' + r.win.butcher + ' | 逃亡者 ' + r.win.runner + ' | 無人 ' + r.win.none);
  console.log('結束原因 %: 回合用完 ' + r.reason.rounds + ' | 肥度9 ' + r.reason.fat + ' | 毒死 ' + r.reason.poison + ' | 全殘響 ' + r.reason.allEcho);
  console.log('平均: 回合 ' + r.avgRounds + ', 牛肥度 ' + r.avgFat + ', 死亡 ' + r.avgKills + ' 人, 首殺回合 ' + r.firstDeath + ', 吃到毒 ' + r.avgDoses + ' 劑');
  console.log('飼養者交付 ' + r.transfers + ' 次/場, 飼養者獲勝平均回合 ' + r.breederWinRound + ', 飼養者失格 ' + r.breederDQ + '%, 逃出 ' + r.escaped + ' 人/場, 樣本箱剩 ' + r.boxLeft + ', 最高噪點 ' + r.maxNoise);
  console.log('牛原地不動 ' + r.cowStayRate + '% 回合, 預告線與實際不同 ' + r.previewMissRate + '% 回合, 隊列距離平手 ' + r.queueTieRate + '%');
  console.log('作廢牌/場 ' + JSON.stringify(r.forfeitsPerGame) + ', 只剩重製的回合/場 ' + r.resetOnlyPerGame);
}

module.exports = { runBatch: runBatch, playGame: playGame };
