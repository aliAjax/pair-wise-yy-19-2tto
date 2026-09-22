"use strict";

/* ============================================================
 * 判定（纯函数层）：只依赖入参，不读写状态、不触碰 DOM
 * ============================================================ */
const CHANNEL_TOLERANCE = 0.03; // 通道偏差阈值：3%
const COLOR_TEMP_RANGE = { min: 5000, max: 6500 }; // 合格色温区间（K）
const COMPARE_TEMP_DELTA = 500; // 跨镜对照允许的最大色温差（K）
const STANDARD_PLATE = { r: 200, g: 200, b: 200 }; // 标准板标称读数

const sampleKey = (code, polarization) => `${code}::${polarization}`;
const pairIdOf = (keyA, keyB) => [keyA, keyB].sort().join("⇄");
const now = () => new Date().toISOString();

/* 查询助手：判定与渲染共用的只读查找 */
const Query = {
  sampleById: (state, id) => state.samples.find((s) => s.id === id),
  sampleByKey: (state, key) => state.samples.find((s) => s.key === key),
  // 校准记录按新到旧排列，find 即最新一条
  latestCalibration: (state, key) => state.calibrations.find((c) => c.sampleKey === key),
  microscopeById: (state, id) => state.microscopes.find((m) => m.id === id),
  lightBatchById: (state, id) => state.lightBatches.find((b) => b.id === id),
  comparisonOf: (state, keyA, keyB) =>
    state.comparisons.find((c) => c.pairId === pairIdOf(keyA, keyB)),
  sampleStatus: (state, key) => {
    const cal = Query.latestCalibration(state, key);
    return cal ? cal.status : "none";
  }
};

const Judge = {
  /* 校准判定：任一通道偏差超过 3%，或色温不在 5000–6500K，只能登记「待校色」 */
  calibration(reading, colorTemp) {
    const deviations = {
      r: Math.abs(reading.r - STANDARD_PLATE.r) / STANDARD_PLATE.r,
      g: Math.abs(reading.g - STANDARD_PLATE.g) / STANDARD_PLATE.g,
      b: Math.abs(reading.b - STANDARD_PLATE.b) / STANDARD_PLATE.b
    };
    const maxDeviation = Math.max(deviations.r, deviations.g, deviations.b);
    const tempOk = colorTemp >= COLOR_TEMP_RANGE.min && colorTemp <= COLOR_TEMP_RANGE.max;
    const passed = maxDeviation <= CHANNEL_TOLERANCE && tempOk;
    return { deviations, maxDeviation, tempOk, status: passed ? "passed" : "pending" };
  },

  /* 跨镜对照判定：取双方最新校准，校色/设备/光源任一异常即「需重新校准」 */
  comparison(keys, state) {
    const issues = [];
    const sides = keys.map((key) => Judge.side(key, state, issues));
    const [a, b] = sides;
    let deltaTemp = null;
    let deltaChannels = null;
    let maxDeltaChannel = null;
    if (a.calibration && b.calibration) {
      deltaTemp = Math.abs(a.calibration.colorTemp - b.calibration.colorTemp);
      deltaChannels = {
        r: Math.abs(a.calibration.deviations.r - b.calibration.deviations.r),
        g: Math.abs(a.calibration.deviations.g - b.calibration.deviations.g),
        b: Math.abs(a.calibration.deviations.b - b.calibration.deviations.b)
      };
      maxDeltaChannel = Math.max(deltaChannels.r, deltaChannels.g, deltaChannels.b);
    }
    let verdict = "可对照";
    if (issues.length) verdict = "需重新校准";
    else if (maxDeltaChannel > CHANNEL_TOLERANCE || deltaTemp > COMPARE_TEMP_DELTA) {
      verdict = "偏差超限";
    }
    return { sides, issues, deltaTemp, deltaChannels, maxDeltaChannel, verdict, computedAt: now() };
  },

  /* 对照单侧快照：样品 + 最新校准 + 设备/光源可用性 */
  side(key, state, issues) {
    const sample = Query.sampleByKey(state, key);
    const label = sample ? `${sample.code}（${sample.polarization}）` : key;
    const calibration = Query.latestCalibration(state, key);
    if (!calibration) {
      issues.push(`${label} 尚未校准`);
      return { label, calibration: null, microscope: "—", lightBatch: "—" };
    }
    const microscope = Query.microscopeById(state, calibration.microscopeId);
    const lightBatch = Query.lightBatchById(state, calibration.lightBatchId);
    if (calibration.status !== "passed") issues.push(`${label} 仍待校色`);
    if (microscope && microscope.decommissioned) issues.push(`${microscope.name} 已报废`);
    if (lightBatch && lightBatch.replaced) issues.push(`光源批次「${lightBatch.name}」已更换`);
    return {
      label,
      calibration: {
        status: calibration.status,
        colorTemp: calibration.colorTemp,
        deviations: { ...calibration.deviations },
        maxDeviation: calibration.maxDeviation,
        version: calibration.version
      },
      microscope: microscope ? microscope.name : "未知显微镜",
      lightBatch: lightBatch ? lightBatch.name : "未知批次"
    };
  }
};

