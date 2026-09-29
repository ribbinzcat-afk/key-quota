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
export function buildEstimates({ snap, pricing, s, currentModel }) {
    const cur = resolveCurrency(snap, s);
    const qpu = snap?.qpu || DEFAULT_QPU;
    const { tin, tout } = avgTokens(s);
    const gr = groupRatioOf(pricing, s.group);
    const manual = parseManualPrices(s.manualPrices);
    const limits = snap?.modelLimits && snap.modelLimits.length ? new Set(snap.modelLimits) : null;

    const priceMap = new Map((pricing?.models || []).map(p => [p.model, p]));
    const names = new Set();
    for (const p of pricing?.models || []) {
        if (limits && !limits.has(p.model)) continue;
        const g = s.group || "default";
        if (p.groups && p.groups.length && !p.groups.includes(g) && !p.groups.includes("all")) continue;
        names.add(p.model);
    }
    for (const m of snap?.models || []) if (!limits || limits.has(m)) names.add(m);
    for (const m of manual.keys()) names.add(m);
    for (const m of Object.keys(s.costSamples || {})) if ((s.costSamples[m] || []).length) names.add(m);
    if (currentModel) names.add(currentModel);

    const remaining = snap?.remainingUsd;
    const rows = [];
    for (const model of names) {
        let perMsg = null, source = null, samples = 0;
        const measured = median(s.costSamples?.[model]);
        if (measured && measured > 0) { perMsg = measured; source = "วัดจริง"; samples = s.costSamples[model].length; }
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
