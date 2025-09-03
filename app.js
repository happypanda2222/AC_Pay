'use strict';
// --- Lock zoom: block pinch & double-tap zoom (best-effort for iOS PWAs) ---
(function preventZoom(){
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  // Pinch-zoom gestures (iOS Safari exposes these)
  document.addEventListener('gesturestart', stop, {passive:false});
  document.addEventListener('gesturechange', stop, {passive:false});
  document.addEventListener('gestureend', stop, {passive:false});
  // Double-tap zoom
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouch < 300) { e.preventDefault(); }
    lastTouch = now;
  }, {passive:false});
})();

// --- Constants & Config ---
const DOH = new Date('2024-08-07T00:00:00Z');
const PROGRESSION = {m:11, d:10};
const SWITCH = {m:9, d:30};
const AIRCRAFT_ORDER = ["777","787","330","767","320","737","220"];
const HEALTH_MO = 58.80;

// --- Pay tables 2023–2026 (from contract) ---
const PAY_TABLES = {
  2023: { CA: { "777":{1:365.60,2:369.28,3:372.99,4:376.75,5:380.54,6:384.38,7:388.26,8:392.18,9:396.14,10:400.14,11:404.18,12:408.27},
                "787":{1:336.02,2:339.40,3:342.81,4:346.27,5:349.76,6:353.28,7:356.85,8:360.45,9:364.09,10:367.77,11:371.48,12:375.23},
                "330":{1:329.57,2:332.88,3:336.23,4:339.62,5:343.04,6:346.50,7:349.99,8:353.53,9:357.10,10:360.70,11:364.35,12:368.03},
                "767":{1:308.82,2:311.93,3:315.07,4:318.24,5:321.45,6:324.69,7:327.96,8:331.27,9:334.62,10:338.00,11:341.41,12:344.86},
                "320":{1:268.55,2:271.25,3:273.98,4:276.74,5:279.53,6:282.35,7:285.20,8:288.07,9:290.98,10:293.92,11:296.89,12:299.89},
                "737":{1:268.55,2:271.25,3:273.98,4:276.74,5:279.53,6:282.35,7:285.20,8:288.07,9:290.98,10:293.92,11:296.89,12:299.89},
                "220":{1:263.35,2:265.99,3:268.67,4:271.37,5:274.11,6:276.87,7:279.67,8:282.49,9:285.34,10:288.22,11:291.14,12:294.08} },
          FO: { "777":{1:84.12,2:91.16,3:138.01,4:148.82,5:207.40,6:215.25,7:223.25,8:231.39,9:239.66,10:248.09,11:256.66,12:265.37},
                "787":{1:84.12,2:91.16,3:126.84,4:136.78,5:190.62,6:197.84,7:205.19,8:212.67,9:220.27,10:228.02,11:235.89,12:243.90},
                "330":{1:84.12,2:91.16,3:124.41,4:134.15,5:186.96,6:194.04,7:201.25,8:208.58,9:216.04,10:223.64,11:231.36,12:239.22},
                "767":{1:84.12,2:91.16,3:116.57,4:125.70,5:175.19,6:181.82,7:188.58,8:195.45,9:202.44,10:209.56,11:216.80,12:224.16},
                "320":{1:84.12,2:91.16,3:115.07,4:123.15,5:156.54,6:162.35,7:168.27,8:174.29,9:180.41,10:186.64,11:192.98,12:199.43},
                "737":{1:84.12,2:91.16,3:115.07,4:123.15,5:156.54,6:162.35,7:168.27,8:174.29,9:180.41,10:186.64,11:192.98,12:199.43},
                "220":{1:84.12,2:91.16,3:112.84,4:120.76,5:153.50,6:159.20,7:165.00,8:170.91,9:176.91,10:183.02,11:189.24,12:195.56} },
          RP: { "777":{1:84.12,2:91.16,3:106.30,4:114.91,5:140.80,6:146.07,7:151.42,8:156.87,9:162.42,10:168.06,11:171.78,12:175.55},
                "787":{1:84.12,2:91.16,3:97.70,4:105.61,5:129.41,6:134.25,7:139.17,8:144.18,9:149.28,10:154.46,11:157.88,12:161.35},
                "330":{1:84.12,2:91.16,3:95.83,4:103.58,5:126.92,6:131.67,7:136.50,8:141.41,9:146.41,10:151.50,11:154.85,12:158.25} }
        },
  2024: { CA: { "777":{1:380.23,2:384.05,3:387.91,4:391.82,5:395.77,6:399.76,7:403.79,8:407.87,9:411.99,10:416.15,11:420.35,12:424.60},
                "787":{1:349.46,2:352.98,3:356.53,4:360.12,5:363.75,6:367.41,7:371.12,8:374.87,9:378.65,10:382.48,11:386.34,12:390.24},
                "330":{1:342.75,2:346.20,3:349.68,4:353.20,5:356.76,6:360.36,7:364.00,8:367.67,9:371.38,10:375.13,11:378.92,12:382.75},
                "767":{1:321.18,2:324.40,3:327.67,4:330.97,5:334.30,6:337.67,7:341.08,8:344.52,9:348.00,10:351.52,11:355.07,12:358.66},
                "320":{1:279.29,2:282.10,3:284.94,4:287.81,5:290.71,6:293.64,7:296.60,8:299.60,9:302.62,10:305.68,11:308.77,12:311.89},
                "737":{1:279.29,2:282.10,3:284.94,4:287.81,5:290.71,6:293.64,7:296.60,8:299.60,9:302.62,10:305.68,11:308.77,12:311.89},
                "220":{1:273.88,2:276.63,3:279.41,4:282.23,5:285.07,6:287.95,7:290.85,8:293.79,9:296.76,10:299.75,11:302.78,12:305.84} },
          FO: { "777":{1:87.48,2:94.81,3:143.53,4:154.77,5:215.69,6:223.86,7:232.18,8:240.64,9:249.25,10:258.01,11:266.92,12:275.99},
                "787":{1:87.48,2:94.81,3:131.92,4:142.25,5:198.24,6:205.75,7:213.40,8:221.17,9:229.09,10:237.14,11:245.33,12:253.66},
                "330":{1:87.48,2:94.81,3:129.38,4:139.51,5:194.43,6:201.80,7:209.30,8:216.93,9:224.69,10:232.58,11:240.62,12:248.79},
                "767":{1:87.48,2:94.81,3:121.24,4:130.73,5:182.20,6:189.10,7:196.12,8:203.27,9:210.54,10:217.94,11:225.47,12:233.13},
                "320":{1:87.48,2:94.81,3:119.67,4:128.07,5:162.80,6:168.84,7:175.00,8:181.26,9:187.63,10:194.11,11:200.70,12:207.40},
                "737":{1:87.48,2:94.81,3:119.67,4:128.07,5:162.80,6:168.84,7:175.00,8:181.26,9:187.63,10:194.11,11:200.70,12:207.40},
                "220":{1:87.48,2:94.81,3:117.35,4:125.59,5:159.64,6:165.57,7:171.60,8:177.74,9:183.99,10:190.34,11:196.81,12:203.38} },
          RP: { "777":{1:87.48,2:94.81,3:110.56,4:119.50,5:146.43,6:151.91,7:157.48,8:163.15,9:168.91,10:174.78,11:178.65,12:182.58},
                "787":{1:87.48,2:94.81,3:101.61,4:109.84,5:134.59,6:139.62,7:144.74,8:149.95,9:155.25,10:160.64,11:164.20,12:167.80},
                "330":{1:87.48,2:94.81,3:99.66,4:107.73,5:132.00,6:136.94,7:141.96,8:147.07,9:152.27,10:157.56,11:161.04,12:164.58} }
        },
  2025: { CA: { "777":{1:395.43,2:399.40,3:403.42,4:407.48,5:411.59,6:415.74,7:419.94,8:424.18,9:428.46,10:432.79,11:437.16,12:441.57},
                "787":{1:363.44,2:367.09,3:370.78,4:374.52,5:378.29,6:382.10,7:385.96,8:389.86,9:393.79,10:397.77,11:401.79,12:405.85},
                "330":{1:356.46,2:360.04,3:363.66,4:367.32,5:371.03,6:374.77,7:378.55,8:382.37,9:386.23,10:390.13,11:394.07,12:398.05},
                "767":{1:334.02,2:337.37,3:340.77,4:344.20,5:347.67,6:351.18,7:354.72,8:358.30,9:361.92,10:365.57,11:369.27,12:373.00},
                "320":{1:290.46,2:293.38,3:296.33,4:299.32,5:302.33,6:305.38,7:308.46,8:311.58,9:314.72,10:317.90,11:321.11,12:324.36},
                "737":{1:290.46,2:293.38,3:296.33,4:299.32,5:302.33,6:305.38,7:308.46,8:311.58,9:314.72,10:317.90,11:321.11,12:324.36},
                "220":{1:284.83,2:287.69,3:290.59,4:293.51,5:296.47,6:299.46,7:302.48,8:305.54,9:308.62,10:311.74,11:314.89,12:318.07} },
          FO: { "777":{1:90.98,2:98.60,3:149.27,4:160.96,5:224.32,6:232.82,7:241.46,8:250.26,9:259.22,10:268.33,11:277.60,12:287.02},
                "787":{1:90.98,2:98.60,3:137.19,4:147.93,5:206.17,6:213.98,7:221.93,8:230.02,9:238.24,10:246.62,11:255.14,12:263.80},
                "330":{1:90.98,2:98.60,3:134.55,4:145.09,5:202.21,6:209.87,7:217.67,8:225.60,9:233.67,10:241.88,11:250.24,12:258.73},
                "767":{1:90.98,2:98.60,3:126.08,4:135.96,5:189.48,6:196.66,7:203.96,8:211.40,9:218.96,10:226.66,11:234.48,12:242.45},
                "320":{1:90.98,2:98.60,3:124.46,4:133.20,5:169.31,6:175.59,7:181.99,8:188.50,9:195.13,10:201.87,11:208.72,12:215.70},
                "737":{1:90.98,2:98.60,3:124.46,4:133.20,5:169.31,6:175.59,7:181.99,8:188.50,9:195.13,10:201.87,11:208.72,12:215.70},
                "220":{1:90.98,2:98.60,3:122.05,4:130.61,5:166.02,6:172.19,7:178.46,8:184.85,9:191.34,10:197.95,11:204.68,12:211.51} },
          RP: { "777":{1:90.98,2:98.60,3:114.98,4:124.28,5:152.29,6:157.98,7:163.78,8:169.67,9:175.67,10:181.77,11:185.79,12:189.88},
                "787":{1:90.98,2:98.60,3:105.67,4:114.23,5:139.97,6:145.20,7:150.52,8:155.94,9:161.46,10:167.06,11:170.76,12:174.51},
                "330":{1:90.98,2:98.60,3:103.64,4:112.03,5:137.28,6:142.41,7:147.63,8:152.95,9:158.35,10:163.86,11:167.48,12:171.16} }
        },
  2026: { CA: { "777":{1:411.26,2:415.39,3:419.57,4:423.80,5:428.07,6:432.39,7:436.75,8:441.16,9:445.61,10:450.11,11:454.66,12:459.25},
                "787":{1:377.98,2:381.78,3:385.62,4:389.51,5:393.43,6:397.40,7:401.41,8:405.46,9:409.56,10:413.69,11:417.87,12:422.09},
                "330":{1:370.72,2:374.45,3:378.22,4:382.03,5:385.88,6:389.77,7:393.70,8:397.68,9:401.69,10:405.75,11:409.85,12:413.99},
                "767":{1:347.39,2:350.88,3:354.41,4:357.98,5:361.58,6:365.23,7:368.92,8:372.64,9:376.40,10:380.21,11:384.05,12:387.92},
                "320":{1:302.08,2:305.12,3:308.19,4:311.29,5:314.43,6:317.60,7:320.80,8:324.04,9:327.32,10:330.62,11:333.96,12:337.33},
                "737":{1:302.08,2:305.12,3:308.19,4:311.29,5:314.43,6:317.60,7:320.80,8:324.04,9:327.32,10:330.62,11:333.96,12:337.33},
                "220":{1:296.23,2:299.20,3:302.21,4:305.26,5:308.33,6:311.44,7:314.58,8:317.76,9:320.97,10:324.21,11:327.49,12:330.79} },
        FO: { "777":{1:94.62,2:102.54,3:155.24,4:167.40,5:233.30,6:242.14,7:251.13,8:260.28,9:269.60,10:279.07,11:288.71,12:298.51},
              "787":{1:94.62,2:102.54,3:142.68,4:153.86,5:214.42,6:222.54,7:230.81,8:239.22,9:247.78,10:256.49,11:265.35,12:274.36},
              "330":{1:94.62,2:102.54,3:139.94,4:150.90,5:210.30,6:218.27,7:226.38,8:234.63,9:243.02,10:251.56,11:260.25,12:269.09},
              "767":{1:94.62,2:102.54,3:131.13,4:141.40,5:197.06,6:204.53,7:212.13,8:219.86,9:227.72,10:235.73,11:243.87,12:252.15},
              "320":{1:94.62,2:102.54,3:129.44,4:138.53,5:176.08,6:182.62,7:189.27,8:196.05,9:202.94,10:209.94,11:217.07,12:224.33},
              "737":{1:94.62,2:102.54,3:129.44,4:138.53,5:176.08,6:182.62,7:189.27,8:196.05,9:202.94,10:209.94,11:217.07,12:224.33},
              "220":{1:94.62,2:102.54,3:126.93,4:135.84,5:172.67,6:179.08,7:185.61,8:192.25,9:199.00,10:205.87,11:212.87,12:219.98} },
        RP: { "777":{1:94.62,2:102.54,3:119.58,4:129.26,5:158.39,6:164.31,7:170.33,8:176.46,9:182.70,10:189.05,11:193.23,12:197.48},
              "787":{1:94.62,2:102.54,3:109.90,4:118.80,5:145.57,6:151.01,7:156.55,8:162.18,9:167.92,10:173.75,11:177.60,12:181.50},
              "330":{1:94.62,2:102.54,3:107.79,4:116.52,5:142.77,6:148.11,7:153.54,8:159.07,9:164.69,10:170.41,11:174.18,12:178.01} }
        }
};