/* ============================================================
 * 记录（状态层）：唯一可写状态的地方，负责持久化与失效重算
 * ============================================================ */
const storageKey = "wxyy-2-thin-section-index";

function loadState() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(storageKey) || "null");
  } catch {
    raw = null;
  }
  const state = raw && typeof raw === "object" ? raw : {};
  state.samples = Array.isArray(state.samples) ? state.samples : [];
  state.samples.forEach((sample) => {
    sample.key = sample.key || sampleKey(sample.code, sample.polarization);
  });
  state.microscopes = Array.isArray(state.microscopes) ? state.microscopes : [];
  state.lightBatches = Array.isArray(state.lightBatches) ? state.lightBatches : [];
  state.calibrations = Array.isArray(state.calibrations) ? state.calibrations : [];
  state.comparisons = Array.isArray(state.comparisons) ? state.comparisons : [];
  state.compare = Array.isArray(state.compare) ? state.compare : [];
  state.filters = Object.assign({ mineral: "", polarization: "", calibration: "" }, state.filters);
  // 清理指向已删除样品的勾选与对照，保证刷新后一致
  state.compare = state.compare.filter((id) => state.samples.some((s) => s.id === id));
  state.comparisons = state.comparisons.filter((comp) =>
    comp.sampleKeys.every((key) => state.samples.some((s) => s.key === key))
  );
  state.comparisons.forEach((comp) => {
    comp.recomputeCount = comp.recomputeCount || 0;
  });
  if (!state.microscopes.length) {
    state.microscopes = [
      { id: crypto.randomUUID(), name: "徕卡 DM2700P（A 镜）", decommissioned: false },
      { id: crypto.randomUUID(), name: "尼康 LV100N POL（B 镜）", decommissioned: false }
    ];
  }
  if (!state.lightBatches.length) {
    state.lightBatches = [
      { id: crypto.randomUUID(), name: "LED-5600K·2026-08 批次", replaced: false }
    ];
  }
  return state;
}

