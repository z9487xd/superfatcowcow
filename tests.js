/* 超肥牛牛 ── 牛演算法單元測試
 * 必寫的八個情況 (最初的建置需求): 繞路、撞牆、半路停下、目標封死、
 * 平手取最近、平手取順時針、波及範圍、起點不殺人。
 * 這八個錯一個現場就會吵架 → 全部斷言。
 *
 * 執行: node tests.js   或   在瀏覽器開 tests.html
 */
(function (root) {
  'use strict';

  var CFG = root.SFCC_CONFIG || (typeof require !== 'undefined' ? require('./config.js') : null);
  var E = root.SFCC_ENGINE || (typeof require !== 'undefined' ? require('./engine.js') : null);

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  // 建立最小測試狀態 (完全可控, 不經 newGame 的隨機)
  function blankState(N, decay) {
    var rooms = [];
    for (var i = 0; i < N * N; i++) rooms.push({ noise: 0, poison: false, device: null, boxRemaining: 0, corpses: 0, dropped: 0, isExit: false });
    return {
      config: deepCopy(CFG.DEFAULT_CONFIG),
      N: N, decay: decay == null ? 1 : decay,
      table: { N: N, decay: decay == null ? 1 : decay, devices: {}, exits: 1, exitSchedule: [], exitSchedule2: [] },
      count: 0, rounds: 12, round: 1, phase: 'resolve',
      walls: new Set(), rooms: rooms,
      cow: { cell: cell(Math.floor(N / 2), Math.floor(N / 2), N), fatness: 1, doses: [], target: null },
      players: [],
      factions: { breeder: { disqualified: false, won: false, total: 0, deadWithEnough: 0, deadCount: 0 }, butcher: { won: false }, runner: { won: false } },
      exitCells: [], lastExitCells: [], queue: [], queueIndex: 0, flips: {}, preview: null,
      log: [], winners: [], gameOver: false, seed: 1
    };
  }
  function cell(r, c, N) { return r * N + c; }
  function addWall(s, a, b) { s.walls.add(E.edgeKey(a, b)); }
  function addPlayer(s, cellIdx, faction) {
    var p = { id: s.players.length, name: 'P' + s.players.length, faction: faction || 'runner', cell: cellIdx, samples: 0, hand: E.fullHand(), echo: false, dead: false, leftGame: false, seat: s.players.length, resetPending: false, echoUsed: {}, deathSamples: null };
    s.players.push(p); return p;
  }

  // ---- 迷你測試框架 ----
  var results = [];
  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, err: e.message || String(e) }); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || '斷言失敗'); }
  function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + b + ' 得到 ' + a); }
  function arrHas(arr, v) { return arr.indexOf(v) >= 0; }
  function pathPassable(s, path) { for (var i = 1; i < path.length; i++) if (!E.areAdjacent(path[i - 1], path[i], s.N) || s.walls.has(E.edgeKey(path[i - 1], path[i]))) return false; return true; }

  // ============ 1. 繞路 ============
  test('繞路: 肥度1–3 遇牆走最短可通行路徑', function () {
    var s = blankState(3);
    s.cow.cell = 0; s.cow.fatness = 1;
    s.rooms[2].noise = 5;             // 目標在 (0,2)
    addWall(s, 1, 2);                 // 擋掉直達
    var full = E.shortestPathMinTurns(s, 0, 2);
    assert(full, '應找得到繞路');
    eq(full.length, 5, '繞路長度 (4步)');
    assert(pathPassable(s, full), '路徑每步須可通行');
    for (var i = 1; i < full.length; i++) assert(!(full[i - 1] === 1 && full[i] === 2 || full[i - 1] === 2 && full[i] === 1), '不可穿越被擋的牆');
    var mv = E.computeCowMove(blankStateClone(s));
    eq(mv.path.length, 3, '肥度1 只走2步'); eq(mv.reached, false, '沒走到目標');
  });

  // ============ 2. 撞牆 ============
  test('撞牆: 肥度4+ 幾何直線撞穿沿路牆', function () {
    var s = blankState(3);
    s.cow.cell = 0; s.cow.fatness = 4;
    s.rooms[2].noise = 5;
    addWall(s, 1, 2);
    var mv = E.computeCowMove(s);     // 會實際移除牆
    assert(arrHas(mv.smashed, E.edgeKey(1, 2)), '應撞穿 1|2 牆');
    assert(!s.walls.has(E.edgeKey(1, 2)), '牆永久消失');
    eq(mv.reached, true, '直線抵達目標');
    eq(mv.path.join(','), '0,1,2', '路徑 0→1→2');
  });

  // ============ 3. 半路停下 ============
  test('半路停下: 路徑較長走到最遠處, 不吃不長', function () {
    var s = blankState(5);
    s.cow.cell = 0; s.cow.fatness = 1;
    s.rooms[4].noise = 5;             // (0,4) 距離4
    var mv = E.computeCowMove(s);
    eq(mv.path.length, 3, '肥度1 走2步停下');
    eq(mv.reached, false, '沒抵達目標');
    eq(mv.ate, 0, '半路停下不吃');
    eq(mv.evolvedTo, null, '不進化');
  });

  // ============ 4. 目標封死 ============
  test('目標封死: 撞穿一面朝目標的相鄰牆, 移動結束', function () {
    var s = blankState(3);
    s.cow.cell = 5; s.cow.fatness = 1;
    s.rooms[8].noise = 5;            // 角落 (2,2)
    addWall(s, 8, 5); addWall(s, 8, 7); // 封死 8
    var dist = E.bfsDist(s, 5);
    eq(dist[8], Infinity, '目標確實封死');
    var mv = E.computeCowMove(s);
    eq(mv.smashed.length, 1, '撞穿一面牆');
    eq(mv.smashed[0], E.edgeKey(5, 8), '撞的是朝目標那面');
    eq(mv.reached, false, '本回合不抵達');
  });

  // ============ 5. 平手取最近 ============
  test('平手取最近: 噪點相同取離牛最近', function () {
    var s = blankState(5);           // 牛在中央 12
    s.rooms[11].noise = 5;           // (2,1) 距1
    s.rooms[0].noise = 5;            // (0,0) 距4
    eq(E.selectCowTarget(s), 11, '取近的 11');
  });

  // ============ 6. 平手取順時針 ============
  test('平手取順時針: 噪點與距離都相同, 從正北順時針取第一個', function () {
    var s = blankState(5);           // 牛在中央 12 (2,2)
    s.rooms[2].noise = 5;            // 北 (0,2)
    s.rooms[14].noise = 5;           // 東 (2,4)
    s.rooms[22].noise = 5;           // 南 (4,2)
    s.rooms[10].noise = 5;           // 西 (2,0)
    eq(E.selectCowTarget(s), 2, '正北優先');
  });

  // ============ 7. 波及範圍 ============
  test('波及範圍: 肥度7+ 路徑每格四方相鄰也殺', function () {
    var s = blankState(5);
    s.cow.cell = 12; s.cow.fatness = 7;
    s.rooms[14].noise = 5;           // 目標 (2,4), 路徑 12→13→14
    var mv = E.computeCowMove(s);
    assert(arrHas(mv.splashCells, 18), '13 的下方 18 應在波及'); // 18=(3,3)
    assert(arrHas(mv.killedCells, 18), '波及格納入殺人');
    assert(arrHas(mv.killedCells, 8), '13 的上方 8 也波及'); // 8=(1,3)
  });

  // ============ 8. 起點不殺人 ============
  test('起點不殺人: 路徑起點不列入殺人格', function () {
    var s = blankState(5);
    s.cow.cell = 12; s.cow.fatness = 1;
    s.rooms[13].noise = 5;           // 目標 (2,3), 路徑 12→13
    var mv = E.computeCowMove(s);
    assert(!arrHas(mv.killedCells, 12), '起點 12 不殺人');
    assert(arrHas(mv.killedCells, 13), '終點 13 殺人');
  });

  // ============ 額外: 連通性保證 ============
  test('地圖生成: 20 張隨機圖皆連通', function () {
    for (var seed = 1; seed <= 20; seed++) {
      var rng = E.mulberry32(seed * 131);
      var N = seed % 2 ? 5 : 6;
      var s = blankState(N);
      s.walls = E.generateWalls(N, rng);
      assert(E.isConnected(s), 'seed ' + seed + ' 應連通');
    }
  });

  // ============ 額外: 環境卡不可封死/切斷 ============
  test('環境卡: 造成封死時拒絕並還原', function () {
    var s = blankState(3);
    var p = addPlayer(s, 4, 'runner'); // 中心 (1,1) 四鄰 1,3,5,7
    addWall(s, 4, 1); addWall(s, 4, 5); addWall(s, 4, 7);
    s.flips[0] = ['env'];
    var msg = '';
    try { E.declareCard(s, 0, 'env', { wallCell: 3, op: 'add' }); } catch (e) { msg = e.message; }
    assert(/封死/.test(msg), '應因封死擋掉, 實得: ' + msg);
    assert(!s.walls.has(E.edgeKey(4, 3)), '非法操作須還原');
  });

  // ============ 回歸: 宣告中途復原/重新整理不可卡死 ============
  test('卡死回歸: 已宣告的牌記在 state, 快照還原後剩餘牌正確', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var p = addPlayer(s, 0, 'runner');
    s.flips[0] = ['move', 'lure'];
    E.declareCard(s, 0, 'move', { dest: 0 });
    var r = E.restore(E.snapshot(s));                 // 模擬 Undo 到這一步 / 重新整理頁面
    var rem = E.remainingCards(r, 0);
    eq(rem.length, 1, '只剩一張');
    eq(rem[0], 'lure', '剩下的是誘導');
    var threw = false;
    try { E.declareCard(r, 0, 'move', { dest: 0 }); } catch (e) { threw = true; }
    assert(threw, '已宣告的牌不可再打');
  });

  test('卡死回歸: 舊版存檔 (沒有 declared) 宣告到一半, 已打掉的牌不會再出現', function () {
    var s = blankState(5);
    s.phase = 'declare';
    addPlayer(s, 0, 'runner');
    s.flips[0] = ['move', 'lure'];
    E.declareCard(s, 0, 'move', { dest: 0 });
    delete s.declared;                                 // 模擬昨天的舊存檔
    var r = E.restore(E.snapshot(s));
    var rem = E.remainingCards(r, 0);
    eq(rem.join(','), 'lure', '只剩誘導');
    E.declareCard(r, 0, 'lure', { target: 0 });        // 不可再報「手上沒有此牌」
    eq(E.remainingCards(r, 0).length, 0, '打完');
  });

  test('飼養者: 任一人帶滿樣本死亡即勝; 樣本不足死亡不失格', function () {
    var s = blankState(5);
    s.config.breederWinAny = 1;
    var a = addPlayer(s, 0, 'breeder'), b = addPlayer(s, 1, 'breeder');
    s.factions.breeder.total = 2;
    a.samples = s.config.breederSampleThreshold - 1; E.killPlayer(s, a);
    assert(!s.factions.breeder.disqualified && !s.factions.breeder.won, '差 1 個死亡: 不失格也不勝');
    b.samples = s.config.breederSampleThreshold; E.killPlayer(s, b);
    assert(s.factions.breeder.won && s.winners.indexOf('breeder') >= 0, '帶滿死亡即勝');
  });

  test('飼養者 (v6 舊規則): 有人不足即失格', function () {
    var s = blankState(5);
    s.config.breederWinAny = 0;
    var a = addPlayer(s, 0, 'breeder'), b = addPlayer(s, 1, 'breeder');
    s.factions.breeder.total = 2;
    a.samples = 2; E.killPlayer(s, a);
    b.samples = s.config.breederSampleThreshold; E.killPlayer(s, b);
    assert(s.factions.breeder.disqualified && !s.factions.breeder.won, '失格');
  });

  test('v13 各人數參數: 逃亡者門檻 / 飼養者門檻 / 牛步數加成 / 牛勝肥度 / 毒效 (照說明書第 4 節表格)', function () {
    function mk(n) { var ps = []; for (var i = 0; i < n; i++) ps.push({ name: 'P' + i }); return E.newGame({ players: ps, rng: E.mulberry32(3) }); }
    //          逃亡 飼養 步數 肥度勝 毒效
    var expect = { 7: [5, 7, 1, 9, 8], 8: [5, 6, 1, 9, 12], 9: [5, 7, 1, 9, 9], 10: [5, 7, 1, 9, 7], 11: [7, 8, 2, 9, 7],
      12: [7, 9, 2, 9, 7], 13: [6, 8, 2, 9, 5], 14: [7, 8, 2, 9, 6] };
    Object.keys(expect).forEach(function (n) {
      var g = mk(+n), e = expect[n];
      eq(g.config.runnerSampleThreshold, e[0], n + ' 人逃亡門檻');
      eq(g.config.breederSampleThreshold, e[1], n + ' 人飼養者門檻');
      eq(g.config.cowMoveBonus, e[2], n + ' 人牛步數加成');
      eq(g.config.fatnessWin, e[3], n + ' 人牛勝肥度');
      eq(g.config.poisonDuration, e[4], n + ' 人毒效');
      eq(g.factions.breeder.total, CFG.FACTION_TABLE[n].breeder, n + ' 人飼養者人數');
    });
    eq(mk(8).config.teamTransfer, 1, '預設同陣營交付'); eq(mk(8).config.dropAllowed, 1, '預設可以丟在地上');
    eq(mk(7).config.boxSize, 6, '7 人每箱 6 個樣本'); eq(mk(14).config.boxSize, 5, '14 人每箱 5 個');
    eq(mk(14).config.poisonDoseLimit, 3, '14 人 3 劑'); eq(mk(8).config.poisonDoseLimit, 3, '8 人 3 劑'); eq(mk(9).config.poisonDoseLimit, 3, '9 人 3 劑'); eq(mk(10).config.poisonDoseLimit, 3, '10 人 3 劑');
    eq(mk(9).config.timeoutCowWins, 1, '預設時間到牛贏');
  });

  // ============ v10: 時間到牛贏 (沒有平手) ============
  test('時間到: 沒有陣營達成 → 牛獲勝; 有陣營達成 → 牛不額外獲勝', function () {
    var s = blankState(5);
    s.round = s.rounds; s.cow.cell = 12; addPlayer(s, 0, 'runner');
    E.resolveRound(s);
    assert(s.gameOver, '第 12 回合結算完畢遊戲結束');
    eq(s.winners.join(), 'cow', '沒人達成 → 牛贏');
    var t = blankState(5);
    t.round = t.rounds; t.cow.cell = 12; addPlayer(t, 0, 'runner');
    t.factions.runner.won = true; t.winners.push('runner');
    E.resolveRound(t);
    eq(t.winners.join(), 'runner', '逃亡者已達成 → 牛不贏');
    var u = blankState(5);
    u.config.timeoutCowWins = 0; u.round = u.rounds; u.cow.cell = 12; addPlayer(u, 0, 'runner');
    E.resolveRound(u);
    eq(u.winners.length, 0, '舊規則 (開關關閉) → 無人勝');
  });

  // ============ 邏輯修正 (2026-10-09) ============
  test('毒死優先: 同一餐吃到第 3 劑又長到肥度 9 → 屠夫贏, 死掉的牛不算贏', function () {
    var s = blankState(5);
    s.cow.cell = 12; s.cow.fatness = 8;
    s.cow.doses = [{ left: 3 }, { left: 4 }];
    s.rooms[13].noise = 10; s.rooms[13].poison = true;
    addPlayer(s, 0, 'butcher');
    E.applyCowMove(s);
    assert(s.gameOver, '遊戲結束');
    eq(s.winners.join(), 'butcher', '只有屠夫贏');
  });
  test('只有逃亡者能從出口離開; 飼養者帶滿樣本站上出口不會被彈出', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var b = addPlayer(s, 0, 'breeder'); b.samples = 7;
    var r = addPlayer(s, 0, 'runner'); r.samples = s.config.runnerSampleThreshold;
    s.exitCells = [1]; s.rooms[1].isExit = true;
    s.flips[0] = ['move', 'interact']; s.flips[1] = ['move', 'interact'];
    E.declareCard(s, 0, 'move', { dest: 1 });
    assert(!b.leftGame, '飼養者留在場上');
    E.declareCard(s, 1, 'move', { dest: 1 });
    assert(r.leftGame && s.factions.runner.won, '逃亡者離場並獲勝');
  });

  test('任一陣營達成就結束: 逃亡者逃出 → 遊戲立刻結束, 只有逃亡者贏', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var r = addPlayer(s, 0, 'runner'); r.samples = s.config.runnerSampleThreshold;
    addPlayer(s, 6, 'butcher');
    s.exitCells = [1]; s.rooms[1].isExit = true;
    s.flips[0] = ['move', 'interact'];
    E.declareCard(s, 0, 'move', { dest: 1 });
    assert(s.gameOver, '遊戲結束');
    eq(s.winners.join(), 'runner', '只有逃亡者贏');
  });
  test('任一陣營達成就結束: 牛的同一次行動輾死帶滿的主祭又吃到致命毒 → 飼養者與屠夫一起贏', function () {
    var s = blankState(5);
    s.cow.cell = 12; s.cow.fatness = 2;
    s.cow.doses = [{ left: 3 }, { left: 4 }];
    s.rooms[13].noise = 6; s.rooms[13].poison = true;
    var b = addPlayer(s, 13, 'breeder'); b.samples = s.config.breederSampleThreshold;
    s.factions.breeder.total = 1;
    E.applyCowMove(s);
    assert(s.gameOver, '遊戲結束');
    eq(s.winners.slice().sort().join(), 'breeder,butcher', '同一刻達成一起贏');
  });

  test('下毒: 只有屠夫能下毒; 其他陣營誘導可以, 但不能下毒', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var r = addPlayer(s, 6, 'runner'), k = addPlayer(s, 6, 'butcher');
    r.samples = 2; k.samples = 2;
    s.flips[r.id] = ['lure', 'move']; s.flips[k.id] = ['lure', 'move'];
    var bad = false; try { E.declareCard(s, r.id, 'lure', { target: 7, poison: true }); } catch (e) { bad = true; }
    assert(bad, '逃亡者不能下毒'); eq(r.samples, 2, '逃亡者樣本沒少'); assert(!s.rooms[7].poison, '房間沒有毒');
    E.declareCard(s, k.id, 'lure', { target: 7, poison: true });
    assert(s.rooms[7].poison, '屠夫下毒成功'); eq(k.samples, 1, '屠夫用掉 1 個樣本');
    eq(s.rooms[7].noise, s.config.lureTargetNoise + s.config.poisonBonus, '下毒的誘導目標 +6');
  });

  test('殘響的互動: 只能操作回聲器; 不能撿樣本; 用過任兩張牌就全部收回', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var e = addPlayer(s, 6, 'runner'); e.dead = true; e.echo = true; e.echoUsed = {};
    s.rooms[6].device = 'echo'; s.rooms[6].noise = 4; s.rooms[6].dropped = 3;
    s.flips[e.id] = ['interact'];
    E.declareCard(s, e.id, 'interact', { echoTarget: 7 });
    eq(s.rooms[7].noise, 5, '複製 4+1 到相鄰房間'); eq(s.rooms[6].noise, 2, '本格 5 砍半剩 2');
    eq(e.samples, 0, '殘響不會撿樣本'); eq(s.rooms[6].dropped, 3, '地上樣本還在');
    eq(E.handList(e).join(), 'move,lure', '用過互動後剩移動、誘導');
    s.declared = {}; s.flips[e.id] = ['lure'];
    E.declareCard(s, e.id, 'lure', { target: 6 });
    eq(E.handList(e).join(), 'move,lure,interact', '用過兩張就全部收回');
    var t = blankState(5); t.phase = 'declare';
    var f = addPlayer(t, 6, 'runner'); f.dead = true; f.echo = true; f.echoUsed = {};
    t.rooms[6].device = 'sample_box'; t.rooms[6].boxRemaining = 5;
    t.flips[f.id] = ['interact'];
    E.declareCard(t, f.id, 'interact', {});
    eq(f.samples, 0, '殘響不能拿樣本箱'); eq(t.rooms[6].boxRemaining, 5, '箱子沒少'); eq(t.rooms[6].noise, 1, '照樣 +1 噪點');
  });

  test('消音器: 自己這格和上下左右四格 (隔牆也算) 噪點歸 0、毒清掉; 斜角不受影響', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var p = addPlayer(s, 12, 'runner');                 // 中央 C3
    s.rooms[12].device = 'silencer'; s.rooms[12].noise = 5;
    [7, 11, 13, 17].forEach(function (c) { s.rooms[c].noise = 4; });
    s.rooms[13].poison = true; addWall(s, 12, 13);      // 隔著牆的鄰格也清
    s.rooms[6].noise = 4;                               // 斜角
    s.flips[p.id] = ['interact', 'move'];
    E.declareCard(s, p.id, 'interact', {});
    [12, 7, 11, 13, 17].forEach(function (c) { eq(s.rooms[c].noise, 0, '格 ' + c + ' 歸 0'); });
    assert(!s.rooms[13].poison, '隔牆鄰格的毒也清掉');
    eq(s.rooms[6].noise, 4, '斜角不受影響');
  });

  test('回聲器砍半: 好幾個人連續刷, 加到隔壁的總量有上限 (不會無限疊)', function () {
    var s = blankState(5);
    s.phase = 'declare';
    s.rooms[6].device = 'echo'; s.rooms[6].noise = 20;
    var es = [];
    for (var i = 0; i < 6; i++) { var e = addPlayer(s, 6, 'runner'); e.dead = true; e.echo = true; e.echoUsed = {}; s.flips[e.id] = ['interact']; es.push(e); }
    es.forEach(function (e) { E.declareCard(s, e.id, 'interact', { echoTarget: 7 }); });
    assert(s.rooms[7].noise <= 50, '6 次連刷, 隔壁 ≤ 50 (不砍半的話會是 135)，實際 ' + s.rooms[7].noise);
    assert(s.rooms[6].noise <= 2, '本格被砍到剩一點');
  });

  test('毒只維持一回合: 牛沒吃到的毒, 回合結束就消失 (噪點還在)', function () {
    var s = blankState(5);
    s.cow.cell = 12; s.cow.fatness = 1;
    s.rooms[0].noise = 10; s.rooms[0].poison = true;   // 牛 2 步走不到 A1
    addPlayer(s, 24, 'butcher');
    E.resolveRound(s);
    eq(s.cow.doses.length, 0, '沒吃到');
    assert(!s.rooms[0].poison, '毒消失');
    assert(s.rooms[0].noise > 0, '噪點還在');
  });
  test('樣本箱至少離牛 2 格 (30 張隨機地圖)', function () {
    for (var g = 0; g < 30; g++) {
      var n = 7 + (g % 8), ps = []; for (var i = 0; i < n; i++) ps.push({ name: 'P' + i });
      var st = E.newGame({ players: ps, rng: E.mulberry32(100 + g) });
      var d = E.bfsDist(st, st.cow.cell);
      st.rooms.forEach(function (r, idx) { if (r.device === 'sample_box') assert(d[idx] >= 2, '第 ' + g + ' 張圖 ' + E.cellName(idx, st.N) + ' 離牛只有 ' + d[idx]); });
      eq(st.rooms.filter(function (r) { return r.device === 'sample_box'; }).length, st.table.devices.sample_box, '箱子數量正確');
    }
  });

  // ============ v12: 同陣營交付 / 丟在地上 ============
  function transferState() {
    var s = blankState(5);
    var a = addPlayer(s, 6, 'breeder'), b = addPlayer(s, 6, 'breeder');
    s.factions.breeder.total = 2;
    a.samples = 3; b.samples = 2;
    return { s: s, a: a, b: b };
  }
  test('交付: 同房活著的隊友 → 不指定數量就是全部, 不出牌、不加噪點', function () {
    var t = transferState(), s = t.s;
    var handBefore = JSON.stringify(t.a.hand);
    E.giveSamples(s, t.a.id, t.b.id);
    eq(t.a.samples, 0, '交付者歸 0'); eq(t.b.samples, 5, '接收者 2+3');
    eq(s.rooms[6].noise, 0, '不產生噪點');
    eq(JSON.stringify(t.a.hand), handBefore, '不消耗手牌');
  });
  test('交付: 不同房 / 對方已死 / 不同陣營 / 沒樣本 / 給自己 / 數量不對 → 全部擋下', function () {
    function rejects(setup, msg, amount) {
      var t = transferState(); var to = setup(t);
      var before = [t.a.samples, t.b.samples].join();
      var ok = false; try { E.giveSamples(t.s, t.a.id, to == null ? t.b.id : to, amount); } catch (e) { ok = true; }
      assert(ok, msg); eq([t.a.samples, t.b.samples].join(), before, msg + ' (樣本不應變動)');
    }
    rejects(function (t) { t.b.cell = 7; }, '不同房間');
    rejects(function (t) { t.b.dead = true; t.b.echo = true; }, '對方是殘響');
    rejects(function (t) { t.b.leftGame = true; }, '對方已離場');
    rejects(function (t) { t.b.faction = 'butcher'; }, '對方不同陣營');
    rejects(function (t) { t.a.samples = 0; }, '身上沒樣本');
    rejects(function (t) { t.a.dead = true; t.a.echo = true; }, '交付者是殘響');
    rejects(function (t) { return t.a.id; }, '交給自己');
    rejects(function (t) { t.s.config.teamTransfer = 0; t.s.config.breederTransfer = 0; }, '規則關閉時不可交付');
    rejects(function () {}, '給 0 個', 0);
    rejects(function () {}, '給超過身上的數量', 4);
  });
  test('交付: 可以只給一部分; 逃亡者、屠夫也能交給同陣營隊友', function () {
    var t = transferState();
    E.giveSamples(t.s, t.a.id, t.b.id, 1);
    eq(t.a.samples + '/' + t.b.samples, '2/3', '飼養者給 1 個');
    var s = blankState(5);
    var r1 = addPlayer(s, 6, 'runner'), r2 = addPlayer(s, 6, 'runner'), k1 = addPlayer(s, 6, 'butcher'), k2 = addPlayer(s, 6, 'butcher');
    r1.samples = 3; k1.samples = 2;
    E.giveSamples(s, r1.id, r2.id, 2); eq(r2.samples, 2, '逃亡者交給逃亡者');
    E.giveSamples(s, k1.id, k2.id); eq(k2.samples, 2, '屠夫交給屠夫');
  });
  test('丟在地上: 可以選數量, 不出牌、不加噪點; 任何人打互動卡都能撿', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var a = addPlayer(s, 6, 'runner'), b = addPlayer(s, 6, 'butcher');
    a.samples = 3;
    E.dropSamples(s, a.id, 2);
    eq(a.samples, 1, '身上剩 1'); eq(s.rooms[6].dropped, 2, '地上 2 個'); eq(s.rooms[6].noise, 0, '不產生噪點');
    s.flips[b.id] = ['interact', 'move'];
    E.declareCard(s, b.id, 'interact', {});
    eq(b.samples, 2, '屠夫撿起地上的 2 個'); eq(s.rooms[6].dropped, 0, '地上清空');
    var bad = false; try { E.dropSamples(s, a.id, 5); } catch (e) { bad = true; } assert(bad, '丟超過身上的數量要擋下');
    a.dead = true; a.echo = true; bad = false; try { E.dropSamples(s, a.id, 1); } catch (e) { bad = true; } assert(bad, '殘響不能丟');
  });
  test('交付後的飼養者帶滿門檻死亡 → 飼養者勝', function () {
    var t = transferState(), s = t.s;
    s.config.breederSampleThreshold = 5;
    E.giveSamples(s, t.a.id, t.b.id);
    E.killPlayer(s, t.b);
    assert(s.factions.breeder.won, '集中 5 個後死亡即勝');
  });

  test('卡死回歸: 無合法目標的牌可作廢, 回合能繼續', function () {
    var s = blankState(3);
    s.phase = 'declare';
    addPlayer(s, 4, 'runner');
    addWall(s, 4, 1); addWall(s, 4, 5); addWall(s, 4, 7); // 再加任何牆都會封死
    s.flips[0] = ['env'];
    E.forfeitCard(s, 0, 'env');
    eq(E.remainingCards(s, 0).length, 0, '作廢後無剩餘牌');
    eq(s.players[0].hand.env, false, '牌已消耗');
    eq(s.rooms[4].noise, 0, '作廢不產生噪點');
  });

  test('卡死回歸: 走出出口離場後, 剩下的牌不用再打', function () {
    var s = blankState(5);
    s.phase = 'declare';
    var p = addPlayer(s, 0, 'runner'); p.samples = s.config.runnerSampleThreshold;
    s.exitCells = [1]; s.rooms[1].isExit = true;
    s.flips[0] = ['move', 'interact'];
    E.declareCard(s, 0, 'move', { dest: 1 });
    assert(p.leftGame, '已離場');
    eq(E.remainingCards(s, 0).length, 0, '離場後無剩餘牌');
  });

  // ============ 額外: 毒滿3劑 → 牛暴斃, 屠夫勝 ============
  test('毒: 累計3劑同時存在牛暴斃, 屠夫勝', function () {
    var s = blankState(5);
    s.cow.cell = 12; s.cow.fatness = 2;
    s.cow.doses = [{ left: 3 }, { left: 4 }]; // 已 2 劑
    s.rooms[13].noise = 5; s.rooms[13].poison = true; // 第3劑來源
    addPlayer(s, 0, 'butcher');
    E.applyCowMove(s);
    eq(s.cow.doses.length, 3, '第3劑加入');
    assert(s.gameOver, '牛暴斃遊戲結束');
    assert(s.factions.butcher.won, '屠夫勝利');
  });
  test('毒: 牛毒死的那一回合, 劑數不會在回合末被排出 (結束畫面顯示 3/3)', function () {
    var s = blankState(5);
    s.cow.cell = 12; s.cow.fatness = 2;
    s.cow.doses = [{ left: 1 }, { left: 4 }]; // 第一劑本回合末到期
    s.rooms[13].noise = 8; s.rooms[13].poison = true;
    addPlayer(s, 0, 'butcher');
    E.resolveRound(s);
    assert(s.gameOver && s.factions.butcher.won, '屠夫勝利');
    eq(s.cow.doses.length, 3, '劑數停在 3');
  });

  // ============ 額外: 屍體噪點不被當回合衰減 ============
  test('結算順序: 屍體噪點不被當回合衰減 (−2 圖仍維持)', function () {
    var s = blankState(5, 2);
    s.rooms[0].corpses = 1; s.rooms[0].noise = 0;
    E.settleNoisePhase(s);
    eq(s.rooms[0].noise, s.config.corpseNoise, '屍體 +2 不被衰減掉');
  });

  // ============ 額外: 攜帶樣本噪點跟人 ============
  test('攜帶噪點: 身上樣本每回合為所在房間 +N', function () {
    var s = blankState(5, 1);
    var p = addPlayer(s, 6, 'breeder'); p.samples = 3;
    E.settleNoisePhase(s);
    eq(s.rooms[6].noise, 3, '3 樣本 → +3');
  });

  test('v17.1: 第 1 回合出口至少離樣本箱 3 步', function () {
    for (var g = 0; g < 60; g++) {
      var names = []; for (var i = 0; i < 8; i++) names.push({ name: 'P' + i });
      var s = E.newGame({ players: names, rng: E.mulberry32(500 + g), seed: 500 + g });
      E.startRound(s);
      // 出口離最近箱子的距離, 要是外圈所有格子裡最遠的 (或至少 3 步)
      var boxes = []; s.rooms.forEach(function (r, i) { if (r.device === 'sample_box') boxes.push(E.bfsDist(s, i)); });
      function near(x) { return Math.min.apply(null, boxes.map(function (d) { return d[x]; })); }
      var best = 0; for (var x = 0; x < s.N * s.N; x++) { var rr = Math.floor(x / s.N), cc = x % s.N; if (rr === 0 || cc === 0 || rr === s.N - 1 || cc === s.N - 1) best = Math.max(best, near(x)); }
      var got = near(s.exitCells[0]);
      assert(got >= Math.min(3, best), '種子 ' + (500 + g) + ' 出口離箱 ' + got + ' 步, 外圈最遠 ' + best);
    }
  });

  function blankStateClone(s) { return E.cloneState(s); }

  // ---- 輸出 ----
  var pass = results.filter(function (r) { return r.ok; }).length;
  var fail = results.length - pass;
  var lines = results.map(function (r) { return (r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : '  → ' + r.err); });
  var summary = '超肥牛牛 測試: ' + pass + '/' + results.length + ' 通過' + (fail ? ' (' + fail + ' 失敗)' : ' 全數通過');

  var report = { results: results, pass: pass, fail: fail, summary: summary, lines: lines };
  root.SFCC_TESTS = report;

  if (typeof module !== 'undefined' && module.exports) {
    console.log(summary);
    console.log(lines.join('\n'));
    if (fail) process.exitCode = 1;
    module.exports = report;
  } else if (root.document) {
    // 瀏覽器: 稍後由 tests.html 讀取 SFCC_TESTS 顯示
  }
})(typeof window !== 'undefined' ? window : globalThis);
