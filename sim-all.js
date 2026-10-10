/* 超肥牛牛 ── 批次平衡測試: 各種變因各跑 N 場 (預設 100), 平行執行
 *   node sim-all.js            → 印出表格, 並存 sim-results/sim-results.json
 *   node sim-all.js 200        → 每組 200 場
 */
'use strict';
var execFile = require('child_process').execFile;
var os = require('os');
var fs = require('fs');
var GAMES = +process.argv[2] || 100;

var CONFIGS = [];
[7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: '人數', name: n + ' 人', args: ['--players', n] }); });
[8, 12].forEach(function (n) {
  CONFIGS.push({ group: '玩家打法', name: n + ' 人 亂打', args: ['--players', n, '--bot', 'random'] });
  CONFIGS.push({ group: '玩家打法', name: n + ' 人 重製拖到第3回合', args: ['--players', n, '--reset', 'late'] });
  CONFIGS.push({ group: '規則變體', name: n + ' 人 飼養者門檻 4', args: ['--players', n, '--set', 'breederSampleThreshold=4'] });
  CONFIGS.push({ group: '規則變體', name: n + ' 人 毒 4 劑', args: ['--players', n, '--set', 'poisonDoseLimit=4'] });
  CONFIGS.push({ group: '規則變體', name: n + ' 人 毒效 4 回合', args: ['--players', n, '--set', 'poisonDuration=4'] });
  CONFIGS.push({ group: '規則變體', name: n + ' 人 每箱 6 樣本', args: ['--players', n, '--set', 'boxSize=6'] });
  CONFIGS.push({ group: '規則變體', name: n + ' 人 重製噪點 1', args: ['--players', n, '--set', 'resetNoise=1'] });
  CONFIGS.push({ group: '規則變體', name: n + ' 人 屍體噪點 1', args: ['--players', n, '--set', 'corpseNoise=1'] });
});
[12, 14].forEach(function (n) {
  CONFIGS.push({ group: '規則變體', name: n + ' 人 規則書建議 (8回合/門檻4/出口1,3,5,7)', args: ['--players', n, '--rounds', 8, '--set', 'breederSampleThreshold=4', '--exits', '1,3,5,7'] });
});

// 第二輪: 修正提案 (node sim-all.js 100 proposal)
if (process.argv[3] === 'proposal') {
  CONFIGS = [];
  [7, 8, 10].forEach(function (n) {
    CONFIGS.push({ group: '現行', name: n + ' 人 現行規則', args: ['--players', n] });
    CONFIGS.push({ group: '提案', name: n + ' 人 飼養者任一人即勝', args: ['--players', n, '--set', 'breederWinAny=1'] });
    CONFIGS.push({ group: '提案', name: n + ' 人 飼養者任一人即勝 + 門檻4', args: ['--players', n, '--set', 'breederWinAny=1', '--set', 'breederSampleThreshold=4'] });
  });
  [11, 12, 14].forEach(function (n) {
    CONFIGS.push({ group: '現行', name: n + ' 人 現行規則', args: ['--players', n] });
    CONFIGS.push({ group: '提案', name: n + ' 人 飼養者任一人即勝', args: ['--players', n, '--set', 'breederWinAny=1'] });
    CONFIGS.push({ group: '提案', name: n + ' 人 逃亡者門檻4', args: ['--players', n, '--set', 'runnerSampleThreshold=4'] });
    CONFIGS.push({ group: '提案', name: n + ' 人 牛步數 肥度+2', args: ['--players', n, '--set', 'cowMoveBonus=2'] });
    CONFIGS.push({ group: '提案', name: n + ' 人 組合 (飼養者任一/逃亡4/牛+2)', args: ['--players', n, '--set', 'breederWinAny=1', '--set', 'runnerSampleThreshold=4', '--set', 'cowMoveBonus=2'] });
    CONFIGS.push({ group: '提案', name: n + ' 人 組合 (飼養者任一/逃亡4)', args: ['--players', n, '--set', 'breederWinAny=1', '--set', 'runnerSampleThreshold=4'] });
  });
}

// 第三輪: 飼養者集中樣本 (node sim-all.js 150 transfer)
if (process.argv[3] === 'transfer') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) {
    CONFIGS.push({ group: n + '人', name: n + ' 人 v7 (不可交付, 門檻5)', args: ['--players', n] });
    [5, 6].forEach(function (t) {
      CONFIGS.push({ group: n + '人', name: n + ' 人 互動卡交付 門檻' + t, args: ['--players', n, '--set', 'breederTransfer=1', '--set', 'breederSampleThreshold=' + t] });
    });
    [5, 6, 7].forEach(function (t) {
      CONFIGS.push({ group: n + '人', name: n + ' 人 免費交付 門檻' + t, args: ['--players', n, '--set', 'breederTransfer=2', '--set', 'breederSampleThreshold=' + t] });
    });
  });
}

