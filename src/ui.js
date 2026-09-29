// วาดแผงสรุปโควตา + badge ข้างช่องพิมพ์
import { buildEstimates, fmtMoney, fmtQuota, avgTokens } from "./estimate.js";

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_LABEL = {
    "new-api": "new-api (ยอดของคีย์)",
    "new-api (บัญชี)": "new-api (ยอดของบัญชี)",
    "billing": "one-api / OpenAI billing",
    "openrouter": "OpenRouter",
    "models-only": "ไม่มี endpoint เช็คยอด",
};

function timeAgo(ts) {
    if (!ts) return "";
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec} วินาทีที่แล้ว`;
    if (sec < 3600) return `${Math.round(sec / 60)} นาทีที่แล้ว`;
    return new Date(ts).toLocaleString();
}

function stat(label, main, sub = "") {
    return `<div class="kq-stat"><div class="kq-stat-label">${esc(label)}</div>
        <div class="kq-stat-main">${esc(main)}</div>${sub ? `<div class="kq-stat-sub">${esc(sub)}</div>` : ""}</div>`;
}

function fmtCount(n) {
    if (n === null || n === undefined) return "—";
    return n >= 100000 ? "100,000+" : `≈ ${n.toLocaleString()}`;
}

/** state: { snap, pricing, error, busy, target } */
export function renderPanel($root, state, s) {
    const { snap, pricing, error, busy, target } = state;
    const est = buildEstimates({ snap, pricing, s, currentModel: target?.model || "" });
    const { cur } = est;
    const tok = avgTokens(s);

    let html = `<div class="kq-head">
        <div class="kq-title"><i class="fa-solid fa-coins"></i> Key Quota</div>
        <div class="kq-meta">${target ? `${esc(target.label)} · <code>${esc(target.masked)}</code> · ${esc(target.host)}` : ""}</div>
        <div class="kq-actions">
            <div class="menu_button kq-btn" data-kq="check"><i class="fa-solid fa-rotate${busy ? " fa-spin" : ""}"></i> เช็คตอนนี้</div>
        </div>
    </div>`;

    if (error) html += `<div class="kq-error"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(error)}</div>`;

    if (snap) {
        html += `<div class="kq-sub">ระบบ: ${esc(KIND_LABEL[snap.kind] || snap.kind)}${snap.tokenName ? ` · คีย์ “${esc(snap.tokenName)}”` : ""} · เช็คเมื่อ ${esc(timeAgo(snap.checkedAt))}</div>`;
        if (snap.note) html += `<div class="kq-note">${esc(snap.note)}</div>`;

        if (snap.unlimited && snap.remainingUsd === null) {
            html += `<div class="kq-stats">${stat("คงเหลือ", "ไม่จำกัด")}${stat("ใช้ไปแล้ว", fmtMoney(snap.usedUsd, cur), fmtQuota(snap.usedUsd, snap))}</div>`;
        } else if (snap.remainingUsd !== null && snap.remainingUsd !== undefined) {
            const pct = snap.totalUsd > 0 ? Math.max(0, Math.min(100, (snap.remainingUsd / snap.totalUsd) * 100)) : null;
            html += `<div class="kq-stats">
                ${stat("คงเหลือ", fmtMoney(snap.remainingUsd, cur), fmtQuota(snap.remainingUsd, snap))}
                ${stat("ใช้ไปแล้ว", fmtMoney(snap.usedUsd, cur), fmtQuota(snap.usedUsd, snap))}
                ${stat("ทั้งหมด", fmtMoney(snap.totalUsd, cur), fmtQuota(snap.totalUsd, snap))}
                ${snap.expiresAt ? stat("หมดอายุ", new Date(snap.expiresAt).toLocaleDateString()) : ""}
            </div>`;
            if (pct !== null) html += `<div class="kq-bar"><div class="kq-bar-fill ${pct < 15 ? "kq-low" : ""}" style="width:${pct.toFixed(1)}%"></div></div>`;
        }
    } else if (!error) {
        html += `<div class="kq-sub">${busy ? "กำลังเช็ค..." : "ยังไม่ได้เช็ค กด “เช็คตอนนี้”"}</div>`;
    }

    // แพ็กรายข้อความ
    if (s.pack?.enabled) {
        const left = Math.max(0, (s.pack.total || 0) - (s.pack.used || 0));
        html += `<div class="kq-section"><div class="kq-section-title"><i class="fa-solid fa-message"></i> แพ็กรายข้อความ (นับเองในเครื่อง)</div>
            <div class="kq-pack">
                <div class="kq-pack-num"><b>${left.toLocaleString()}</b> / ${(s.pack.total || 0).toLocaleString()} ข้อความ</div>
                <div class="kq-pack-btns">
                    <div class="menu_button kq-btn" data-kq="pack-minus" title="ลดตัวนับ 1">−1</div>
                    <div class="menu_button kq-btn" data-kq="pack-plus" title="เพิ่มตัวนับ 1">+1</div>
                    <div class="menu_button kq-btn" data-kq="pack-reset" title="เริ่มนับใหม่">รีเซ็ต</div>
                </div>
            </div></div>`;
    }

    // ตารางโมเดล
    const rows = est.rows;
    html += `<div class="kq-section"><div class="kq-section-title"><i class="fa-solid fa-list"></i> ใช้ได้อีกประมาณกี่ข้อความ</div>
        <div class="kq-assume">คิดจากข้อความละ ≈ ${tok.tin.toLocaleString()} โทเคนขาเข้า / ${tok.tout.toLocaleString()} โทเคนขาออก
        ${tok.measured ? `(วัดด้วย tokenizer ของ ST จาก ${tok.n} ครั้งล่าสุด)` : `(ค่าตั้งเอง — ส่งข้อความอีก ${Math.max(0, 3 - tok.n)} ครั้งจะเริ่มใช้ค่าที่วัดจริง)`}
        ${pricing && est.gr !== 1 ? ` · ตัวคูณกลุ่ม ×${est.gr}` : ""}</div>`;

    if (!rows.length) {
        html += `<div class="kq-note">ยังไม่มีข้อมูลราคา — ร้านไม่เปิดตารางราคา ให้รอให้ extension วัดจากการใช้จริง หรือกรอกราคาเองในหน้าตั้งค่า</div>`;
    } else {
        html += `<input class="text_pole kq-search" type="search" placeholder="ค้นหาโมเดล..." value="${esc(state.search || "")}">
        <div class="kq-table-wrap"><table class="kq-table">
            <thead><tr><th>โมเดล</th><th>ต่อข้อความ</th><th>เหลือ</th><th>ที่มา</th></tr></thead><tbody>`;
        const q = String(state.search || "").toLowerCase();
        let shown = 0;
        for (const r of rows) {
            if (q && !r.model.toLowerCase().includes(q)) continue;
            if (++shown > 150) break;
            const low = r.messages !== null && r.messages <= (Number(s.warnMessages) || 0);
            html += `<tr class="${r.current ? "kq-current" : ""}">
                <td class="kq-model">${r.current ? `<i class="fa-solid fa-star" title="โมเดลที่ใช้อยู่"></i> ` : ""}${esc(r.model)}</td>
                <td>${r.perMsgUsd ? esc(fmtMoney(r.perMsgUsd, cur)) : "—"}</td>
                <td class="${low ? "kq-lowtext" : ""}">${r.perMsgUsd ? esc(fmtCount(r.messages)) : "—"}</td>
                <td class="kq-src">${esc(r.source || "ไม่มีราคา")}${r.samples ? ` (${r.samples})` : ""}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }
    html += `<div class="kq-foot">ตัวเลขเป็นค่าประมาณ ข้อความยาว/สั้นกว่าปกติ, cache, หรือโหมดคิดเหตุผลทำให้คลาดได้ · “วัดจริง” คือยอดที่ลดลงจริงต่อ 1 ข้อความ (แม่นสุด)</div>`;

    $root.html(html);
    const $s = $root.find(".kq-search");
    if (state.focusSearch && $s.length) {
        const el = $s.get(0); el.focus(); el.setSelectionRange(el.value.length, el.value.length);
    }
}

