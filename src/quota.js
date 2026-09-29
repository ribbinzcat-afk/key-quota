// ยิงไปถามยอดคงเหลือ / ตารางราคา / หน่วยเงินของร้าน
// ไม่มีการเรียก chat completion เลย จึงไม่เสียโทเคน
import { getContext } from "../../../../extensions.js";

const DEFAULT_QPU = 500000;          // new-api/one-api: 500,000 quota = $1
const UNLIMITED_USD = 100000000;     // one-api คืนค่านี้เมื่อไม่จำกัด

export class CorsError extends Error {}

/** fetch JSON: ยิงตรงก่อน ถ้าโดน CORS ลองผ่าน /proxy/ ของ ST (ต้องเปิด enableCorsProxy) */
export async function fetchJson(url, key, { timeoutMs = 15000 } = {}) {
    const auth = key ? { Authorization: `Bearer ${key}` } : {};
    const run = async (target, headers) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(target, { method: "GET", headers, signal: ctrl.signal, cache: "no-store" });
            const text = await r.text();
            let json = null;
            try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
            return { ok: r.ok, status: r.status, json };
        } finally { clearTimeout(t); }
    };

    try {
        return await run(url, { ...auth, Accept: "application/json" });
    } catch (e) {
        if (e?.name === "AbortError") throw new Error("ร้านตอบช้าเกินไป (timeout)");
        // TypeError = CORS หรือเน็ตหลุด → ลอง proxy ของ ST
        let headers = {};
        try { headers = getContext().getRequestHeaders(); } catch { /* ignore */ }
        delete headers["Content-Type"];
        const res = await run(`/proxy/${url}`, { ...headers, ...auth, Accept: "application/json" }).catch(() => null);
        if (res && res.json !== null) return res;
        throw new CorsError("ติดต่อร้านไม่ได้ — URL อาจผิด/ร้านล่ม หรือร้านบล็อกการเรียกจากเบราว์เซอร์ (CORS) ถ้าเป็นกรณีหลัง ให้ตั้ง enableCorsProxy: true ใน config.yaml แล้วรีสตาร์ท ST");
    }
}

const errMsg = (res) =>
    res?.json?.error?.message || res?.json?.message || (res ? `HTTP ${res.status}` : "ไม่มีการตอบกลับ");

/** /api/status ของ new-api: หน่วยเงินที่ร้านใช้แสดง (เปิดสาธารณะ ไม่ต้องใช้คีย์) */
export async function fetchStoreStatus(root) {
    try {
        const res = await fetchJson(`${root}/api/status`, null, { timeoutMs: 8000 });
        const d = res?.json?.data;
        if (!res.ok || !d || typeof d !== "object") return null;
        return {
            quotaPerUnit: Number(d.quota_per_unit) || DEFAULT_QPU,
            displayType: d.quota_display_type || (d.display_in_currency === false ? "TOKENS" : "USD"),
            usdRate: Number(d.usd_exchange_rate) || Number(d.price) || 0,
            customSymbol: d.custom_currency_symbol || "",
            customRate: Number(d.custom_currency_exchange_rate) || 0,
            systemName: d.system_name || "",
        };
    } catch { return null; }
}

/** /api/pricing ของ new-api: ตารางราคาทุกโมเดล */
export async function fetchPricing(root, key) {
    try {
        const res = await fetchJson(`${root}/api/pricing`, key, { timeoutMs: 12000 });
        const j = res?.json;
        if (!res.ok || !j || !Array.isArray(j.data)) return null;
        const models = j.data
            .filter(m => m && m.model_name)
            .map(m => ({
                model: String(m.model_name),
                quotaType: Number(m.quota_type) || 0,          // 0 = ตามโทเคน, 1 = ต่อครั้ง
                modelRatio: Number(m.model_ratio) || 0,
                completionRatio: Number(m.completion_ratio) || 1,
                modelPrice: Number(m.model_price) || 0,        // $ ต่อครั้ง
                groups: Array.isArray(m.enable_groups) ? m.enable_groups : null,
            }));
        return { models, groupRatio: j.group_ratio && typeof j.group_ratio === "object" ? j.group_ratio : {} };
    } catch { return null; }
}

/** /v1/models: รายชื่อโมเดล + เช็คว่าคีย์ยังใช้ได้ */
async function fetchModels(root, key) {
    const res = await fetchJson(`${root}/v1/models`, key);
    if (!res.ok) return { ok: false, status: res.status, error: errMsg(res) };
    const list = Array.isArray(res.json?.data) ? res.json.data.map(m => m?.id).filter(Boolean) : [];
    return { ok: true, models: list };
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }

/**
 * เช็คยอด ลองทีละแบบจนเจอ
 * คืน snapshot มาตรฐาน:
 * { kind, keyValid, unlimited, totalUsd, usedUsd, remainingUsd, totalQuota, usedQuota, remainingQuota,
 *   expiresAt, tokenName, modelLimits, models, qpu, note }
 * หน่วย *Usd = "$ ของร้าน" (quota ÷ quota_per_unit)
 */