const Ledger = {
  state: loadState(),

  save() {
    localStorage.setItem(storageKey, JSON.stringify(this.state));
  },

  /* 样品按「编号 + 偏光条件」唯一：重复录入合并进原档案 */
  upsertSample(fields) {
    const existing = Query.sampleByKey(this.state, fields.key);
    if (existing) {
      if (fields.photo) existing.photo = fields.photo;
      ["location", "magnification", "minerals", "texture", "comment"].forEach((name) => {
        if (fields[name]) existing[name] = fields[name];
      });
      existing.updatedAt = now();
      return { sample: existing, created: false };
    }
    const sample = { id: crypto.randomUUID(), ...fields, createdAt: now(), updatedAt: now() };
    this.state.samples.unshift(sample);
    return { sample, created: true };
  },

  /* 同一样品仅保留一条未完成校准；重复/并发录入沿用首次结果 */
  recordCalibration(entry) {
    const unfinished = this.state.calibrations.find(
      (c) => c.sampleKey === entry.sampleKey && c.status === "pending"
    );
    if (unfinished) return { calibration: unfinished, reused: true };
    const judged = Judge.calibration(entry.reading, entry.colorTemp);
    const calibration = {
      id: crypto.randomUUID(),
      sampleKey: entry.sampleKey,
      microscopeId: entry.microscopeId,
      lightBatchId: entry.lightBatchId,
      reading: entry.reading,
      colorTemp: entry.colorTemp,
      ...judged,
      version: 1,
      history: [],
      createdAt: now(),
      updatedAt: now()
    };
    this.state.calibrations.unshift(calibration);
    return { calibration, reused: false };
  },

  /* 校准更正：留痕重判，并令相关未锁定对照失效重算 */
  correctCalibration(id, reading, colorTemp) {
    const cal = this.state.calibrations.find((c) => c.id === id);
    if (!cal) return;
    cal.history.push({
      reading: { ...cal.reading },
      colorTemp: cal.colorTemp,
      deviations: { ...cal.deviations },
      status: cal.status,
      version: cal.version,
      replacedAt: now()
    });
    const judged = Judge.calibration(reading, colorTemp);
    Object.assign(cal, { reading, colorTemp, ...judged, version: cal.version + 1, updatedAt: now() });
    this.invalidateAndRecompute(
      (comp) => comp.sampleKeys.includes(cal.sampleKey),
      `校准更正（v${cal.version}）`
    );
  },

  addMicroscope(name) {
    this.state.microscopes.push({ id: crypto.randomUUID(), name, decommissioned: false });
  },

  addLightBatch(name) {
    this.state.lightBatches.push({ id: crypto.randomUUID(), name, replaced: false });
  },

  /* 仪器报废：相关未锁定对照失效重算 */
  decommissionMicroscope(id) {
    const microscope = Query.microscopeById(this.state, id);
    if (!microscope || microscope.decommissioned) return;
    microscope.decommissioned = true;
    const affected = new Set(
      this.state.calibrations.filter((c) => c.microscopeId === id).map((c) => c.sampleKey)
    );
    this.invalidateAndRecompute(
      (comp) => comp.sampleKeys.some((key) => affected.has(key)),
      `仪器报废（${microscope.name}）`
    );
  },

  /* 换光源：相关未锁定对照失效重算 */
  replaceLightBatch(id) {
    const batch = Query.lightBatchById(this.state, id);
    if (!batch || batch.replaced) return;
    batch.replaced = true;
    const affected = new Set(
      this.state.calibrations.filter((c) => c.lightBatchId === id).map((c) => c.sampleKey)
    );
    this.invalidateAndRecompute(
      (comp) => comp.sampleKeys.some((key) => affected.has(key)),
      `光源更换（${batch.name}）`
    );
  },

  /* 同一对样品只建一条对照记录 */
  ensureComparison(keyA, keyB) {
    const pairId = pairIdOf(keyA, keyB);
    let comp = this.state.comparisons.find((c) => c.pairId === pairId);
    if (!comp) {
      comp = {
        id: crypto.randomUUID(),
        pairId,
        sampleKeys: [keyA, keyB],
        locked: false,
        version: 1,
        recomputeCount: 0,
        lastReason: "",
        createdAt: now(),
        updatedAt: now(),
        result: Judge.comparison([keyA, keyB], this.state)
      };
      this.state.comparisons.unshift(comp);
    }
    return comp;
  },

  toggleComparisonLock(id) {
    const comp = this.state.comparisons.find((c) => c.id === id);
    if (!comp) return;
    comp.locked = !comp.locked;
    comp.updatedAt = now();
  },

  deleteSample(id) {
    const sample = Query.sampleById(this.state, id);
    if (!sample) return;
    this.state.samples = this.state.samples.filter((s) => s.id !== id);
    this.state.calibrations = this.state.calibrations.filter((c) => c.sampleKey !== sample.key);
    this.state.comparisons = this.state.comparisons.filter(
      (c) => !c.sampleKeys.includes(sample.key)
    );
    this.state.compare = this.state.compare.filter((sid) => sid !== id);
  },

  /* 失效重算：只动未锁定对照，已锁定对照保持只读 */
  invalidateAndRecompute(match, reason) {
    this.state.comparisons.forEach((comp) => {
      if (comp.locked || !match(comp)) return;
      comp.result = Judge.comparison(comp.sampleKeys, this.state);
      comp.version += 1;
      comp.recomputeCount += 1;
      comp.lastReason = reason;
      comp.updatedAt = now();
    });
  }
};

/* ============================================================
 * 渲染（展示层）：只读状态，输出 DOM
 * ============================================================ */
