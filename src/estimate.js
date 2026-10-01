// แปลงยอดเงินเป็นหน่วยที่แสดง + ประมาณจำนวนข้อความต่อโมเดล (ไม่มี import จาก ST — ทดสอบแยกได้)

export const median = (arr) => {
    const a = (arr || []).filter(n => typeof n === "number" && isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const DEFAULT_QPU = 500000;

/** หน่วยที่ใช้แสดง: { mode: "money"|"quota", symbol, rate (หน่วยแสดง ต่อ $1), qpu } */
export function resolveCurrency(snap, s) {
    const st = snap?.status;
    const qpu = snap?.qpu || DEFAULT_QPU;
    const hasQuota = snap && /new-api|billing/.test(snap.kind || "");
    let choice = s.displayCurrency || "auto";
    if (choice === "auto") {
        const t = String(st?.displayType || "USD").toUpperCase();
        if (t === "CNY") return { mode: "money", symbol: "¥", rate: st.usdRate || s.cnyRate || 7.3, qpu };
        if (t === "CUSTOM" && st.customRate) return { mode: "money", symbol: st.customSymbol || "¤", rate: st.customRate, qpu };
        if (t === "TOKENS" && hasQuota) return { mode: "quota", symbol: "", rate: qpu, qpu };
        return { mode: "money", symbol: "$", rate: 1, qpu };
    }
    if (choice === "CNY") return { mode: "money", symbol: "¥", rate: st?.usdRate || s.cnyRate || 7.3, qpu };
    if (choice === "QUOTA") return { mode: "quota", symbol: "", rate: qpu, qpu };
    return { mode: "money", symbol: "$", rate: 1, qpu };
}

export function fmtMoney(usd, cur) {
    if (usd === null || usd === undefined || !isFinite(usd)) return "—";
    const v = usd * cur.rate;
    if (cur.mode === "quota") return `${Math.round(v).toLocaleString()} เครดิต`;
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
    return `${cur.symbol}${v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: abs >= 100 ? 2 : 0 })}`;
}

/** เครดิตดิบ (quota) ของ one-api/new-api — null ถ้าร้านไม่ได้ใช้ระบบ quota */
export function fmtQuota(usd, snap) {
    if (usd === null || usd === undefined || !isFinite(usd)) return "";
    if (!snap || !/new-api|billing/.test(snap.kind || "")) return "";
    return `${Math.round(usd * (snap.qpu || DEFAULT_QPU)).toLocaleString()} เครดิต`;
}

/** ขนาดข้อความเฉลี่ยที่ใช้คำนวณ */
export function avgTokens(s) {
    const mIn = median(s.measured?.in), mOut = median(s.measured?.out);
    const n = Math.min(s.measured?.in?.length || 0, s.measured?.out?.length || 0);
    if (s.useMeasuredTokens && n >= 3 && mIn && mOut) {
        return { tin: Math.round(mIn), tout: Math.round(mOut), measured: true, n };
    }
    return { tin: Number(s.avgIn) || 0, tout: Number(s.avgOut) || 0, measured: false, n };
}

/** "gpt-4o = 0.02" ต่อบรรทัด → Map(model -> ราคาในหน่วยแสดง) */
export function parseManualPrices(text) {
    const map = new Map();
    for (const line of String(text || "").split(/\r?\n/)) {
        const m = line.match(/^\s*(.+?)\s*[=:]\s*([\d.,]+)\s*$/);
        if (!m) continue;
        const v = parseFloat(m[2].replace(/,/g, ""));
        if (isFinite(v) && v > 0) map.set(m[1].trim(), v);
    }
    return map;
}

export function groupRatioOf(pricing, group) {
    const g = group || "default";
    const r = pricing?.groupRatio?.[g];
    return typeof r === "number" && r > 0 ? r : 1;
}

/** ราคาต่อข้อความ ($ ของร้าน) จากตารางราคา new-api */
export function pricingPerMessageUsd(p, tin, tout, gr, qpu) {
    if (!p) return null;
    if (p.quotaType === 1) return p.modelPrice > 0 ? p.modelPrice * gr : null;
    if (!(p.modelRatio > 0)) return null;
    return ((tin + tout * (p.completionRatio || 1)) * p.modelRatio * gr) / (qpu || DEFAULT_QPU);
}

/**
 * รายการโมเดลพร้อมราคา/ข้อความ และจำนวนข้อความที่เหลือโดยประมาณ
 * source: "วัดจริง" | "กำหนดเอง" | "ตามราคาร้าน" | null
 */
export function samplesFor(s, root, model) {
    const a = s.costSamples?.[`${root}::${model}`];
    return Array.isArray(a) && a.length ? a : [];
}

export function buildEstimates({ snap, pricing, s, currentModel }) {
    // ร้านบอกจำนวนข้อความมาเอง → ใช้ตามนั้นเลย
    if (Array.isArray(snap?.messageModels)) {
        const cur = resolveCurrency(null, s);
        const rows = snap.messageModels.map(m => ({
            model: m.model, perMsgUsd: null, source: "ร้านบอก", samples: 0,
            messages: Math.max(0, Math.floor(m.remaining)), used: m.used, total: m.total,
            current: modelMatches(m.model, currentModel),
        }));
        rows.sort((a, b) => (b.current - a.current) || a.model.localeCompare(b.model));
        return { rows, cur, tin: 0, tout: 0, gr: 1, storeCounted: true };
    }
    const root = snap?.root || "";
    const cur = resolveCurrency(snap, s);
    const qpu = snap?.qpu || DEFAULT_QPU;
    const { tin, tout } = avgTokens(s);
    const gr = groupRatioOf(pricing, s.group || snap?.group || "");
    const manual = parseManualPrices(s.manualPrices);
    const limits = snap?.modelLimits && snap.modelLimits.length ? new Set(snap.modelLimits) : null;

    const priceMap = new Map((pricing?.models || []).map(p => [p.model, p]));
    const names = new Set();
    for (const p of pricing?.models || []) {
        if (limits && !limits.has(p.model)) continue;
        const g = s.group || snap?.group || "default";
        if (p.groups && p.groups.length && !p.groups.includes(g) && !p.groups.includes("all")) continue;
        names.add(p.model);
    }
    for (const m of snap?.models || []) if (!limits || limits.has(m)) names.add(m);
    for (const m of manual.keys()) names.add(m);
    const prefix = `${root}::`;
    for (const k of Object.keys(s.costSamples || {})) {
        if (k.startsWith(prefix) && (s.costSamples[k] || []).length) names.add(k.slice(prefix.length));
    }
    if (currentModel) names.add(currentModel);

    const remaining = snap?.remainingUsd;
    const rows = [];
    for (const model of names) {
        let perMsg = null, source = null, samples = 0;
        const smp = samplesFor(s, root, model);
        const measured = median(smp);
        if (measured && measured > 0) { perMsg = measured; source = "วัดจริง"; samples = smp.length; }
        else if (manual.has(model)) {
            perMsg = cur.mode === "quota" ? manual.get(model) / qpu : manual.get(model) / cur.rate;
            source = "กำหนดเอง";
        } else {
            const v = pricingPerMessageUsd(priceMap.get(model), tin, tout, gr, qpu);
            if (v && v > 0) { perMsg = v; source = priceMap.get(model).quotaType === 1 ? "ราคาร้าน (ต่อครั้ง)" : "ราคาร้าน"; }
        }
        const messages = perMsg && remaining !== null && remaining !== undefined && isFinite(remaining)
            ? Math.max(0, Math.floor(remaining / perMsg)) : null;
        rows.push({ model, perMsgUsd: perMsg, source, samples, messages, current: model === currentModel });
    }
    rows.sort((a, b) =>
        (b.current - a.current) ||
        ((b.perMsgUsd !== null) - (a.perMsgUsd !== null)) ||
        a.model.localeCompare(b.model));
    return { rows, cur, tin, tout, gr };
}

/** ชื่อโมเดลใน ST อาจไม่มีคำนำหน้า [星一] แบบที่ร้านใช้ */
export function modelMatches(storeModel, current) {
    if (!current) return false;
    if (storeModel === current) return true;
    const strip = (x) => String(x).replace(/^\[[^\]]*\]\s*/, "").toLowerCase();
    return String(current).startsWith("[") ? false : strip(storeModel) === strip(current);
}