// 第四輪: 逃亡者 (以建議的飼養者規則為基準)  node sim-all.js 150 runner
if (process.argv[3] === 'runner') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) {
    var bt = n >= 12 ? 7 : 6, rt = n >= 11 ? 4 : 3;
    var base = ['--players', n, '--set', 'breederTransfer=2', '--set', 'breederSampleThreshold=' + bt];
    CONFIGS.push({ group: n + '人', name: n + ' 人 建議飼養者規則', args: base });
    CONFIGS.push({ group: n + '人', name: n + ' 人 + 逃亡者門檻' + (rt + 1), args: base.concat(['--set', 'runnerSampleThreshold=' + (rt + 1)]) });
    CONFIGS.push({ group: n + '人', name: n + ' 人 + 出口晚開 (4/7/10)', args: base.concat(['--exits', '4,7,10']) });
  });
}

// v10 正式預設值驗證 (時間到牛贏, 新種子)  node sim-all.js 400 v10
if (process.argv[3] === 'v10') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v10', name: n + ' 人 v10 預設', args: ['--players', n, '--seed', 3] }); });
}

// 第十二輪: v9 正式預設值驗證 (新種子)  node sim-all.js 400 v9
if (process.argv[3] === 'v9') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v9', name: n + ' 人 v9 預設', args: ['--players', n, '--seed', 3] }); });
}

// 第五輪: v8 正式預設值驗證 (不加任何 --set)  node sim-all.js 200 v8
if (process.argv[3] === 'v8') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v8', name: n + ' 人 v8 預設', args: ['--players', n] }); });
}

// 第六輪: 操作變因 + 11–14 人規則變因 (以 v8 為基準)  node sim-all.js 200 explore
if (process.argv[3] === 'explore') {
  CONFIGS = [];
  [7, 9, 12, 14].forEach(function (n) {
    var b = ['--players', n], g = '打法 ' + n + '人';
    CONFIGS.push({ group: g, name: n + ' 人 基準 (v8, 聰明打法)', args: b });
    CONFIGS.push({ group: g, name: n + ' 人 飼養者約好會合 (coop 2)', args: b.concat(['--coop', 2]) });
    CONFIGS.push({ group: g, name: n + ' 人 全場 2→2→1 (重製拖到第3回合)', args: b.concat(['--reset', 'late']) });
    CONFIGS.push({ group: g, name: n + ' 人 飼養者亂打', args: b.concat(['--dumb', 'breeder']) });
    CONFIGS.push({ group: g, name: n + ' 人 屠夫亂打', args: b.concat(['--dumb', 'butcher']) });
    CONFIGS.push({ group: g, name: n + ' 人 逃亡者亂打', args: b.concat(['--dumb', 'runner']) });
    CONFIGS.push({ group: g, name: n + ' 人 全場亂打', args: b.concat(['--bot', 'random']) });
  });
  [11, 12, 14].forEach(function (n) {
    var b = ['--players', n], g = '規則 ' + n + '人';
    if (n === 11) CONFIGS.push({ group: g, name: n + ' 人 基準 (v8)', args: b });
    CONFIGS.push({ group: g, name: n + ' 人 肥度5以後步數+1', args: b.concat(['--set', 'cowLateBonus=1']) });
    CONFIGS.push({ group: g, name: n + ' 人 牛步數 肥度+3', args: b.concat(['--set', 'cowMoveBonus=3']) });
    CONFIGS.push({ group: g, name: n + ' 人 毒效 5 回合', args: b.concat(['--set', 'poisonDuration=5']) });
    CONFIGS.push({ group: g, name: n + ' 人 毒 4 劑', args: b.concat(['--set', 'poisonDoseLimit=4']) });
    CONFIGS.push({ group: g, name: n + ' 人 肥度5以後+1 & 毒效5', args: b.concat(['--set', 'cowLateBonus=1', '--set', 'poisonDuration=5']) });
  });
}

// 第七輪: 11–14 人 牛/屠夫 針對性變因  node sim-all.js 200 explore2
if (process.argv[3] === 'explore2') {
  CONFIGS = [{ group: '打法 12人', name: '12 人 飼養者約好會合 (coop 2)', args: ['--players', 12, '--coop', 2] }];
  [11, 12, 14].forEach(function (n) {
    var b = ['--players', n], g = '規則 ' + n + '人';
    CONFIGS.push({ group: g, name: n + ' 人 毒效 4 回合', args: b.concat(['--set', 'poisonDuration=4']) });
    CONFIGS.push({ group: g, name: n + ' 人 牛勝肥度 8', args: b.concat(['--set', 'fatnessWin=8']) });
    CONFIGS.push({ group: g, name: n + ' 人 牛勝肥度 8 & 毒效 5', args: b.concat(['--set', 'fatnessWin=8', '--set', 'poisonDuration=5']) });
    CONFIGS.push({ group: g, name: n + ' 人 牛步數 肥度+3 & 毒效 5', args: b.concat(['--set', 'cowMoveBonus=3', '--set', 'poisonDuration=5']) });
  });
}

// 第八輪: 確認 11–14 人「毒效 4 回合」  node sim-all.js 300 confirm
if (process.argv[3] === 'confirm') {
  CONFIGS = [];
  [11, 12, 13, 14].forEach(function (n) {
    var b = ['--players', n], p4 = b.concat(['--set', 'poisonDuration=4']);
    CONFIGS.push({ group: n + '人', name: n + ' 人 v8', args: b });
    CONFIGS.push({ group: n + '人', name: n + ' 人 毒效 4', args: p4 });
    if (n === 12 || n === 14) {
      CONFIGS.push({ group: n + '人', name: n + ' 人 毒效 4 + 全場 2→2→1', args: p4.concat(['--reset', 'late']) });
      CONFIGS.push({ group: n + '人', name: n + ' 人 毒效 4 + 飼養者會合', args: p4.concat(['--coop', 2]) });
      CONFIGS.push({ group: n + '人', name: n + ' 人 毒效 4 + 逃亡者亂打', args: p4.concat(['--dumb', 'runner']) });
      CONFIGS.push({ group: n + '人', name: n + ' 人 毒效 4 + 飼養者亂打', args: p4.concat(['--dumb', 'breeder']) });
    }
  });
}

