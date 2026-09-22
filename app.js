/* ============================================================
 * 入口层 app.js
 * 职责：表单录入、界面渲染、事件编排；判定问 rules.js，落库问 records.js。
 * ============================================================ */

const uiKey = "wxyy-2-ui-filters";

const $ = (sel) => document.querySelector(sel);

const sampleForm = $("#sampleForm");
const photoInput = $("#photoInput");
const scopeSelect = $("#scopeSelect");
const boundBatchLine = $("#boundBatchLine");
const formMessage = $("#formMessage");
const sampleGrid = $("#sampleGrid");
const pickBar = $("#pickBar");
const compareList = $("#compareList");
const kitList = $("#kitList");
const logBody = $("#logBody");
const logTypeFilter = $("#logTypeFilter");
const qFilter = $("#qFilter");
const polarFilter = $("#polarFilter");
const statusFilter = $("#statusFilter");
const scopeFilter = $("#scopeFilter");

let pendingPhoto = "";
let uiState = JSON.parse(localStorage.getItem(uiKey) || "{}");

/* ---------- 小工具 ---------- */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function toast(text, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "info");
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

function currentBatch(scopeId) {
  const scope = Store.scopeById(scopeId);
  return scope ? scope.batches[scope.batches.length - 1] : null;
}

function comparisonPart(sample) {
  const cal = Store.currentCalibration(sample.id);
  return {
    microscopeId: sample.microscopeId,
    status: sample.status,
    gain: Rules.gainOf(sample, cal),
    residual: Rules.residualOf(sample, cal),
    colorTemp: cal ? cal.result.appliedColorTemp : sample.colorTemp
  };
}

function pairKey(sample) {
  return `${sample.code} · ${sample.polarization}`;
}

/* ---------- 一致性扫描：未锁定对照依据变更即失效并重算 ---------- */

function sweepComparisons({ silent }) {
  for (const c of Store.comparisons()) {
    if (c.locked) continue;
    const sa = Store.sampleById(c.sampleAId);
    const sb = Store.sampleById(c.sampleBId);
    if (!sa || !sb) {
      Store.removeComparison(c.id);
      continue;
    }
    let reason = "";
    if (c.basis) {
      reason = Rules.detectBasisChange(c.basis.a, sa, Store.scopeById(sa.microscopeId))
        || Rules.detectBasisChange(c.basis.b, sb, Store.scopeById(sb.microscopeId));
    } else if (!c.result) {
      reason = "首次计算";
    }
    if (!reason) continue;

    const result = Rules.crossResult(comparisonPart(sa), comparisonPart(sb));
    Store.updateComparison(c.id, {
      result,
      stale: false,
      staleReason: "",
      basis: { a: Rules.buildBasis(sa), b: Rules.buildBasis(sb) },
      lastReason: reason === "首次计算" ? "" : reason,
      lastRecomputedAt: new Date().toISOString()
    }, reason);
    if (!silent && reason !== "首次计算") {
      Store.log("comparison.recompute", `${pairKey(sa)} ↔ ${pairKey(sb)}`, `${reason}，未锁定对照已重算`);
      Store.persist();
    }
  }
}

/* ---------- 仪器区 ---------- */

function renderScopeOptions() {
  const active = Store.scopes().filter((s) => s.active);
  scopeSelect.innerHTML = active.length
    ? active.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")
    : '<option value="">（请先登记显微镜）</option>';

  scopeFilter.innerHTML = '<option value="">全部显微镜</option>' +
    Store.scopes().map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  if (uiState.scopeId && Store.scopeById(uiState.scopeId)) scopeFilter.value = uiState.scopeId;
}

function renderBoundBatch() {
  const batch = currentBatch(scopeSelect.value);
  boundBatchLine.textContent = batch
    ? `当前绑定光源批次：${batch.label}（${fmtTime(batch.installedAt)} 启用）`
    : "当前绑定光源批次：—";
}

