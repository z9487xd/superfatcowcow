/* 超肥牛牛 ── 可調參數 (現場可改，不用重開程式)
 * All tunable numbers live here. The UI parameter panel edits state.config,
 * which starts as a deep copy of DEFAULT_CONFIG.
 */
(function (root) {
  'use strict';

  var DEFAULT_CONFIG = {
    rounds: 12,                 // 回合總數 (12人以上建議 8)

    // 陣營門檻
    breederSampleThreshold: 6,  // 飼養者死亡時需持有的樣本 (v8: 2 位飼養者 6; 12 人以上 3 位飼養者 → 7, 見 tableFor)
    breederWinAny: 1,           // 1 = 任一飼養者帶滿死亡就贏 (說明書 v7, 預設); 0 = 全體都帶滿死亡才贏, 有人不足即失格 (規則書 v6)
    dropAllowed: 1,             // v12: 輪到自己時可以把任意數量的樣本丟在地上 (不用出牌、不產生噪點), 任何人用互動卡撿
    teamTransfer: 1,            // v12: 同陣營交付 (所有陣營, 同房間、雙方活著, 任意數量, 不用出牌、不產生噪點); 0 = 只看 breederTransfer
    breederTransfer: 2,         // 舊開關 (teamTransfer = 0 時才有意義): 0 = 不可; 1 = 用互動卡交給同房飼養者; 2 = 免費交給同房飼養者
    runnerSampleThreshold: 4,   // 逃亡者帶出出口需持有的樣本 (v8: 7–10 人 4; 11 人以上 5, 見 tableFor)

    // 毒
    poisonDoseLimit: 3,         // 同時存在幾劑 → 牛暴斃
    poisonDuration: 6,          // 一劑毒在牛體內留幾回合

    // 樣本
    boxSize: 5,                 // 每箱樣本數
    boxTake: 2,                 // 每次互動取得數 (箱內剩 1 個時拿 1)

    // 卡牌噪點值
    moveNoise: 1,               // 移動: 起點 +1
    envNoise: 2,                // 環境: 自己 +2
    interactNoise: 1,           // 互動: 自己 +1
    lureTargetNoise: 3,         // 誘導: 目標 +3
    lureSelfNoise: 1,           // 誘導: 自己 +1
    resetNoise: 3,              // 重製: 自己 +3

    // 其他噪點來源
    carryNoisePerSample: 1,     // 攜帶: 身上每個樣本，所在房間 +1/回合
    corpseNoise: 2,             // 屍體: +2/回合，不衰減
    decoyNoise: 5,              // 誘餌槽: 該房間 +5
    poisonOneRound: 1,          // v16: 毒只在下毒的那一回合有效, 回合結束沒被吃掉就消失; 0 = 毒跟著噪點, 噪點歸 0 才消失
    boxMinDist: 2,              // v16: 開局樣本箱至少離牛這麼多格 (可通行步數); 0 = 不限制
    echoHalveSource: 1,         // v15: 回聲器複製後, 自己這格噪點砍半 (無條件捨去); 0 = 不砍半
    silencerRadius: 1,          // v14: 消音器清掉自己這格 + 上下左右四格 (隔牆也算); 0 = 只清自己這格

    // 肥度門檻
    fatnessSmash: 4,            // 肥度 >= 此值 → 撞牆 (不繞路)
    fatnessSplash: 7,           // 肥度 >= 此值 → 路徑波及旁邊
    fatnessWin: 9,              // 肥度達此值 → 牛獲勝
    cowMoveBonus: 1,            // 牛移動格數 = 肥度 + cowMoveBonus
    cowLateBonus: 0,            // (測試中) 肥度 >= cowLateFat 時步數再 +N; 0 = 不用
    cowLateFat: 5,
    firstWinEnds: 1,            // 任一陣營達成 → 遊戲立刻結束 (牛的同一次行動中達成的陣營一起贏); 0 = 舊規則: 勝利鎖定、遊戲繼續
    timeoutCowWins: 1,          // v10: 第 12 回合結束時沒有任何陣營獲勝 → 牛獲勝 (沒有平手); 0 = 舊規則 (可能無人勝)

    // 場地 (依人數自動選, 見 tableFor)
    // 這些是「每張地圖」的預設, tableFor() 會依人數覆寫 decay / 裝置數量
  };

  // 依人數決定場地規模與裝置數量 (說明書 第 3 節)
  function tableFor(playerCount) {
    var t = baseTable(playerCount);
    var o = t.overrides;
    // v13 各人數微調 (陣營人數依序加 + 同陣營交付 + 誰先達成誰贏 + 時間到牛贏; 見 平衡測試報告.md)
    //   人數   逃亡門檻 飼養門檻 毒效 每箱 毒死劑數
    // v16: 毒只維持一回合之後, 8–9 人屠夫偏弱 → 毒 2 劑就死、毒效 3 回合
    var V13 = { 7: [5, 7, 8, 6, 3], 8: [5, 6, 3, 5, 2], 9: [5, 7, 3, 5, 2], 10: [5, 7, 7, 5, 3],
      11: [7, 8, 7, 5, 3], 12: [7, 9, 7, 5, 3], 13: [6, 9, 6, 5, 3], 14: [7, 8, 6, 5, 3] }[playerCount];
    if (V13) { o.runnerSampleThreshold = V13[0]; o.breederSampleThreshold = V13[1]; o.poisonDuration = V13[2]; o.boxSize = V13[3]; o.poisonDoseLimit = V13[4]; }
    return t;
  }

  function baseTable(playerCount) {
    if (playerCount <= 10) {
      return {
        N: 5, decay: 1,
        overrides: {},
        devices: { sample_box: 4, silencer: 2, decoy: 2, echo: 2 },
        exits: 1,
        exitSchedule: [1, 4, 7, 10],      // 一個出口刷新回合
        exitSchedule2: [2, 5, 8, 11]      // 第二個出口 (此人數用不到)
      };
    }
    return {
      N: 6, decay: 2,
      // 11–14 人修正 (v7 模擬: 逃亡者原本勝率 74–85%、牛只有 5% → 牛步數 +2; v8 逃亡者門檻 5)
      overrides: { runnerSampleThreshold: 5, cowMoveBonus: 2 },
      devices: { sample_box: 6, silencer: 3, decoy: 3, echo: 2 },
      exits: 2,
      exitSchedule: [1, 4, 7, 10],
      exitSchedule2: [2, 5, 8, 11]
    };
  }

  // 陣營配置 (說明書 第 2 節)  index = 人數
  var FACTION_TABLE = {   // v13: 每多一人依序加給 屠夫 → 逃亡者 → 飼養者 (飼養者永遠最少或並列最少)
    7:  { breeder: 2, butcher: 3, runner: 2 },
    8:  { breeder: 2, butcher: 3, runner: 3 },
    9:  { breeder: 3, butcher: 3, runner: 3 },
    10: { breeder: 3, butcher: 4, runner: 3 },
    11: { breeder: 3, butcher: 4, runner: 4 },
    12: { breeder: 4, butcher: 4, runner: 4 },
    13: { breeder: 4, butcher: 5, runner: 4 },
    14: { breeder: 4, butcher: 5, runner: 5 }
  };

  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    tableFor: tableFor,
    FACTION_TABLE: FACTION_TABLE
  };

  root.SFCC_CONFIG = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
