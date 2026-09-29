import { getContext } from "../../../extensions.js";
import { extensionName, extensionFolderPath, getSettings, getSetting, setSetting, saveSettings } from "./src/store.js";
import { resolveTarget, maskKey, mainConnectionRoot, normalizeRoot, getProfiles } from "./src/keysource.js";
import { checkQuota, fetchPricing } from "./src/quota.js";
import { buildEstimates, resolveCurrency } from "./src/estimate.js";
import { renderPanel, badgeText, esc } from "./src/ui.js";

const MAX_TOKEN_SAMPLES = 20;
const MAX_COST_SAMPLES = 15;
const PRICING_TTL_MS = 30 * 60 * 1000;

const state = {
    snap: null, pricing: null, pricingRoot: "", pricingAt: 0,
    error: "", busy: false, target: null, trackedRoot: "",
    lastCheckAt: 0, gens: 0, genModel: "", pendingIn: null,
    autoTimer: null, $panel: null, search: "", focusSearch: false,
    warned: new Set(),
};

/* ---------------- นับโทเคนด้วย tokenizer ของ ST ---------------- */
async function countTokens(ctx, text) {
    text = String(text || "");
    if (!text) return 0;
    try {
        if (typeof ctx.getTokenCountAsync === "function") {
            const n = await ctx.getTokenCountAsync(text);
            if (typeof n === "number" && n >= 0) return n;
        } else if (typeof ctx.getTokenCount === "function") {
            const n = ctx.getTokenCount(text);
            if (typeof n === "number" && n >= 0) return n;
        }
    } catch (e) { console.warn(`[${extensionName}] countTokens ล้มเหลว:`, e); }
    return Math.ceil(text.length / 4);
}

function messageText(m) {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map(p => (typeof p?.text === "string" ? p.text : "")).join("\n");
    return "";
}

function pushLimited(arr, v, max) { arr.push(v); while (arr.length > max) arr.shift(); }

/* ---------------- เช็คยอด ---------------- */
async function checkNow({ silent = false } = {}) {
    if (!getSetting("enabled") || state.busy) return;
    const s = getSettings();
    state.busy = true; refreshUi();
    const prev = state.snap;
    try {
        const t = await resolveTarget();
        state.target = { ...t, masked: maskKey(t.key), host: safeHost(t.root) };
        if (state.trackedRoot && state.trackedRoot !== t.root) { state.gens = 0; state.snap = null; }
        state.trackedRoot = t.root;

        const snap = await checkQuota(t.root, t.key, { qpuOverride: Number(s.quotaPerUnit) || 0 });

        // ตารางราคา (new-api) — ดึงใหม่ทุก 30 นาทีหรือเมื่อเปลี่ยนร้าน
        if (state.pricingRoot !== t.root || Date.now() - state.pricingAt > PRICING_TTL_MS) {
            state.pricing = /openrouter\.ai/i.test(t.root) ? null : await fetchPricing(t.root, t.key);
            state.pricingRoot = t.root; state.pricingAt = Date.now();
            populateGroups();
        }

        // วัดราคาจริงต่อข้อความ: ยอดที่ใช้เพิ่มขึ้นระหว่าง 2 ครั้งที่เช็ค โดยมี AI ตอบแค่ 1 ครั้ง
        if (prev && prev.root === snap.root && state.gens === 1 && state.genModel
            && typeof prev.usedUsd === "number" && typeof snap.usedUsd === "number") {
            const delta = snap.usedUsd - prev.usedUsd;
            if (delta > 0) {
                const arr = s.costSamples[state.genModel] || (s.costSamples[state.genModel] = []);
                pushLimited(arr, delta, MAX_COST_SAMPLES);
            }
        }
        state.gens = 0; state.genModel = "";
        state.snap = snap; state.error = "";
        s.last = { kind: snap.kind, remainingUsd: snap.remainingUsd, checkedAt: snap.checkedAt, root: snap.root };
        saveSettings();
        evaluateWarnings();
    } catch (e) {
        console.warn(`[${extensionName}] เช็คยอดไม่สำเร็จ:`, e);
        state.error = e?.message || String(e);
        if (!silent) toastr.error(state.error, "Key Quota");
    } finally {
        state.busy = false; state.lastCheckAt = Date.now();
        refreshUi();
    }
}

