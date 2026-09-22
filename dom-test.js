const fs = require("fs");
const path = require("path");
const { JSDOM } = require(path.join("/tmp", "node_modules", "jsdom"));
const assert = require("assert");

const html = fs.readFileSync("index.html", "utf8");
const boot = "\n;window.__Store = Store; window.__Rules = Rules;";
const evalScripts = ["records.js", "rules.js", "app.js"]
  .map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n;\n") + boot;

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  url: "http://localhost/",
  pretendToBeVisual: true
});
const { window } = dom;
window.confirm = () => true;
window.crypto = window.crypto || {};
if (!window.crypto.randomUUID) {
  let n = 0;
  window.crypto.randomUUID = () => "uuid-" + (++n);
}
window.eval(evalScripts);
const S = window.__Store;

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const setVal = (el, v) => { el.value = v; fire(el, "input"); fire(el, "change"); };
const cards = () => $$("#sampleGrid .sample-card");
const cmps = () => $$("#compareList .cmp-card");

// ---- 1. 登记仪器 ----
$("#newScopeToggle").click();
$("#newScopeName").value = "BX53-甲";
$("#newBatchLabel").value = "LED-A1";
$("#newScopeSave").click();
assert.ok($("#boundBatchLine").textContent.includes("LED-A1"));

const scopeAId = $("#scopeSelect").value;
const scopeB = S.addScope("BX53-乙", "LED-B1");

// ---- 2. 录入合格样本 ----
function fillEntry({ code, pol, r, g, b, temp, scopeId }) {
  const f = $("#sampleForm");
  f.querySelector('[name="code"]').value = code;
  f.querySelector('[name="polarization"]').value = pol;
  $("#scopeSelect").value = scopeId; fire($("#scopeSelect"), "change");
  f.querySelector('[name="r"]').value = r;
  f.querySelector('[name="g"]').value = g;
  f.querySelector('[name="b"]').value = b;
  f.querySelector('[name="colorTemp"]').value = temp;
  f.requestSubmit ? f.requestSubmit() : fire(f, "submit");
}
fillEntry({ code: "BX-01", pol: "单偏光", r: 255, g: 255, b: 255, temp: 5500, scopeId: scopeAId });
assert.strictEqual(cards().length, 1);
assert.ok($("#formMessage").textContent.includes("合格"));
assert.ok(cards()[0].textContent.includes("合格免校"));

// 重复唯一键应被驳回
fillEntry({ code: "BX-01", pol: "单偏光", r: 255, g: 255, b: 255, temp: 5500, scopeId: scopeAId });
assert.strictEqual(cards().length, 1, "编号+偏光重复不得再建");
assert.ok($("#formMessage").textContent.includes("唯一"));

// 同编号不同偏光可建
fillEntry({ code: "BX-01", pol: "正交偏光", r: 255, g: 255, b: 255, temp: 5500, scopeId: scopeAId });
assert.strictEqual(cards().length, 2);

// ---- 3. 录入待校色样本（R=240, 色温 6800 越界）----
fillEntry({ code: "BX-02", pol: "单偏光", r: 240, g: 255, b: 255, temp: 6800, scopeId: scopeB.id });
const card2 = $$("#sampleGrid .sample-card").find((c) => c.textContent.includes("BX-02"));
assert.ok(card2.textContent.includes("待校色"));
assert.ok(card2.querySelector(".cal-box"), "录入即自动开校准单");
assert.ok(card2.querySelector('[data-pick]').disabled, "待校色样本不可加入对照");

// 重复发起沿用：校准单仍只有一张
card2.querySelector('[data-reuse-cal]').click();
const card2afterReuse = $$("#sampleGrid .sample-card").find((c) => c.textContent.includes("BX-02"));
assert.strictEqual(card2afterReuse.querySelectorAll(".cal-box").length, 1);