function renderKit() {
  const scopes = Store.scopes();
  kitList.innerHTML = scopes.length ? scopes.map((scope) => {
    const batch = scope.batches[scope.batches.length - 1];
    if (!scope.active) {
      return `<article class="kit-card retired">
        <h3>${esc(scope.name)} <span class="badge badge-retired">已报废</span></h3>
        <p>末次光源：${esc(batch ? batch.label : "—")}</p>
        <p class="rule-hint">未锁定对照已失效重算；已锁定对照保持只读。</p>
      </article>`;
    }
    return `<article class="kit-card">
      <h3>${esc(scope.name)} <span class="badge badge-ok">在用</span></h3>
      <p>当前光源批次：<strong>${esc(batch.label)}</strong>（${fmtTime(batch.installedAt)}）</p>
      <p class="rule-hint">历史批次 ${scope.batches.length} 个</p>
      <div class="kit-actions">
        <input data-batch-input="${scope.id}" placeholder="新光源批次号，如 LED-2611-B">
        <button type="button" class="ghost-btn" data-replace-batch="${scope.id}">更换光源</button>
        <button type="button" class="danger-btn" data-retire-scope="${scope.id}">仪器报废</button>
      </div>
    </article>`;
  }).join("") : "<p class='rule-hint'>尚无仪器，请先登记显微镜与首批光源。</p>";
}

/* ---------- 样本卡片 ---------- */

function deviationChips(readingOrDev, isDev) {
  const devs = isDev ? readingOrDev : Rules.channelDeviations(readingOrDev);
  return ["r", "g", "b"].map((k) => {
    const bad = devs[k] > Rules.MAX_CHANNEL_DEV_PCT;
    return `<span class="chip ${bad ? "chip-bad" : "chip-ok"}">${k.toUpperCase()} ${devs[k]}%</span>`;
  }).join("");
}

function pendingCalCard(sample, cal) {
  const draft = cal.draftReading || { r: 255, g: 255, b: 255 };
  const draftTemp = cal.draftColorTemp ?? 5500;
  return `<div class="cal-box" data-cal-card="${cal.id}">
    <p class="cal-title">${cal.reason === "correction" ? "校准更正单" : "待校色单"}
      <span class="badge badge-pending">进行中</span></p>
    <p class="rule-hint">录入读数 ${cal.fromReading.r}/${cal.fromReading.g}/${cal.fromReading.b}，
      色温 ${cal.fromColorTemp}K。同一样品仅一条未完成校准，重复发起沿用此单。</p>
    <div class="readings">
      <label>校后 R<input type="number" min="1" max="255" data-draft="r" value="${draft.r}"></label>
      <label>校后 G<input type="number" min="1" max="255" data-draft="g" value="${draft.g}"></label>
      <label>校后 B<input type="number" min="1" max="255" data-draft="b" value="${draft.b}"></label>
    </div>
    <label>校后色温 (K)<input type="number" min="2000" max="10000" data-draft="temp" value="${draftTemp}"></label>
    <div class="card-row">
      <button type="button" data-complete-cal="${cal.id}">保存校色结果</button>
      <button type="button" class="ghost-btn" data-reuse-cal="${sample.id}">重复发起（沿用首次结果）</button>
    </div>
  </div>`;
}

function calibratedInfo(sample) {
  const cal = Store.currentCalibration(sample.id);
  if (!cal) return "";
  const { gain, residual, appliedColorTemp, grade } = cal.result;
  return `<div class="cal-done">
    <p>通道增益 <span class="chip">R×${gain.r}</span><span class="chip">G×${gain.g}</span><span class="chip">B×${gain.b}</span></p>
    <p>校后偏差 ${deviationChips(residual, true)}</p>
    <p>校后色温 ${appliedColorTemp}K · ${grade === "pass" ? "达标" : "仍有偏差，已如实记录"}</p>
  </div>`;
}