function safeHost(u) { try { return new URL(u).host; } catch { return u; } }

function scheduleAutoCheck(delayMs = 2500) {
    if (!getSetting("enabled") || !getSetting("autoCheck")) return;
    clearTimeout(state.autoTimer);
    const minGap = Math.max(5, Number(getSetting("minIntervalSec")) || 15) * 1000;
    const wait = Math.max(delayMs, state.lastCheckAt + minGap - Date.now());
    state.autoTimer = setTimeout(() => checkNow({ silent: true }), wait);
}

/* ---------------- เตือน ---------------- */
function evaluateWarnings() {
    const s = getSettings();
    if (!s.enabled || !s.warnEnabled) return;
    const hits = [];
    const snap = state.snap;
    if (snap && typeof snap.remainingUsd === "number") {
        const est = buildEstimates({ snap, pricing: state.pricing, s, currentModel: state.target?.model || "" });
        const cur = resolveCurrency(snap, s);
        if (snap.remainingUsd * cur.rate <= (Number(s.warnCredits) || 0)) hits.push(["credits", "ยอดเครดิตใกล้หมดแล้ว"]);
        const row = est.rows.find(r => r.current);
        if (row && row.messages !== null && row.messages <= (Number(s.warnMessages) || 0)) {
            hits.push(["msgs", `${row.model} ใช้ได้อีกประมาณ ${row.messages} ข้อความ`]);
        }
    }
    if (s.pack?.enabled) {
        const left = Math.max(0, (s.pack.total || 0) - (s.pack.used || 0));
        if (left <= (Number(s.warnMessages) || 0)) hits.push(["pack", `แพ็กข้อความเหลือ ${left} ข้อความ`]);
    }
    const now = new Set(hits.map(h => h[0]));
    for (const [k, msg] of hits) if (!state.warned.has(k)) toastr.warning(msg, "Key Quota", { timeOut: 8000 });
    state.warned = now;   // เตือนซ้ำเมื่อกลับขึ้นไปแล้วลงมาใหม่เท่านั้น
}

/* ---------------- UI ---------------- */
function refreshUi() {
    const s = getSettings();
    // badge
    const $b = $("#kq-badge");
    if (s.enabled && s.showBadge) {
        const b = badgeText(state, s);
        $b.show().toggleClass("kq-badge-warn", !!b.warn).attr("title", b.title)
            .find(".kq-badge-text").text(state.busy && !state.snap ? "…" : b.text);
    } else $b.hide();
    // panel
    if (state.$panel) { renderPanel(state.$panel, state, s); state.focusSearch = false; }
    // settings status
    $("#kq-settings-status").text(state.error ? `⚠ ${state.error}` : (state.snap ? `เช็คล่าสุด ${new Date(state.snap.checkedAt).toLocaleTimeString()}` : ""));
}

async function openPanel() {
    if (!getSetting("enabled")) return;
    const ctx = getContext();
    const $el = $(`<div class="kq-panel"></div>`);
    state.$panel = $el;
    $el.on("click", "[data-kq]", async function () {
        const act = $(this).data("kq");
        const s = getSettings();
        if (act === "check") return checkNow();
        if (act === "pack-plus") s.pack.used = (s.pack.used || 0) + 1;
        if (act === "pack-minus") s.pack.used = Math.max(0, (s.pack.used || 0) - 1);
        if (act === "pack-reset") s.pack.used = 0;
        saveSettings(); syncSettingsUi(); refreshUi();
    });
    $el.on("input", ".kq-search", function () {
        state.search = String($(this).val() || ""); state.focusSearch = true; refreshUi();
    });
    refreshUi();
    if (!state.snap || Date.now() - state.lastCheckAt > 30000) checkNow();
    try {
        await ctx.callGenericPopup($el, ctx.POPUP_TYPE.TEXT, "", { wide: true, allowVerticalScrolling: true, okButton: "ปิด" });
    } finally {
        state.$panel = null;
    }
}

