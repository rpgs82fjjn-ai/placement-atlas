// Placement Atlas daily reminders.
// Runs on GitHub Actions once a day. For each signed-in student it sends:
//   • deadline reminders 7 days and 1 day before a listing closes (listings they're tracking, or that fit them)
//   • alerts for new listings that fit their subject and year
// by device notification and (if they want) email. sent_log stops duplicates.
import fs from "node:fs";
import vm from "node:vm";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import nodemailer from "nodemailer";

const env = k => { const v = process.env[k]; if (!v) throw new Error(`Missing ${k}`); return v; };
const DRY = process.env.DRY_RUN === "1";
const SITE = (process.env.SITE_URL || "https://placement-atlas.netlify.app").replace(/\/$/, "");

// ---- Read listings straight from the website file so there's one source of truth.
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const grab = (start, end) => { const a = html.indexOf(start); const b = html.indexOf(end, a); if (a < 0 || b < 0) throw new Error("Couldn't find " + start); return html.slice(a + start.length - 1, b + end.replace(/;$/, "").length); };
const ZH = vm.runInNewContext("(" + grab("const ZH={", "\n};") + ")");
const ROWS = vm.runInNewContext("(" + grab("const ROWS=[", "\n]") + ")");
const REL = vm.runInNewContext("(" + grab("const REL={", "};") + ")");

// ---- Dates in Hong Kong time.
const hkToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" }).format(new Date());
const days = iso => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(hkToday + "T00:00:00Z")) / 864e5);
const fmt = (iso, lang) => new Date(iso + "T00:00:00Z").toLocaleDateString(lang === "zh" ? "zh-HK" : "en-GB", { timeZone: "UTC", day: "numeric", month: lang === "zh" ? "long" : "short", year: "numeric" });

// ---- Same matching rules as the website.
function relevant(r, p) {
  if (!p.subj) return 0;
  if (r.subj) return r.subj.includes(p.subj) ? 2 : 0;
  if (r.rel && r.rel.includes(p.subj)) return 2;
  if (r.rel) return r.anyDegree ? 1 : 0;
  if ((REL[p.subj] || []).includes(r.field)) return 2;
  if (r.anyDegree || r.field === "any") return 1;
  return 0;
}
function blocked(r, p) {
  if (p.year && r.yr && !r.yr.includes(p.year)) return true;
  if (p.subj && r.subj && !r.subj.includes(p.subj)) return true;
  if (r.req === "hkpr" && p.res && p.res !== "hkpr") return true;
  if (r.req === "hkuni" && p.uni && p.uni !== "hk") return true;
  return false;
}
const fits = (r, p) => p.subj && relevant(r, p) === 2 && !blocked(r, p);
const TRACKING = ["Researching", "Contacted"];
const t = (r, k, lang) => (lang === "zh" && ZH[r.id] && ZH[r.id][k]) || r[k] || "";

// ---- Clients.
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
webpush.setVapidDetails("mailto:" + env("GMAIL_USER"), env("VAPID_PUBLIC"), env("VAPID_PRIVATE"));
const mail = nodemailer.createTransport({ service: "gmail", auth: { user: env("GMAIL_USER"), pass: env("GMAIL_APP_PASSWORD") } });