function renderSampleCard(sample) {
  const scope = Store.scopeById(sample.microscopeId);
  const batch = Store.batchOf(sample.microscopeId, sample.batchId);
  const pending = Store.pendingCalibration(sample.id);
  const badge = {
    qualified: '<span class="badge badge-ok">合格免校</span>',
    pending: '<span class="badge badge-pending">待校色</span>',
    calibrated: '<span class="badge badge-done">已校色</span>'
  }[sample.status];
  const comparable = Rules.canCompare(sample);
  const checked = Store.get().pick.includes(sample.id);

  return `<article class="sample-card">
    ${sample.photo ? `<img src="${sample.photo}" alt="${esc(sample.code)}显微照片">` : '<div class="photo-placeholder"></div>'}
    <div class="sample-body">
      <h3>${esc(sample.code)} ${badge}</h3>
      <p>${esc(sample.polarization)} · ${esc(sample.magnification || "倍数未记")}</p>
      <p>显微镜：${esc(scope ? scope.name : "已删仪器")}${scope && !scope.active ? "（已报废）" : ""}</p>
      <p>光源批次：${esc(batch ? batch.label : "未知")} · 色温 ${sample.colorTemp}K
        ${Rules.tempInRange(sample.colorTemp) ? "" : '<span class="chip chip-bad">色温越界</span>'}</p>
      <p>标准板偏差 ${deviationChips(sample.reading)}</p>
      <p>矿物：${esc(sample.minerals || "未记录")} · 结构：${esc(sample.texture || "未记录")}</p>
      ${sample.comment ? `<p>批注：${esc(sample.comment)}</p>` : ""}
      ${sample.status === "pending" && pending ? pendingCalCard(sample, pending) : ""}
      ${sample.status === "calibrated" ? calibratedInfo(sample) : ""}
      <div class="card-actions">
        <label class="compare-check">
          <input type="checkbox" data-pick="${sample.id}" ${checked ? "checked" : ""}
            ${comparable ? "" : "disabled"}>
          加入对照${comparable ? "" : "（待校色不可用）"}
        </label>
        <span class="spacer"></span>
        ${sample.status === "calibrated" ? `<button type="button" class="ghost-btn" data-correct="${sample.id}">校色更正</button>` : ""}
        <button type="button" class="danger-btn" data-delete="${sample.id}">删除</button>
      </div>
    </div>
  </article>`;
}

function renderGrid() {
  const rows = Store.samples().filter((s) => Rules.matchesFilters(s, {
    q: qFilter.value,
    polarization: polarFilter.value,
    status: statusFilter.value,
    microscopeId: scopeFilter.value
  }));
  sampleGrid.innerHTML = rows.length
    ? rows.map(renderSampleCard).join("")
    : "<p class='empty'>没有符合筛选条件的样本。</p>";
}

/* ---------- 对照勾选条 ---------- */

function renderPickBar() {
  const pick = Store.get().pick;
  if (!pick.length) {
    pickBar.hidden = true;
    return;
  }
  pickBar.hidden = false;
  const chips = pick.map((id) => {
    const s = Store.sampleById(id);
    return s ? `<span class="pick-chip">${esc(pairKey(s))}
      <button type="button" data-unpick="${id}" title="移除">×</button></span>` : "";
  }).join("");
  pickBar.innerHTML = `<strong>对照候选：</strong>${chips}
    <span class="rule-hint" id="pickHint"></span>
    <button type="button" class="primary-btn" id="createCompareBtn" ${pick.length === 2 ? "" : "disabled"}>建立对照</button>`;
}

/* ---------- 对照列表 ---------- */

