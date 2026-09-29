import { getContext } from "../../../extensions.js";
import { extensionName, extensionFolderPath, getSettings, getSetting, setSetting, saveSettings, newId, getPack, setPack } from "./src/store.js";
import { listTargets, resolvePrimaryId, mainConnectionRoot, mainModel, getProfiles } from "./src/keysource.js";
import { checkQuota, fetchPricing } from "./src/quota.js";
import { renderPanel, wandText, summarize, esc } from "./src/ui.js";

const MAX_TOKEN_SAMPLES = 20;
const MAX_COST_SAMPLES = 15;
const PRICING_TTL_MS = 30 * 60 * 1000;
const TARGETS_TTL_MS = 60 * 1000;
const CONCURRENCY = 3;

const state = {
    targets: [], results: new Map(), primaryId: "", listedAt: 0, listing: null, listError: "",
    pricingCache: new Map(),          // root -> { data, at }
    busyAll: false, lastAutoAt: 0, autoTimer: null,
    gens: 0, genModel: "", pendingIn: null,
    $panel: null, search: {}, focusSearch: "",
    warned: new Set(),
};

/* ---------------- tokenizer ของ ST ---------------- */
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
const messageText = (m) => typeof m?.content === "string" ? m.content
    : Array.isArray(m?.content) ? m.content.map(p => (typeof p?.text === "string" ? p.text : "")).join("\n") : "";
function pushLimited(arr, v, max) { arr.push(v); while (arr.length > max) arr.shift(); }

/* ---------------- รายการคีย์ ---------------- */
async function refreshTargets(force = false) {
    if (!force && state.targets.length && Date.now() - state.listedAt < TARGETS_TTL_MS) return;
    if (state.listing) return state.listing;
    state.listing = (async () => {
        try {
            const targets = await listTargets();
            state.primaryId = await resolvePrimaryId(targets);
            state.targets = targets;
            state.listError = "";
            // ล้างผลของคีย์ที่ไม่อยู่ในรายการแล้ว
            const ids = new Set(targets.map(t => t.id));
            for (const id of [...state.results.keys()]) if (!ids.has(id)) state.results.delete(id);
            // ย้ายแพ็กจากเวอร์ชันเก่ามาผูกกับคีย์ที่กำลังใช้
            const s = getSettings();
            if (s.legacyPack && state.primaryId && !state.primaryId.startsWith("err:")) {
                setPack(state.primaryId, s.legacyPack); delete s.legacyPack; saveSettings();
            }
            if (state.primaryId && s.openCards[state.primaryId] === undefined) s.openCards[state.primaryId] = true;
        } catch (e) {
            console.warn(`[${extensionName}] รวบรวมคีย์ไม่สำเร็จ:`, e);
            state.listError = e?.message || String(e);
        } finally {
            state.listedAt = Date.now();
            state.listing = null;
        }
    })();
    refreshUi();
    await state.listing;
    refreshUi();
}

const primaryTarget = () => state.targets.find(t => t.id === state.primaryId) || null;

/* ---------------- เช็คยอด ---------------- */
async function getPricing(root, key) {
    if (/openrouter\.ai/i.test(root)) return null;
    const c = state.pricingCache.get(root);
    if (c && Date.now() - c.at < PRICING_TTL_MS) return c.data;
    const data = await fetchPricing(root, key);
    state.pricingCache.set(root, { data, at: Date.now() });
    return data;
}

async function checkOne(t, { silent = true } = {}) {
    if (!getSetting("enabled") || !t || t.error) return;
    const s = getSettings();
    const r = state.results.get(t.id) || {};
    if (r.busy) return;
    r.busy = true; state.results.set(t.id, r); refreshUi();
    const prev = r.snap;
    try {
        const snap = await checkQuota(t.root, t.key, { qpuOverride: Number(s.quotaPerUnit) || 0 });
        r.pricing = await getPricing(t.root, t.key);

        // วัดราคาจริง: คีย์ที่กำลังใช้, AI ตอบ 1 ครั้งพอดีระหว่างการเช็ค 2 ครั้ง
        if (t.id === state.primaryId) {
            if (prev && state.gens === 1 && state.genModel
                && typeof prev.usedUsd === "number" && typeof snap.usedUsd === "number") {
                const delta = snap.usedUsd - prev.usedUsd;
                if (delta > 0) {
                    const k = `${t.root}::${state.genModel}`;
                    pushLimited(s.costSamples[k] || (s.costSamples[k] = []), delta, MAX_COST_SAMPLES);
                    saveSettings();
                }
            }
            state.gens = 0; state.genModel = "";
        }
        r.snap = snap; r.error = "";
        populateGroups(r.pricing);
    } catch (e) {
        console.warn(`[${extensionName}] เช็ค ${t.labels.join("/")} ไม่สำเร็จ:`, e);
        r.error = e?.message || String(e);
        if (!silent) toastr.error(`${t.labels.join(" · ")}: ${r.error}`, "Key Quota");
    } finally {
        r.busy = false;
        refreshUi();
    }
}