// 第九輪: 各人數微調到 ±5% (最高−最低 ≤ 10)  node sim-all.js 300 tune1
if (process.argv[3] === 'tune1') {
  CONFIGS = [];
  function add(n, name, sets) { var a = ['--players', n]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name, args: a }); }
  add(8, '毒效 5', ['poisonDuration=5']);
  add(8, '逃亡者門檻 5', ['runnerSampleThreshold=5']);
  add(8, '牛步數 肥度+2', ['cowMoveBonus=2']);
  add(9, '毒效 5', ['poisonDuration=5']);
  add(9, '毒效 4', ['poisonDuration=4']);
  add(10, '毒效 5', ['poisonDuration=5']);
  add(10, '毒效 4', ['poisonDuration=4']);
  add(11, '毒效 5', ['poisonDuration=5']);
  add(12, '毒效 5', ['poisonDuration=5']);
  add(12, '毒效 4 + 逃亡者門檻 6', ['poisonDuration=4', 'runnerSampleThreshold=6']);
  add(13, '毒效 5', ['poisonDuration=5']);
  add(13, '毒效 4 + 逃亡者門檻 6', ['poisonDuration=4', 'runnerSampleThreshold=6']);
}

// 第十輪  node sim-all.js 300 tune2
if (process.argv[3] === 'tune2') {
  CONFIGS = [];
  function add2(n, name, sets) { var a = ['--players', n]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name, args: a }); }
  [9, 10, 11, 12, 13, 14].forEach(function (n) { add2(n, '毒效 5 + 牛肥度 8 勝', ['poisonDuration=5', 'fatnessWin=8']); });
  add2(9, '毒效 5 + 逃亡者門檻 5', ['poisonDuration=5', 'runnerSampleThreshold=5']);
  add2(10, '毒效 5 + 逃亡者門檻 5', ['poisonDuration=5', 'runnerSampleThreshold=5']);
  add2(11, '毒效 4 + 逃亡者門檻 6', ['poisonDuration=4', 'runnerSampleThreshold=6']);
  add2(9, '毒效 6 + 牛肥度 8 勝', ['fatnessWin=8']);
  add2(10, '毒效 6 + 牛肥度 8 勝', ['fatnessWin=8']);
}

// 第十一輪  node sim-all.js 300 tune3
if (process.argv[3] === 'tune3') {
  CONFIGS = [];
  function add3(n, name, sets, seed) { var a = ['--players', n]; sets.forEach(function (kv) { a.push('--set', kv); }); if (seed) a.push('--seed', seed); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name, args: a }); }
  add3(7, 'A 毒效5+肥度8勝', ['poisonDuration=5', 'fatnessWin=8']);
  add3(8, 'A 毒效5+肥度8勝', ['poisonDuration=5', 'fatnessWin=8']);
  add3(8, 'A + 逃亡者門檻 5', ['poisonDuration=5', 'fatnessWin=8', 'runnerSampleThreshold=5']);
  add3(14, '毒效4+逃亡者門檻6', ['poisonDuration=4', 'runnerSampleThreshold=6']);
  add3(9, 'A (種子2)', ['poisonDuration=5', 'fatnessWin=8'], 2);
  add3(10, 'A (種子2)', ['poisonDuration=5', 'fatnessWin=8'], 2);
  add3(11, '毒效4+逃亡者6 (種子2)', ['poisonDuration=4', 'runnerSampleThreshold=6'], 2);
  add3(13, '毒效4+逃亡者6 (種子2)', ['poisonDuration=4', 'runnerSampleThreshold=6'], 2);
  add3(8, '逃亡者門檻 5 (種子2)', ['runnerSampleThreshold=5'], 2);
}

// 時間到牛贏: 現狀 (v9 + timeoutCowWins)  node sim-all.js 300 tc0
if (process.argv[3] === 'tc0') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v9+時間到牛贏', name: n + ' 人', args: ['--players', n, '--set', 'timeoutCowWins=1'] }); });
}