export async function checkQuota(root, key, { qpuOverride = 0 } = {}) {
    const status = await fetchStoreStatus(root);
    const qpu = qpuOverride > 0 ? qpuOverride : (status?.quotaPerUnit || DEFAULT_QPU);
    const base = { root, status, qpu, checkedAt: Date.now() };

    // 1) OpenRouter
    if (/openrouter\.ai/i.test(root)) {
        const res = await fetchJson(`https://openrouter.ai/api/v1/key`, key);
        if (!res.ok) throw new Error(`คีย์ใช้ไม่ได้: ${errMsg(res)}`);
        const d = res.json?.data || {};
        const unlimited = d.limit === null || d.limit === undefined;
        const used = Number(d.usage) || 0;
        return {
            ...base, kind: "openrouter", keyValid: true, unlimited,
            totalUsd: unlimited ? null : Number(d.limit), usedUsd: used,
            remainingUsd: unlimited ? null : (d.limit_remaining ?? (Number(d.limit) - used)),
            tokenName: d.label || "", note: d.is_free_tier ? "บัญชีฟรี" : "",
        };
    }

    let tokenSnap = null;

    // 2) new-api: /api/usage/token/
    try {
        const res = await fetchJson(`${root}/api/usage/token/`, key);
        const d = res?.json?.data;
        if (res.ok && d && d.object === "token_usage") {
            const unlimited = !!d.unlimited_quota;
            tokenSnap = {
                ...base, kind: "new-api", keyValid: true, unlimited,
                totalQuota: Number(d.total_granted) || 0,
                usedQuota: Number(d.total_used) || 0,
                remainingQuota: Number(d.total_available) || 0,
                expiresAt: Number(d.expires_at) > 0 ? Number(d.expires_at) * 1000 : null,
                tokenName: d.name || "",
                modelLimits: d.model_limits_enabled && d.model_limits ? Object.keys(d.model_limits) : null,
            };
            tokenSnap.totalUsd = tokenSnap.totalQuota / qpu;
            tokenSnap.usedUsd = tokenSnap.usedQuota / qpu;
            tokenSnap.remainingUsd = tokenSnap.remainingQuota / qpu;
            if (!unlimited) return tokenSnap;
        }
    } catch (e) {
        if (e instanceof CorsError) throw e;
    }

    // 3) one-api / new-api: OpenAI billing (คีย์ไม่จำกัด → ยอดของบัญชีเจ้าของคีย์)
    try {
        const sub = await fetchJson(`${root}/v1/dashboard/billing/subscription`, key);
        if (sub.ok && sub.json && sub.json.hard_limit_usd !== undefined) {
            const end = new Date(Date.now() + 86400000);
            const start = new Date(Date.now() - 99 * 86400000);
            const use = await fetchJson(
                `${root}/v1/dashboard/billing/usage?start_date=${fmtDate(start)}&end_date=${fmtDate(end)}`, key);
            const total = Number(sub.json.hard_limit_usd);
            const unlimited = total >= UNLIMITED_USD;
            const used = use.ok ? (Number(use.json?.total_usage) || 0) / 100 : null;
            const snap = {
                ...base, kind: tokenSnap ? "new-api (บัญชี)" : "billing", keyValid: true, unlimited,
                totalUsd: unlimited ? null : total,
                usedUsd: used,
                remainingUsd: unlimited || used === null ? null : total - used,
                expiresAt: Number(sub.json.access_until) > 0 ? Number(sub.json.access_until) * 1000 : tokenSnap?.expiresAt ?? null,
                tokenName: tokenSnap?.tokenName || "",
                modelLimits: tokenSnap?.modelLimits || null,
                note: tokenSnap ? "คีย์ตั้งเป็นไม่จำกัด ยอดที่เห็นเป็นยอดของบัญชีที่ออกคีย์" : "",
            };
            return snap;
        }
    } catch (e) {
        if (e instanceof CorsError) throw e;
    }

    if (tokenSnap) return { ...tokenSnap, note: "คีย์ตั้งเป็นไม่จำกัด และร้านไม่บอกยอดบัญชี" };

    // 4) ไม่มี endpoint เช็คยอด → เช็คแค่ว่าคีย์ยังใช้ได้
    const m = await fetchModels(root, key);
    if (!m.ok) throw new Error(`คีย์ใช้ไม่ได้หรือ URL ผิด: ${m.error}`);
    return {
        ...base, kind: "models-only", keyValid: true, unlimited: false,
        totalUsd: null, usedUsd: null, remainingUsd: null, models: m.models,
        note: "ร้านนี้ไม่มี endpoint เช็คยอด — บอกได้แค่ว่าคีย์ยังใช้ได้ (ใช้โหมดแพ็กข้อความช่วยนับแทนได้)",
    };
}

export { fetchModels };
