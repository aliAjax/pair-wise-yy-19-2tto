/* ============================================================
 * 记录层 records.js
 * 职责：数据结构、持久化、增删改、操作流水。
 * 不含任何判定逻辑（阈值、合格与否、跨镜指数全部在 rules.js）。
 * ============================================================ */

const StorageKey = "wxyy-2-thin-section-index";

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ---------- 初始数据 / 旧版迁移 ---------- */

function emptyState() {
  return {
    version: 2,
    microscopes: [],
    samples: [],
    calibrations: [],
    comparisons: [],
    logs: [],
    pick: [] // 对照台当前勾选（跨筛选、跨刷新保留）
  };
}

function migrate(raw) {
  if (raw && raw.version === 2) return raw;

  const next = emptyState();
  if (!raw || !Array.isArray(raw.samples)) return next;

  // 旧版没有仪器实体：为旧样本补一台默认显微镜与光源批次
  const scopeId = uid();
  const batchId = uid();
  next.microscopes.push({
    id: scopeId,
    name: "默认显微镜（迁移）",
    active: true,
    batches: [{ id: batchId, label: "默认光源批次", installedAt: new Date().toISOString() }],
    createdAt: new Date().toISOString()
  });

  next.samples = raw.samples.map((s) => ({
    id: s.id || uid(),
    photo: s.photo || "",
    code: s.code || "",
    polarization: s.polarization || "单偏光",
    location: s.location || "",
    magnification: s.magnification || "",
    minerals: s.minerals || "",
    texture: s.texture || "",
    comment: s.comment || "",
    microscopeId: scopeId,
    batchId,
    reading: { r: 255, g: 255, b: 255 },
    colorTemp: 5500,
    status: "qualified",
    currentCalibrationId: null,
    calibrationVersion: 0,
    createdAt: s.createdAt || new Date().toISOString()
  }));

  // 旧版 compare 只是两个 id，升级为对照实体（待重算）
  const oldPick = Array.isArray(raw.compare) ? raw.compare.slice(0, 2) : [];
  next.pick = oldPick;
  return next;
}

