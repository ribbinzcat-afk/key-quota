// ยิงไปถามยอดคงเหลือ / ตารางราคา / หน่วยเงินของร้าน
// ไม่มีการเรียก chat completion เลย จึงไม่เสียโทเคน
import { getContext } from "../../../../extensions.js";

const DEFAULT_QPU = 500000;          // new-api/one-api: 500,000 quota = $1
const UNLIMITED_USD = 100000000;     // one-api คืนค่านี้เมื่อไม่จำกัด

export class CorsError extends Error {}

/** fetch JSON: ยิงตรงก่อน ถ้าโดน CORS ลองผ่าน /proxy/ ของ ST (ต้องเปิด enableCorsProxy) */
export async function fetchJson(url, key, { timeoutMs = 15000, headers: extra = {}, method = "GET", body = undefined } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) extra = { "Content-Type": "application/json", ...extra };
    const auth = { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
    const run = async (target, headers) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(target, { method, headers, body: payload, signal: ctrl.signal, cache: "no-store" });
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
        if (payload === undefined) delete headers["Content-Type"];
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
export async function checkQuota(root, key, { qpuOverride = 0, uid = "", accessToken = "", checker = null } = {}) {
    // หน้าเช็คของร้านเอง (นับเป็นจำนวนข้อความ)
    if (checker?.type && checker.type !== "standard" && STORE_CHECKERS[checker.type]) return STORE_CHECKERS[checker.type].check(root, key, checker);

    const status = await fetchStoreStatus(root);
    const qpu = qpuOverride > 0 ? qpuOverride : (status?.quotaPerUnit || DEFAULT_QPU);
    const base = { root, status, qpu, checkedAt: Date.now() };

    // 0) มี UID → ถามยอดของบัญชีตัวเองตรงๆ (new-api และร้านที่แตกมาจาก new-api)
    let uidNote = "";
    if (uid) {
        const r = await checkUserSelf(root, uid, accessToken || key);
        if (r.ok) {
            const d = r.data;
            const remainingQuota = Number(d.quota) || 0;
            const usedQuota = Number(d.used_quota) || 0;
            return {
                ...base, kind: "new-api (UID)", keyValid: true, unlimited: false,
                totalQuota: remainingQuota + usedQuota, usedQuota, remainingQuota,
                totalUsd: (remainingQuota + usedQuota) / qpu, usedUsd: usedQuota / qpu, remainingUsd: remainingQuota / qpu,
                requestCount: Number(d.request_count) || 0,
                group: d.group || "", tokenName: d.display_name || d.username || `UID ${uid}`,
                uidOk: true,
            };
        }
        if (accessToken) throw new Error(`เช็คด้วย UID ไม่ได้: ${r.error}`);
        uidNote = `เช็คด้วย UID ไม่ได้ (${r.error}) — ร้านส่วนใหญ่ไม่รับ sk-key ตรงนี้ ต้องใช้ Access Token ของบัญชี`;
    }
    const withUidNote = (snap) => uidNote ? { ...snap, note: [uidNote, snap.note].filter(Boolean).join(" · ") } : snap;
    return withUidNote(await checkByKey(root, key, base, qpu));
}

/** /api/user/self — ยอดของบัญชีตาม UID (ต้องมี Access Token ของบัญชี; บางร้านรับ sk-key) */
async function checkUserSelf(root, uid, token) {
    try {
        const res = await fetchJson(`${root}/api/user/self`, token, {
            headers: { "New-Api-User": String(uid) },
        });
        const j = res?.json;
        if (res.ok && j && j.success !== false && j.data && j.data.quota !== undefined) return { ok: true, data: j.data };
        return { ok: false, error: errMsg(res) };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

async function checkByKey(root, key, base, qpu) {

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
                shared: !!tokenSnap,
                note: tokenSnap ? "คีย์นี้ไม่ได้จำกัดยอดในตัว ยอดที่เห็นเป็นยอดของบัญชีที่ออกคีย์ ถ้าคนกลางใช้บัญชีเดียวแจกคีย์ให้หลายคน ยอดนี้คือยอดรวมของทุกคน — ใส่ UID (และ Access Token) ในการ์ดนี้เพื่อดูยอดของตัวเอง" : "",
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

/* ---------------- หน้าเช็คของร้าน (ร้านที่นับยอดเอง) ---------------- */

/** POPKO Proxy Hub — https://honeycheck.popkoproxyhub.com */
async function checkPopko(root, key, cfg) {
    const provider = String(cfg.provider || cfg.defaultProvider || "").trim();
    if (!provider) throw new Error("ยังไม่ได้ใส่ provider ของ POPKO — กางการ์ดนี้แล้วใส่ provider (ดูได้จากหน้าเช็คของร้าน เช่น xing)");
    const res = await fetchJson("https://honeycheck.popkoproxyhub.com/api/check", null, {
        method: "POST", body: { provider, key },
    });
    const j = res?.json;
    if (!res.ok || !j || !Array.isArray(j.models)) {
        throw new Error(`หน้าเช็คของ POPKO ตอบผิดปกติ: ${j?.detail || j?.error || j?.message || `HTTP ${res?.status}`}`);
    }
    const messageModels = j.models.map(m => ({
        model: String(m.id || m.label || ""),
        remaining: Number(m.remaining), used: Number(m.used_messages), total: Number(m.total),
    })).filter(m => m.model && isFinite(m.remaining));
    const summary = j.history?.summary || {};
    return {
        root, status: null, qpu: DEFAULT_QPU, checkedAt: Date.now(),
        kind: "store-popko", keyValid: true, unlimited: false,
        totalUsd: null, usedUsd: null, remainingUsd: null,
        tokenName: j.key_name || j.label || "",
        messageModels,
        requestCount: Number(summary.records) || 0,
        note: `${j.label || provider} · ทุกโมเดลในคีย์เดียวกันใช้ยอดร่วมกัน (ตัวเลขต่อโมเดลคือถ้าใช้โมเดลนั้นอย่างเดียว)`,
    };
}

/** RVL Connect — https://rvlconnect.com/check.html (base URL แบบ https://api.rvlconnect.com/<channel>) */
export const RVL_SERIES = {
    1: "LHAO", 11: "LHAO", 12: "LHAO", 2: "G", 3: "HHJM", 4: "TTK", 5: "TTK", 6: "น้ำ", 7: "S",
    8: "PANDA", 9: "CHR", 10: "GM", 14: "GM", 15: "GM", 16: "GM", 19: "GM", 13: "DZ", 17: "X",
    18: "DM", 20: "KFC", 21: "สาเก", 22: "LULU",
};
export const rvlChannelOf = (root) => {
    const m = String(root || "").match(/^https?:\/\/api\.rvlconnect\.com\/(\d+)/i);
    return m ? Number(m[1]) : null;
};

/** ดึงตัวเลขยอดจาก usage ที่หน้าตาไม่แน่นอน */
function parseLooseUsage(u, qpu) {
    if (!u || typeof u !== "object") return null;
    const d = u.data && typeof u.data === "object" ? u.data : u;
    const n = (k) => (d[k] !== undefined && d[k] !== null && isFinite(Number(d[k])) ? Number(d[k]) : null);
    if (d.object === "token_usage" || n("total_available") !== null) {
        if (d.unlimited_quota) return null;   // คีย์ไม่จำกัด = ยอดของต้นทาง ไม่ใช่ของคุณ
        const rem = n("total_available"), used = n("total_used"), tot = n("total_granted");
        return { remainingUsd: rem / qpu, usedUsd: used !== null ? used / qpu : null, totalUsd: tot !== null ? tot / qpu : null };
    }
    if (n("hard_limit_usd") !== null) {
        const tot = n("hard_limit_usd"); if (tot >= UNLIMITED_USD) return null;
        const used = n("total_usage") !== null ? n("total_usage") / 100 : null;
        return { totalUsd: tot, usedUsd: used, remainingUsd: used !== null ? tot - used : null };
    }
    const rem = n("remaining") ?? n("balance") ?? n("remain");
    if (rem !== null) return { remainingUsd: rem, usedUsd: n("used"), totalUsd: n("total") };
    return null;
}

async function checkRvl(root, key, cfg) {
    const channel = Number(cfg.channel) || rvlChannelOf(root);
    if (!channel) throw new Error("หา channel ของ RVL ไม่ได้จาก Base URL — กางการ์ดนี้แล้วใส่เลข channel (เช่น 8 สำหรับ PANDA)");
    const series = String(cfg.series || RVL_SERIES[channel] || "").trim();
    if (!series) throw new Error(`ไม่รู้จัก series ของ channel ${channel} — ใส่ series เองในการ์ด`);
    const res = await fetchJson("https://rvlconnect.com/api/check.php", null, {
        method: "POST", body: { keys: [key], series, channel }, timeoutMs: 30000,
    });
    const j = res?.json;
    if (!res.ok || !j) throw new Error(`หน้าเช็คของ RVL ตอบผิดปกติ (HTTP ${res?.status})`);
    if (j.ok === false || j.valid === false) throw new Error(`คีย์ใช้ไม่ได้: ${j.message || j.error || "ไม่ทราบสาเหตุ"}`);
    const u = parseLooseUsage(j.usage, DEFAULT_QPU);
    return {
        root, status: null, qpu: DEFAULT_QPU, checkedAt: Date.now(),
        kind: "store-rvl", keyValid: true, unlimited: false,
        totalUsd: u?.totalUsd ?? null, usedUsd: u?.usedUsd ?? null, remainingUsd: u?.remainingUsd ?? null,
        tokenName: `${series} · channel ${channel}`,
        modelsCount: Number(j.models_count) || 0,
        note: u ? (j.message || "")
            : `${j.message || "คีย์ใช้ได้"} — หน้าเช็คของร้านเองก็ไม่บอกยอดของคีย์นี้ ถ้าซื้อเป็นจำนวนข้อความ ให้เปิด “ซื้อแบบนับข้อความ” ด้านล่างให้ extension นับให้`,
    };
}

export const STORE_CHECKERS = {
    popko: { label: "POPKO Proxy Hub (honeycheck)", needs: ["provider"], check: checkPopko },
    rvl: { label: "RVL Connect (check.php)", needs: ["series"], check: checkRvl },
};

/** เลือกวิธีเช็คอัตโนมัติจาก URL (ผู้ใช้เปลี่ยนเองได้ในการ์ด) */
const NAME_HINTS = [
    { type: "popko", re: /popko|ปอกอ|ป๊อกโก|ป็อปโก|ป๊อปโก/i },
    { type: "rvl", re: /rvl|แมวแดง/i },
];

/** เลือกวิธีเช็คอัตโนมัติจาก URL หรือชื่อ Connection Profile / ชื่อคีย์ (ผู้ใช้เปลี่ยนเองได้ในการ์ด) */
export function autoChecker(root, labels = []) {
    if (rvlChannelOf(root)) return { type: "rvl", auto: true };
    if (/popkoproxyhub\.com/i.test(root)) return { type: "popko", auto: true };
    const text = (Array.isArray(labels) ? labels : [labels]).join(" ");
    for (const h of NAME_HINTS) if (h.re.test(text)) return { type: h.type, auto: true, byName: true };
    return null;
}
