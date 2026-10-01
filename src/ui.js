// วาดแผงสรุปโควตา (หลายคีย์) + ข้อความสั้นในเมนูไม้คทา
import { buildEstimates, fmtMoney, fmtQuota, avgTokens } from "./estimate.js";
import { maskKey, safeHost } from "./keysource.js";
import { STORE_CHECKERS, autoChecker, RVL_SERIES, rvlChannelOf } from "./quota.js";

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_LABEL = {
    "new-api": "new-api (ยอดของคีย์)",
    "new-api (บัญชี)": "new-api (ยอดของบัญชีที่ออกคีย์)",
    "new-api (UID)": "new-api (ยอดของ UID ของคุณ)",
    "store-popko": "หน้าเช็คของร้าน POPKO",
    "store-rvl": "หน้าเช็คของร้าน RVL Connect",
    "billing": "one-api / OpenAI billing",
    "openrouter": "OpenRouter",
    "models-only": "ไม่มี endpoint เช็คยอด",
};

function timeAgo(ts) {
    if (!ts) return "";
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return `${Math.max(0, sec)} วินาทีที่แล้ว`;
    if (sec < 3600) return `${Math.round(sec / 60)} นาทีที่แล้ว`;
    return new Date(ts).toLocaleString();
}

const fmtCount = (n) => (n === null || n === undefined) ? "—" : (n >= 100000 ? "100,000+" : `≈ ${n.toLocaleString()}`);

function stat(label, main, sub = "") {
    return `<div class="kq-stat"><div class="kq-stat-label">${esc(label)}</div>
        <div class="kq-stat-main">${esc(main)}</div>${sub ? `<div class="kq-stat-sub">${esc(sub)}</div>` : ""}</div>`;
}

/** สรุปของคีย์เดียว ใช้ทั้งในการ์ดและเมนูไม้คทา */
export function summarize(t, r, s, getPack) {
    const snap = r?.snap || null;
    const est = buildEstimates({ snap, pricing: r?.pricing, s, currentModel: t.model || "" });
    const pack = getPack(t.id);
    const packLeft = pack.enabled ? Math.max(0, (pack.total || 0) - (pack.used || 0)) : null;
    const row = est.rows.find(x => x.current) || null;
    let money = "—";
    if (snap) {
        if (typeof snap.remainingUsd === "number") money = fmtMoney(snap.remainingUsd, est.cur);
        else if (snap.unlimited) money = "ไม่จำกัด";
        else if (snap.kind === "models-only") money = "คีย์ใช้ได้";
        else if (est.storeCounted) money = row ? `${row.messages.toLocaleString()} ข้อความ` : `${est.rows.length} โมเดล`;
        else if (snap.kind === "store-rvl") money = "คีย์ใช้ได้";
    }
    const warn = (typeof snap?.remainingUsd === "number" && snap.remainingUsd * est.cur.rate <= (Number(s.warnCredits) || 0))
        || (row?.messages !== null && row?.messages !== undefined && row.messages <= (Number(s.warnMessages) || 0))
        || (packLeft !== null && pack.total > 0 && packLeft <= (Number(s.warnMessages) || 0));
    return { snap, est, row, money, packLeft, pack, warn };
}

/**
 * view: { targets, results(Map), primaryId, busyAll, listing, search, listError }
 */