function mountWandButton() {
    if ($("#kq-menu-button").length) return;
    const btn = $(`
        <div id="kq-menu-button" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-coins extensionsMenuExtensionButton"></div>
            <span>เช็คโควตาคีย์</span>
        </div>`);
    btn.on("click", openPanel);
    $("#extensionsMenu").append(btn);
}

function mountBadge() {
    if ($("#kq-badge").length) return;
    const $b = $(`<div id="kq-badge" class="kq-badge interactable" tabindex="0" title="Key Quota"><i class="fa-solid fa-coins"></i><span class="kq-badge-text">—</span></div>`);
    $b.on("click", openPanel);
    $("#leftSendForm").append($b);
}

function applyEnabled() {
    const on = !!getSetting("enabled");
    $("#kq-menu-button").toggle(on);
    if (!on) {
        clearTimeout(state.autoTimer);
        $("#kq-badge").hide();
        if (state.$panel) state.$panel.closest("dialog").find(".popup-button-ok").trigger("click");
    }
    refreshUi();
}

/* ---------------- Settings drawer ---------------- */
function populateApiProfiles() {
    let html = `<option value="">การเชื่อมต่อหลักของ ST ตอนนี้</option>`;
    for (const p of getProfiles()) {
        if (!p?.id) continue;
        html += `<option value="${esc(p.id)}">${esc(p.name || p.id)}${p["api-url"] ? ` — ${esc(p["api-url"])}` : ""}</option>`;
    }
    $("#kq-api-profile").html(html).val(getSetting("apiProfile") || "");
}

function populateGroups() {
    const groups = Object.keys(state.pricing?.groupRatio || {});
    const $g = $("#kq-group");
    $g.html(`<option value="">default</option>` + groups.filter(g => g !== "default")
        .map(g => `<option value="${esc(g)}">${esc(g)} (×${esc(state.pricing.groupRatio[g])})</option>`).join(""));
    $g.val(getSetting("group") || "");
}

function syncSettingsUi() {
    const s = getSettings();
    $("#kq-enabled").prop("checked", !!s.enabled);
    $("#kq-key-source").val(s.keySource);
    $(".kq-src-profile").toggle(s.keySource === "profile");
    $(".kq-src-manual").toggle(s.keySource === "manual");
    populateApiProfiles();
    $("#kq-manual-url").val(s.manualUrl);
    $("#kq-manual-key").val(s.manualKey);
    $("#kq-auto").prop("checked", !!s.autoCheck);
    $("#kq-interval").val(s.minIntervalSec);
    $("#kq-badge-on").prop("checked", !!s.showBadge);
    $("#kq-warn").prop("checked", !!s.warnEnabled);
    $("#kq-warn-credits").val(s.warnCredits);
    $("#kq-warn-msgs").val(s.warnMessages);
    $("#kq-currency").val(s.displayCurrency);
    $("#kq-cny").val(s.cnyRate);
    $("#kq-qpu").val(s.quotaPerUnit || "");
    $("#kq-measured").prop("checked", !!s.useMeasuredTokens);
    $("#kq-avg-in").val(s.avgIn);
    $("#kq-avg-out").val(s.avgOut);
    $("#kq-prices").val(s.manualPrices);
    $("#kq-pack-on").prop("checked", !!s.pack.enabled);
    $("#kq-pack-total").val(s.pack.total);
    $("#kq-pack-used").val(s.pack.used);
    $(".kq-pack-fields").toggle(!!s.pack.enabled);
    populateGroups();
    const n = Object.values(s.costSamples || {}).reduce((a, b) => a + (b?.length || 0), 0);
    $("#kq-samples-info").text(`เก็บไว้: ขนาดข้อความ ${s.measured.in.length} ครั้ง · ราคาจริง ${n} ครั้ง`);
}