async function checkAll({ silent = false } = {}) {
    if (!getSetting("enabled") || state.busyAll) return;
    state.busyAll = true; refreshUi();
    try {
        await refreshTargets(true);
        const queue = state.targets.filter(t => !t.error);
        const worker = async () => { while (queue.length) await checkOne(queue.shift(), { silent: true }); };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
        const failed = state.targets.filter(t => t.error || state.results.get(t.id)?.error).length;
        if (!silent && failed) toastr.warning(`เช็คไม่ได้ ${failed} คีย์ (ดูรายละเอียดในแผง)`, "Key Quota");
        evaluateWarnings();
    } finally {
        state.busyAll = false;
        refreshUi();
    }
}

async function checkPrimary() {
    await refreshTargets();
    const t = primaryTarget();
    if (!t) return;
    await checkOne(t, { silent: true });
    state.lastAutoAt = Date.now();
    evaluateWarnings();
}

function scheduleAutoCheck(delayMs = 2500) {
    if (!getSetting("enabled") || !getSetting("autoCheck")) return;
    clearTimeout(state.autoTimer);
    const minGap = Math.max(5, Number(getSetting("minIntervalSec")) || 15) * 1000;
    const wait = Math.max(delayMs, state.lastAutoAt + minGap - Date.now());
    state.autoTimer = setTimeout(checkPrimary, wait);
}

/* ---------------- เตือน ---------------- */
function evaluateWarnings() {
    const s = getSettings();
    if (!s.enabled || !s.warnEnabled) return;
    const hits = new Map();
    for (const t of state.targets) {
        if (t.error) continue;
        const r = state.results.get(t.id);
        const pack = getPack(t.id);
        if (!r?.snap && !pack.enabled) continue;
        const sm = summarize(t, r, s, getPack);
        const name = t.labels.join(" · ");
        if (typeof sm.snap?.remainingUsd === "number" && sm.snap.remainingUsd * sm.est.cur.rate <= (Number(s.warnCredits) || 0)) {
            hits.set(`${t.id}:c`, `${name}: ยอดเหลือ ${sm.money}`);
        }
        if (sm.row && sm.row.messages !== null && sm.row.messages <= (Number(s.warnMessages) || 0)) {
            hits.set(`${t.id}:m`, `${name}: ${sm.row.model} ใช้ได้อีกประมาณ ${sm.row.messages} ข้อความ`);
        }
        if (sm.packLeft !== null && sm.pack.total > 0 && sm.packLeft <= (Number(s.warnMessages) || 0)) {
            hits.set(`${t.id}:p`, `${name}: แพ็กเหลือ ${sm.packLeft} ข้อความ`);
        }
    }
    for (const [k, msg] of hits) if (!state.warned.has(k)) toastr.warning(msg, "Key Quota ใกล้หมด", { timeOut: 8000 });
    state.warned = new Set(hits.keys());
}

/* ---------------- UI ---------------- */
function refreshUi() {
    const s = getSettings();
    // ข้อความใต้ปุ่มในไม้คทา
    const $sub = $("#kq-menu-button .kq-wand-sub");
    if (s.enabled && s.showInWand) {
        const t = primaryTarget();
        const w = wandText(t, t ? state.results.get(t.id) : null, s, getPack, state.targets.filter(x => !x.error).length);
        $sub.text(w.text).toggle(!!w.text);
        $("#kq-menu-button").toggleClass("kq-wand-warn", !!w.warn).attr("title", w.title || "เช็คโควตาคีย์");
    } else {
        $sub.text("").hide();
        $("#kq-menu-button").removeClass("kq-wand-warn");
    }
    if (state.$panel) {
        renderPanel(state.$panel, {
            targets: state.targets, results: state.results, primaryId: state.primaryId,
            busyAll: state.busyAll, listing: !!state.listing, listError: state.listError,
            search: state.search, focusSearch: state.focusSearch,
        }, s, getPack);
        state.focusSearch = "";
    }
    const ok = [...state.results.values()].filter(r => r.snap).length;
    $("#kq-settings-status").text(state.targets.length ? `${state.targets.length} คีย์ · เช็คแล้ว ${ok}` : "");
}