// --- Projections 2027–2031 ---
(function buildProjections(){
  const raises = {2027:1.12, 2028:1.12*1.04, 2029:1.12*1.04*1.04, 2030:1.12*1.04*1.04*1.04, 2031:1.12*1.04*1.04*1.04*1.04};
  [2027,2028,2029,2030,2031].forEach(y=>{
    const factor = raises[y];
    const base = PAY_TABLES[2026];
    const proj = {}; for (const seat in base){ proj[seat]={}; for (const ac in base[seat]){
      proj[seat][ac]={}; for (const k in base[seat][ac]){ proj[seat][ac][k] = +(base[seat][ac][k]*factor).toFixed(2); }
    }}
    PAY_TABLES[y] = proj;
  });
})();

// === Projected 2027–2031: FO & RP anchored to CA Step 12 ===
// Captain "composite" anchor interpreted as CA Step 12 on the same fleet/year.
// FO1/FO2 remain flat across fleets (use the year's flat values as-is).

const NB_FLEETS = new Set(['320','737','220']);           // narrow-body
const WB_FLEETS = new Set(['777','787','330','767']);      // wide-body

// FO % of CA12 (Years 3–12)
const MULT_FO_NB = { // Narrow-body
  3:0.50, 4:0.53, 5:0.56, 6:0.58, 7:0.60, 8:0.615, 9:0.63, 10:0.645, 11:0.66, 12:0.68
};
const MULT_FO_WB = { // Wide-body
  3:0.48, 4:0.51, 5:0.545, 6:0.565, 7:0.585, 8:0.60, 9:0.615, 10:0.63, 11:0.65, 12:0.67
};