async function all(table, cols = "*") {
  const out = []; let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw error; out.push(...data); if (data.length < 1000) return out; from += 1000;
  }
}
async function allUsers() {
  const m = new Map(); let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) if (u.email && u.email_confirmed_at) m.set(u.id, u.email);
    if (data.users.length < 1000) return m; page++;
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function compose(items, lang) {
  const zh = lang === "zh";
  const dl = items.filter(i => i.kind !== "new"), nw = items.filter(i => i.kind === "new");
  const line = i => i.kind === "new"
    ? `${t(i.r, "org", lang)}: ${t(i.r, "role", lang)}`
    : `${t(i.r, "org", lang)}${zh ? "：" : ": "}${zh ? fmt(i.r.closes, lang) + "截止" : "closes " + fmt(i.r.closes, lang)}`;
  const title = zh
    ? [dl.length ? `${dl.length} 個截止日期將至` : "", nw.length ? `${nw.length} 個適合你的新職位` : ""].filter(Boolean).join("，")
    : [dl.length ? `${dl.length} deadline${dl.length > 1 ? "s" : ""} coming up` : "", nw.length ? `${nw.length} new job${nw.length > 1 ? "s" : ""} for you` : ""].filter(Boolean).join(" · ");
  const body = items.slice(0, 3).map(line).join("\n") + (items.length > 3 ? (zh ? `\n另有 ${items.length - 3} 項` : `\n+${items.length - 3} more`) : "");
  const url = `${SITE}/#row-${items[0].r.id}`;
  const li = i => `<li style="margin:0 0 10px"><a href="${SITE}/#row-${i.r.id}" style="color:#2843b8;font-weight:600">${esc(t(i.r, "org", lang))}</a> – ${esc(t(i.r, "role", lang))}<br><span style="color:#5b6170">${i.kind === "new" ? esc(t(i.r, "deadline", lang)) : esc(zh ? `${fmt(i.r.closes, lang)}截止（尚餘 ${days(i.r.closes)} 日）` : `Closes ${fmt(i.r.closes, lang)} (${days(i.r.closes)} day${days(i.r.closes) === 1 ? "" : "s"} left)`)}</span></li>`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#1b1f2a">
<h2 style="font-size:20px">${esc(title)}</h2>
${dl.length ? `<h3 style="font-size:16px">${zh ? "截止日期將至" : "Deadlines coming up"}</h3><ul style="padding-left:18px">${dl.map(li).join("")}</ul>` : ""}
${nw.length ? `<h3 style="font-size:16px">${zh ? "適合你的新職位" : "New jobs that fit you"}</h3><ul style="padding-left:18px">${nw.map(li).join("")}</ul>` : ""}
<p style="color:#5b6170;font-size:13px">${zh ? "請務必在官方網頁確認截止時間。" : "Always check the exact closing time on the official page."}<br>
${zh ? `更改提醒設定或刪除帳戶：<a href="${SITE}/">${SITE.replace("https://", "")}</a>` : `Change your alert settings or delete your account: <a href="${SITE}/">${SITE.replace("https://", "")}</a>`}</p></div>`;
  return { title, body, url, html, text: `${title}\n\n${items.map(line).join("\n")}\n\n${SITE}/` };
}

async function main() {
  const [users, profiles, subs, sent, known] = await Promise.all([
    allUsers(), all("profiles"), all("push_subs"), all("sent_log", "user_id,kind,item"), all("known_jobs", "id")
  ]);
  const sentSet = new Set(sent.map(s => `${s.user_id}|${s.kind}|${s.item}`));
  const knownSet = new Set(known.map(k => k.id));
  const firstRun = knownSet.size === 0;
  const newRows = firstRun ? [] : ROWS.filter(r => !knownSet.has(r.id));
  const subsBy = new Map(); for (const s of subs) { if (!subsBy.has(s.user_id)) subsBy.set(s.user_id, []); subsBy.get(s.user_id).push(s); }
  console.log(`Today ${hkToday} · ${ROWS.length} listings · ${newRows.length} new · ${profiles.length} profiles · ${subs.length} devices`);

  let pushes = 0, emails = 0;
  for (const pr of profiles) {
    const p = pr.prof || {}, st = (pr.state && pr.state.status) || {}, lang = pr.lang === "zh" ? "zh" : "en";
    const items = [];
    if (pr.notify_deadlines) for (const r of ROWS) {
      if (!r.closes) continue;
      const d = days(r.closes); if (d < 0 || d > 7) continue;
      const tracked = TRACKING.includes(st[r.id]);
      const done = ["Applied", "Interview", "Offer", "Declined / closed"].includes(st[r.id]);
      if (done || !(tracked || fits(r, p))) continue;
      const kind = d <= 1 ? "d1" : "d7";
      if (!sentSet.has(`${pr.user_id}|${kind}|${r.id}`)) items.push({ kind, r });
    }
    if (pr.notify_new) for (const r of newRows) if (fits(r, p) && !sentSet.has(`${pr.user_id}|new|${r.id}`)) items.push({ kind: "new", r });
    if (!items.length) continue;

    const m = compose(items, lang);
    let delivered = false;
    for (const s of subsBy.get(pr.user_id) || []) {
      if (DRY) { console.log("[dry] push", pr.user_id, m.title); delivered = true; continue; }
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: "pa-" + hkToday }), { TTL: 86400 }); pushes++; delivered = true; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await sb.from("push_subs").delete().eq("id", s.id); else console.warn("push failed", e.statusCode || e.message); }
    }
    const email = users.get(pr.user_id);
    if (email && (pr.notify_email || !delivered)) {
      if (DRY) { console.log("[dry] email", email.replace(/(.).*@/, "$1***@"), m.title); delivered = true; }
      else {
        try { await mail.sendMail({ from: `Placement Atlas <${env("GMAIL_USER")}>`, to: email, subject: m.title, text: m.text, html: m.html }); emails++; delivered = true; }
        catch (e) { console.warn("email failed", e.message); }
      }
    }
    if (delivered && !DRY) {
      const { error } = await sb.from("sent_log").upsert(items.map(i => ({ user_id: pr.user_id, kind: i.kind, item: i.r.id })), { onConflict: "user_id,kind,item", ignoreDuplicates: true });
      if (error) console.warn("sent_log", error.message);
    }
  }
  if (!DRY) {
    const add = ROWS.filter(r => !knownSet.has(r.id)).map(r => ({ id: r.id }));
    if (add.length) { const { error } = await sb.from("known_jobs").upsert(add, { onConflict: "id", ignoreDuplicates: true }); if (error) console.warn("known_jobs", error.message); }
  }
  console.log(`Sent ${pushes} notifications and ${emails} emails${firstRun ? " (first run: recorded current listings; new-job alerts start tomorrow)" : ""}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