function bindSettingsHandlers() {
    const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
    const on = (sel, ev, fn) => $(document).on(ev, sel, fn);
    const after = () => { syncSettingsUi(); refreshUi(); };

    on("#kq-enabled", "change", function () { setSetting("enabled", this.checked); applyEnabled(); });
    on("#kq-key-source", "change", function () { setSetting("keySource", this.value); state.snap = null; after(); });
    on("#kq-api-profile", "change", function () { setSetting("apiProfile", this.value); state.snap = null; after(); });
    on("#kq-api-profile", "focus", populateApiProfiles);
    on("#kq-manual-url", "change", function () { setSetting("manualUrl", this.value.trim()); state.snap = null; after(); });
    on("#kq-manual-key", "change", function () { setSetting("manualKey", this.value.trim()); state.snap = null; after(); });
    on("#kq-auto", "change", function () { setSetting("autoCheck", this.checked); });
    on("#kq-interval", "change", function () { setSetting("minIntervalSec", Math.max(5, num(this.value, 15))); });
    on("#kq-badge-on", "change", function () { setSetting("showBadge", this.checked); refreshUi(); });
    on("#kq-warn", "change", function () { setSetting("warnEnabled", this.checked); state.warned.clear(); });
    on("#kq-warn-credits", "change", function () { setSetting("warnCredits", num(this.value, 0)); state.warned.clear(); refreshUi(); });
    on("#kq-warn-msgs", "change", function () { setSetting("warnMessages", Math.max(0, Math.round(num(this.value, 0)))); state.warned.clear(); refreshUi(); });
    on("#kq-currency", "change", function () { setSetting("displayCurrency", this.value); refreshUi(); });
    on("#kq-cny", "change", function () { setSetting("cnyRate", num(this.value, 7.3)); refreshUi(); });
    on("#kq-qpu", "change", function () { setSetting("quotaPerUnit", Math.max(0, num(this.value, 0))); state.snap = null; checkNow(); });
    on("#kq-group", "change", function () { setSetting("group", this.value); refreshUi(); });
    on("#kq-measured", "change", function () { setSetting("useMeasuredTokens", this.checked); refreshUi(); });
    on("#kq-avg-in", "change", function () { setSetting("avgIn", Math.max(0, Math.round(num(this.value, 6000)))); refreshUi(); });
    on("#kq-avg-out", "change", function () { setSetting("avgOut", Math.max(0, Math.round(num(this.value, 500)))); refreshUi(); });
    on("#kq-prices", "change", function () { setSetting("manualPrices", this.value); refreshUi(); });
    on("#kq-pack-on", "change", function () { getSettings().pack.enabled = this.checked; saveSettings(); after(); });
    on("#kq-pack-total", "change", function () { getSettings().pack.total = Math.max(0, Math.round(num(this.value, 0))); saveSettings(); state.warned.clear(); after(); });
    on("#kq-pack-used", "change", function () { getSettings().pack.used = Math.max(0, Math.round(num(this.value, 0))); saveSettings(); state.warned.clear(); after(); });
    on("#kq-open-panel", "click", openPanel);
    on("#kq-check-now", "click", () => checkNow());
    on("#kq-clear-samples", "click", () => {
        const s = getSettings();
        s.measured = { in: [], out: [] }; s.costSamples = {};
        saveSettings(); after();
        toastr.info("ล้างค่าที่วัดไว้แล้ว", "Key Quota");
    });
    on("#kq-toggle-key", "click", () => {
        const $k = $("#kq-manual-key");
        $k.attr("type", $k.attr("type") === "password" ? "text" : "password");
    });
}