// 時間到牛贏 第一輪調整  node sim-all.js 300 tc1
if (process.argv[3] === 'tc1') {
  CONFIGS = [];
  var V9 = { 7: [4, 6, 6, 9], 8: [5, 6, 6, 9], 9: [4, 6, 5, 8], 10: [4, 6, 5, 8], 11: [5, 6, 5, 8], 12: [5, 7, 5, 8], 13: [5, 7, 5, 8], 14: [5, 7, 4, 9] }; // 逃亡 飼養 毒效 肥度勝
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) {
    var v = V9[n];
    function addT(name, r, b, p, f) {
      CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' (逃' + r + '/飼' + b + '/毒' + p + '/肥' + f + ')',
        args: ['--players', n, '--set', 'timeoutCowWins=1', '--set', 'runnerSampleThreshold=' + r, '--set', 'breederSampleThreshold=' + b, '--set', 'poisonDuration=' + p, '--set', 'fatnessWin=' + f] });
    }
    if (v[3] === 8) addT('肥度勝回 9', v[0], v[1], v[2], 9);
    addT('肥9 + 毒效+1', v[0], v[1], v[2] + 1, 9);
    addT('肥9 + 逃亡−1', v[0] - 1, v[1], v[2], 9);
    addT('肥9 + 飼養−1', v[0], v[1] - 1, v[2], 9);
    addT('肥9 + 逃亡−1 + 飼養−1', v[0] - 1, v[1] - 1, v[2], 9);
  });
}

// 時間到牛贏 第二輪  node sim-all.js 300 tc2
if (process.argv[3] === 'tc2') {
  CONFIGS = [];
  function addU(n, name, r, b, p, f, extra, seed) {
    var a = ['--players', n, '--set', 'timeoutCowWins=1', '--set', 'runnerSampleThreshold=' + r, '--set', 'breederSampleThreshold=' + b, '--set', 'poisonDuration=' + p, '--set', 'fatnessWin=' + f];
    (extra || []).forEach(function (kv) { a.push('--set', kv); }); if (seed) a.push('--seed', seed);
    CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' (逃' + r + '/飼' + b + '/毒' + p + '/肥' + f + (extra ? '/' + extra.join('/') : '') + ')', args: a });
  }
  addU(7, '毒8', 4, 6, 8, 9);
  addU(7, '毒7+每箱6', 4, 6, 7, 9, ['boxSize=6']);
  addU(7, '每箱6', 4, 6, 6, 9, ['boxSize=6']);
  addU(8, '逃4+毒7', 4, 6, 7, 9);
  addU(8, '每箱6', 5, 6, 6, 9, ['boxSize=6']);
  addU(8, '逃4 (種子2)', 4, 6, 6, 9, null, 2);
  addU(14, '飼6+毒5', 5, 6, 5, 9);
  addU(14, '飼6+毒4+每箱6', 5, 6, 4, 9, ['boxSize=6']);
  addU(14, '毒5+每箱6', 5, 7, 5, 9, ['boxSize=6']);
  addU(9, '選定 (種子2)', 4, 5, 5, 9, null, 2);
  addU(10, '選定 (種子2)', 4, 5, 5, 9, null, 2);
  addU(11, '選定 (種子2)', 5, 6, 5, 9, null, 2);
  addU(12, '選定 (種子2)', 5, 6, 5, 9, null, 2);
  addU(13, '選定 (種子2)', 5, 6, 5, 9, null, 2);
}

// 時間到牛贏 第三輪  node sim-all.js 300 tc3
if (process.argv[3] === 'tc3') {
  CONFIGS = [];
  function addV(n, name, r, b, p, f, extra, seed) {
    var a = ['--players', n, '--set', 'timeoutCowWins=1', '--set', 'runnerSampleThreshold=' + r, '--set', 'breederSampleThreshold=' + b, '--set', 'poisonDuration=' + p, '--set', 'fatnessWin=' + f];
    (extra || []).forEach(function (kv) { a.push('--set', kv); }); if (seed) a.push('--seed', seed);
    CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name, args: a });
  }
  addV(7, '毒8 (種子2)', 4, 6, 8, 9, null, 2);
  addV(7, '毒9', 4, 6, 9, 9);
  addV(7, '毒9 (種子2)', 4, 6, 9, 9, null, 2);
  addV(8, '逃4+毒7 (種子2)', 4, 6, 7, 9, null, 2);
  addV(14, '飼6+毒5 (種子2)', 5, 6, 5, 9, null, 2);
  addV(14, '毒5+每箱6 (種子2)', 5, 7, 5, 9, ['boxSize=6'], 2);
}

// 邏輯修正後重調  node sim-all.js 300 tc4
if (process.argv[3] === 'tc4') {
  CONFIGS = [];
  function addW(n, name, sets) {
    [1, 2].forEach(function (seed) {
      var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); });
      CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a });
    });
  }
  addW(9, '飼6', ['breederSampleThreshold=6']);
  addW(9, '飼6+毒6', ['breederSampleThreshold=6', 'poisonDuration=6']);
  addW(12, '飼7', ['breederSampleThreshold=7']);
  addW(13, '飼7', ['breederSampleThreshold=7']);
  addW(14, '毒4', ['poisonDuration=4']);
  addW(14, '飼8', ['breederSampleThreshold=8']);
  addW(14, '每箱5', ['boxSize=5']);
  addW(14, '逃6', ['runnerSampleThreshold=6']);
}

// 14 人  node sim-all.js 300 tc5
if (process.argv[3] === 'tc5') {
  CONFIGS = [];
  function addX(name, sets) {
    [1, 2].forEach(function (seed) {
      var a = ['--players', 14, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); });
      CONFIGS.push({ group: '14人', name: '14 人 ' + name + ' 種子' + seed, args: a });
    });
  }
  addX('牛步數 肥度+1', ['cowMoveBonus=1']);
  addX('毒4劑+毒效7', ['poisonDoseLimit=4', 'poisonDuration=7']);
  addX('毒4劑+毒效8', ['poisonDoseLimit=4', 'poisonDuration=8']);
}

