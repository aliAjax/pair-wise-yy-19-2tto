const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// ---- 最小浏览器存根 ----
const mem = {};
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; }
  },
  crypto: { randomUUID: () => "u" + (++idc) + "-" + Math.random().toString(36).slice(2, 8) },
  setTimeout, clearTimeout, Date, JSON, Math, Number, Object, Array, String, Boolean
};
let idc = 0;
sandbox.window = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync("records.js", "utf8") + "\n;globalThis.__Store = Store;", sandbox, { filename: "records.js" });
vm.runInContext(fs.readFileSync("rules.js", "utf8") + "\n;globalThis.__Rules = Rules;", sandbox, { filename: "rules.js" });

const Store = sandbox.__Store;
const Rules = sandbox.__Rules;
const log = (s) => console.log("  " + s);

// 1. 仪器登记
const scopeA = Store.addScope("显微镜甲", "LED-A1");
const scopeB = Store.addScope("显微镜乙", "LED-B1");
assert.ok(scopeA.id && scopeB.id);
log("仪器登记 OK");

// 2. 合格样本（255/255/255, 5500K）
let v = Rules.entryVerdict({ r: 255, g: 255, b: 255 }, 5500);
assert.strictEqual(v.qualified, true);
const s1 = Store.addSample({
  code: "BX-01", polarization: "单偏光", microscopeId: scopeA.id,
  batchId: scopeA.batches[0].id, r: 255, g: 255, b: 255, colorTemp: 5500,
  status: v.status
});
assert.strictEqual(s1.status, "qualified");

// 2b. 唯一键
assert.ok(Store.findSample("BX-01", "单偏光"));
assert.ok(!Store.findSample("BX-01", "正交偏光"));

// 3. 偏差样本 R=240 → 5.88% > 3%
v = Rules.entryVerdict({ r: 240, g: 255, b: 255 }, 5500);
assert.strictEqual(v.qualified, false);
assert.ok(v.reasons[0].includes("R"));
const s2 = Store.addSample({
  code: "BX-02", polarization: "单偏光", microscopeId: scopeB.id,
  batchId: scopeB.batches[0].id, r: 240, g: 255, b: 255, colorTemp: 5500,
  status: v.status
});
assert.strictEqual(s2.status, "pending");

// 4. 色温越界 4800K
v = Rules.entryVerdict({ r: 255, g: 255, b: 255 }, 4800);
assert.strictEqual(v.qualified, false);
assert.ok(v.reasons.join().includes("色温"));

// 5. 同一样品仅一条未完成校准：重复/并发沿用
const c1 = Store.startCalibration(s2.id, "entry");
const c1again = Store.startCalibration(s2.id, "entry");
assert.strictEqual(c1.id, c1again.id, "重复发起必须沿用首次校准单");
const result = Rules.calibrationResult(c1.fromReading, { r: 254, g: 255, b: 255 }, 5500);
assert.ok(result.gain.r >= 1.06 && result.gain.g === 1);
assert.strictEqual(result.grade, "pass");
Store.completeCalibration(c1.id, result);
assert.strictEqual(Store.sampleById(s2.id).status, "calibrated");
assert.strictEqual(Store.sampleById(s2.id).calibrationVersion, 1);
log("录入判定 / 唯一未完成校准 / 校色 OK");

// 6. 建立对照（跨镜：甲 vs 乙）
const [aId, bId] = [s1.id, s2.id].sort();
const a = Store.sampleById(aId), b = Store.sampleById(bId);
const part = (s) => ({
  microscopeId: s.microscopeId,
  status: s.status,
  gain: Rules.gainOf(s, Store.currentCalibration(s.id)),
  residual: Rules.residualOf(s, Store.currentCalibration(s.id)),
  colorTemp: (Store.currentCalibration(s.id) || {}).result
    ? Store.currentCalibration(s.id).result.appliedColorTemp : s.colorTemp
});
const cr = Rules.crossResult(part(a), part(b));
assert.strictEqual(cr.crossScope, true);
assert.ok(["match", "usable", "diverged"].includes(cr.grade));
const cmp = Store.addComparison(aId, bId, cr);
Store.updateComparison(cmp.id, { basis: { a: Rules.buildBasis(a), b: Rules.buildBasis(b) } });
const idxAtCreate = Store.comparisons()[0].result.index;
log(`跨镜指数=${cr.index} 评级=${cr.grade}（增益差${cr.gainDiff}% 残差${cr.residualMean}% 色温${cr.tempDelta}K）`);

// 7. 校准更正 → 未锁定对照失效依据能检出
const c2 = Store.startCalibration(s2.id, "correction");
assert.notStrictEqual(c2.id, c1.id, "已完成后允许新的更正单");
const result2 = Rules.calibrationResult({ r: 230, g: 250, b: 250 }, { r: 253, g: 254, b: 254 }, 5600);
Store.completeCalibration(c2.id, result2);
let reason = Rules.detectBasisChange(cmp.basis.b, Store.sampleById(s2.id), Store.scopeById(scopeB.id));
assert.strictEqual(reason, "校准已更正");
assert.strictEqual(Store.sampleById(s2.id).calibrationVersion, 2);
log("校准更正触发失效 OK");