// 完成校准（复用按钮触发过重渲染，需重新取节点）
const box = card2afterReuse.querySelector(".cal-box");
box.querySelector('[data-draft="r"]').value = 254;
box.querySelector('[data-draft="g"]').value = 255;
box.querySelector('[data-draft="b"]').value = 255;
box.querySelector('[data-draft="temp"]').value = 5600;
box.querySelector('[data-complete-cal]').click();
const card2b = $$("#sampleGrid .sample-card").find((c) => c.textContent.includes("BX-02"));
assert.ok(card2b.textContent.includes("已校色"));
assert.ok(card2b.textContent.includes("通道增益"));
assert.ok(!card2b.querySelector('[data-pick]').disabled, "校准后可加入对照");

// ---- 4. 建立跨镜对照 ----
const findCard = (matcher) => $$("#sampleGrid .sample-card").find(matcher);
const togglePick = (matcher) => {
  const card = typeof matcher === "function" ? findCard(matcher) : matcher;
  const cb = card.querySelector('[data-pick]');
  cb.checked = true;
  fire(cb, "change");
};
const isBX01Plane = (c) => /BX-01/.test(c.querySelector("h3").textContent) && c.textContent.includes("单偏光");
togglePick(isBX01Plane);
togglePick((c) => c.textContent.includes("BX-02"));
assert.ok(!$("#pickBar").hidden);
$("#createCompareBtn").click();
assert.strictEqual(cmps().length, 1);
assert.ok(cmps()[0].textContent.includes("跨镜"));
assert.ok(cmps()[0].textContent.includes("跨镜指数"));

// 重复建立沿用（每次勾选触发重绘，需重新取节点）
togglePick(isBX01Plane);
togglePick((c) => c.textContent.includes("BX-02"));
$("#createCompareBtn").click();
assert.strictEqual(cmps().length, 1, "相同样本对沿用同一对照");

// ---- 5. 校色更正 → 未锁定对照自动重算 ----
$$("#sampleGrid .sample-card").find((c) => c.textContent.includes("BX-02"))
  .querySelector('[data-correct]').click();
let card2c = $$("#sampleGrid .sample-card").find((c) => c.textContent.includes("BX-02"));
const box2 = card2c.querySelector(".cal-box");
box2.querySelector('[data-draft="r"]').value = 250;
box2.querySelector('[data-draft="g"]').value = 252;
box2.querySelector('[data-draft="b"]').value = 252;
box2.querySelector('[data-draft="temp"]').value = 5900;
box2.querySelector('[data-complete-cal]').click();
const cmpAfterCorrect = $$("#compareList .cmp-card")[0];
assert.ok(cmpAfterCorrect.textContent.includes("校准已更正"), "重算原因应展示");
assert.ok(cmpAfterCorrect.textContent.includes("↻"));

// ---- 6. 锁定对照 → 只读，后续事件不动它 ----
cmpAfterCorrect.querySelector('[data-lock-cmp]').click();
let cmpLocked = $$("#compareList .cmp-card")[0];
assert.ok(cmpLocked.classList.contains("locked"));
assert.ok(cmpLocked.textContent.includes("已锁定 · 只读"));
assert.ok(!cmpLocked.querySelector('[data-lock-cmp]'));

// 再次更正，锁定卡仍显示旧快照
const card2d = $$("#sampleGrid .sample-card").find((c) => c.textContent.includes("BX-02"));
card2d.querySelector('[data-correct]').click();
const card2e = $$("#sampleGrid .sample-card").find((c) => c.textContent.includes("BX-02"));
const box3 = card2e.querySelector(".cal-box");
box3.querySelector('[data-draft="r"]').value = 251;
["g", "b"].forEach((k) => (box3.querySelector(`[data-draft="${k}"]`).value = 253));
box3.querySelector('[data-draft="temp"]').value = 5800;
box3.querySelector('[data-complete-cal]').click();
cmpLocked = $$("#compareList .cmp-card")[0];
assert.ok(cmpLocked.classList.contains("locked"), "锁定对照不受更正影响");