// 任一陣營達成就結束: 現狀  node sim-all.js 300 fw0
if (process.argv[3] === 'fw0') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: '先達成者贏', name: n + ' 人', args: ['--players', n] }); });
}

// 任一陣營達成就結束 第一輪調整  node sim-all.js 300 fw1
if (process.argv[3] === 'fw1') {
  CONFIGS = [];
  var B = { 7: [4, 6, 8, 5, 3], 8: [4, 6, 7, 5, 3], 9: [4, 6, 5, 5, 3], 10: [4, 5, 5, 5, 3], 11: [5, 6, 5, 5, 3], 12: [5, 7, 5, 5, 3], 13: [5, 7, 5, 5, 3], 14: [5, 7, 8, 6, 4] };
  function addF(n, name, v) {
    CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' (逃' + v[0] + '/飼' + v[1] + '/毒效' + v[2] + '/箱' + v[3] + '/劑' + v[4] + ')',
      args: ['--players', n, '--set', 'runnerSampleThreshold=' + v[0], '--set', 'breederSampleThreshold=' + v[1], '--set', 'poisonDuration=' + v[2], '--set', 'boxSize=' + v[3], '--set', 'poisonDoseLimit=' + v[4]] });
  }
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) {
    var b = B[n];
    addF(n, '逃+1', [b[0] + 1, b[1], b[2], b[3], b[4]]);
    addF(n, '逃+1 毒效+2', [b[0] + 1, b[1], b[2] + 2, b[3], b[4]]);
    addF(n, '毒效+2', [b[0], b[1], b[2] + 2, b[3], b[4]]);
  });
  addF(10, '逃+1 毒效+2 飼+1', [5, 6, 7, 5, 3]);
  addF(14, '逃+1 3劑 毒效6', [6, 7, 6, 6, 3]);
  addF(14, '逃+1 毒效10', [6, 7, 10, 6, 4]);
}

// 任一陣營達成就結束 第二輪  node sim-all.js 300 fw2
if (process.argv[3] === 'fw2') {
  CONFIGS = [];
  function addG(n, name, v, seed) {
    var a = ['--players', n, '--set', 'runnerSampleThreshold=' + v[0], '--set', 'breederSampleThreshold=' + v[1], '--set', 'poisonDuration=' + v[2], '--set', 'boxSize=' + v[3], '--set', 'poisonDoseLimit=' + v[4]];
    if (seed) a.push('--seed', seed);
    CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' (逃' + v[0] + '/飼' + v[1] + '/毒效' + v[2] + '/箱' + v[3] + '/劑' + v[4] + ')' + (seed ? ' 種子' + seed : ''), args: a });
  }
  addG(7, 'a', [5, 7, 10, 5, 3]);
  addG(7, 'b', [5, 6, 10, 6, 3]);
  addG(7, 'c', [5, 7, 10, 6, 3]);
  addG(8, '', [5, 6, 9, 5, 3], 2);
  addG(9, '', [5, 6, 7, 5, 3], 2);
  addG(10, '', [5, 6, 7, 5, 3], 2);
  addG(11, '', [6, 6, 5, 5, 3], 2);
  addG(11, '飼7', [6, 7, 5, 5, 3]);
  addG(12, '', [6, 7, 5, 5, 3], 2);
  addG(13, '', [6, 7, 5, 5, 3], 2);
  addG(14, 'a', [7, 7, 8, 6, 4]);
  addG(14, 'b', [7, 7, 10, 6, 4]);
  addG(14, 'c', [7, 7, 6, 6, 3]);
}

// 任一陣營達成就結束 第三輪  node sim-all.js 300 fw3
if (process.argv[3] === 'fw3') {
  CONFIGS = [];
  function addH(n, name, v, seeds) {
    (seeds || [1]).forEach(function (seed) {
      var a = ['--players', n, '--seed', seed, '--set', 'runnerSampleThreshold=' + v[0], '--set', 'breederSampleThreshold=' + v[1], '--set', 'poisonDuration=' + v[2], '--set', 'boxSize=' + v[3], '--set', 'poisonDoseLimit=' + v[4]];
      CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' (逃' + v[0] + '/飼' + v[1] + '/毒效' + v[2] + '/箱' + v[3] + '/劑' + v[4] + ') 種子' + seed, args: a });
    });
  }
  addH(7, 'c', [5, 7, 10, 6, 3], [2]);
  addH(9, '', [5, 6, 6, 5, 3], [1, 2]);
  addH(10, '', [5, 6, 6, 5, 3], [1, 2]);
  addH(13, '', [6, 7, 4, 5, 3], [1, 2]);
  addH(14, 'a', [6, 6, 8, 5, 4]);
  addH(14, 'b', [6, 7, 8, 5, 4]);
  addH(14, 'c', [6, 6, 6, 5, 3]);
}

