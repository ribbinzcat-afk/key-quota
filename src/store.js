import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";

export const extensionName = "key-quota";   // ต้องตรงชื่อโฟลเดอร์
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

export const defaultSettings = {
    enabled: true,

    // แหล่งคีย์
    keySource: "profile",      // "profile" = ดึงจาก Connection Profile / API หลัก, "manual" = กรอกเอง
    apiProfile: "",            // "" = การเชื่อมต่อหลักของ ST ตอนนี้
    manualUrl: "",
    manualKey: "",

    // เช็คเมื่อไร
    autoCheck: true,           // เช็คหลัง AI ตอบ
    minIntervalSec: 15,        // กันยิงถี่เกิน
    showBadge: true,           // ตัวเลขเล็กๆ ข้างช่องพิมพ์

    // เตือน
    warnEnabled: true,
    warnCredits: 1,            // หน่วยเดียวกับที่แสดง (เช่น $ หรือ ¥)
    warnMessages: 20,          // ข้อความคงเหลือของโมเดลที่ใช้อยู่

    // หน่วยเงิน
    displayCurrency: "auto",   // auto | USD | CNY | QUOTA
    cnyRate: 7.3,              // ใช้เมื่อเลือก CNY เองแต่ร้านไม่บอกเรท
    quotaPerUnit: 0,           // 0 = อ่านจากร้าน (ค่าปกติ 500000 = $1)
    group: "",                 // "" = default

    // ขนาดข้อความ (ใช้ประมาณราคาจากตารางร้าน)
    useMeasuredTokens: true,
    avgIn: 6000,
    avgOut: 500,
    measured: { in: [], out: [] },   // วัดด้วย tokenizer ของ ST (เก็บล่าสุด 20 ครั้ง)
    costSamples: {},                 // model -> [usd ต่อข้อความ] วัดจากยอดที่ลดจริง

    // ราคากำหนดเอง: บรรทัดละ "ชื่อโมเดล = ราคาต่อข้อความ" (หน่วยเดียวกับที่แสดง)
    manualPrices: "",

    // แพ็กแบบรายข้อความ
    pack: { enabled: false, total: 0, used: 0 },

    last: null,               // ผลเช็คล่าสุด (ไม่มีคีย์อยู่ในนี้)
};

export function getSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];
    for (const k of Object.keys(defaultSettings)) {
        if (s[k] === undefined) s[k] = structuredClone(defaultSettings[k]);
    }
    if (!s.measured || !Array.isArray(s.measured.in)) s.measured = { in: [], out: [] };
    if (!s.pack || typeof s.pack !== "object") s.pack = structuredClone(defaultSettings.pack);
    if (!s.costSamples || typeof s.costSamples !== "object") s.costSamples = {};
    return s;
}
export const getSetting = (k) => getSettings()[k];
export function setSetting(k, v) { getSettings()[k] = v; saveSettingsDebounced(); }
export const saveSettings = () => saveSettingsDebounced();
