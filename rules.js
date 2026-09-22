/* ============================================================
 * 判定层 rules.js
 * 职责：所有阈值与判定规则的唯一来源，全部为纯函数，不读写存储。
 *   - 通道偏差 > 3%（|读数-255| / 255）→ 只待校色
 *   - 色温不在 5000–6500K → 只待校色
 *   - 同一样品仅一条未完成校准（判定由记录层配合复用）
 *   - 校准更正 / 换光源 / 仪器报废 → 未锁定对照失效重算
 * ============================================================ */

const Rules = (() => {
  const REFERENCE = 255;          // 标准白板读数基准
  const MAX_CHANNEL_DEV_PCT = 3;  // 单通道允许偏差
  const MIN_COLOR_TEMP = 5000;    // K
  const MAX_COLOR_TEMP = 6500;    // K
  const TARGET_COLOR_TEMP = 5500; // 校色目标色温

  const STATUS_LABEL = {
    qualified: "合格免校",
    pending: "待校色",
    calibrated: "已校色"
  };

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  /* ---------- 通道偏差 ---------- */
  function channelDeviations(reading) {
    const dev = (v) => Math.abs(v - REFERENCE) / REFERENCE * 100;
    return {
      r: round2(dev(reading.r)),
      g: round2(dev(reading.g)),
      b: round2(dev(reading.b))
    };
  }

  function maxChannelDev(reading) {
    const d = channelDeviations(reading);
    return Math.max(d.r, d.g, d.b);
  }

  function tempInRange(temp) {
    return temp >= MIN_COLOR_TEMP && temp <= MAX_COLOR_TEMP;
  }

  /* ---------- 录入判定 ---------- */
  function entryVerdict(reading, colorTemp) {
    const devs = channelDeviations(reading);
    const reasons = [];
    if (Math.max(devs.r, devs.g, devs.b) > MAX_CHANNEL_DEV_PCT) {
      const bad = Object.entries(devs)
        .filter(([, v]) => v > MAX_CHANNEL_DEV_PCT)
        .map(([k, v]) => `${k.toUpperCase()} ${v}%`)
        .join("、");
      reasons.push(`标准板通道偏差超 3%（${bad}）`);
    }
    if (!tempInRange(colorTemp)) {
      reasons.push(`色温 ${colorTemp}K 不在 ${MIN_COLOR_TEMP}–${MAX_COLOR_TEMP}K`);
    }
    return {
      qualified: reasons.length === 0,
      status: reasons.length === 0 ? "qualified" : "pending",
      reasons,
      deviations: devs
    };
  }

  /* ---------- 校准计算 ---------- */
  // 每通道增益：把录入时读数拉回标准白板 255 的乘性系数
  function correctionGain(fromReading) {
    return {
      r: round2(REFERENCE / fromReading.r),
      g: round2(REFERENCE / fromReading.g),
      b: round2(REFERENCE / fromReading.b)
    };
  }

  function calibrationResult(fromReading, postReading, postColorTemp) {
    const gain = correctionGain(fromReading);
    const residual = channelDeviations(postReading);
    const residualMax = Math.max(residual.r, residual.g, residual.b);
    const grade = residualMax <= MAX_CHANNEL_DEV_PCT && tempInRange(postColorTemp)
      ? "pass"
      : "weak";
    return {
      gain,
      residual,
      residualMax: round2(residualMax),
      appliedColorTemp: postColorTemp,
      grade
    };
  }

  function gainOf(sample, calibration) {
    if (sample.status === "calibrated" && calibration && calibration.result) {
      return clone(calibration.result.gain);
    }
    return { r: 1, g: 1, b: 1 };
  }

  function residualOf(sample, calibration) {
    if (sample.status === "calibrated" && calibration && calibration.result) {
      return clone(calibration.result.residual);
    }
    return channelDeviations(sample.reading);
  }

  /* ---------- 跨镜对照指数 ---------- */
  // part: { microscopeId, status, gain, residual:{r,g,b}, colorTemp }
  function crossResult(partA, partB) {
    const gainKeys = ["r", "g", "b"];
    const gainDiff = round2(
      gainKeys.reduce((sum, k) => sum + Math.abs(partA.gain[k] - partB.gain[k]), 0) / 3 * 100
    );
    const residualAvg = (p) => (p.residual.r + p.residual.g + p.residual.b) / 3;
    const residualMean = round2((residualAvg(partA) + residualAvg(partB)) / 2);
    const tempDelta = Math.abs(partA.colorTemp - partB.colorTemp);

    const index = round2(residualMean * 0.4 + gainDiff * 0.35 + tempDelta * 0.04);
    let grade;
    if (index <= 3) grade = "match";      // 色彩一致
    else if (index <= 6) grade = "usable"; // 可参考
    else grade = "diverged";               // 色彩差异明显

    return {
      index,
      grade,
      gainDiff,
      residualMean,
      tempDelta,
      crossScope: partA.microscopeId !== partB.microscopeId,
      computedAt: new Date().toISOString()
    };
  }

  const COMPARE_GRADE_LABEL = {
    match: "色彩一致",
    usable: "可参考",
    diverged: "色彩差异明显"
  };

  /* ---------- 对照失效依据 ---------- */
  function buildBasis(sample) {
    return {
      microscopeId: sample.microscopeId,
      batchId: sample.batchId,
      calibrationVersion: sample.calibrationVersion,
      currentCalibrationId: sample.currentCalibrationId,
      status: sample.status
    };
  }

  // 返回失效原因；未失效返回 ""
  function detectBasisChange(basis, sample, scope) {
    if (!sample) return "对照样本已删除";
    if (!scope || scope.active === false) return "绑定显微镜已报废";
    if (scope.batches[scope.batches.length - 1].id !== basis.batchId) return "光源批次已更换";
    if (sample.calibrationVersion !== basis.calibrationVersion ||
        sample.currentCalibrationId !== basis.currentCalibrationId) {
      return "校准已更正";
    }
    if (sample.status !== basis.status) return "样本状态变化";
    return "";
  }

  /* ---------- 筛选 ---------- */
  function matchesFilters(sample, f) {
    const q = (f.q || "").trim().toLowerCase();
    if (q) {
      const hay = [sample.code, sample.minerals, sample.location, sample.texture, sample.comment]
        .join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.polarization && sample.polarization !== f.polarization) return false;
    if (f.status && sample.status !== f.status) return false;
    if (f.microscopeId && sample.microscopeId !== f.microscopeId) return false;
    return true;
  }

  function canCompare(sample) {
    return sample.status === "qualified" || sample.status === "calibrated";
  }

  return {
    REFERENCE, MAX_CHANNEL_DEV_PCT, MIN_COLOR_TEMP, MAX_COLOR_TEMP, TARGET_COLOR_TEMP,
    STATUS_LABEL, COMPARE_GRADE_LABEL,
    clamp, round2,
    channelDeviations, maxChannelDev, tempInRange,
    entryVerdict, correctionGain, calibrationResult,
    gainOf, residualOf, crossResult,
    buildBasis, detectBasisChange,
    matchesFilters, canCompare
  };
})();