// 任一陣營達成就結束 第四輪: 出口晚開當作逃亡者的細調  node sim-all.js 300 fw4
if (process.argv[3] === 'fw4') {
  CONFIGS = [];
  function addI(n, name, v, exits, seeds) {
    (seeds || [1, 2]).forEach(function (seed) {
      var a = ['--players', n, '--seed', seed, '--set', 'runnerSampleThreshold=' + v[0], '--set', 'breederSampleThreshold=' + v[1], '--set', 'poisonDuration=' + v[2], '--set', 'boxSize=' + v[3], '--set', 'poisonDoseLimit=' + v[4]];
      if (exits) a.push('--exits', exits);
      CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' (逃' + v[0] + '/飼' + v[1] + '/毒效' + v[2] + '/箱' + v[3] + '/劑' + v[4] + (exits ? '/出口' + exits : '') + ') 種子' + seed, args: a });
    });
  }
  addI(9, '', [4, 6, 6, 5, 3], '4,7,10');
  addI(10, '', [4, 6, 6, 5, 3], '4,7,10');
  addI(13, '', [5, 7, 5, 5, 3], '4,7,10');
  addI(14, 'a', [5, 7, 8, 6, 4], '4,7,10');
  addI(14, 'b', [5, 7, 8, 5, 4], '4,7,10');
}

// v11 最終驗證  node sim-all.js 400 v11
if (process.argv[3] === 'v11') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v11', name: n + ' 人 v11 預設', args: ['--players', n, '--seed', 3] }); });
  CONFIGS.push({ group: 'v11', name: '14 人 出口晚開 4,7,10', args: ['--players', 14, '--seed', 3, '--exits', '4,7,10'] });
  CONFIGS.push({ group: 'v11', name: '14 人 每箱6', args: ['--players', 14, '--seed', 3, '--set', 'boxSize=6'] });
}

// v12 (同陣營交付 + 丟在地上) 現狀  node sim-all.js 300 v12a
if (process.argv[3] === 'v12a') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 種子' + seed, args: ['--players', n, '--seed', seed] }); }); });
}

// v12 調整  node sim-all.js 300 v12b
if (process.argv[3] === 'v12b') {
  CONFIGS = [];
  function addJ(n, name, sets) { [1, 2].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  addJ(7, '毒效8', ['poisonDuration=8']);
  addJ(8, '逃6', ['runnerSampleThreshold=6']);
  addJ(10, '逃6', ['runnerSampleThreshold=6']);
  addJ(10, '逃7', ['runnerSampleThreshold=7']);
  addJ(11, '逃7', ['runnerSampleThreshold=7']);
  addJ(12, '逃7', ['runnerSampleThreshold=7']);
  addJ(13, '逃7', ['runnerSampleThreshold=7']);
  addJ(14, '逃6', ['runnerSampleThreshold=6']);
  addJ(14, '逃7', ['runnerSampleThreshold=7']);
}

// v12 調整 2  node sim-all.js 300 v12c
if (process.argv[3] === 'v12c') {
  CONFIGS = [];
  function addK(n, name, sets) { [1, 2].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  addK(10, '逃6 飼5', ['runnerSampleThreshold=6', 'breederSampleThreshold=5']);
  addK(10, '逃5 飼5', ['breederSampleThreshold=5']);
  addK(14, '逃7 毒效10', ['runnerSampleThreshold=7', 'poisonDuration=10']);
  addK(14, '逃7 3劑 毒效6', ['runnerSampleThreshold=7', 'poisonDoseLimit=3', 'poisonDuration=6']);
}

// v12 最終驗證  node sim-all.js 400 v12
if (process.argv[3] === 'v12') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v12', name: n + ' 人 v12 預設', args: ['--players', n, '--seed', 3] }); });
}

// v13 (陣營人數平均) 現狀  node sim-all.js 300 v13a
if (process.argv[3] === 'v13a') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 種子' + seed, args: ['--players', n, '--seed', seed] }); }); });
}

// v13 (11、14 人陣營人數調整) 現狀與候選  node sim-all.js 300 v13b
if (process.argv[3] === 'v13b') {
  CONFIGS = [];
  function addL(n, name, sets) { [1, 2].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  addL(11, '現狀 (飼6)', []);
  addL(11, '飼7', ['breederSampleThreshold=7']);
  addL(11, '飼8', ['breederSampleThreshold=8']);
  addL(14, '現狀 (飼7)', []);
  addL(14, '飼8', ['breederSampleThreshold=8']);
  addL(14, '飼9', ['breederSampleThreshold=9']);
}

// v13 調整  node sim-all.js 300 v13c
if (process.argv[3] === 'v13c') {
  CONFIGS = [];
  var B13 = { 9: [6, 6], 10: [5, 6], 11: [6, 5], 12: [7, 5], 13: [7, 5], 14: [7, 6] }; // 飼養門檻, 毒效 (v12)
  function addM(n, name, b, p) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' (飼' + b + '/毒效' + p + ') 種子' + seed, args: ['--players', n, '--seed', seed, '--set', 'breederSampleThreshold=' + b, '--set', 'poisonDuration=' + p] }); }); }
  [9, 10, 11, 12, 13, 14].forEach(function (n) {
    var v = B13[n];
    addM(n, '飼+1', v[0] + 1, v[1]);
    addM(n, '飼+2', v[0] + 2, v[1]);
    addM(n, '飼+2 毒效+2', v[0] + 2, v[1] + 2);
  });
}