const form = document.querySelector("#sampleForm");
const photoInput = document.querySelector("#photoInput");
const entryNotice = document.querySelector("#entryNotice");
const microscopeSelect = document.querySelector("#microscopeSelect");
const lightBatchSelect = document.querySelector("#lightBatchSelect");
const microscopeForm = document.querySelector("#microscopeForm");
const microscopeList = document.querySelector("#microscopeList");
const lightBatchForm = document.querySelector("#lightBatchForm");
const lightBatchList = document.querySelector("#lightBatchList");
const sampleGrid = document.querySelector("#sampleGrid");
const comparePane = document.querySelector("#comparePane");
const comparisonLedger = document.querySelector("#comparisonLedger");
const calibrationLedger = document.querySelector("#calibrationLedger");
const mineralFilter = document.querySelector("#mineralFilter");
const polarFilter = document.querySelector("#polarFilter");
const calibrationFilter = document.querySelector("#calibrationFilter");

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
const pct = (value) => `${(value * 100).toFixed(2)}%`;
const formatTime = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
};
const statusText = { passed: "合格", pending: "待校色", none: "未校准" };
const statusBadge = {
  passed: '<span class="badge pass">合格</span>',
  pending: '<span class="badge pending">待校色</span>',
  none: '<span class="badge none">未校准</span>'
};

let correctingId = null; // 正在更正的校准记录（仅界面态，不落盘）

function filteredSamples() {
  const { mineral, polarization, calibration } = Ledger.state.filters;
  return Ledger.state.samples.filter((sample) => {
    const mineralMatch = !mineral || sample.minerals.includes(mineral);
    const polarMatch = !polarization || sample.polarization === polarization;
    const calMatch = !calibration || Query.sampleStatus(Ledger.state, sample.key) === calibration;
    return mineralMatch && polarMatch && calMatch;
  });
}

function syncSelect(select, items) {
  const current = select.value;
  select.innerHTML = items.length
    ? items.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join("")
    : '<option value="">（无可用项，请先添加）</option>';
  if (items.some((item) => item.id === current)) select.value = current;
}

function renderDevices() {
  const state = Ledger.state;
  syncSelect(microscopeSelect, state.microscopes.filter((m) => !m.decommissioned));
  syncSelect(lightBatchSelect, state.lightBatches.filter((b) => !b.replaced));
  microscopeList.innerHTML = state.microscopes
    .map(
      (m) => `
      <li>
        <span>${esc(m.name)}${m.decommissioned ? ' <span class="badge bad">已报废</span>' : ""}</span>
        ${m.decommissioned ? "" : `<button type="button" data-decommission="${m.id}">报废</button>`}
      </li>`
    )
    .join("");
  lightBatchList.innerHTML = state.lightBatches
    .map(
      (b) => `
      <li>
        <span>${esc(b.name)}${b.replaced ? ' <span class="badge warn">已换光源</span>' : ""}</span>
        ${b.replaced ? "" : `<button type="button" data-replace="${b.id}">换光源</button>`}
      </li>`
    )
    .join("");
}

function renderSamples() {
  const state = Ledger.state;
  const rows = filteredSamples();
  sampleGrid.innerHTML = rows.length
    ? rows
        .map((sample) => {
          const cal = Query.latestCalibration(state, sample.key);
          const status = cal ? cal.status : "none";
          const calLine = cal
            ? `<p class="cal-line">${esc(
                Query.microscopeById(state, cal.microscopeId)?.name || "未知显微镜"
              )} · ${esc(Query.lightBatchById(state, cal.lightBatchId)?.name || "未知批次")} · ${
                cal.colorTemp
              }K · 最大偏差 ${pct(cal.maxDeviation)}</p>`
            : "";
          return `
    <article class="sample-card">
      ${sample.photo ? `<img src="${sample.photo}" alt="${esc(sample.code)}显微照片">` : '<div class="photo-placeholder"></div>'}
      <div class="sample-body">
        <h3>${esc(sample.code)} ${statusBadge[status]}</h3>
        <p>${esc(sample.location || "未记录地点")} · ${esc(sample.magnification || "未记录倍数")} · ${esc(sample.polarization)}</p>
        <p>矿物：${esc(sample.minerals || "未记录")}</p>
        <p>结构：${esc(sample.texture || "未记录")}</p>
        <p>${esc(sample.comment || "未填写批注")}</p>
        ${calLine}
        <div class="card-actions">
          <label><input type="checkbox" data-compare="${sample.id}" ${state.compare.includes(sample.id) ? "checked" : ""}>对照</label>
          <button type="button" data-delete="${sample.id}">删除</button>
        </div>
      </div>
    </article>`;
        })
        .join("")
    : "<p>还没有样本，先从左侧录入一张薄片照片。</p>";
}