function resultBlock(r) {
  const label = Rules.COMPARE_GRADE_LABEL[r.grade];
  const cls = r.grade === "match" ? "badge-ok" : r.grade === "usable" ? "badge-pending" : "badge-bad";
  return `<div class="cmp-result">
    <span class="badge ${cls}">跨镜指数 ${r.index} · ${label}</span>
    <p class="rule-hint">增益差均值 ${r.gainDiff}% · 校后残差均值 ${r.residualMean}% · 色温差 ${r.tempDelta}K</p>
  </div>`;
}

function compareCard(c) {
  if (c.locked && c.lockedSnapshot) {
    const snap = c.lockedSnapshot;
    return `<article class="cmp-card locked">
      <h3>${esc(snap.a.code)} ↔ ${esc(snap.b.code)} <span class="badge badge-lock">已锁定 · 只读</span></h3>
      <p class="rule-hint">锁定于 ${fmtTime(snap.at)}</p>
      <div class="cmp-sides">
        ${[snap.a, snap.b].map((p) => `<div class="cmp-side">
          <p><strong>${esc(p.code)}</strong> · ${esc(p.polarization)}</p>
          <p>${esc(p.scopeName)} · ${esc(p.batch)}</p>
          <p class="rule-hint">R×${p.gain.r} G×${p.gain.g} B×${p.gain.b} · ${p.colorTemp}K</p>
        </div>`).join("")}
      </div>
      ${resultBlock(snap.result)}
    </article>`;
  }

  const a = Store.sampleById(c.sampleAId);
  const b = Store.sampleById(c.sampleBId);
  if (!a || !b) return "";
  const scopeA = Store.scopeById(a.microscopeId);
  const scopeB = Store.scopeById(b.microscopeId);
  const batchA = Store.batchOf(a.microscopeId, a.batchId);
  const batchB = Store.batchOf(b.microscopeId, b.batchId);

  return `<article class="cmp-card">
    <h3>${esc(a.code)} ↔ ${esc(b.code)}
      <span class="badge ${scopeA && scopeB && scopeA.id === scopeB.id ? "" : "badge-cross"}">
        ${scopeA && scopeB && scopeA.id === scopeB.id ? "同镜" : "跨镜"}
      </span>
    </h3>
    <div class="cmp-sides">
      ${[{ s: a, sc: scopeA, bt: batchA }, { s: b, sc: scopeB, bt: batchB }].map(({ s, sc, bt }) => `
        <div class="cmp-side">
          <p><strong>${esc(s.code)}</strong> · ${esc(s.polarization)}
            <span class="badge ${s.status === "calibrated" ? "badge-done" : "badge-ok"}">${Rules.STATUS_LABEL[s.status]}</span></p>
          <p>${esc(sc ? sc.name : "已删仪器")} · ${esc(bt ? bt.label : "未知批次")}</p>
        </div>`).join("")}
    </div>
    ${c.result ? resultBlock(c.result) : "<p class='rule-hint'>等待首次计算…</p>"}
    ${c.lastReason ? `<p class="recompute-note">↻ ${fmtTime(c.lastRecomputedAt)} 因「${esc(c.lastReason)}」已自动重算</p>` : ""}
    ${c.history.length ? `<p class="rule-hint">历史结果 ${c.history.length} 次（更正/换光/报废触发）</p>` : ""}
    <div class="card-row">
      <button type="button" data-lock-cmp="${c.id}">锁定对照</button>
      <button type="button" class="ghost-btn" data-remove-cmp="${c.id}">移除</button>
    </div>
  </article>`;
}

function renderComparisons() {
  const list = Store.comparisons();
  compareList.innerHTML = list.length
    ? list.map(compareCard).join("")
    : "<p class='empty'>在卡片上勾选两张合格/已校色样本，建立跨镜对照。</p>";
}

/* ---------- 记录层流水 ---------- */

const LOG_LABELS = {
  "sample.entry": "样本录入",
  "sample.delete": "样本删除",
  "calibration.start": "发起校色",
  "calibration.reuse": "重复发起·沿用",
  "calibration.done": "校色完成",
  "comparison.create": "建立对照",
  "comparison.lock": "锁定对照",
  "comparison.remove": "移除对照",
  "comparison.recompute": "对照失效重算",
  "scope.register": "仪器登记",
  "light.replace": "更换光源",
  "scope.retire": "仪器报废"
};