// v13 調整 2  node sim-all.js 300 v13d
if (process.argv[3] === 'v13d') {
  CONFIGS = [];
  function addN(n, b, p) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 (飼' + b + '/毒效' + p + ') 種子' + seed, args: ['--players', n, '--seed', seed, '--set', 'breederSampleThreshold=' + b, '--set', 'poisonDuration=' + p] }); }); }
  addN(9, 7, 8); addN(10, 7, 7); addN(12, 8, 7); addN(13, 8, 6); addN(13, 9, 6);
}

// v13 最終驗證  node sim-all.js 400 v13
if (process.argv[3] === 'v13') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v13', name: n + ' 人 v13 預設', args: ['--players', n, '--seed', 3] }); });
}

// v14 (消音器清自己和四鄰格) 現狀  node sim-all.js 300 v14a
if (process.argv[3] === 'v14a') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 種子' + seed, args: ['--players', n, '--seed', seed] }); }); });
}

// v14 (消音器清自己和四鄰格) 現狀  node sim-all.js 300 v14a
if (process.argv[3] === 'v14a') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 種子' + seed, args: ['--players', n, '--seed', seed] }); }); });
}

// v15 (回聲器砍半) 驗證  node sim-all.js 300 v15a
if (process.argv[3] === 'v15a') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 種子' + seed, args: ['--players', n, '--seed', seed] }); }); });
}

// v16 (毒一回合 + 箱子離牛 2 格) 現狀  node sim-all.js 300 v16a
if (process.argv[3] === 'v16a') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 種子' + seed, args: ['--players', n, '--seed', seed] }); }); });
}

// v16 調整  node sim-all.js 300 v16b
if (process.argv[3] === 'v16b') {
  CONFIGS = [];
  function addO(n, name, sets) { [1, 2].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  addO(8, '毒效11', ['poisonDuration=11']);
  addO(8, '毒效11 逃6', ['poisonDuration=11', 'runnerSampleThreshold=6']);
  addO(9, '毒效10', ['poisonDuration=10']);
  addO(9, '毒效10 飼8', ['poisonDuration=10', 'breederSampleThreshold=8']);
}

// v16 調整 2  node sim-all.js 300 v16c
if (process.argv[3] === 'v16c') {
  CONFIGS = [];
  function addP(n, name, sets) { [1, 2].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  [8, 9].forEach(function (n) {
    addP(n, '2劑 毒效3', ['poisonDoseLimit=2', 'poisonDuration=3']);
    addP(n, '2劑 毒效4', ['poisonDoseLimit=2', 'poisonDuration=4']);
  });
}

// v16 調整 3  node sim-all.js 300 v16d
if (process.argv[3] === 'v16d') {
  CONFIGS = [];
  function addQ(n, name, sets) { [1, 2].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  [7, 10].forEach(function (n) { addQ(n, '2劑 毒效3', ['poisonDoseLimit=2', 'poisonDuration=3']); });
}

// v16 最終驗證  node sim-all.js 400 v16
if (process.argv[3] === 'v16') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { CONFIGS.push({ group: 'v16', name: n + ' 人 v16 預設', args: ['--players', n, '--seed', 3] }); });
}

// 8–9 人改回 3 劑 + 下毒加成  node sim-all.js 300 v17a
if (process.argv[3] === 'v17a') {
  CONFIGS = [];
  function addR(n, name, sets) { [1, 2, 3].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  [8, 9].forEach(function (n) {
    addR(n, '3劑', []);
    addR(n, '3劑 下毒+2', ['poisonBonus=2']);
    addR(n, '3劑 下毒+3', ['poisonBonus=3']);
  });
}

// 全人數 下毒 +3  node sim-all.js 300 v17b
if (process.argv[3] === 'v17b') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [1, 2].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 下毒+3 種子' + seed, args: ['--players', n, '--seed', seed, '--set', 'poisonBonus=3'] }); }); });
}

// 大樣本確認: 新種子 4/5/6 各 400 場, 沒加成 vs 下毒 +3  node sim-all.js 400 v17c
if (process.argv[3] === 'v17c') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) {
    [4, 5, 6].forEach(function (seed) {
      CONFIGS.push({ group: n + '人', name: n + ' 人 沒加成 種子' + seed, args: ['--players', n, '--seed', seed] });
      CONFIGS.push({ group: n + '人', name: n + ' 人 下毒+3 種子' + seed, args: ['--players', n, '--seed', seed, '--set', 'poisonBonus=3'] });
    });
  });
}