function comparisonCard(comp) {
  const { result } = comp;
  const verdictClass =
    result.verdict === "可对照" ? "pass" : result.verdict === "偏差超限" ? "warn" : "bad";
  const sides = result.sides
    .map(
      (side) => `
      <div class="side-box">
        <strong>${esc(side.label)}</strong>
        <p>${esc(side.microscope)} · ${esc(side.lightBatch)}</p>
        ${
          side.calibration
            ? `<p>${side.calibration.colorTemp}K · 最大偏差 ${pct(side.calibration.maxDeviation)} · ${
                statusText[side.calibration.status]
              } v${side.calibration.version}</p>`
            : "<p>未校准</p>"
        }
      </div>`
    )
    .join("");
  const deltas =
    result.maxDeltaChannel === null
      ? ""
      : `<p>跨镜差异：通道 Δ最大 ${pct(result.maxDeltaChannel)}（R ${pct(result.deltaChannels.r)} / G ${pct(
          result.deltaChannels.g
        )} / B ${pct(result.deltaChannels.b)}）· 色温 Δ${result.deltaTemp}K</p>`;
  const issues = result.issues.length
    ? `<p class="issues">待处理：${result.issues.map(esc).join("；")}</p>`
    : "";
  return `
    <article class="ledger-item ${comp.locked ? "locked" : ""}">
      <header>
        <span>${esc(result.sides[0].label)} ⇄ ${esc(result.sides[1].label)}</span>
        <span>
          <span class="badge ${verdictClass}">${result.verdict}</span>
          ${comp.locked ? '<span class="badge lock">已锁定·只读</span>' : ""}
        </span>
      </header>
      <div class="side-grid">${sides}</div>
      ${deltas}
      ${issues}
      <p>记录 v${comp.version} · 重算 ${comp.recomputeCount} 次${
        comp.lastReason ? ` · 最近失效：${esc(comp.lastReason)}` : ""
      } · ${formatTime(comp.updatedAt)}</p>
      <div class="card-actions">
        <button type="button" data-lock="${comp.id}">${comp.locked ? "解除锁定" : "锁定对照"}</button>
      </div>
    </article>`;
}

function renderCompare() {
  const state = Ledger.state;
  const selected = state.compare.map((id) => Query.sampleById(state, id)).filter(Boolean).slice(0, 2);
  if (selected.length < 2) {
    comparePane.innerHTML = "<p>勾选两张样本卡片后建立跨镜对照。</p>";
    return;
  }
  const comp = Query.comparisonOf(state, selected[0].key, selected[1].key);
  comparePane.innerHTML = comp ? comparisonCard(comp) : "<p>对照记录缺失。</p>";
}

function correctionForm(cal) {
  return `
    <form class="correct-form" data-correct-form="${cal.id}">
      <label>R<input name="plateR" type="number" min="0" max="255" required value="${cal.reading.r}"></label>
      <label>G<input name="plateG" type="number" min="0" max="255" required value="${cal.reading.g}"></label>
      <label>B<input name="plateB" type="number" min="0" max="255" required value="${cal.reading.b}"></label>
      <label>色温<input name="colorTemp" type="number" min="1000" max="12000" step="50" required value="${cal.colorTemp}"></label>
      <div class="correct-actions">
        <button type="submit">确认更正</button>
        <button type="button" data-correct-cancel>取消</button>
      </div>
    </form>`;
}

function renderLedgers() {
  const state = Ledger.state;
  comparisonLedger.innerHTML = state.comparisons.length
    ? state.comparisons.map(comparisonCard).join("")
    : "<p>暂无对照记录。</p>";

  calibrationLedger.innerHTML = state.calibrations.length
    ? state.calibrations
        .map((cal) => {
          const sample = Query.sampleByKey(state, cal.sampleKey);
          const label = sample ? `${sample.code}（${sample.polarization}）` : cal.sampleKey;
          const microscope = Query.microscopeById(state, cal.microscopeId);
          const batch = Query.lightBatchById(state, cal.lightBatchId);
          const correcting = correctingId === cal.id;
          return `
    <article class="ledger-item">
      <header>
        <span>${esc(label)}</span>
        <span>${statusBadge[cal.status]}<span class="badge none">v${cal.version}</span></span>
      </header>
      <p>${esc(microscope?.name || "未知显微镜")}${
            microscope?.decommissioned ? ' <span class="badge bad">已报废</span>' : ""
          } · ${esc(batch?.name || "未知批次")}${
            batch?.replaced ? ' <span class="badge warn">已换光源</span>' : ""
          }</p>
      <p>标准板 R${cal.reading.r} G${cal.reading.g} B${cal.reading.b} → 偏差 ${pct(
            cal.deviations.r
          )} / ${pct(cal.deviations.g)} / ${pct(cal.deviations.b)}</p>
      <p>色温 ${cal.colorTemp}K${cal.tempOk ? "" : "（超出 5000–6500K）"} · ${formatTime(cal.updatedAt)}</p>
      ${
        cal.status === "pending" && !correcting
          ? `<div class="card-actions"><button type="button" data-correct="${cal.id}">校准更正</button></div>`
          : ""
      }
      ${correcting ? correctionForm(cal) : ""}
    </article>`;
        })
        .join("")
    : "<p>暂无校准记录。</p>";
}