// RP % of CA12 (Years 3–12; all fleets)
const MULT_RP_ALL = {
  3:0.35, 4:0.38, 5:0.41, 6:0.43, 7:0.45, 8:0.465, 9:0.48, 10:0.49, 11:0.495, 12:0.50
};

function applyAnchoredSlopesFO_RP() {
  const YEARS = [2027, 2028, 2029, 2030, 2031];
  YEARS.forEach((y) => {
    const yr = PAY_TABLES[y];
    if (!yr || !yr.CA) return;

    // Use the year's FO1/FO2 (flat) from any AC to enforce uniformity
    let flatFO1, flatFO2;
    if (yr.FO) {
      const ac0 = Object.keys(yr.FO)[0];
      if (ac0) {
        flatFO1 = yr.FO[ac0][1];
        flatFO2 = yr.FO[ac0][2];
      }
    }

    for (const ac of Object.keys(yr.CA)) {
      const ca = yr.CA[ac]; if (!ca || !ca[12]) continue;
      const ca12 = ca[12];

      // ---- FO (anchor to CA12 with NB/WB slopes) ----
      if (yr.FO && yr.FO[ac]) {
        const fo = yr.FO[ac];

        // Keep FO1/FO2 flat across fleets
        if (typeof flatFO1 === 'number') fo[1] = flatFO1;
        if (typeof flatFO2 === 'number') fo[2] = flatFO2;

        const map = NB_FLEETS.has(ac) ? MULT_FO_NB : MULT_FO_WB;
        for (let s = 3; s <= 12; s++) {
          const m = map[s]; if (!m) continue;
          const target = +(ca12 * m).toFixed(2);
          // Only raise (never lower) any prior projection
          fo[s] = Math.max(fo[s] || 0, target);
        }
        // Monotonic guard
        for (let s = 2; s <= 12; s++) {
          if (fo[s] < fo[s-1]) fo[s] = fo[s-1];
        }
      }

      // ---- RP (anchor to CA12; same curve for all fleets) ----
      if (yr.RP && yr.RP[ac]) {
        const rp = yr.RP[ac];
        for (let s = 3; s <= 12; s++) {
          const m = MULT_RP_ALL[s]; if (!m) continue;
          const target = +(ca12 * m).toFixed(2);
          rp[s] = Math.max(rp[s] || 0, target);
        }
        for (let s = 2; s <= 12; s++) {
          if (rp[s] < rp[s-1]) rp[s] = rp[s-1];
        }
      }
    }
  });
}

