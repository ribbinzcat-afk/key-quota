import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";

export const extensionName = "key-quota";   // ต้องตรงชื่อโฟลเดอร์
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

export const defaultSettings = {
    enabled: true,

    // รายการคีย์ที่จะเช็ค
    includeMain: true,         // การเชื่อมต่อหลักของ ST ตอนนี้
    includeProfiles: true,     // ทุก Connection Profile ที่มี URL
    excludedProfiles: [],      // id ของ profile ที่ไม่ต้องเช็ค
    manualKeys: [],            // [{ id, label, url, key }]

    // เช็คเมื่อไร
    autoCheck: true,           // เช็คคีย์ที่กำลังใช้ หลัง AI ตอบ
    minIntervalSec: 15,
    showInWand: true,          // แสดงยอดของคีย์ที่กำลังใช้ในเมนูไม้คทา

    // เตือน
    warnEnabled: true,
    warnCredits: 1,            // หน่วยเดียวกับที่แสดง
    warnMessages: 20,

    // หน่วยเงิน
    displayCurrency: "auto",   // auto | USD | CNY | QUOTA
    cnyRate: 7.3,
    quotaPerUnit: 0,           // 0 = อ่านจากร้าน
    group: "",

    // ขนาดข้อความ
    useMeasuredTokens: true,
    avgIn: 6000,
    avgOut: 500,
    measured: { in: [], out: [] },
    costSamples: {},           // "root::model" -> [$ ต่อข้อความ]

    manualPrices: "",

    packs: {},                 // targetId -> { enabled, total, used }
    openCards: {},             // targetId -> true (การ์ดที่กางไว้ในแผง)
    userAuth: {},              // targetId -> { uid, token } ใช้เช็คยอดของบัญชีตัวเอง
    checkers: {},              // targetId -> { type: "popko", provider } หน้าเช็คของร้าน
};

let migrated = false;

export function getSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];
    for (const k of Object.keys(defaultSettings)) {
        if (s[k] === undefined) s[k] = structuredClone(defaultSettings[k]);
    }
    if (!s.measured || !Array.isArray(s.measured.in)) s.measured = { in: [], out: [] };
    if (!s.costSamples || typeof s.costSamples !== "object") s.costSamples = {};
    if (!Array.isArray(s.manualKeys)) s.manualKeys = [];
    if (!Array.isArray(s.excludedProfiles)) s.excludedProfiles = [];
    if (!s.packs || typeof s.packs !== "object") s.packs = {};
    if (!s.openCards || typeof s.openCards !== "object") s.openCards = {};
    if (!s.userAuth || typeof s.userAuth !== "object") s.userAuth = {};
    if (!s.checkers || typeof s.checkers !== "object") s.checkers = {};

    // ย้ายค่าจากเวอร์ชัน 1.0 (คีย์เดียว)
    if (!migrated) {
        migrated = true;
        if (s.manualUrl && s.manualKey && !s.manualKeys.some(k => k.key === s.manualKey)) {
            s.manualKeys.push({ id: newId(), label: "คีย์ที่กรอกไว้", url: s.manualUrl, key: s.manualKey });
        }
        if (s.pack && s.pack.enabled && !s.legacyPack) s.legacyPack = s.pack;   // จะผูกกับคีย์ที่กำลังใช้ตอนเช็คครั้งแรก
        if (s.showBadge !== undefined && s.showInWand === undefined) s.showInWand = s.showBadge;
        for (const k of ["keySource", "apiProfile", "manualUrl", "manualKey", "pack", "showBadge", "last"]) delete s[k];
    }
    return s;
}
export const getSetting = (k) => getSettings()[k];
export function setSetting(k, v) { getSettings()[k] = v; saveSettingsDebounced(); }
export const saveSettings = () => saveSettingsDebounced();

export const newId = () => Math.random().toString(36).slice(2, 10);

export function getPack(id) {
    const s = getSettings();
    return s.packs[id] || { enabled: false, total: 0, used: 0 };
}
export function setPack(id, patch) {
    const s = getSettings();
    s.packs[id] = { ...getPack(id), ...patch };
    saveSettingsDebounced();
}