function renderLogFilter() {
  const types = Object.keys(LOG_LABELS);
  const current = logTypeFilter.value;
  logTypeFilter.innerHTML = '<option value="">全部类型</option>' +
    types.map((t) => `<option value="${t}">${LOG_LABELS[t]}</option>`).join("");
  if (current) logTypeFilter.value = current;
}

function renderLogs() {
  const type = logTypeFilter.value;
  const rows = Store.get().logs.filter((l) => !type || l.type === type).slice(0, 120);
  logBody.innerHTML = rows.length ? rows.map((l) => `
    <tr>
      <td>${fmtTime(l.at)}</td>
      <td><span class="log-type">${esc(LOG_LABELS[l.type] || l.type)}</span></td>
      <td>${esc(l.target)}</td>
      <td>${esc(l.detail)}</td>
    </tr>`).join("") : '<tr><td colspan="4" class="empty">暂无记录。</td></tr>';
}

/* ---------- 总渲染 ---------- */

function renderAll() {
  renderScopeOptions();
  renderBoundBatch();
  renderKit();
  renderGrid();
  renderPickBar();
  renderComparisons();
  renderLogFilter();
  renderLogs();
}

/* ---------- 录入表单 ---------- */

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) { pendingPhoto = ""; return; }
  pendingPhoto = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.readAsDataURL(file);
  });
});

scopeSelect.addEventListener("change", renderBoundBatch);

$("#newScopeToggle").addEventListener("click", () => {
  $("#newScopeForm").hidden = !$("#newScopeForm").hidden;
});

$("#newScopeSave").addEventListener("click", () => {
  const name = $("#newScopeName").value.trim();
  const batchLabel = $("#newBatchLabel").value.trim();
  if (!name || !batchLabel) { toast("仪器名称与首批光源批次都要填写", "bad"); return; }
  const scope = Store.addScope(name, batchLabel);
  $("#newScopeForm").hidden = true;
  $("#newScopeName").value = "";
  $("#newBatchLabel").value = "";
  renderAll();
  scopeSelect.value = scope.id;
  renderBoundBatch();
  toast("显微镜与首批光源已登记", "ok");
});

sampleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  formMessage.textContent = "";
  const data = new FormData(sampleForm);
  const code = data.get("code").trim();
  const polarization = data.get("polarization");
  const microscopeId = scopeSelect.value;

  if (!code) { formMessage.textContent = "样本编号必填。"; return; }
  if (!microscopeId) { formMessage.textContent = "请先登记并选择显微镜。"; return; }
  if (Store.findSample(code, polarization)) {
    formMessage.textContent = `编号 ${code} + ${polarization} 已存在，样品按编号与偏光条件唯一。`;
    return;
  }
  const r = Number(data.get("r"));
  const g = Number(data.get("g"));
  const b = Number(data.get("b"));
  const colorTemp = Number(data.get("colorTemp"));
  if ([r, g, b].some((v) => !Number.isFinite(v) || v < 1 || v > 255)) {
    formMessage.textContent = "标准板读数需在 1–255 之间。";
    return;
  }
  if (!Number.isFinite(colorTemp) || colorTemp < 2000 || colorTemp > 10000) {
    formMessage.textContent = "色温需在 2000–10000K 之间。";
    return;
  }

  const batch = currentBatch(microscopeId);
  const verdict = Rules.entryVerdict({ r, g, b }, colorTemp);
  const sample = Store.addSample({
    photo: pendingPhoto,
    code,
    polarization,
    location: data.get("location").trim(),
    magnification: data.get("magnification").trim(),
    minerals: data.get("minerals").trim(),
    texture: data.get("texture").trim(),
    comment: data.get("comment").trim(),
    microscopeId,
    batchId: batch ? batch.id : null,
    r, g, b,
    colorTemp,
    status: verdict.status
  });

  if (verdict.status === "pending") {
    Store.startCalibration(sample.id, "entry");
    formMessage.textContent = "判定：只待校色 —— " + verdict.reasons.join("；");
    formMessage.className = "form-message bad";
  } else {
    formMessage.textContent = "判定：通道与色温均合格，免校色，可直接用于对照。";
    formMessage.className = "form-message ok";
  }

  pendingPhoto = "";
  photoInput.value = "";
  sampleForm.reset();
  renderAll();
});

