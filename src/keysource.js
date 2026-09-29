// รวบรวมคีย์ทั้งหมดที่จะเช็ค: การเชื่อมต่อหลัก + ทุก Connection Profile + คีย์ที่กรอกเอง
import { getContext } from "../../../../extensions.js";
import { findSecret } from "../../../../secrets.js";
import { proxies } from "../../../../openai.js";
import { getSettings } from "./store.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export function normalizeRoot(url) {
    let u = String(url || "").trim().replace(/\/+$/, "");
    u = u.replace(/\/chat\/completions$/i, "").replace(/\/completions$/i, "");
    u = u.replace(/\/v1$/i, "");
    return u.replace(/\/+$/, "");
}

export const maskKey = (k) => {
    k = String(k || "");
    if (!k) return "(ไม่มีคีย์)";
    return k.length <= 8 ? "••••" : `${k.slice(0, 3)}••••${k.slice(-4)}`;
};

export const safeHost = (u) => { try { return new URL(u).host; } catch { return String(u || ""); } };

/** FNV-1a — ใช้ทำ id ที่คงที่ของคีย์ โดยไม่เก็บตัวคีย์ลง id */
export function hashId(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return "k" + (h >>> 0).toString(16);
}

export function getProfiles() {
    try { return (getContext().extensionSettings.connectionManager || {}).profiles || []; }
    catch { return []; }
}

/** รายละเอียดการเชื่อมต่อหลักของ ST ตอนนี้ (ยังไม่อ่านคีย์) */
export function describeMainConnection() {
    const ctx = getContext();
    if (ctx.mainApi !== "openai") return null;
    const s = ctx.chatCompletionSettings || {};
    const source = s.chat_completion_source;
    let url = "", proxyPassword = null;
    if (source === "custom") url = s.custom_url;
    else if (s.reverse_proxy) { url = s.reverse_proxy; proxyPassword = s.proxy_password || ""; }
    else if (source === "openrouter") url = OPENROUTER_BASE;
    let model = "";
    try { model = ctx.getChatCompletionModel?.() || ""; } catch { /* ignore */ }
    return { origin: "main", label: "การเชื่อมต่อหลัก", source, url, secretKey: `api_key_${source}`, secretId: undefined, proxyPassword, model };
}

function describeProfile(p) {
    const source = p.api || "";
    let url = "", proxyPassword = null;
    const preset = p.proxy && p.proxy !== "None" ? proxies.find(x => x.name === p.proxy) : null;
    if (source === "custom") url = p["api-url"] || "";
    else if (preset?.url) { url = preset.url; proxyPassword = preset.password || ""; }
    else if (source === "openrouter") url = OPENROUTER_BASE;
    return {
        origin: "profile", profileId: p.id, label: p.name || p.id, source, url,
        secretKey: `api_key_${source}`, secretId: p["secret-id"] || undefined, proxyPassword, model: p.model || "",
    };
}

async function readKey(d) {
    if (d.proxyPassword) return d.proxyPassword;
    try { return await findSecret(d.secretKey, d.secretId); } catch { return null; }
}

export const KEY_NOT_EXPOSED = "อ่านคีย์จาก ST ไม่ได้ — ตั้ง allowKeysExposure: true ใน config.yaml แล้วรีสตาร์ท ST หรือกรอกคีย์นี้เองในหน้าตั้งค่า";

/**
 * คืนรายการเป้าหมาย [{ id, labels[], origins[], root, key, model, error }]
 * คีย์ที่ซ้ำกัน (URL + คีย์เดียวกัน) จะรวมเป็นอันเดียว
 */
export async function listTargets() {
    const s = getSettings();
    const raw = [];

    if (s.includeMain) {
        const d = describeMainConnection();
        if (d && d.url) raw.push(d);
    }
    if (s.includeProfiles) {
        for (const p of getProfiles()) {
            if (!p?.id || s.excludedProfiles.includes(p.id)) continue;
            const d = describeProfile(p);
            if (d.url) raw.push(d);
        }
    }
    for (const m of s.manualKeys) {
        if (!m?.url || !m?.key) continue;
        raw.push({ origin: "manual", manualId: m.id, label: m.label || "กรอกเอง", url: m.url, key: String(m.key).trim(), model: "" });
    }

    const byId = new Map();
    const out = [];
    for (const d of raw) {
        const root = normalizeRoot(d.url);
        const key = d.key ?? await readKey(d);
        if (!key) {
            out.push({
                id: `err:${d.origin}:${d.profileId || ""}:${hashId(root)}`, labels: [d.label], origins: [d.origin],
                root, key: "", model: d.model, error: KEY_NOT_EXPOSED,
            });
            continue;
        }
        const id = hashId(`${root}|${String(key).trim()}`);
        const existing = byId.get(id);
        if (existing) {
            if (!existing.labels.includes(d.label)) existing.labels.push(d.label);
            if (!existing.origins.includes(d.origin)) existing.origins.push(d.origin);
            if (!existing.model && d.model) existing.model = d.model;
            if (d.origin === "main" && d.model) existing.model = d.model;   // โมเดลที่ใช้อยู่จริงสำคัญกว่า
            continue;
        }
        const t = { id, labels: [d.label], origins: [d.origin], root, key: String(key).trim(), model: d.model || "", error: "" };
        byId.set(id, t);
        out.push(t);
    }
    // คีย์ที่อ่านไม่ได้ แต่ URL ซ้ำกับคีย์ที่อ่านได้แล้ว → ไม่ต้องโชว์ error ซ้ำ
    return out.filter(t => !t.error || !out.some(o => !o.error && o.root === t.root));
}

/** id ของคีย์ที่การเชื่อมต่อหลักใช้อยู่ตอนนี้ */
export async function resolvePrimaryId(targets) {
    const d = describeMainConnection();
    if (!d?.url) return "";
    const root = normalizeRoot(d.url);
    const key = await readKey(d);
    if (key) {
        const id = hashId(`${root}|${String(key).trim()}`);
        if (targets.some(t => t.id === id)) return id;
    }
    // อ่านคีย์ไม่ได้ → ใช้คีย์แรกที่ URL ตรงกัน
    return targets.find(t => !t.error && t.root === root)?.id || targets.find(t => t.origins.includes("main"))?.id || "";
}

export function mainConnectionRoot() {
    const d = describeMainConnection();
    return d?.url ? normalizeRoot(d.url) : "";
}

export function mainModel() {
    return describeMainConnection()?.model || "";
}