/* ---------------- Events ---------------- */
function isTrackedConnection() {
    if (!state.trackedRoot) return true;           // ยังไม่เคยเช็ค → ถือว่าใช่ไปก่อน
    const main = mainConnectionRoot();
    if (!main) return false;
    return normalizeRoot(main) === state.trackedRoot;
}

function bindChatEvents(ctx) {
    const E = ctx.eventTypes;

    // วัดขนาด prompt ขาเข้า (ใช้ tokenizer ของ ST)
    ctx.eventSource.on(E.CHAT_COMPLETION_PROMPT_READY, async (data) => {
        if (!getSetting("enabled") || !data || data.dryRun || !Array.isArray(data.chat)) return;
        try {
            const text = data.chat.map(messageText).join("\n");
            state.pendingIn = await countTokens(getContext(), text);
        } catch (e) { console.warn(`[${extensionName}] นับโทเคนขาเข้าไม่ได้:`, e); }
    });

    // นับจำนวนครั้งที่ยิง API ระหว่างการเช็ค (รวม quiet generation ของ extension อื่น)
    ctx.eventSource.on(E.GENERATION_STARTED, (_type, _params, dryRun) => {
        if (!getSetting("enabled") || dryRun) return;
        if (!isTrackedConnection()) return;
        state.gens += 1;
        try { state.genModel = getContext().getChatCompletionModel?.() || ""; } catch { state.genModel = ""; }
    });

    ctx.eventSource.on(E.MESSAGE_RECEIVED, async (id, type) => {
        if (!getSetting("enabled") || type === "first_message") return;
        const s = getSettings();
        const c = getContext();
        // วัดขนาดคำตอบ
        if (state.pendingIn !== null && type !== "continue") {
            const out = await countTokens(c, c.chat?.[id]?.mes || "");
            if (out > 0) {
                pushLimited(s.measured.in, state.pendingIn, MAX_TOKEN_SAMPLES);
                pushLimited(s.measured.out, out, MAX_TOKEN_SAMPLES);
            }
        }
        state.pendingIn = null;
        // แพ็กรายข้อความ
        if (s.pack.enabled && isTrackedConnection()) s.pack.used = (s.pack.used || 0) + 1;
        saveSettings();
        evaluateWarnings();
        refreshUi();
    });

    ctx.eventSource.on(E.GENERATION_ENDED, () => {
        if (!getSetting("enabled")) return;
        if (state.gens > 0) scheduleAutoCheck();
    });

    // เปลี่ยน API/โปรไฟล์ → ล้างผลเก่า
    const reset = () => { state.snap = null; state.trackedRoot = ""; state.gens = 0; state.target = null; refreshUi(); };
    if (E.CONNECTION_PROFILE_LOADED) ctx.eventSource.on(E.CONNECTION_PROFILE_LOADED, () => { if (!getSetting("apiProfile")) reset(); });
    if (E.CHATCOMPLETION_SOURCE_CHANGED) ctx.eventSource.on(E.CHATCOMPLETION_SOURCE_CHANGED, () => { if (!getSetting("apiProfile")) reset(); });
}

/* ---------------- Bootstrap ---------------- */
jQuery(async () => {
    console.log(`[${extensionName}] กำลังโหลด...`);
    try {
        getSettings();
        $("#extensions_settings2").append(await $.get(`${extensionFolderPath}/settings.html`));
        bindSettingsHandlers();
        syncSettingsUi();
        mountWandButton();
        mountBadge();
        const ctx = getContext();
        bindChatEvents(ctx);
        applyEnabled();
        // เช็คครั้งแรกหลังโหลดหน้า (รอให้ ST ตั้งค่า API เสร็จก่อน)
        if (getSetting("enabled") && getSetting("autoCheck")) setTimeout(() => checkNow({ silent: true }), 4000);
        console.log(`[${extensionName}] ✅ โหลดสำเร็จ`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ โหลดไม่สำเร็จ:`, error);
        toastr.error("โหลดไม่สำเร็จ (ดู console)", "Key Quota");
    }
});