const Store = (() => {
  let state = migrate(JSON.parse(localStorage.getItem(StorageKey) || "null"));

  function persist() {
    localStorage.setItem(StorageKey, JSON.stringify(state));
  }

  function log(type, target, detail) {
    state.logs.unshift({
      id: uid(),
      at: new Date().toISOString(),
      type,
      target: target || "",
      detail: detail || ""
    });
    if (state.logs.length > 500) state.logs.length = 500;
  }

  /* ----- 读 ----- */
  const get = () => state;
  const scopes = () => state.microscopes;
  const samples = () => state.samples;
  const calibrations = () => state.calibrations;
  const comparisons = () => state.comparisons;

  function scopeById(id) {
    return state.microscopes.find((m) => m.id === id) || null;
  }
  function sampleById(id) {
    return state.samples.find((s) => s.id === id) || null;
  }
  function calibrationById(id) {
    return state.calibrations.find((c) => c.id === id) || null;
  }
  function findSample(code, polarization) {
    return state.samples.find((s) => s.code === code && s.polarization === polarization) || null;
  }
  function batchOf(scopeId, batchId) {
    const scope = scopeById(scopeId);
    if (!scope) return null;
    return scope.batches.find((b) => b.id === batchId) || null;
  }
  function pendingCalibration(sampleId) {
    return state.calibrations.find((c) => c.sampleId === sampleId && c.status === "pending") || null;
  }
  function currentCalibration(sampleId) {
    const sample = sampleById(sampleId);
    return sample && sample.currentCalibrationId ? calibrationById(sample.currentCalibrationId) : null;
  }
  function comparisonBetween(idA, idB) {
    const [a, b] = [idA, idB].sort();
    return state.comparisons.find((c) => {
      const [x, y] = [c.sampleAId, c.sampleBId].sort();
      return x === a && y === b;
    }) || null;
  }

  /* ----- 显微镜 / 光源批次 ----- */
  function addScope(name, batchLabel) {
    const now = new Date().toISOString();
    const scope = {
      id: uid(),
      name: name.trim(),
      active: true,
      batches: [{ id: uid(), label: batchLabel.trim(), installedAt: now }],
      createdAt: now
    };
    state.microscopes.push(scope);
    log("scope.register", scope.name, `登记显微镜，首批光源：${scope.batches[0].label}`);
    persist();
    return scope;
  }

  function replaceBatch(scopeId, label) {
    const scope = scopeById(scopeId);
    if (!scope) return null;
    const batch = { id: uid(), label: label.trim(), installedAt: new Date().toISOString() };
    scope.batches.push(batch);
    log("light.replace", scope.name, `更换光源批次 → ${batch.label}`);
    persist();
    return batch;
  }

  function retireScope(scopeId) {
    const scope = scopeById(scopeId);
    if (!scope) return;
    scope.active = false;
    scope.retiredAt = new Date().toISOString();
    log("scope.retire", scope.name, "仪器报废停用");
    persist();
  }

  /* ----- 样本 ----- */
  function addSample(draft) {
    const now = new Date().toISOString();
    const sample = {
      id: uid(),
      photo: draft.photo || "",
      code: draft.code,
      polarization: draft.polarization,
      location: draft.location || "",
      magnification: draft.magnification || "",
      minerals: draft.minerals || "",
      texture: draft.texture || "",
      comment: draft.comment || "",
      microscopeId: draft.microscopeId,
      batchId: draft.batchId,
      reading: { r: draft.r, g: draft.g, b: draft.b },
      colorTemp: draft.colorTemp,
      status: draft.status, // qualified | pending | calibrated
      currentCalibrationId: null,
      calibrationVersion: 0,
      createdAt: now
    };
    state.samples.unshift(sample);
    log(
      "sample.entry",
      sample.code,
      `${sample.polarization} 录入，判定：${sample.status === "qualified" ? "合格免校" : "只待校色"}`
    );
    persist();
    return sample;
  }

  function patchSample(sampleId, patch, type, target, detail) {
    const sample = sampleById(sampleId);
    if (!sample) return null;
    Object.assign(sample, patch);
    if (type) log(type, target || sample.code, detail || "");
    persist();
    return sample;
  }

  function deleteSample(sampleId) {
    const sample = sampleById(sampleId);
    if (!sample) return;
    state.samples = state.samples.filter((s) => s.id !== sampleId);
    state.calibrations = state.calibrations.filter((c) => c.sampleId !== sampleId);
    state.pick = state.pick.filter((id) => id !== sampleId);
    state.comparisons = state.comparisons.filter((c) => c.locked ||
      (c.sampleAId !== sampleId && c.sampleBId !== sampleId));
    log("sample.delete", sample.code, "删除样本；未锁定对照一并移除");
    persist();
  }

  /* ----- 校准（同一样品仅一条未完成；重复/并发沿用首次结果） ----- */
  function startCalibration(sampleId, reason) {
    const existing = pendingCalibration(sampleId);
    const sample = sampleById(sampleId);
    if (existing) {
      log("calibration.reuse", sample.code, "存在未完成校准，沿用首次创建的校准单");
      persist();
      return existing;
    }
    const cal = {
      id: uid(),
      sampleId,
      status: "pending",
      reason: reason || "entry", // entry | correction
      microscopeId: sample ? sample.microscopeId : null,
      fromReading: sample ? clone(sample.reading) : null,
      fromColorTemp: sample ? sample.colorTemp : null,
      draftReading: null,
      draftColorTemp: null,
      beforeCalibrationId: sample ? sample.currentCalibrationId : null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    state.calibrations.push(cal);
    log("calibration.start", sample.code, reason === "correction" ? "发起校准更正" : "发起校色");
    if (sample) {
      sample.status = "pending";
    }
    persist();
    return cal;
  }

  function saveCalibrationDraft(calId, reading, colorTemp) {
    const cal = calibrationById(calId);
    if (!cal || cal.status !== "pending") return;
    cal.draftReading = clone(reading);
    cal.draftColorTemp = colorTemp;
    persist();
  }

  function completeCalibration(calId, result) {
    const cal = calibrationById(calId);
    if (!cal || cal.status !== "pending") return null;
    const sample = sampleById(cal.sampleId);

    cal.status = "done";
    cal.completedAt = new Date().toISOString();
    cal.result = result; // { gain, residual, appliedColorTemp, grade }

    if (sample) {
      sample.status = "calibrated";
      sample.currentCalibrationId = cal.id;
      sample.calibrationVersion += 1;
    }
    log("calibration.done", sample ? sample.code : "", "校色完成，样本转已校色，未锁定对照将重算");
    persist();
    return cal;
  }

  /* ----- 对照 ----- */
  function addComparison(idA, idB, result) {
    const [a, b] = [idA, idB].sort();
    const comparison = {
      id: uid(),
      sampleAId: a,
      sampleBId: b,
      locked: false,
      result,
      stale: false,
      staleReason: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      basis: null, // 快照依据，重算时写入
      lockedSnapshot: null,
      history: []
    };
    state.comparisons.unshift(comparison);
    log("comparison.create", `${a} ↔ ${b}`, "建立跨镜对照");
    persist();
    return comparison;
  }

  function updateComparison(comparisonId, patch, note) {
    const comparison = state.comparisons.find((c) => c.id === comparisonId);
    if (!comparison || comparison.locked) return null;
    if (note && comparison.result) {
      comparison.history.push({
        at: new Date().toISOString(),
        result: clone(comparison.result),
        note
      });
    }
    Object.assign(comparison, patch);
    comparison.updatedAt = new Date().toISOString();
    persist();
    return comparison;
  }

  function lockComparison(comparisonId) {
    const comparison = state.comparisons.find((c) => c.id === comparisonId);
    if (!comparison || comparison.locked) return;
    const a = sampleById(comparison.sampleAId);
    const b = sampleById(comparison.sampleBId);
    comparison.locked = true;
    comparison.stale = false;
    comparison.staleReason = "";
    comparison.lockedSnapshot = {
      at: new Date().toISOString(),
      a: a ? snapshotPart(a) : null,
      b: b ? snapshotPart(b) : null,
      result: clone(comparison.result)
    };
    log("comparison.lock", `${a ? a.code : "?"} ↔ ${b ? b.code : "?"}`, "对照锁定，此后只读");
    persist();
  }

  function snapshotPart(sample) {
    const cal = currentCalibration(sample.id);
    return {
      sampleId: sample.id,
      code: sample.code,
      polarization: sample.polarization,
      scopeName: scopeById(sample.microscopeId)?.name || "（已删仪器）",
      batch: batchOf(sample.microscopeId, sample.batchId)?.label || "（批次未知）",
      status: sample.status,
      gain: cal ? clone(cal.result.gain) : { r: 1, g: 1, b: 1 },
      residual: cal ? clone(cal.result.residual) : clone(sample.reading),
      colorTemp: cal ? cal.result.appliedColorTemp : sample.colorTemp,
      calibrationVersion: sample.calibrationVersion
    };
  }

  function removeComparison(comparisonId) {
    const comparison = state.comparisons.find((c) => c.id === comparisonId);
    if (!comparison || comparison.locked) return;
    state.comparisons = state.comparisons.filter((c) => c.id !== comparisonId);
    log("comparison.remove", "", "移除未锁定对照");
    persist();
  }

  /* ----- 对照勾选 ----- */
  function setPick(ids) {
    state.pick = ids.slice(0, 2);
    persist();
  }

  return {
    get, persist, log,
    scopes, samples, calibrations, comparisons,
    scopeById, sampleById, calibrationById, findSample, batchOf,
    pendingCalibration, currentCalibration, comparisonBetween,
    addScope, replaceBatch, retireScope,
    addSample, patchSample, deleteSample,
    startCalibration, saveCalibrationDraft, completeCalibration,
    addComparison, updateComparison, lockComparison, removeComparison,
    setPick
  };
})();