// 下毒 +3 之後修 8、13 人  node sim-all.js 400 v17d
if (process.argv[3] === 'v17d') {
  CONFIGS = [];
  function addS(n, name, sets) { [7, 8].forEach(function (seed) { var a = ['--players', n, '--seed', seed, '--set', 'poisonBonus=3']; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人', name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  addS(8, '逃6', ['runnerSampleThreshold=6']);
  addS(8, '毒效12', ['poisonDuration=12']);
  addS(13, '飼8', ['breederSampleThreshold=8']);
  addS(13, '飼8 毒效4', ['breederSampleThreshold=8', 'poisonDuration=4']);
}

// v17 最終驗證: 新種子 9/10/11 各 400 場  node sim-all.js 400 v17
if (process.argv[3] === 'v17') {
  CONFIGS = [];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { [9, 10, 11].forEach(function (seed) { CONFIGS.push({ group: n + '人', name: n + ' 人 v17 種子' + seed, args: ['--players', n, '--seed', seed] }); }); });
}

// v17 驗證後: 修 13 人 (牛低屠夫高)、9 人 (屠夫低); 測出口離樣本箱  node sim-all.js 400 v17e
if (process.argv[3] === 'v17e') {
  CONFIGS = [];
  function addE(n, name, sets) { [12, 13, 14].forEach(function (seed) { var a = ['--players', n, '--seed', seed]; sets.forEach(function (kv) { a.push('--set', kv); }); CONFIGS.push({ group: n + '人 ' + name, name: n + ' 人 ' + name + ' 種子' + seed, args: a }); }); }
  addE(13, '毒效5', ['poisonDuration=5']);
  addE(13, '毒效5 飼9', ['poisonDuration=5', 'breederSampleThreshold=9']);
  addE(9, '毒效9', ['poisonDuration=9']);
  addE(9, '毒效10', ['poisonDuration=10']);
  addE(8, '出口離箱3', ['exitBoxMinDist=3']);
  addE(8, '出口離箱3 只第1回合', ['exitBoxMinDist=3', 'exitBoxFirstOnly=1']);
}

// 牛餓肚子加速 / 牛勝肥度 7  node sim-all.js 400 v18a
if (process.argv[3] === 'v18a') {
  CONFIGS = [];
  var V18 = [['基準', []], ['餓+1', ['cowHungerStep=1']], ['餓+1 肥7', ['cowHungerStep=1', 'fatnessWin=7']], ['肥7', ['fatnessWin=7']]];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { V18.forEach(function (v) { [21, 22].forEach(function (seed) {
    var a = ['--players', n, '--seed', seed]; v[1].forEach(function (kv) { a.push('--set', kv); });
    CONFIGS.push({ group: n + '人 ' + v[0], name: n + ' 人 ' + v[0] + ' 種子' + seed, args: a });
  }); }); });
}

// 餓肚子 +1 之後屠夫太強: 下毒改回 +3, 肥度 9/8, 餓肚子上限  node sim-all.js 400 v18b
if (process.argv[3] === 'v18b') {
  CONFIGS = [];
  var V18B = [['餓1 毒3 肥9', ['cowHungerStep=1', 'poisonBonus=0']], ['餓1 毒3 肥8', ['cowHungerStep=1', 'poisonBonus=0', 'fatnessWin=8']],
    ['餓1上限2 毒3 肥8', ['cowHungerStep=1', 'cowHungerMax=2', 'poisonBonus=0', 'fatnessWin=8']]];
  [7, 8, 9, 10, 11, 12, 13, 14].forEach(function (n) { V18B.forEach(function (v) { [21, 22].forEach(function (seed) {
    var a = ['--players', n, '--seed', seed]; v[1].forEach(function (kv) { a.push('--set', kv); });
    CONFIGS.push({ group: n + '人 ' + v[0], name: n + ' 人 ' + v[0] + ' 種子' + seed, args: a });
  }); }); });
}

function run(cfg) {
  return new Promise(function (resolve) {
    var args = [__dirname + '/sim.js', '--games', GAMES, '--json'].concat(cfg.args).map(String);
    var t0 = Date.now();
    execFile(process.execPath, args, { maxBuffer: 1 << 24 }, function (err, out) {
      if (err) { resolve({ cfg: cfg, err: String(err) }); return; }
      resolve({ cfg: cfg, r: JSON.parse(out), sec: (Date.now() - t0) / 1000 });
    });
  });
}

(async function () {
  var queue = CONFIGS.slice(), results = [], par = Math.max(1, os.cpus().length - 1);
  async function worker() {
    while (queue.length) {
      var c = queue.shift(); var res = await run(c); results.push(res);
      process.stderr.write('  ✓ ' + c.name + (res.sec ? ' (' + res.sec.toFixed(0) + 's)' : ' ✗ ' + res.err) + '\n');
    }
  }
  var ws = []; for (var i = 0; i < par; i++) ws.push(worker()); await Promise.all(ws);
  results.sort(function (a, b) { return CONFIGS.indexOf(a.cfg) - CONFIGS.indexOf(b.cfg); });
  fs.writeFileSync(__dirname + '/sim-results/' + (process.argv[3] ? 'sim-results-' + process.argv[3] + '.json' : 'sim-results.json'), JSON.stringify({ games: GAMES, date: new Date().toISOString(), results: results }, null, 1));
  console.log('| 組別 | 設定 | 牛 | 飼養者 | 屠夫 | 逃亡者 | 平均回合 | 牛肥度 | 死亡 | 飼養者失格 | 毒死 | 肥度9 | 全殘響 | 交付/場 | 飼養者勝回合 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  results.forEach(function (x) {
    if (x.err) { console.log('| ' + x.cfg.group + ' | ' + x.cfg.name + ' | 錯誤 |'); return; }
    var r = x.r;
    console.log('| ' + [x.cfg.group, x.cfg.name, r.win.cow + '%', r.win.breeder + '%', r.win.butcher + '%', r.win.runner + '%',
      r.avgRounds, r.avgFat, r.avgKills, r.breederDQ + '%', r.reason.poison + '%', r.reason.fat + '%', r.reason.allEcho + '%', r.transfers, r.breederWinRound].join(' | ') + ' |');
  });
})();