/** ข้อความสั้นๆ สำหรับ badge */
export function badgeText(state, s) {
    const { snap, error, target, pricing } = state;
    if (error && !snap) return { text: "!", title: error, warn: true };
    const parts = [], title = [];
    let warn = false;
    if (s.pack?.enabled) {
        const left = Math.max(0, (s.pack.total || 0) - (s.pack.used || 0));
        parts.push(`${left}✉`); title.push(`แพ็ก: เหลือ ${left} ข้อความ`);
        if (left <= (Number(s.warnMessages) || 0)) warn = true;
    }
    if (snap) {
        const est = buildEstimates({ snap, pricing, s, currentModel: target?.model || "" });
        if (snap.remainingUsd !== null && snap.remainingUsd !== undefined) {
            parts.push(fmtMoney(snap.remainingUsd, est.cur)); title.push(`คงเหลือ ${fmtMoney(snap.remainingUsd, est.cur)}`);
        } else if (snap.unlimited) parts.push("∞");
        else if (snap.kind === "models-only" && !s.pack?.enabled) parts.push("✓");
        const curRow = est.rows.find(r => r.current);
        if (curRow && curRow.messages !== null) {
            parts.push(`≈${curRow.messages >= 100000 ? "99k+" : curRow.messages}✉`);
            title.push(`${curRow.model}: เหลือประมาณ ${curRow.messages} ข้อความ`);
            if (curRow.messages <= (Number(s.warnMessages) || 0)) warn = true;
        }
    }
    if (error) { title.push(`เช็คล่าสุดล้มเหลว: ${error}`); }
    return { text: parts.join(" · ") || "—", title: title.join("\n") || "Key Quota", warn };
}