// Run after projections
applyAnchoredSlopesFO_RP();

// === Conservative RP1–4 discount compression for 2027–2031 ===
// Discounts vs RP Step 5 on the same aircraft.
const RP_EARLY_CONSERVATIVE = { 1: 0.42, 2: 0.35, 3: 0.22, 4: 0.15 };

function applyConservativeRPCompression() {
  const years = [2027, 2028, 2029, 2030, 2031];
  years.forEach((y) => {
    const rp = PAY_TABLES[y] && PAY_TABLES[y].RP;
    if (!rp) return;
    Object.keys(rp).forEach((ac) => {
      const step5 = rp[ac][5];
      if (!step5) return;
      for (let s = 1; s <= 4; s++) {
        const target = +(step5 * (1 - RP_EARLY_CONSERVATIVE[s])).toFixed(2);
        rp[ac][s] = Math.max(rp[ac][s] || 0, target);
      }
    });
  });
}
applyConservativeRPCompression();


// --- 2025 Tax Data ---
const FED = { brackets:[[57375,0.145],[114750,0.205],[177882,0.26],[253414,0.29],[Infinity,0.33]],
              bpa_base:14538,bpa_additional:1591,bpa_addl_start:177882,bpa_addl_end:253414 };
const PROV = {
  AB:{brackets:[[60000,0.08],[151234,0.10],[181481,0.12],[241974,0.13],[362961,0.14],[Infinity,0.15]], bpa:22323},
  BC:{brackets:[[49279,0.0506],[98560,0.077],[113158,0.105],[137407,0.1229],[186306,0.147],[259829,0.168],[Infinity,0.205]], bpa:12932},
  MB:{brackets:[[47000,0.108],[100000,0.1275],[Infinity,0.174]], bpa:15780},
  NB:{brackets:[[51306,0.094],[102614,0.14],[190060,0.16],[Infinity,0.195]], bpa:13261},
  NL:{brackets:[[44192,0.087],[88382,0.145],[157792,0.158],[220910,0.178],[282214,0.198],[564429,0.208],[1128858,0.213],[Infinity,0.218]], bpa:10882},
  NS:{brackets:[[30507,0.0879],[61015,0.1495],[95883,0.1667],[154650,0.175],[Infinity,0.21]], bpa:8841},
  NT:{brackets:[[51964,0.059],[103930,0.086],[168967,0.122],[Infinity,0.1405]], bpa:16673},
  NU:{brackets:[[54707,0.04],[109413,0.07],[177881,0.09],[Infinity,0.115]], bpa:16862},
  ON:{brackets:[[52886,0.0505],[105775,0.0915],[150000,0.1116],[220000,0.1216],[Infinity,0.1316]], bpa:12399},
  PE:{brackets:[[33328,0.095],[64656,0.1347],[105000,0.166],[140000,0.1762],[Infinity,0.19]], bpa:13000},
  QC:{brackets:[[53255,0.14],[106495,0.19],[129590,0.24],[Infinity,0.2575]], bpa:18571},
  SK:{brackets:[[53463,0.105],[152750,0.125],[Infinity,0.145]], bpa:19241},
  YT:{brackets:[[57375,0.064],[114750,0.09],[177882,0.109],[500000,0.128],[Infinity,0.15]], bpa:15805}
};
const CPP = {ympe:71300,yampe:81200,ybe:3500, rate_base:0.0595, rate_cpp2:0.04, max_base:4034.10, max_cpp2:396.00};
const QPP = {ympe:71300,yampe:81200,ybe:3500, rate_base_total:0.064, rate_qpp2:0.04};
const EI = {mie:65700, rate:0.0164, rate_qc:0.0131, max_prem:1077.48, max_prem_qc:860.67};