/* ---------- 卡片事件（事件委托） ---------- */

sampleGrid.addEventListener("click", (event) => {
  const t = event.target;

  if (t.dataset.delete) {
    const s = Store.sampleById(t.dataset.delete);
    if (!s || !confirm(`删除样本 ${s.code}（${s.polarization}）？未锁定对照将一并移除。`)) return;
    Store.deleteSample(s.id);
    sweepComparisons({ silent: false });
    renderAll();
    return;
  }

  if (t.dataset.correct) {
    const sampleId = t.dataset.correct;
    const hadPending = !!Store.pendingCalibration(sampleId);
    Store.startCalibration(sampleId, "correction");
    toast(hadPending ? "已有未完成校准单，沿用首次结果，未重复建单" : "已创建校准更正单", "info");
    renderAll();
    return;
  }

  if (t.dataset.reuseCal) {
    Store.startCalibration(t.dataset.reuseCal, "entry");
    toast("已有未完成校准单，沿用首次结果，未重复建单", "info");
    renderAll();
    return;
  }

  if (t.dataset.completeCal) {
    const box = t.closest("[data-cal-card]");
    const get = (k) => Number(box.querySelector(`[data-draft="${k}"]`).value);
    const r = get("r"), g = get("g"), b = get("b"), temp = get("temp");
    if ([r, g, b].some((v) => !Number.isFinite(v) || v < 1 || v > 255)) {
      toast("校后读数需在 1–255 之间", "bad"); return;
    }
    if (!Number.isFinite(temp) || temp < 2000 || temp > 10000) {
      toast("校后色温需在 2000–10000K 之间", "bad"); return;
    }
    const cal = Store.calibrationById(t.dataset.completeCal);
    const result = Rules.calibrationResult(cal.fromReading, { r, g, b }, temp);
    Store.saveCalibrationDraft(cal.id, { r, g, b }, temp);
    Store.completeCalibration(cal.id, result);
    sweepComparisons({ silent: false });
    toast(result.grade === "pass" ? "校色完成且达标，未锁定对照已重算" : "校色完成（仍有偏差），对照已重算",
      result.grade === "pass" ? "ok" : "info");
    renderAll();
  }
});

sampleGrid.addEventListener("change", (event) => {
  const t = event.target;

  if (t.dataset.draft) {
    const box = t.closest("[data-cal-card]");
    const cal = Store.calibrationById(box.dataset.calCard);
    if (!cal || cal.status !== "pending") return;
    const num = (k) => Number(box.querySelector(`[data-draft="${k}"]`).value);
    Store.saveCalibrationDraft(cal.id, { r: num("r"), g: num("g"), b: num("b") }, num("temp"));
    return;
  }

  if (t.dataset.pick) {
    let pick = Store.get().pick.slice();
    if (t.checked) {
      pick = [t.dataset.pick, ...pick.filter((id) => id !== t.dataset.pick)].slice(0, 2);
      if (Store.get().pick.length === 2 && !Store.get().pick.includes(t.dataset.pick)) {
        toast("对照最多两张，已替换最早选择", "info");
      }
    } else {
      pick = pick.filter((id) => id !== t.dataset.pick);
    }
    Store.setPick(pick);
    renderGrid();
    renderPickBar();
  }
});

