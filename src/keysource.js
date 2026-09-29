// หาว่าจะเช็คคีย์ไหน: URL + คีย์ + โมเดลที่ใช้อยู่
import { getContext } from "../../../../extensions.js";
import { findSecret } from "../../../../secrets.js";
import { proxies } from "../../../../openai.js";
import { getSetting } from "./store.js";

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

function getProfiles() {
    try { return (getContext().extensionSettings.connectionManager || {}).profiles || []; }
    catch { return []; }
}

// การเชื่อมต่อหลักของ ST ตอนนี้ (ใช้เทียบว่า AI ที่เพิ่งตอบใช้คีย์เดียวกันไหม)
export function describeMainConnection() {
    const ctx = getContext();
    if (ctx.mainApi !== "openai") return null;
    const s = ctx.chatCompletionSettings || {};
    const source = s.chat_completion_source;
    let url = "";
    let secretKey = `api_key_${source}`;
    let proxyPassword = null;
    if (source === "custom") url = s.custom_url;
    else if (s.reverse_proxy) { url = s.reverse_proxy; proxyPassword = s.proxy_password || ""; }
    else if (source === "openrouter") url = OPENROUTER_BASE;
    let model = "";
    try { model = ctx.getChatCompletionModel?.() || ""; } catch { /* ignore */ }
    return { source, url, secretKey, secretId: undefined, proxyPassword, model, label: "API หลักของ ST" };
}

function describeProfile(profileId) {
    const p = getProfiles().find(x => x?.id === profileId);
    if (!p) return null;
    const source = p.api || "";
    let url = "";
    let proxyPassword = null;
    const proxyPreset = p.proxy && p.proxy !== "None" ? proxies.find(x => x.name === p.proxy) : null;
    if (source === "custom") url = p["api-url"] || "";
    else if (proxyPreset?.url) { url = proxyPreset.url; proxyPassword = proxyPreset.password || ""; }
    else if (source === "openrouter") url = OPENROUTER_BASE;
    return {
        source, url, secretKey: `api_key_${source}`, secretId: p["secret-id"] || undefined,
        proxyPassword, model: p.model || "", label: `Profile: ${p.name || p.id}`,
    };
}

/**
 * คืน { root, key, model, label } หรือ throw Error พร้อมข้อความภาษาไทย
 */
export async function resolveTarget() {
    if (getSetting("keySource") === "manual") {
        const url = getSetting("manualUrl");
        const key = String(getSetting("manualKey") || "").trim();
        if (!url || !key) throw new Error("ยังไม่ได้กรอก URL หรือคีย์ในหน้าตั้งค่า");
        const main = describeMainConnection();
        return { root: normalizeRoot(url), key, model: main?.model || "", label: "กรอกเอง" };
    }

    const profileId = getSetting("apiProfile");
    const d = profileId ? describeProfile(profileId) : describeMainConnection();
    if (!d) {
        throw new Error(profileId
            ? "หา Connection Profile นี้ไม่เจอ (อาจถูกลบไปแล้ว)"
            : "API หลักของ ST ตอนนี้ไม่ใช่ Chat Completion");
    }
    if (!d.url) throw new Error(`${d.label} ไม่ได้ตั้ง URL (ใช้ได้กับ Custom (OpenAI-compatible), Reverse Proxy หรือ OpenRouter)`);

    let key = d.proxyPassword;
    if (key === null || key === undefined || key === "") {
        key = await findSecret(d.secretKey, d.secretId);
    }
    if (!key) {
        throw new Error("อ่านคีย์จาก ST ไม่ได้ ต้องตั้ง allowKeysExposure: true ใน config.yaml แล้วรีสตาร์ท ST หรือเปลี่ยนไปใช้แบบ “กรอกเอง”");
    }
    return { root: normalizeRoot(d.url), key: String(key).trim(), model: d.model, label: d.label };
}

// ใช้ตัดสินว่า generation ที่เพิ่งเกิดใช้คีย์ที่เรากำลังติดตามไหม
export function mainConnectionRoot() {
    const d = describeMainConnection();
    return d?.url ? normalizeRoot(d.url) : "";
}

export { getProfiles };