function render() {
  renderDevices();
  renderSamples();
  renderCompare();
  renderLedgers();
}

/* ============================================================
 * 入口（事件层）：表单、筛选与按钮，只负责收集输入并调用记录层
 * ============================================================ */
let pendingPhoto = "";
const inflight = new Map(); // sampleKey -> Promise，并发提交沿用首次结果

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.readAsDataURL(file);
  });
}

function showNotice(text) {
  entryNotice.textContent = text;
  entryNotice.hidden = false;
}

photoInput.addEventListener("change", async () => {
  pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const code = String(data.get("code")).trim();
  const polarization = data.get("polarization");
  const key = sampleKey(code, polarization);
  // 并发：同一样品的提交已在进行，直接沿用首次结果
  if (inflight.has(key)) {
    inflight.get(key).then(() => showNotice("检测到同一样品的并发提交，已沿用首次结果。"));
    return;
  }
  const task = processSampleEntry(data, key, code, polarization);
  inflight.set(key, task);
  task.finally(() => inflight.delete(key));
});

async function processSampleEntry(data, key, code, polarization) {
  const state = Ledger.state;
  const microscope = Query.microscopeById(state, data.get("microscopeId"));
  const batch = Query.lightBatchById(state, data.get("lightBatchId"));
  if (!microscope || microscope.decommissioned || !batch || batch.replaced) {
    showNotice("请选择可用的显微镜与光源批次（已报废或已更换的不可录入）。");
    return;
  }
  const reading = {
    r: Number(data.get("plateR")),
    g: Number(data.get("plateG")),
    b: Number(data.get("plateB"))
  };
  const colorTemp = Number(data.get("colorTemp"));
  if ([reading.r, reading.g, reading.b, colorTemp].some((v) => Number.isNaN(v))) {
    showNotice("标准板读数与色温需为数字。");
    return;
  }
  if (!pendingPhoto && photoInput.files[0]) {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  }
  const { created } = Ledger.upsertSample({
    key,
    code,
    polarization,
    photo: pendingPhoto,
    location: String(data.get("location")).trim(),
    magnification: String(data.get("magnification")).trim(),
    minerals: String(data.get("minerals")).trim(),
    texture: String(data.get("texture")).trim(),
    comment: String(data.get("comment")).trim()
  });
  const { calibration, reused } = Ledger.recordCalibration({
    sampleKey: key,
    microscopeId: microscope.id,
    lightBatchId: batch.id,
    reading,
    colorTemp
  });
  Ledger.save();

  const notes = [];
  if (!created) notes.push("样品已存在（编号 + 偏光唯一），档案已合并");
  if (reused) notes.push("该样品存在未完成校准，已沿用首次结果");
  else if (calibration.status === "passed") notes.push("校准合格");
  else notes.push("判定为「待校色」，可在右侧校准记录中更正");
  showNotice(`${notes.join("；")}。`);

  pendingPhoto = "";
  photoInput.value = "";
  form.reset();
  render();
}

microscopeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = String(new FormData(microscopeForm).get("name")).trim();
  if (!name) return;
  Ledger.addMicroscope(name);
  Ledger.save();
  microscopeForm.reset();
  render();
});

lightBatchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = String(new FormData(lightBatchForm).get("name")).trim();
  if (!name) return;
  Ledger.addLightBatch(name);
  Ledger.save();
  lightBatchForm.reset();
  render();
});