/* ---------- 对照台事件 ---------- */

pickBar.addEventListener("click", (event) => {
  if (event.target.dataset.unpick) {
    Store.setPick(Store.get().pick.filter((id) => id !== event.target.dataset.unpick));
    renderGrid();
    renderPickBar();
    return;
  }
  if (event.target.id === "createCompareBtn") {
    const [idA, idB] = Store.get().pick;
    const sa = Store.sampleById(idA);
    const sb = Store.sampleById(idB);
    if (!sa || !sb) return;
    const existing = Store.comparisonBetween(idA, idB);
    if (existing) {
      toast(existing.locked
        ? "该对照已锁定，锁定结果只读，无需重复建立"
        : "该对照已存在，沿用首次结果；依据变更时会自动重算", "info");
      return;
    }
    if (!Rules.canCompare(sa) || !Rules.canCompare(sb)) {
      toast("仅合格 / 已校色样本可建立对照", "bad");
      return;
    }
    const [a, b] = [idA, idB].sort().map(Store.sampleById);
    const result = Rules.crossResult(comparisonPart(a), comparisonPart(b));
    const cmp = Store.addComparison(a.id, b.id, result);
    Store.updateComparison(cmp.id, {
      basis: { a: Rules.buildBasis(a), b: Rules.buildBasis(b) }
    });
    Store.setPick([]);
    renderAll();
    toast("跨镜对照已建立", "ok");
  }
});

compareList.addEventListener("click", (event) => {
  const t = event.target;
  if (t.dataset.lockCmp) {
    Store.lockComparison(t.dataset.lockCmp);
    renderAll();
    toast("对照已锁定，此后只读", "ok");
  }
  if (t.dataset.removeCmp) {
    Store.removeComparison(t.dataset.removeCmp);
    renderAll();
  }
});

/* ---------- 仪器区事件 ---------- */

kitList.addEventListener("click", (event) => {
  const t = event.target;
  if (t.dataset.replaceBatch) {
    const scopeId = t.dataset.replaceBatch;
    const input = kitList.querySelector(`[data-batch-input="${scopeId}"]`);
    const label = input.value.trim();
    if (!label) { toast("请填写新光源批次号", "bad"); return; }
    Store.replaceBatch(scopeId, label);
    sweepComparisons({ silent: false });
    renderAll();
    toast("光源已更换，未锁定对照失效并重算", "ok");
  }
  if (t.dataset.retireScope) {
    const scope = Store.scopeById(t.dataset.retireScope);
    if (!scope || !confirm(`报废「${scope.name}」？该仪器相关的未锁定对照将失效重算，已锁定对照保持只读。`)) return;
    Store.retireScope(scope.id);
    sweepComparisons({ silent: false });
    renderAll();
    toast("仪器已报废", "info");
  }
});

/* ---------- 筛选（选择状态跨刷新保留） ---------- */

function syncUiState() {
  uiState = {
    q: qFilter.value,
    polarization: polarFilter.value,
    status: statusFilter.value,
    scopeId: scopeFilter.value
  };
  localStorage.setItem(uiKey, JSON.stringify(uiState));
}

[qFilter, polarFilter, statusFilter, scopeFilter].forEach((el) => {
  el.addEventListener("input", () => { syncUiState(); renderGrid(); });
  el.addEventListener("change", () => { syncUiState(); renderGrid(); });
});
logTypeFilter.addEventListener("change", renderLogs);

/* ---------- 导出 ---------- */

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(Store.get(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `thin-section-ledger-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

/* ---------- 启动：先静默扫描保证刷新后一致，再渲染 ---------- */

(function init() {
  if (uiState.q !== undefined) qFilter.value = uiState.q;
  if (uiState.polarization) polarFilter.value = uiState.polarization;
  if (uiState.status) statusFilter.value = uiState.status;
  sweepComparisons({ silent: true });
  renderAll();
})();