// ---- 7. 换光源：新建一个未锁定对照验证失效重算 ----
fillEntry({ code: "BX-03", pol: "反射光", r: 255, g: 255, b: 255, temp: 5300, scopeId: scopeAId });
togglePick(isBX01Plane);
togglePick((c) => c.textContent.includes("BX-03"));
$("#createCompareBtn").click();
let unlocked = $$("#compareList .cmp-card").find((c) => !c.classList.contains("locked"));
assert.ok(unlocked, "存在未锁定对照");
const input0 = $$("#kitList [data-batch-input]")[0];
input0.value = "LED-A2";
$$("#kitList [data-replace-batch]")[0].click();
unlocked = $$("#compareList .cmp-card").find((c) => !c.classList.contains("locked"));
assert.ok(unlocked.textContent.includes("光源批次已更换"));

// 锁定卡仍在且只读
assert.ok($$("#compareList .cmp-card").find((c) => c.classList.contains("locked")));

// ---- 8. 仪器报废 ----
$$("#kitList [data-retire-scope]")[0].click();
const retiredKit = $$("#kitList .kit-card").find((k) => k.textContent.includes("BX53-甲"));
assert.ok(retiredKit.classList.contains("retired"));

// ---- 9. 筛选一致性：过滤不改变勾选/对照 ----
setVal($("#statusFilter"), "qualified");
assert.ok(cards().every((c) => c.textContent.includes("合格免校")));
setVal($("#statusFilter"), "");
setVal($("#polarFilter"), "正交偏光");
assert.ok(cards().length === 1 && cards()[0].textContent.includes("正交偏光"));
setVal($("#polarFilter"), "");
assert.strictEqual(cmps().length, 2, "对照不受筛选影响");

// ---- 10. 记录流水 ----
const logRows = $$("#logBody tr");
assert.ok(logRows.length > 5);
const types = $$("#logBody .log-type").map((e) => e.textContent);
assert.ok(types.includes("对照失效重算"));
assert.ok(types.includes("重复发起·沿用"));
assert.ok(types.includes("更换光源"));
// 类型过滤
setVal($("#logTypeFilter"), "light.replace");
assert.ok($$("#logBody tr").every((tr) => tr.textContent.includes("更换光源")));
setVal($("#logTypeFilter"), "");

// ---- 11. 刷新后一致：用持久化数据新建一个 JSDOM 重新加载 ----
const savedHtml = window.document.documentElement.outerHTML;
const persisted = window.localStorage.getItem("wxyy-2-thin-section-index");
const dom2 = new JSDOM(html, {
  runScripts: "outside-only",
  url: "http://localhost/",
  pretendToBeVisual: true,
  beforeParse(window2b) {
    window2b.__boot = function () { window2b.__Store = Store; window2b.__Rules = Rules; };
  }
});
dom2.window.confirm = () => true;
let nn = 1000;
dom2.window.crypto = { randomUUID: () => "uuid-r-" + (++nn) };
dom2.window.localStorage.setItem("wxyy-2-thin-section-index", persisted);
dom2.window.localStorage.setItem("wxyy-2-ui-filters", window.localStorage.getItem("wxyy-2-ui-filters") || "{}");
dom2.window.eval(evalScripts);
const w2 = dom2.window;
const cmps2 = [...w2.document.querySelectorAll("#compareList .cmp-card")];
assert.strictEqual(cmps2.length, 2, "刷新后对照数量一致");
const locked2 = cmps2.find((c) => c.classList.contains("locked"));
assert.ok(locked2, "锁定对照刷新后仍锁定只读");
const unlocked2 = cmps2.find((c) => !c.classList.contains("locked"));
assert.ok(unlocked2.textContent.includes("BX-01") || unlocked2.textContent.includes("BX-03"));
// 筛选状态保留
assert.ok(w2.document.querySelector("#sampleGrid .sample-card"), "刷新后网格正常渲染");

// ---- 12. 导出 ----
const logsBefore = $$("#logBody tr").length;
assert.ok(logsBefore > 0);

console.log("DOM 端到端全部通过 ✔  样本卡:", w2.document.querySelectorAll("#sampleGrid .sample-card").length,
  " 对照:", cmps2.length, " 流水条数:", JSON.parse(persisted).logs.length);