// 8. 模拟 app.js 的 sweep 重算
function sweep(silent) {
  for (const c of Store.comparisons()) {
    if (c.locked) continue;
    const sa = Store.sampleById(c.sampleAId), sb = Store.sampleById(c.sampleBId);
    if (!sa || !sb) { Store.removeComparison(c.id); continue; }
    const r = Rules.detectBasisChange(c.basis.a, sa, Store.scopeById(sa.microscopeId))
      || Rules.detectBasisChange(c.basis.b, sb, Store.scopeById(sb.microscopeId));
    if (!r) continue;
    const nr = Rules.crossResult(part(sa), part(sb));
    Store.updateComparison(c.id, {
      result: nr, stale: false, staleReason: "", lastReason: r,
      basis: { a: Rules.buildBasis(sa), b: Rules.buildBasis(sb) }
    }, r);
  }
}
sweep();
let cmpNow = Store.comparisons()[0];
assert.strictEqual(cmpNow.lastReason, "校准已更正");
assert.strictEqual(cmpNow.history.length, 1, "旧结果须进 history");
log("失效重算 OK，指数 " + idxAtCreate + " → " + cmpNow.result.index);

// 9. 锁定对照只读：之后再更正也不动它
Store.lockComparison(cmp.id);
const c3 = Store.startCalibration(s2.id, "correction");
const r3 = Rules.calibrationResult({ r: 220, g: 245, b: 245 }, { r: 252, g: 253, b: 253 }, 5700);
Store.completeCalibration(c3.id, r3);
sweep();
cmpNow = Store.comparisons()[0];
assert.strictEqual(cmpNow.locked, true);
assert.ok(cmpNow.lockedSnapshot, "锁定须留快照");
const lockedIndex = cmpNow.lockedSnapshot.result.index;
assert.strictEqual(cmpNow.result.index, lockedIndex, "锁定后显示值不变");
log("锁定对照只读 OK");

// 10. 换光源：另一台显微镜上的合格样本 + 未锁定对照被标记
const s3 = Store.addSample({
  code: "BX-03", polarization: "反射光", microscopeId: scopeA.id,
  batchId: scopeA.batches[0].id, r: 255, g: 255, b: 255, colorTemp: 5200, status: "qualified"
});
const cmp2ent = Store.addComparison(...[s1.id, s3.id].sort(),
  Rules.crossResult(part(s1), part(s3)));
const sorted2 = [s1.id, s3.id].sort().map(Store.sampleById);
Store.updateComparison(cmp2ent.id, { basis: { a: Rules.buildBasis(sorted2[0]), b: Rules.buildBasis(sorted2[1]) } });
Store.replaceBatch(scopeA.id, "LED-A2");
reason = Rules.detectBasisChange(
  Store.comparisons().find((c) => c.id === cmp2ent.id).basis.b,
  s3, Store.scopeById(scopeA.id));
assert.strictEqual(reason, "光源批次已更换");
log("换光源触发失效 OK");

// 11. 仪器报废
Store.retireScope(scopeB.id);
reason = Rules.detectBasisChange(cmp.basis.b, Store.sampleById(s2.id), Store.scopeById(scopeB.id));
assert.strictEqual(reason, "绑定显微镜已报废");
log("仪器报废触发失效 OK");

// 12. 删除样本：未锁定对照移除，锁定对照保留
Store.deleteSample(s3.id);
const ids = Store.comparisons().map((c) => c.id);
assert.ok(!ids.includes(cmp2ent.id), "未锁定对照随样本删除");
assert.ok(ids.includes(cmp.id), "锁定对照保留（只读快照）");
log("删除样本级联 OK");

// 13. 筛选
assert.ok(Rules.matchesFilters(s1, { q: "BX-0", polarization: "单偏光" }));
assert.ok(!Rules.matchesFilters(s1, { status: "pending" }));
assert.ok(Rules.matchesFilters(Store.sampleById(s2.id), { status: "calibrated" }));
assert.ok(!Rules.canCompare({ status: "pending" }));
assert.ok(Rules.canCompare({ status: "qualified" }));

// 14. 旧数据迁移
mem["wxyy-2-thin-section-index"] = JSON.stringify({
  samples: [{ id: "old1", code: "OLD-1", polarization: "正交偏光", minerals: "石英" }],
  compare: ["old1"]
});
delete require.cache[require.resolve("./records.js")];
const sandbox2 = {
  console, localStorage: sandbox.localStorage,
  crypto: { randomUUID: () => "m" + (++idc) },
  setTimeout, Date, JSON, Math, Number, Object, Array, String, Boolean
};
sandbox2.window = sandbox2;
vm.createContext(sandbox2);
vm.runInContext(fs.readFileSync("records.js", "utf8") + "\n;globalThis.__Store = Store;", sandbox2);
const migrated = sandbox2.__Store.get();
assert.strictEqual(migrated.version, 2);
assert.strictEqual(migrated.samples[0].status, "qualified");
assert.strictEqual(migrated.microscopes.length, 1);
assert.deepStrictEqual(migrated.pick, ["old1"]);
log("旧版本迁移 OK");

console.log("\n全部断言通过 ✔");