// --- Helpers ---
function clampStep(s){ s=+s; if (s<1) return 1; if (s>12) return 12; return s; }
function federalBPA2025(income){
  const b=FED; let addl=0;
  if (income<=b.bpa_addl_start) addl=b.bpa_additional;
  else if (income<b.bpa_addl_end){ const frac=(b.bpa_addl_end-income)/(b.bpa_addl_end-b.bpa_addl_start); addl=b.bpa_additional*Math.max(0,Math.min(1,frac)); }
  return b.bpa_base+addl;
}
function taxFromBrackets(taxable, brackets){
  let tax=0,last=0;
  for (let i=0;i<brackets.length;i++){
    const cap=brackets[i][0], rate=brackets[i][1];
    const slice=Math.min(taxable,cap)-last;
    if (slice>0){ tax+=slice*rate; last=cap; }
    if (taxable<=cap) break;
  }
  return Math.max(0,tax);
}
function marginalRate(amount, brackets){
  for (let i=0;i<brackets.length;i++){ if (amount<=brackets[i][0]) return brackets[i][1]; }
  return brackets[brackets.length-1][1];
}
function pensionRateOnDate(d){ const years=(d-DOH)/(365.2425*24*3600*1000); if (years<2) return 0.06; if (years<5) return 0.065; return 0.07; }
function stepOnJan1(selectedStep, tieOn, year){ return tieOn ? clampStep((year-2025)+1) : clampStep(selectedStep); }
function rateFor(seat, ac, year, step, xlr){
  const table = PAY_TABLES[year] && PAY_TABLES[year][seat];
  if (!table) throw new Error('Missing pay table for '+year+' '+seat);
  if (seat==='RP' && ['777','787','330'].indexOf(ac)===-1) throw new Error('RP seat only on 777/787/330');
  let rate = table[ac][clampStep(step)];
  if (xlr && ac==='320' && !(seat==='FO' && (step===1||step===2))) rate += 2.46;
  return rate;
}
function yearSegments(year, stepJan1){
  const jan1=new Date(Date.UTC(year,0,1));
  const sep30=new Date(Date.UTC(year, SWITCH.m-1, SWITCH.d));
  const nov10=new Date(Date.UTC(year, PROGRESSION.m-1, PROGRESSION.d));
  const dec31=new Date(Date.UTC(year,11,31));
  const prev=year-1;
  return [
    {start:jan1, end:new Date(sep30.getTime()-86400000), payYear:prev, step:stepJan1},
    {start:sep30, end:new Date(nov10.getTime()-86400000), payYear:year, step:stepJan1},
    {start:nov10, end:dec31, payYear:year, step:clampStep(stepJan1+1)}
  ];
}
function daysInclusive(a,b){ return Math.round((b-a)/86400000)+1; }
function money(x){ return '$'+(x||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
// ---- CPP/QPP & EI precise daily caps ----
// ---- CPP/QPP & EI precise daily caps (cumulative method) ----
function computeCPP_EI_Daily({ year, seat, ac, stepJan1, xlrOn, avgMonthlyHours, province }) {
  const segs = yearSegments(year, stepJan1);
  const dailyHours = avgMonthlyHours * 12 / 365.2425;
  const inQC = (province === 'QC');

  let cpp = 0, ei = 0;

  // Cumulative earnings trackers (used to compute incremental eligible bases)
  let cumGross = 0;           // cumulative pensionable/insurable gross
  let cumEIBase = 0;          // EI base already counted
  let cumBaseElig = 0;        // CPP/QPP Tier-1 eligible base counted (above YBE, up to YMPE)
  let cumTier2Elig = 0;       // CPP2/QPP2 eligible base counted (between YMPE and YAMPE)

  for (let t = Date.UTC(year,0,1); t <= Date.UTC(year,11,31); t += 86400000) {
    const day = new Date(t);

    // Which pay table/step applies today
    let py = year, st = stepJan1;
    for (const s of segs) { if (day >= s.start && day <= s.end) { py = s.payYear; st = s.step; break; } }
    const rate = rateFor(seat, ac, py, st, !!xlrOn);
    const g = dailyHours * rate;           // today's gross
    cumGross += g;

    // --- EI (cap by MIE; incremental contribution on new eligible amount) ---
    {
      const ei_rate = inQC ? EI.rate_qc : EI.rate;
      const ei_maxPrem = inQC ? EI.max_prem_qc : EI.max_prem;
      const eiEligibleToDate = Math.min(cumGross, EI.mie);
      const addEIBase = Math.max(0, eiEligibleToDate - cumEIBase);
      ei += addEIBase * ei_rate;
      cumEIBase += addEIBase;
      if (ei > ei_maxPrem) ei = ei_maxPrem; // rounding guard
    }

    // --- CPP/QPP base (Tier-1) & Tier-2 using cumulative windows ---
    if (inQC) {
      // QPP Tier-1: between YBE and YMPE
      const baseEligToDate = Math.max(0, Math.min(cumGross, QPP.ympe) - QPP.ybe);
      const addBase = Math.max(0, baseEligToDate - cumBaseElig);
      cpp += addBase * QPP.rate_base_total;
      cumBaseElig += addBase;

      // QPP2: between YMPE and YAMPE
      const tier2EligToDate = Math.max(0, Math.min(cumGross, QPP.yampe) - QPP.ympe);
      const add2 = Math.max(0, tier2EligToDate - cumTier2Elig);
      cpp += add2 * QPP.rate_qpp2;
      cumTier2Elig += add2;
    } else {
      // CPP Tier-1: between YBE and YMPE
      const baseEligToDate = Math.max(0, Math.min(cumGross, CPP.ympe) - CPP.ybe);
      const addBase = Math.max(0, baseEligToDate - cumBaseElig);
      cpp += addBase * CPP.rate_base;
      cumBaseElig += addBase;

      // CPP2: between YMPE and YAMPE
      const tier2EligToDate = Math.max(0, Math.min(cumGross, CPP.yampe) - CPP.ympe);
      const add2 = Math.max(0, tier2EligToDate - cumTier2Elig);
      cpp += add2 * CPP.rate_cpp2;
      cumTier2Elig += add2;
    }
  }

  return { cpp_total: +cpp.toFixed(2), ei: +ei.toFixed(2) };
}
// ---- Best-effort haptic tap ----
const hapticTap = (() => {
  let ac; // audio context
  return (el) => {
    try { if (navigator.vibrate) navigator.vibrate(10); } catch(e){}
    // micro visual pulse
    if (el) { el.classList.add('haptic-tap'); setTimeout(()=>el.classList.remove('haptic-tap'), 140); }
    // tiny click
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'square';
      o.frequency.value = 120;
      g.gain.value = 0.02;
      o.connect(g); g.connect(ac.destination);
      o.start();
      setTimeout(()=>o.stop(), 25);
    } catch(e){}
  };
})();
// ---- Union dues at 1.85% of gross, computed monthly ----
function computeUnionDuesMonthly({ year, seat, ac, stepJan1, xlrOn, avgMonthlyHours }) {
  const segs = yearSegments(year, stepJan1);
  const dailyHours = avgMonthlyHours * 12 / 365.2425;
  const monthsGross = new Array(12).fill(0);

  for (let t = Date.UTC(year,0,1); t <= Date.UTC(year,11,31); t += 86400000) {
    const day = new Date(t), m = day.getUTCMonth();
    let py = year, st = stepJan1;
    for (const s of segs) { if (day >= s.start && day <= s.end) { py = s.payYear; st = s.step; break; } }
    const rate = rateFor(seat, ac, py, st, !!xlrOn);
    monthsGross[m] += dailyHours * rate;
  }

  const duesByMonth = monthsGross.map(g => +(g * 0.0185).toFixed(2));
  const annual = +(duesByMonth.reduce((a,b)=>a+b, 0).toFixed(2));
  const avgMonthly = +(annual / 12).toFixed(2);
  return { duesByMonth, annual, avgMonthly };
}

// --- Annual computation ---
function computeAnnual(params){
  const seat=params.seat, ac=params.ac, year=+params.year, province=params.province;
  const stepJan1 = stepOnJan1(params.stepInput, !!params.tieOn, year);
  const segs = yearSegments(year, stepJan1);
  const dailyHours = (+params.avgMonthlyHours)*12/365.2425;
  const audit=[]; let gross=0;
  for (let seg of segs){
    const r=rateFor(seat, ac, seg.payYear, seg.step, !!params.xlrOn);
    const d=daysInclusive(seg.start, seg.end);
    const h=dailyHours*d;
    const pay=h*r;
    gross += pay;
    audit.push({start:seg.start, end:seg.end, pay_table_year:seg.payYear, step:seg.step, hourly:r, days:d, hours:h, segment_gross:pay});
  }
  // Pension accrual loop
  let pension=0;
  for (let t=Date.UTC(year,0,1); t<=Date.UTC(year,11,31); t+=86400000){
    const day=new Date(t);
    const pct = pensionRateOnDate(day);
    let py=year, st=stepJan1;
    for (let s of segs){ if (day>=s.start && day<=s.end){ py=s.payYear; st=s.step; break; } }
    const rate = rateFor(seat, ac, py, st, !!params.xlrOn);
    const dayPay = dailyHours*rate; pension += dayPay*pct;
  }
  const taxable = Math.max(0, gross - pension);

  // Precise CPP/QPP & EI using daily caps
  const ded = computeCPP_EI_Daily({
    year,
    seat,
    ac,
    stepJan1,
    xlrOn: !!params.xlrOn,
    avgMonthlyHours: +params.avgMonthlyHours,
    province
  });
  const cpp_total = ded.cpp_total;
  const eiPrem    = ded.ei;

  // Taxes with credits on lowest rates
  const fed_tax = Math.max(0, taxFromBrackets(taxable, FED.brackets) - (0.145*federalBPA2025(taxable) + 0.15*(cpp_total+eiPrem)));
  const p = PROV[province];
  const prov_gross = taxFromBrackets(taxable, p.brackets);
  const prov_low = p.brackets[0][1];
  const prov_tax = Math.max(0, prov_gross - (prov_low*p.bpa + prov_low*(cpp_total+eiPrem)));
  const income_tax = fed_tax + prov_tax;

  // ESOP and match (approx. after-tax value using combined marginal rate at taxable)
  const esop = Math.min((+params.esopPct/100)*gross, 30000);
  const comb_top = marginalRate(taxable, FED.brackets) + marginalRate(taxable, p.brackets);
  const esop_match_net = +(0.30*esop*(1 - comb_top)).toFixed(2);

  // Union dues (1.85% of gross) computed monthly
  const union = computeUnionDuesMonthly({
    year,
    seat,
    ac,
    stepJan1,
    xlrOn: !!params.xlrOn,
    avgMonthlyHours: +params.avgMonthlyHours
  });

  // Totals
  const annual_health = HEALTH_MO*12;
  const net = gross - income_tax - cpp_total - eiPrem - annual_health - union.annual + esop_match_net;

  const monthly = {
    gross: +(gross/12).toFixed(2),
    net: +((net - esop - esop_match_net)/12).toFixed(2), // take-home excluding ESOP and match
    income_tax: +(income_tax/12).toFixed(2),
    cpp: +(cpp_total/12).toFixed(2),
    ei: +(eiPrem/12).toFixed(2),
    health: +(annual_health/12).toFixed(2),
    pension: +(pension/12).toFixed(2),
    esop: +(esop/12).toFixed(2),
    esop_match_after_tax: +(esop_match_net/12).toFixed(2),
    union_dues: +(union.annual/12).toFixed(2)
  };

  return {
    audit,
    gross:+gross.toFixed(2),
    net:+net.toFixed(2),
    tax:+income_tax.toFixed(2),
    cpp:+cpp_total.toFixed(2),
    ei:+eiPrem.toFixed(2),
    health:+annual_health.toFixed(2),
    pension:+pension.toFixed(2),
    esop:+esop.toFixed(2),
    esop_match_after_tax:+esop_match_net.toFixed(2),
    monthly,
    step_jan1:stepJan1
  };
}

// --- VO computation ---

function computeVO(params){
  const seat=params.seat, ac=params.ac, year=+params.year, province=params.province;
  const step = params.tieOn ? stepOnJan1(params.stepInput, true, year) : clampStep(params.stepInput);
  const rate = rateFor(seat, ac, year, step, !!params.xlrOn);
  const credits = Math.max(0, (+params.creditH) + Math.max(0, Math.min(59, +params.creditM))/60);
  const hours = credits * 2;
  const gross = hours * rate;
  const fed_m = marginalRate(gross, FED.brackets);
  const prov_m = marginalRate(gross, PROV[province].brackets);
  const net = gross*(1-(fed_m+prov_m));
  return {rate,hours,gross,net,fed_m,prov_m,step_used:step};
}

// --- UI helpers ---
function setActiveTab(which){
  const btnA=document.getElementById('tabbtn-annual');
  const btnV=document.getElementById('tabbtn-vo');
  const tabA=document.getElementById('tab-annual');
  const tabV=document.getElementById('tab-vo');
  if (which==='annual'){
    btnA.classList.add('active'); btnV.classList.remove('active');
    tabA.classList.remove('hidden'); tabV.classList.add('hidden');
  } else {
    btnV.classList.add('active'); btnA.classList.remove('active');
    tabV.classList.remove('hidden'); tabA.classList.add('hidden');
  }
}
function onSeatChange(isVO){
  const seat = (isVO? document.getElementById('ot-seat').value : document.getElementById('seat').value);
  const acSel = isVO? document.getElementById('ot-ac') : document.getElementById('ac');
  const allowed = (seat==='RP') ? ["777","787","330"] : AIRCRAFT_ORDER.slice();
  acSel.innerHTML = '';
  allowed.forEach(ac => {
    const opt=document.createElement('option'); opt.textContent=ac; acSel.appendChild(opt);
  });
  if (allowed.includes('320')) acSel.value='320';
}
function tieYearStepFromYear(isVO){
  const tie = (isVO? document.getElementById('ot-tie') : document.getElementById('tie')).checked;
  if (!tie) return;
  const yearEl = isVO? document.getElementById('ot-year') : document.getElementById('year');
  const stepEl = isVO? document.getElementById('ot-step') : document.getElementById('step');
  const y = +yearEl.value;
  stepEl.value = String(Math.max(1, Math.min(12, (y-2025)+1)));
}
function tieYearStepFromStep(isVO){
  const tie = (isVO? document.getElementById('ot-tie') : document.getElementById('tie')).checked;
  if (!tie) return;
  const yearEl = isVO? document.getElementById('ot-year') : document.getElementById('year');
  const stepEl = isVO? document.getElementById('ot-step') : document.getElementById('step');
  const s = Math.max(1, Math.min(12, +stepEl.value));
  yearEl.value = String(Math.max(2023, Math.min(2031, 2024 + s)));
}

// --- Renderers ---
function renderAnnual(res, params){
  const out = document.getElementById('out');
  const simpleHTML = `
    <div class="simple">
      <div class="block"><div class="label">Annual Gross</div><div class="value">${money(res.gross)}</div></div>
      <div class="block"><div class="label">Annual Net</div><div class="value">${money(res.net)}</div></div>
      <div class="block"><div class="label">Monthly Gross</div><div class="value">${money(res.monthly.gross)}</div></div>
      <div class="block"><div class="label">Monthly Net</div><div class="value">${money(res.monthly.net)}</div></div>
      <div class="block"><div class="label">Income Tax</div><div class="value">${money(res.tax)}</div></div>
      <div class="block"><div class="label">CPP/QPP</div><div class="value">${money(res.cpp)}</div></div>
      <div class="block"><div class="label">EI</div><div class="value">${money(res.ei)}</div></div>
      <div class="block"><div class="label">Pension</div><div class="value">${money(res.pension)}</div></div>
      <div class="block"><div class="label">ESOP Contributions</div><div class="value">${money(res.esop)}</div></div>
      <div class="block"><div class="label">ESOP match (after tax)</div><div class="value">${money(res.esop_match_after_tax)}</div></div>
    </div>`;
  const auditRows = res.audit.map(seg=>{
    const fmt = d => d.toISOString().slice(0,10);
    return `<tr>
      <td>${fmt(seg.start)}</td>
      <td>${fmt(seg.end)}</td>
      <td>${seg.pay_table_year}</td>
      <td>${seg.step}</td>
      <td class="num">$${seg.hourly.toFixed(2)}</td>
      <td class="num">${seg.hours.toFixed(2)}</td>
      <td class="num">$${seg.segment_gross.toFixed(2)}</td>
    </tr>`;
  }).join('');
  const auditHTML = `
    <div class="sectionTitle">Audit (date ranges)</div>
    <div class="auditwrap">
      <table class="audit">
        <thead>
          <tr>
            <th>Start</th><th>End</th><th>Tbl Yr</th><th>Step</th><th>Hourly</th><th>Hours</th><th>Gross</th>
          </tr>
        </thead>
        <tbody>${auditRows}</tbody>
      </table>
    </div>`;
  out.innerHTML = simpleHTML + auditHTML;
}
function renderVO(res, params){
  const out = document.getElementById('ot-out');
  const statsHTML = `
    <div class="simple">
      <div class="block"><div class="label">Hourly Rate</div><div class="value">${money(res.rate)}</div></div>
      <div class="block"><div class="label">Hours (Credit×2)</div><div class="value">${res.hours.toFixed(2)}</div></div>
      <div class="block"><div class="label">Gross</div><div class="value">${money(res.gross)}</div></div>
      <div class="block"><div class="label">Net</div><div class="value">${money(res.net)}</div></div>
      <div class="block"><div class="label">Marginal FED</div><div class="value">${(100*res.fed_m).toFixed(1)}%</div></div>
      <div class="block"><div class="label">Marginal PROV</div><div class="value">${(100*res.prov_m).toFixed(1)}%</div></div>
    </div>`;
  out.innerHTML = statsHTML;
}

// --- Actions ---
function calcAnnual(){
  try{
    const params = {
      seat: document.getElementById('seat').value,
      ac: document.getElementById('ac').value,
      year: +document.getElementById('year').value,
      stepInput: +document.getElementById('step').value,
      tieOn: document.getElementById('tie').checked,
      xlrOn: document.getElementById('xlr').checked,
      avgMonthlyHours: +document.getElementById('avgHrs').value,
      province: document.getElementById('prov').value,
      esopPct: +document.getElementById('esop').value
    };
    const res = computeAnnual(params);
    renderAnnual(res, params);
  } catch(err){
    document.getElementById('out').innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}
function calcVO(){
  try{
    const params = {
      seat: document.getElementById('ot-seat').value,
      ac: document.getElementById('ot-ac').value,
      year: +document.getElementById('ot-year').value,
      stepInput: +document.getElementById('ot-step').value,
      tieOn: document.getElementById('ot-tie').checked,
      xlrOn: document.getElementById('ot-xlr').checked,
      province: document.getElementById('ot-prov').value,
      creditH: +document.getElementById('ot-cred-h').value,
      creditM: +document.getElementById('ot-cred-m').value
    };
    const res = computeVO(params);
    renderVO(res, params);
  } catch(err){
    document.getElementById('ot-out').innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

// --- Init ---
function init(){
  // Tabs
  document.getElementById('tabbtn-annual')?.addEventListener('click', (e)=>{ hapticTap(e.currentTarget); setActiveTab('annual'); });
  document.getElementById('tabbtn-vo')?.addEventListener('click', (e)=>{ hapticTap(e.currentTarget); setActiveTab('vo'); });
  // Dropdown behaviors
  document.getElementById('seat')?.addEventListener('change', ()=>onSeatChange(false));
  document.getElementById('ot-seat')?.addEventListener('change', ()=>onSeatChange(true));
  document.getElementById('year')?.addEventListener('change', ()=>tieYearStepFromYear(false));
  document.getElementById('ot-year')?.addEventListener('change', ()=>tieYearStepFromYear(true));
  document.getElementById('step')?.addEventListener('change', ()=>tieYearStepFromStep(false));
  document.getElementById('ot-step')?.addEventListener('change', ()=>tieYearStepFromStep(true));
  // ESOP slider label
  const esopEl=document.getElementById('esop'); const esopPct=document.getElementById('esopPct');
  if (esopEl && esopPct){ esopEl.addEventListener('input', ()=>{ esopPct.textContent = esopEl.value+'%'; }); }
  // Buttons
  document.getElementById('calc')?.addEventListener('click', (e)=>{ hapticTap(e.currentTarget); calcAnnual(); });
  document.getElementById('ot-calc')?.addEventListener('click', (e)=>{ hapticTap(e.currentTarget); calcVO(); });
  // Defaults
  onSeatChange(false);
  onSeatChange(true);
  tieYearStepFromYear(false);
  tieYearStepFromYear(true);
}
if (document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
// PWA: register the service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .catch(() => { /* no-op */ });
  });
}