microscopeList.addEventListener("click", (event) => {
  const id = event.target.dataset.decommission;
  if (!id) return;
  if (!confirm("报废该显微镜会让相关未锁定对照失效并重算，确认报废？")) return;
  Ledger.decommissionMicroscope(id);
  Ledger.save();
  render();
});

lightBatchList.addEventListener("click", (event) => {
  const id = event.target.dataset.replace;
  if (!id) return;
  if (!confirm("标记换光源会让相关未锁定对照失效并重算，确认更换？")) return;
  Ledger.replaceLightBatch(id);
  Ledger.save();
  render();
});

sampleGrid.addEventListener("click", (event) => {
  const deleteId = event.target.dataset.delete;
  if (!deleteId) return;
  if (!confirm("删除样本将同时移除其校准与对照记录，确认删除？")) return;
  Ledger.deleteSample(deleteId);
  Ledger.save();
  render();
});

sampleGrid.addEventListener("change", (event) => {
  const id = event.target.dataset.compare;
  if (!id) return;
  const state = Ledger.state;
  if (event.target.checked) {
    state.compare = [id, ...state.compare.filter((item) => item !== id)].slice(0, 2);
  } else {
    state.compare = state.compare.filter((item) => item !== id);
  }
  if (state.compare.length === 2) {
    const [a, b] = state.compare.map((sid) => Query.sampleById(state, sid)).filter(Boolean);
    if (a && b) Ledger.ensureComparison(a.key, b.key);
  }
  Ledger.save();
  render();
});

[comparePane, comparisonLedger].forEach((pane) =>
  pane.addEventListener("click", (event) => {
    const id = event.target.dataset.lock;
    if (!id) return;
    Ledger.toggleComparisonLock(id);
    Ledger.save();
    render();
  })
);

calibrationLedger.addEventListener("click", (event) => {
  const correctId = event.target.dataset.correct;
  if (correctId) {
    correctingId = correctingId === correctId ? null : correctId;
    render();
    return;
  }
  if (event.target.hasAttribute("data-correct-cancel")) {
    correctingId = null;
    render();
  }
});

calibrationLedger.addEventListener("submit", (event) => {
  const formEl = event.target.closest("[data-correct-form]");
  if (!formEl) return;
  event.preventDefault();
  const data = new FormData(formEl);
  const reading = {
    r: Number(data.get("plateR")),
    g: Number(data.get("plateG")),
    b: Number(data.get("plateB"))
  };
  const colorTemp = Number(data.get("colorTemp"));
  if ([reading.r, reading.g, reading.b, colorTemp].some((v) => Number.isNaN(v))) return;
  Ledger.correctCalibration(formEl.dataset.correctForm, reading, colorTemp);
  correctingId = null;
  Ledger.save();
  render();
});

[mineralFilter, polarFilter, calibrationFilter].forEach((field) =>
  field.addEventListener("input", () => {
    Ledger.state.filters = {
      mineral: mineralFilter.value.trim(),
      polarization: polarFilter.value,
      calibration: calibrationFilter.value
    };
    Ledger.save();
    renderSamples();
  })
);

document.querySelector("#exportBtn").addEventListener("click", () => {
  const state = Ledger.state;
  const archive = {
    导出时间: now(),
    判定规则: {
      通道偏差阈值: "3%",
      合格色温区间: "5000-6500K",
      标准板标称值: STANDARD_PLATE,
      跨镜色温差上限: "500K"
    },
    显微镜: state.microscopes,
    光源批次: state.lightBatches,
    样本: state.samples.map((sample) => ({
      样本编号: sample.code,
      偏光类型: sample.polarization,
      采样地点: sample.location,
      放大倍数: sample.magnification,
      主要矿物: sample.minerals,
      颗粒结构: sample.texture,
      老师批注: sample.comment,
      校准状态: statusText[Query.sampleStatus(state, sample.key)]
    })),
    校准记录: state.calibrations,
    对照记录: state.comparisons
  };
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "color-calibration-archive.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

/* 初始化：恢复筛选与对照勾选，刷新后保持一致 */
(function init() {
  const state = Ledger.state;
  mineralFilter.value = state.filters.mineral;
  polarFilter.value = state.filters.polarization;
  calibrationFilter.value = state.filters.calibration;
  if (state.compare.length === 2) {
    const [a, b] = state.compare.map((id) => Query.sampleById(state, id)).filter(Boolean);
    if (a && b) Ledger.ensureComparison(a.key, b.key);
  }
  Ledger.save();
  render();
})();