export function renderPanel($root, view, s, getPack) {
    const { targets, results, primaryId, busyAll, listing } = view;
    const tok = avgTokens(s);

    // รวมยอดทุกคีย์ แยกตามหน่วย
    const totals = new Map();
    let okCount = 0, errCount = 0;
    for (const t of targets) {
        const r = results.get(t.id);
        if (t.error || r?.error) { errCount++; continue; }
        if (!r?.snap) continue;
        okCount++;
        const sm = summarize(t, r, s, getPack);
        if (typeof sm.snap.remainingUsd === "number") {
            const unit = sm.est.cur.mode === "quota" ? "เครดิต" : sm.est.cur.symbol;
            const cur = totals.get(unit) || { usd: 0, cur: sm.est.cur, n: 0 };
            cur.usd += sm.snap.remainingUsd; cur.n++;
            totals.set(unit, cur);
        }
    }

    let html = `<div class="kq-head">
        <div class="kq-title"><i class="fa-solid fa-coins"></i> Key Quota</div>
        <div class="kq-actions">
            <div class="menu_button kq-btn" data-kq="check-all"><i class="fa-solid fa-rotate${busyAll ? " fa-spin" : ""}"></i> เช็คทุกคีย์</div>
        </div>
    </div>`;

    if (view.listError) html += `<div class="kq-error">${esc(view.listError)}</div>`;

    if (!targets.length) {
        html += `<div class="kq-note">${listing ? "กำลังรวบรวมคีย์..." : "ยังไม่มีคีย์ให้เช็ค — เพิ่มคีย์ในหน้าตั้งค่า (Extensions → Key Quota Checker) หรือเปิด “เช็คทุก Connection Profile”"}</div>`;
        $root.html(html);
        return;
    }

    // แถบรวม
    const totalParts = [...totals.values()].map(v => fmtMoney(v.usd, v.cur));
    html += `<div class="kq-total">
        <div><span class="kq-stat-label">คงเหลือรวม</span> <b>${esc(totalParts.join(" + ") || "—")}</b></div>
        <div class="kq-stat-label">${targets.length} คีย์ · เช็คแล้ว ${okCount}${errCount ? ` · มีปัญหา ${errCount}` : ""}</div>
    </div>`;

    html += `<div class="kq-cards">`;
    for (const t of targets) html += renderCard(t, results.get(t.id), s, getPack, t.id === primaryId, view, tok);
    html += `</div>`;
    html += `<div class="kq-foot">จำนวนข้อความเป็นค่าประมาณ คิดจากข้อความละ ≈ ${tok.tin.toLocaleString()} / ${tok.tout.toLocaleString()} โทเคน (เข้า/ออก)
        ${tok.measured ? `วัดด้วย tokenizer ของ ST จาก ${tok.n} ครั้งล่าสุด` : "ค่าตั้งต้น"} · “วัดจริง” = ยอดที่ลดลงจริงต่อ 1 ข้อความ แม่นที่สุด</div>`;

    $root.html(html);
    if (view.focusSearch) {
        const el = $root.find(`.kq-search[data-id="${view.focusSearch}"]`).get(0);
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
}

function renderCard(t, r, s, getPack, isPrimary, view, tok) {
    const open = !!s.openCards[t.id];
    const sm = summarize(t, r, s, getPack);
    const { snap, est, row, money, packLeft, pack } = sm;
    const err = t.error || r?.error || "";
    const labels = t.labels.join(" · ");
    const pct = snap && snap.totalUsd > 0 && typeof snap.remainingUsd === "number"
        ? Math.max(0, Math.min(100, (snap.remainingUsd / snap.totalUsd) * 100)) : null;

    let msgLine = "";
    if (row && row.messages !== null) msgLine = est.storeCounted ? `<span class="kq-dim">${esc(row.model)}</span>` : `${fmtCount(row.messages)} ข้อความ <span class="kq-dim">(${esc(row.model)})</span>`;
    else if (t.model) msgLine = `<span class="kq-dim">${esc(t.model)}: ยังไม่มีราคา</span>`;
    if (packLeft !== null) msgLine += `${msgLine ? " · " : ""}แพ็กเหลือ <b>${packLeft.toLocaleString()}</b>/${(pack.total || 0).toLocaleString()}`;

    let html = `<div class="kq-card${isPrimary ? " kq-primary" : ""}${sm.warn ? " kq-warncard" : ""}" data-id="${esc(t.id)}">
      <div class="kq-card-head" data-kq="toggle" data-id="${esc(t.id)}">
        <div class="kq-card-name">
            ${isPrimary ? `<i class="fa-solid fa-star" title="คีย์ที่กำลังใช้แชทอยู่"></i> ` : ""}<b>${esc(labels)}</b>
            <div class="kq-dim">${esc(safeHost(t.root))} · <code>${esc(t.key ? maskKey(t.key) : "—")}</code></div>
        </div>
        <div class="kq-card-val">
            <div class="kq-card-money">${r?.busy ? `<i class="fa-solid fa-spinner fa-spin"></i>` : esc(err && !snap ? "!" : money)}</div>
            ${msgLine ? `<div class="kq-card-msgs">${msgLine}</div>` : ""}
            ${snap?.shared ? `<div class="kq-card-msgs kq-lowtext" title="ยอดของบัญชีที่ออกคีย์ อาจรวมของคนอื่น">ยอดบัญชี (อาจรวมคนอื่น)</div>` : ""}
            ${snap?.uidOk ? `<div class="kq-card-msgs kq-dim">ยอดของ UID</div>` : ""}
        </div>
        <i class="fa-solid fa-chevron-${open ? "up" : "down"} kq-chev"></i>
      </div>`;
    if (pct !== null) html += `<div class="kq-bar"><div class="kq-bar-fill ${pct < 15 ? "kq-low" : ""}" style="width:${pct.toFixed(1)}%"></div></div>`;
    if (err) html += `<div class="kq-error">${esc(err)}</div>`;

    if (open) {
        html += `<div class="kq-card-body">`;
        html += `<div class="kq-row">
            <div class="kq-sub">${snap ? `${esc(KIND_LABEL[snap.kind] || snap.kind)}${snap.tokenName ? ` · “${esc(snap.tokenName)}”` : ""} · เช็คเมื่อ ${esc(timeAgo(snap.checkedAt))}` : "ยังไม่ได้เช็ค"}</div>
            ${t.error ? "" : `<div class="menu_button kq-btn" data-kq="check-one" data-id="${esc(t.id)}"><i class="fa-solid fa-rotate"></i> เช็คคีย์นี้</div>`}
        </div>`;
        if (snap?.note) html += `<div class="kq-note">${esc(snap.note)}</div>`;
        if (snap && typeof snap.remainingUsd === "number") {
            html += `<div class="kq-stats">
                ${stat("คงเหลือ", fmtMoney(snap.remainingUsd, est.cur), fmtQuota(snap.remainingUsd, snap))}
                ${stat("ใช้ไปแล้ว", fmtMoney(snap.usedUsd, est.cur), fmtQuota(snap.usedUsd, snap))}
                ${stat("ทั้งหมด", fmtMoney(snap.totalUsd, est.cur), fmtQuota(snap.totalUsd, snap))}
                ${snap.expiresAt ? stat("หมดอายุ", new Date(snap.expiresAt).toLocaleDateString()) : ""}
                ${snap.requestCount ? stat("ส่งไปแล้ว", `${snap.requestCount.toLocaleString()} ครั้ง`) : ""}
                ${snap.group ? stat("กลุ่มราคา", snap.group) : ""}
            </div>`;
        } else if (snap?.unlimited) {
            html += `<div class="kq-stats">${stat("คงเหลือ", "ไม่จำกัด")}${stat("ใช้ไปแล้ว", fmtMoney(snap.usedUsd, est.cur), fmtQuota(snap.usedUsd, snap))}</div>`;
        }

        // หน้าเช็คของร้าน
        if (!t.error) {
            const ck = s.checkers?.[t.id] || autoChecker(t.root, t.labels) || {};
            const opts = [`<option value="">${autoChecker(t.root, t.labels) ? "อัตโนมัติ" : "วิธีมาตรฐาน (new-api / one-api)"}</option>`,
                `<option value="standard" ${ck.type === "standard" ? "selected" : ""}>วิธีมาตรฐาน (new-api / one-api)</option>`]
                .concat(Object.entries(STORE_CHECKERS).map(([k, v]) => `<option value="${esc(k)}" ${ck.type === k && !ck.auto ? "selected" : ""}>${esc(v.label)}</option>`));
            if (ck.auto) opts[0] = `<option value="" selected>อัตโนมัติ: ${esc(STORE_CHECKERS[ck.type]?.label || ck.type)}${ck.byName ? " (จากชื่อ)" : ""}</option>`;
            html += `<div class="kq-uid">
                <div class="kq-section-title"><i class="fa-solid fa-store"></i> วิธีเช็คยอด</div>
                <div class="kq-uid-row">
                    <select class="text_pole" data-kq="checker" data-id="${esc(t.id)}">${opts.join("")}</select>
                    ${ck.type === "popko" ? `<input type="text" class="text_pole" data-kq="checker-provider" data-field="provider" data-id="${esc(t.id)}" placeholder="provider${s.lastPopkoProvider ? ` (ใช้ ${esc(s.lastPopkoProvider)})` : " เช่น xing"}" value="${esc(ck.provider || "")}">` : ""}
                    ${ck.type === "rvl" && !rvlChannelOf(t.root) ? `<input type="number" min="1" class="text_pole" data-kq="checker-provider" data-field="channel" data-id="${esc(t.id)}" placeholder="channel เช่น 8" value="${esc(ck.channel || "")}">` : ""}
                    ${ck.type === "rvl" ? `<input type="text" class="text_pole" data-kq="checker-provider" data-field="series" data-id="${esc(t.id)}" placeholder="series (อัตโนมัติ: ${esc(RVL_SERIES[Number(ck.channel) || rvlChannelOf(t.root)] || "?")})" value="${esc(ck.series || "")}">` : ""}
                </div>
                <small class="kq-dim">ถ้าร้านมีหน้าเช็คยอดของตัวเอง เลือกที่นี่จะได้ยอดของคีย์คุณจริงๆ (ไม่ใช่ยอดรวม)</small>
            </div>`;
        }

        // UID ของบัญชี (ยอดของตัวเอง)
        if (!t.error && !(s.checkers?.[t.id]?.type && s.checkers[t.id].type !== "standard") && !(!s.checkers?.[t.id] && autoChecker(t.root, t.labels))) {
            const ua = s.userAuth?.[t.id] || {};
            html += `<div class="kq-uid">
                <div class="kq-section-title"><i class="fa-solid fa-id-badge"></i> ยอดของบัญชีตัวเอง (UID)</div>
                <div class="kq-uid-row">
                    <input type="text" inputmode="numeric" class="text_pole" data-kq="uid" data-id="${esc(t.id)}" placeholder="UID เช่น 1234" value="${esc(ua.uid || "")}">
                    <input type="password" class="text_pole" data-kq="uid-token" data-id="${esc(t.id)}" placeholder="Access Token (ถ้ามี)" autocomplete="off" value="${esc(ua.token || "")}">
                    <div class="menu_button kq-btn fa-solid fa-eye" data-kq="uid-show" data-id="${esc(t.id)}" title="แสดง/ซ่อน"></div>
                </div>
                <small class="kq-dim">ใส่ UID ที่ร้านให้มา ถ้าร้านไม่ยอมรับ sk-key ให้ใส่ Access Token ของบัญชีด้วย (บนเว็บร้าน: ตั้งค่าส่วนตัว → 系统访问令牌 / Access Token)</small>
            </div>`;
        }

        // แพ็กรายข้อความของคีย์นี้
        if (!t.error) {
            html += `<div class="kq-pack">
                <label class="checkbox_label"><input type="checkbox" data-kq="pack-on" data-id="${esc(t.id)}" ${pack.enabled ? "checked" : ""}/><span>ซื้อแบบนับข้อความ</span></label>
                ${pack.enabled ? `
                <div class="kq-pack-ctrl">
                    <span>ซื้อมา</span><input type="number" min="0" class="text_pole kq-num" data-kq="pack-total" data-id="${esc(t.id)}" value="${esc(pack.total || 0)}">
                    <span>ใช้ไป</span><input type="number" min="0" class="text_pole kq-num" data-kq="pack-used" data-id="${esc(t.id)}" value="${esc(pack.used || 0)}">
                    <div class="menu_button kq-btn" data-kq="pack-minus" data-id="${esc(t.id)}">−1</div>
                    <div class="menu_button kq-btn" data-kq="pack-plus" data-id="${esc(t.id)}">+1</div>
                </div>` : ""}
            </div>`;
        }

        // ตารางโมเดล
        const rows = est.rows;
        if (rows.length) {
            const q = String(view.search?.[t.id] || "").toLowerCase();
            html += `<input class="text_pole kq-search" type="search" data-id="${esc(t.id)}" placeholder="ค้นหาโมเดล..." value="${esc(view.search?.[t.id] || "")}">
            <div class="kq-table-wrap"><table class="kq-table">
            <thead><tr><th>โมเดล</th><th>ต่อข้อความ</th><th>${est.storeCounted ? "เหลือ / ทั้งหมด" : "เหลือ"}</th><th>ที่มา</th></tr></thead><tbody>`;
            let shown = 0;
            for (const x of rows) {
                if (q && !x.model.toLowerCase().includes(q)) continue;
                if (++shown > 150) break;
                const low = x.messages !== null && x.messages <= (Number(s.warnMessages) || 0);
                html += `<tr class="${x.current ? "kq-current" : ""}">
                    <td>${x.current ? `<i class="fa-solid fa-star"></i> ` : ""}${esc(x.model)}</td>
                    <td>${x.perMsgUsd ? esc(fmtMoney(x.perMsgUsd, est.cur)) : "—"}</td>
                    <td class="${low ? "kq-lowtext" : ""}">${x.messages !== null && x.messages !== undefined ? esc(est.storeCounted ? `${x.messages.toLocaleString()} / ${(x.total ?? "?").toLocaleString()}` : fmtCount(x.messages)) : "—"}</td>
                    <td class="kq-src">${esc(x.source || "ไม่มีราคา")}${x.samples ? ` (${x.samples})` : ""}</td></tr>`;
            }
            html += `</tbody></table></div>`;
        } else if (snap) {
            html += `<div class="kq-note">ร้านนี้ไม่เปิดตารางราคา — ส่งข้อความด้วยคีย์นี้สักครั้ง extension จะวัดราคาจริงให้ หรือกรอกราคาเองในหน้าตั้งค่า</div>`;
        }
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

/** ข้อความสั้นใต้ปุ่มในเมนูไม้คทา (เฉพาะคีย์ที่กำลังใช้) */
export function wandText(t, r, s, getPack, count) {
    if (!t) return { text: count ? `${count} คีย์` : "", warn: false, title: "" };
    const sm = summarize(t, r, s, getPack);
    const parts = [];
    if (r?.error && !sm.snap) return { text: "เช็คไม่ได้", warn: true, title: r.error };
    if (sm.snap) parts.push(sm.money);
    if (sm.row && sm.row.messages !== null && !sm.est.storeCounted) parts.push(`≈${sm.row.messages >= 100000 ? "99k+" : sm.row.messages.toLocaleString()} ข้อความ`);
    if (sm.packLeft !== null) parts.push(`แพ็ก ${sm.packLeft}`);
    if (count > 1) parts.push(`+${count - 1} คีย์`);
    return { text: parts.join(" · "), warn: sm.warn, title: t.labels.join(" · ") };
}