async function openPanel() {
    if (!getSetting("enabled")) return;
    const ctx = getContext();
    const $el = $(`<div class="kq-panel"></div>`);
    state.$panel = $el;

    $el.on("click", "[data-kq]", function (ev) {
        const act = $(this).data("kq");
        const id = String($(this).data("id") || "");
        const s = getSettings();
        if (act === "check-all") return checkAll();
        if (act === "check-one") { ev.stopPropagation(); return checkOne(state.targets.find(t => t.id === id), { silent: false }); }
        if (act === "toggle") {
            if ($(ev.target).closest("input, .menu_button, label").length) return;
            s.openCards[id] = !s.openCards[id]; saveSettings(); return refreshUi();
        }
        if (act === "pack-plus") { setPack(id, { used: (getPack(id).used || 0) + 1 }); }
        if (act === "pack-minus") { setPack(id, { used: Math.max(0, (getPack(id).used || 0) - 1) }); }
        if (act === "pack-plus" || act === "pack-minus") { state.warned.delete(`${id}:p`); evaluateWarnings(); refreshUi(); }
    });
    $el.on("change", "[data-kq]", function () {
        const act = $(this).data("kq");
        const id = String($(this).data("id") || "");
        const n = Math.max(0, Math.round(parseFloat(this.value) || 0));
        if (act === "pack-on") setPack(id, { enabled: this.checked });
        else if (act === "pack-total") setPack(id, { total: n });
        else if (act === "pack-used") setPack(id, { used: n });
        else return;
        state.warned.delete(`${id}:p`); evaluateWarnings(); refreshUi();
    });
    $el.on("input", ".kq-search", function () {
        const id = String($(this).data("id") || "");
        state.search[id] = String($(this).val() || ""); state.focusSearch = id; refreshUi();
    });

    refreshUi();
    const stale = !state.results.size || [...state.results.values()].every(r => !r.snap || Date.now() - r.snap.checkedAt > 30000);
    if (stale) checkAll({ silent: true });
    else refreshTargets();
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
            <div class="kq-wand-label">
                <span>เช็คโควตาคีย์</span>
                <small class="kq-wand-sub"></small>
            </div>
        </div>`);
    btn.on("click", openPanel);
    $("#extensionsMenu").append(btn);
}

function applyEnabled() {
    const on = !!getSetting("enabled");
    $("#kq-menu-button").toggle(on);
    if (!on) {
        clearTimeout(state.autoTimer);
        if (state.$panel) state.$panel.closest("dialog").find(".popup-button-ok").trigger("click");
    }
    refreshUi();
}

/* ---------------- Settings drawer ---------------- */
function populateGroups(pricing) {
    const $g = $("#kq-group");
    const have = new Set($g.find("option").map((_, o) => o.value).get());
    for (const [g, ratio] of Object.entries(pricing?.groupRatio || {})) {
        if (g === "default" || have.has(g)) continue;
        $g.append(`<option value="${esc(g)}">${esc(g)} (×${esc(ratio)})</option>`);
    }
    $g.val(getSetting("group") || "");
}

function renderProfileList() {
    const s = getSettings();
    const profiles = getProfiles().filter(p => p?.id);
    const html = profiles.length ? profiles.map(p => {
        const url = p.api === "custom" ? p["api-url"] : (p.proxy && p.proxy !== "None" ? `proxy: ${p.proxy}` : p.api);
        return `<label class="checkbox_label kq-prof">
            <input type="checkbox" data-prof="${esc(p.id)}" ${s.excludedProfiles.includes(p.id) ? "" : "checked"} />
            <span>${esc(p.name || p.id)} <small class="kq-dim">${esc(url || "")}</small></span></label>`;
    }).join("") : `<small>ยังไม่มี Connection Profile</small>`;
    $("#kq-profile-list").html(html).toggle(!!s.includeProfiles);
}

function renderManualList() {
    const s = getSettings();
    const html = s.manualKeys.map(k => `
        <div class="kq-mk" data-mk="${esc(k.id)}">
            <input class="text_pole kq-mk-label" type="text" placeholder="ชื่อเรียก" value="${esc(k.label || "")}" />
            <input class="text_pole kq-mk-url" type="text" placeholder="https://.../v1" value="${esc(k.url || "")}" />
            <div class="kq-inline">
                <input class="text_pole kq-mk-key" type="password" placeholder="sk-..." autocomplete="off" value="${esc(k.key || "")}" />
                <div class="menu_button fa-solid fa-eye kq-mk-show" title="แสดง/ซ่อนคีย์"></div>
                <div class="menu_button fa-solid fa-trash-can kq-mk-del" title="ลบคีย์นี้"></div>
            </div>
        </div>`).join("");
    $("#kq-manual-list").html(html || `<small>ยังไม่มีคีย์ที่กรอกเอง</small>`);
}

function syncSettingsUi() {
    const s = getSettings();
    $("#kq-enabled").prop("checked", !!s.enabled);
    $("#kq-inc-main").prop("checked", !!s.includeMain);
    $("#kq-inc-profiles").prop("checked", !!s.includeProfiles);
    renderProfileList();
    renderManualList();
    $("#kq-auto").prop("checked", !!s.autoCheck);
    $("#kq-interval").val(s.minIntervalSec);
    $("#kq-wand-on").prop("checked", !!s.showInWand);
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
    $("#kq-group").val(s.group || "");
    const n = Object.values(s.costSamples || {}).reduce((a, b) => a + (b?.length || 0), 0);
    $("#kq-samples-info").text(`เก็บไว้: ขนาดข้อความ ${s.measured.in.length} ครั้ง · ราคาจริง ${n} ครั้ง`);
}

function targetsChanged() { state.listedAt = 0; refreshUi(); }

function bindSettingsHandlers() {
    const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
    const on = (sel, ev, fn) => $(document).on(ev, sel, fn);

    on("#kq-enabled", "change", function () { setSetting("enabled", this.checked); applyEnabled(); });
    on("#kq-inc-main", "change", function () { setSetting("includeMain", this.checked); targetsChanged(); });
    on("#kq-inc-profiles", "change", function () { setSetting("includeProfiles", this.checked); renderProfileList(); targetsChanged(); });
    on("#kq-profile-list input[data-prof]", "change", function () {
        const s = getSettings(); const id = $(this).data("prof");
        s.excludedProfiles = s.excludedProfiles.filter(x => x !== id);
        if (!this.checked) s.excludedProfiles.push(id);
        saveSettings(); targetsChanged();
    });
    on("#kq-refresh-profiles", "click", renderProfileList);

    on("#kq-add-key", "click", () => {
        getSettings().manualKeys.push({ id: newId(), label: "", url: "", key: "" });
        saveSettings(); renderManualList();
    });
    on("#kq-manual-list .kq-mk input", "change", function () {
        const id = $(this).closest(".kq-mk").data("mk");
        const k = getSettings().manualKeys.find(x => x.id === id);
        if (!k) return;
        if ($(this).hasClass("kq-mk-label")) k.label = this.value.trim();
        if ($(this).hasClass("kq-mk-url")) k.url = this.value.trim();
        if ($(this).hasClass("kq-mk-key")) k.key = this.value.trim();
        saveSettings(); targetsChanged();
    });
    on("#kq-manual-list .kq-mk-show", "click", function () {
        const $k = $(this).closest(".kq-mk").find(".kq-mk-key");
        $k.attr("type", $k.attr("type") === "password" ? "text" : "password");
    });
    on("#kq-manual-list .kq-mk-del", "click", function () {
        const id = $(this).closest(".kq-mk").data("mk");
        const s = getSettings();
        s.manualKeys = s.manualKeys.filter(x => x.id !== id);
        saveSettings(); renderManualList(); targetsChanged();
    });

    on("#kq-auto", "change", function () { setSetting("autoCheck", this.checked); });
    on("#kq-interval", "change", function () { setSetting("minIntervalSec", Math.max(5, num(this.value, 15))); });
    on("#kq-wand-on", "change", function () { setSetting("showInWand", this.checked); refreshUi(); });
    on("#kq-warn", "change", function () { setSetting("warnEnabled", this.checked); state.warned.clear(); });
    on("#kq-warn-credits", "change", function () { setSetting("warnCredits", num(this.value, 0)); state.warned.clear(); refreshUi(); });
    on("#kq-warn-msgs", "change", function () { setSetting("warnMessages", Math.max(0, Math.round(num(this.value, 0)))); state.warned.clear(); refreshUi(); });
    on("#kq-currency", "change", function () { setSetting("displayCurrency", this.value); refreshUi(); });
    on("#kq-cny", "change", function () { setSetting("cnyRate", num(this.value, 7.3)); refreshUi(); });
    on("#kq-qpu", "change", function () { setSetting("quotaPerUnit", Math.max(0, num(this.value, 0))); state.results.clear(); refreshUi(); });
    on("#kq-group", "change", function () { setSetting("group", this.value); refreshUi(); });
    on("#kq-measured", "change", function () { setSetting("useMeasuredTokens", this.checked); refreshUi(); });
    on("#kq-avg-in", "change", function () { setSetting("avgIn", Math.max(0, Math.round(num(this.value, 6000)))); refreshUi(); });
    on("#kq-avg-out", "change", function () { setSetting("avgOut", Math.max(0, Math.round(num(this.value, 500)))); refreshUi(); });
    on("#kq-prices", "change", function () { setSetting("manualPrices", this.value); refreshUi(); });
    on("#kq-open-panel", "click", openPanel);
    on("#kq-check-all", "click", () => checkAll());
    on("#kq-clear-samples", "click", () => {
        const s = getSettings();
        s.measured = { in: [], out: [] }; s.costSamples = {};
        saveSettings(); syncSettingsUi(); refreshUi();
        toastr.info("ล้างค่าที่วัดไว้แล้ว", "Key Quota");
    });
}

/* ---------------- Events ---------------- */
function usingPrimary() {
    const t = primaryTarget();
    const main = mainConnectionRoot();
    return !!(t && main && main === t.root);
}

function bindChatEvents(ctx) {
    const E = ctx.eventTypes;

    ctx.eventSource.on(E.CHAT_COMPLETION_PROMPT_READY, async (data) => {
        if (!getSetting("enabled") || !data || data.dryRun || !Array.isArray(data.chat)) return;
        try { state.pendingIn = await countTokens(getContext(), data.chat.map(messageText).join("\n")); }
        catch (e) { console.warn(`[${extensionName}] นับโทเคนขาเข้าไม่ได้:`, e); }
    });

    ctx.eventSource.on(E.GENERATION_STARTED, async (_type, _params, dryRun) => {
        if (!getSetting("enabled") || dryRun) return;
        if (!state.primaryId) await refreshTargets();
        if (!usingPrimary()) return;
        state.gens += 1;
        state.genModel = mainModel();
    });

    ctx.eventSource.on(E.MESSAGE_RECEIVED, async (id, type) => {
        if (!getSetting("enabled") || type === "first_message") return;
        const s = getSettings();
        const c = getContext();
        if (state.pendingIn !== null && type !== "continue") {
            const out = await countTokens(c, c.chat?.[id]?.mes || "");
            if (out > 0) {
                pushLimited(s.measured.in, state.pendingIn, MAX_TOKEN_SAMPLES);
                pushLimited(s.measured.out, out, MAX_TOKEN_SAMPLES);
            }
        }
        state.pendingIn = null;
        if (state.primaryId && usingPrimary()) {
            const p = getPack(state.primaryId);
            if (p.enabled) setPack(state.primaryId, { used: (p.used || 0) + 1 });
        }
        saveSettings();
        evaluateWarnings();
        refreshUi();
    });

    ctx.eventSource.on(E.GENERATION_ENDED, () => {
        if (getSetting("enabled") && state.gens > 0) scheduleAutoCheck();
    });

    // เปลี่ยน API/โปรไฟล์ → หาคีย์ที่กำลังใช้ใหม่
    const reset = () => { state.gens = 0; state.listedAt = 0; state.primaryId = ""; refreshTargets(true); };
    if (E.CONNECTION_PROFILE_LOADED) ctx.eventSource.on(E.CONNECTION_PROFILE_LOADED, reset);
    if (E.CHATCOMPLETION_SOURCE_CHANGED) ctx.eventSource.on(E.CHATCOMPLETION_SOURCE_CHANGED, reset);
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
        const ctx = getContext();
        bindChatEvents(ctx);
        applyEnabled();
        // เช็คคีย์ที่กำลังใช้ครั้งแรกหลังโหลดหน้า
        if (getSetting("enabled") && getSetting("autoCheck")) setTimeout(checkPrimary, 4000);
        console.log(`[${extensionName}] ✅ โหลดสำเร็จ`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ โหลดไม่สำเร็จ:`, error);
        toastr.error("โหลดไม่สำเร็จ (ดู console)", "Key Quota");
    }
});

