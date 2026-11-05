import { firebaseConfig } from "./firebase-config.js";

const FB_VERSION = "10.12.2";
const COLORS = ["#e8618c", "#3b82f6", "#16a34a", "#f59e0b", "#8b5cf6", "#0ea5a4", "#ef4444", "#64748b"];
const EARN_CHIPS = ["Allowance", "Chores", "Gift", "Birthday", "Good grades"];
const SPEND_CHIPS = ["Toy", "Candy", "Game", "Book", "Savings goal"];

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

const state = { kids: [], tx: [], meta: {}, ready: false };
let backend;
let familyCode;

// ---------- helpers ----------

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (cents) => {
  const sign = cents < 0 ? "-" : "";
  return sign + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtMonth = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
const randomCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function hashPin(pin) {
  const data = new TextEncoder().encode(familyCode + ":" + pin);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}
const initial = (name) => esc((name || "?").trim().charAt(0).toUpperCase());

function balances() {
  const map = {};
  for (const k of state.kids) map[k.id] = { balance: 0, earned: 0, spent: 0 };
  for (const t of state.tx) {
    const b = map[t.kidId];
    if (!b) continue;
    if (t.type === "earn") { b.balance += t.cents; b.earned += t.cents; }
    else { b.balance -= t.cents; b.spent += t.cents; }
  }
  return map;
}
// Newest first; ties broken by when the entry was created.
const sortTx = (list) => [...list].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
const kidById = (id) => state.kids.find((k) => k.id === id);
const canEdit = () => !state.meta.pinHash || store.get("pb-unlocked") === state.meta.pinHash;
const isDemo = () => !firebaseConfig.apiKey;

// ---------- backends ----------

function localBackend() {
  const KEY = "pb-demo-data";
  let listener = () => {};
  const load = () => {
    try { return JSON.parse(store.get(KEY)) || { kids: [], tx: [], meta: {} }; }
    catch { return { kids: [], tx: [], meta: {} }; }
  };
  const save = (data) => { store.set(KEY, JSON.stringify(data)); listener(data); };
  const mutate = (fn) => { const d = load(); fn(d); save(d); };
  window.addEventListener("storage", (e) => { if (e.key === KEY) listener(load()); });
  return {
    subscribe(fn) { listener = fn; fn(load()); },
    async saveKid(kid) { mutate((d) => { const i = d.kids.findIndex((k) => k.id === kid.id); i >= 0 ? (d.kids[i] = kid) : d.kids.push(kid); }); },
    async deleteKid(id) { mutate((d) => { d.kids = d.kids.filter((k) => k.id !== id); d.tx = d.tx.filter((t) => t.kidId !== id); }); },
    async saveTx(tx) { mutate((d) => { const i = d.tx.findIndex((t) => t.id === tx.id); i >= 0 ? (d.tx[i] = tx) : d.tx.push(tx); }); },
    async deleteTx(id) { mutate((d) => { d.tx = d.tx.filter((t) => t.id !== id); }); },
    async saveMeta(meta) { mutate((d) => { d.meta = { ...d.meta, ...meta }; }); },
  };
}

async function firebaseBackend(code) {
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fs = await import(`${base}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  let db;
  try {
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch {
    db = fs.getFirestore(app);
  }
  const col = (name) => fs.collection(db, "families", code, name);
  const ref = (name, id) => fs.doc(db, "families", code, name, id);
  const strip = ({ id, ...rest }) => rest;
  return {
    subscribe(fn) {
      const data = { kids: [], tx: [], meta: {} };
      const loaded = new Set();
      const emit = (part) => { loaded.add(part); if (loaded.size === 3) fn({ ...data }); };
      const onErr = (err) => { console.error(err); toast("Can't reach the database. Check your connection."); };
      fs.onSnapshot(col("kids"), (snap) => { data.kids = snap.docs.map((d) => ({ id: d.id, ...d.data() })); emit("kids"); }, onErr);
      fs.onSnapshot(col("tx"), (snap) => { data.tx = snap.docs.map((d) => ({ id: d.id, ...d.data() })); emit("tx"); }, onErr);
      fs.onSnapshot(ref("meta", "settings"), (snap) => { data.meta = snap.exists() ? snap.data() : {}; emit("meta"); }, onErr);
    },
    saveKid: (kid) => fs.setDoc(ref("kids", kid.id), strip(kid)),
    async deleteKid(id) {
      const batch = fs.writeBatch(db);
      batch.delete(ref("kids", id));
      for (const t of state.tx.filter((t) => t.kidId === id)) batch.delete(ref("tx", t.id));
      await batch.commit();
    },
    saveTx: (tx) => fs.setDoc(ref("tx", tx.id), strip(tx)),
    deleteTx: (id) => fs.deleteDoc(ref("tx", id)),
    saveMeta: (meta) => fs.setDoc(ref("meta", "settings"), meta, { merge: true }),
  };
}

// ---------- family link ----------

function shareLink(wall = false) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = wall ? "#/wall" : "";
  url.searchParams.set("family", familyCode);
  return url.toString();
}

function readFamilyCode() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("family");
  if (fromUrl && /^[a-z0-9]{20,64}$/.test(fromUrl)) {
    store.set("pb-family", fromUrl);
    url.searchParams.delete("family");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return store.get("pb-family");
}

// ---------- rendering ----------

function render() {
  const app = $("#app");
  if (!familyCode) return renderWelcome(app);
  if (!state.ready) { app.innerHTML = `<div class="loading">Loading…</div>`; return; }
  const route = location.hash.replace(/^#\/?/, "").split("/");
  document.body.classList.toggle("wall", route[0] === "wall");
  if (route[0] === "kid" && kidById(route[1])) return renderKid(app, route[1]);
  if (route[0] === "settings") return renderSettings(app);
  if (route[0] === "wall") return renderWall(app);
  renderHome(app);
}

function header(title, { back = false } = {}) {
  return `<header class="top">
    ${back ? `<button class="back-btn" data-go="#/">‹ Back</button><h1></h1>` : `<h1><img src="icons/icon.svg" alt="">${esc(title)}</h1>`}
    ${back ? "" : `<button class="icon-btn" data-go="#/wall" aria-label="Wall display" title="Wall display">🖥️</button>
    <button class="icon-btn" data-go="#/settings" aria-label="Settings" title="Settings">⚙️</button>`}
  </header>`;
}

function demoBanner() {
  return isDemo() ? `<div class="banner">Demo mode: entries are saved on this device only until the database is connected.</div>` : "";
}

function lockedBanner() {
  return canEdit() ? "" : `<div class="banner">🔒 View only on this device. <button class="btn small" data-act="unlock">Unlock</button></div>`;
}

function renderWelcome(app) {
  app.innerHTML = `<div class="wrap">
    <header class="top"><h1><img src="icons/icon.svg" alt="">Piggy Bank</h1></header>
    <div class="empty">
      <p style="font-size:1.1rem;font-weight:800;margin-top:0">Track what the kids earn and spend.</p>
      <p>Start a new family ledger here. Then open the family link on every other phone or screen that should see it.</p>
      <button class="btn primary" data-act="new-family">Start a family ledger</button>
      <p class="hint" style="margin-top:18px">Already set up on another phone? Open the family link from there, or scan its QR code in Settings.</p>
    </div>
  </div>`;
}

function renderHome(app) {
  const bal = balances();
  const total = state.kids.reduce((s, k) => s + bal[k.id].balance, 0);
  const recent = (id) => sortTx(state.tx.filter((t) => t.kidId === id))[0];
  const cards = state.kids.map((k) => {
    const last = recent(k.id);
    const sub = last ? `${last.type === "earn" ? "+" : "−"}${money(last.cents)} · ${esc(last.note || (last.type === "earn" ? "Earned" : "Spent"))}` : "No entries yet";
    const b = bal[k.id].balance;
    return `<button class="kid-card" style="--kid:${esc(k.color)}" data-go="#/kid/${esc(k.id)}">
      <div class="avatar">${initial(k.name)}</div>
      <div class="info"><div class="name">${esc(k.name)}</div><div class="sub">${sub}</div></div>
      <div class="balance ${b < 0 ? "neg" : ""}">${money(b)}</div>
    </button>`;
  }).join("");
  app.innerHTML = `<div class="wrap">
    ${header("Piggy Bank")}
    ${demoBanner()}${lockedBanner()}
    ${state.kids.length > 1 ? `<div class="family-total">All kids together: ${money(total)}</div>` : ""}
    <div class="kids">${cards || `<div class="empty"><p>No kids added yet.</p>${canEdit() ? `<button class="btn primary" data-act="add-kid">Add a kid</button>` : ""}</div>`}</div>
  </div>
  ${canEdit() && state.kids.length ? `<button class="fab" data-act="add-tx">+ Add entry</button>` : ""}`;
}

function renderKid(app, kidId) {
  const kid = kidById(kidId);
  const b = balances()[kidId];
  const list = sortTx(state.tx.filter((t) => t.kidId === kidId));
  // Running balance after each entry, computed oldest to newest.
  const running = {};
  let acc = 0;
  for (const t of [...list].reverse()) { acc += t.type === "earn" ? t.cents : -t.cents; running[t.id] = acc; }
  let month = "";
  const rows = list.map((t) => {
    const m = (t.date || "").slice(0, 7);
    const head = m !== month ? `<div class="month">${esc(fmtMonth(t.date))}</div>` : "";
    month = m;
    return `${head}<button class="row" data-edit-tx="${esc(t.id)}" ${canEdit() ? "" : "disabled"}>
      <div class="note">${esc(t.note || (t.type === "earn" ? "Earned" : "Spent"))}</div>
      <div class="amt ${t.type}">${t.type === "earn" ? "+" : "−"}${money(t.cents)}</div>
      <div class="when">${esc(fmtDate(t.date))}</div>
      <div class="run">bal ${money(running[t.id])}</div>
    </button>`;
  }).join("");
  app.innerHTML = `<div class="wrap">
    ${header("", { back: true })}
    ${lockedBanner()}
    <div class="kid-hero" style="--kid:${esc(kid.color)}">
      <div class="avatar">${initial(kid.name)}</div>
      <div>
        <div class="label">${esc(kid.name)}'s balance</div>
        <div class="big">${money(b.balance)}</div>
        <div class="stats">Earned ${money(b.earned)} · Spent ${money(b.spent)}</div>
      </div>
    </div>
    ${canEdit() ? `<div class="actions">
      <button class="btn earn" data-act="add-tx" data-kid="${esc(kidId)}" data-type="earn">+ Earned</button>
      <button class="btn spend" data-act="add-tx" data-kid="${esc(kidId)}" data-type="spend">− Spent</button>
    </div>` : ""}
    <h2 class="section">History</h2>
    ${rows ? `<div class="ledger">${rows}</div>` : `<div class="empty">No entries yet.</div>`}
  </div>`;
}

function renderSettings(app) {
  const kids = state.kids.map((k) => `<div class="list-item">
      <div class="avatar" style="background:${esc(k.color)}">${initial(k.name)}</div>
      <div class="grow"><strong>${esc(k.name)}</strong></div>
      ${canEdit() ? `<button class="btn small" data-act="edit-kid" data-kid="${esc(k.id)}">Edit</button>` : ""}
    </div>`).join("");
  app.innerHTML = `<div class="wrap">
    ${header("", { back: true })}
    <h2 class="section" style="margin-top:0">Kids</h2>
    ${kids ? `<div class="list">${kids}</div>` : `<p class="hint">No kids yet.</p>`}
    ${canEdit() ? `<button class="btn" data-act="add-kid">+ Add a kid</button>` : ""}

    <h2 class="section">Share with family</h2>
    <p class="hint">Open this link on your partner's phone. On iPhone use Share › Add to Home Screen; on Android use the ⋮ menu › Add to Home screen. Anyone with this link can see the ledger, so only share it with family.</p>
    ${window.QRCode ? `<div class="qr" id="qr-main"></div>` : ""}
    <div class="linkbox">${esc(shareLink())}</div>
    <button class="btn" data-act="copy" data-link="${esc(shareLink())}">Copy link</button>

    <h2 class="section">Wall calendar (Apolosign)</h2>
    <p class="hint">Open this link in Chrome on the Apolosign for a big, view-only screen that updates on its own.</p>
    <div class="linkbox">${esc(shareLink(true))}</div>
    <button class="btn" data-act="copy" data-link="${esc(shareLink(true))}">Copy wall link</button>

    <h2 class="section">Parent PIN</h2>
    <p class="hint">${state.meta.pinHash
      ? (canEdit() ? "A PIN is set and this device is unlocked. Other devices stay view-only until someone enters the PIN." : "This device is view-only. Enter the PIN to add or change entries.")
      : "No PIN yet, so anyone with the link can add entries. Set one so only parents can make changes."}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${canEdit() ? `<button class="btn" data-act="set-pin">${state.meta.pinHash ? "Change PIN" : "Set a PIN"}</button>` : `<button class="btn primary" data-act="unlock">Unlock</button>`}
      ${state.meta.pinHash && canEdit() ? `<button class="btn" data-act="lock">Lock this device</button>` : ""}
    </div>
    ${isDemo() ? `<h2 class="section">Demo mode</h2><p class="hint">The database isn't connected yet, so data stays on this device only.</p>` : ""}
  </div>`;
  if (window.QRCode) new QRCode($("#qr-main"), { text: shareLink(), width: 180, height: 180 });
}

function renderWall(app) {
  const bal = balances();
  const total = state.kids.reduce((s, k) => s + bal[k.id].balance, 0);
  const n = state.kids.length;
  // Up to three kids sit side by side; four make a 2x2 grid; more wrap three across.
  const cols = n <= 3 ? Math.max(n, 1) : n === 4 ? 2 : 3;
  const cards = state.kids.map((k) => {
    const items = sortTx(state.tx.filter((t) => t.kidId === k.id)).slice(0, 6).map((t) =>
      `<li><span class="n">${esc(t.note || (t.type === "earn" ? "Earned" : "Spent"))}</span><span class="a amt ${t.type}">${t.type === "earn" ? "+" : "−"}${money(t.cents)}</span></li>`).join("");
    const b = bal[k.id].balance;
    return `<div class="wall-card" style="--kid:${esc(k.color)}">
      <div class="who"><div class="avatar" style="background:${esc(k.color)}">${initial(k.name)}</div>${esc(k.name)}</div>
      <div class="bal ${b < 0 ? "neg" : ""}">${money(b)}</div>
      <ul>${items || `<li><span class="n" style="color:var(--muted)">No entries yet</span></li>`}</ul>
    </div>`;
  }).join("");
  app.innerHTML = `<div class="wall-view">
    <div class="wall-head">
      <h1><img src="icons/icon.svg" alt="">Piggy Bank</h1>
      ${n > 1 ? `<div class="total">Together: ${money(total)}</div>` : ""}
    </div>
    <div class="wall-grid" style="--cols:${cols}">${cards || `<div class="empty">No kids added yet.</div>`}</div>
  </div>
  <button class="btn small ghost wall-exit" data-go="#/">Exit</button>`;
}

// ---------- modals ----------

function openModal(html, onMount) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const overlay = $(".overlay", root);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  onMount?.($(".sheet", root));
}
const closeModal = () => { $("#modal-root").innerHTML = ""; render(); };

function txModal({ tx, kidId, type = "earn" } = {}) {
  if (!state.kids.length) return kidModal();
  const editing = !!tx;
  let cur = {
    kidId: tx?.kidId || kidId || (state.kids.length === 1 ? state.kids[0].id : ""),
    type: tx?.type || type,
  };
  openModal(`
    <h3>${editing ? "Edit entry" : "New entry"}</h3>
    <div class="kid-pick">${state.kids.map((k) => `<button type="button" style="--kid:${esc(k.color)}" data-pick="${esc(k.id)}">${esc(k.name)}</button>`).join("")}</div>
    <div class="seg">
      <button type="button" class="earn" data-type="earn">+ Earned</button>
      <button type="button" class="spend" data-type="spend">− Spent</button>
    </div>
    <label class="field"><span>Amount</span><input class="amount-input" id="f-amt" inputmode="decimal" placeholder="$0.00" value="${tx ? (tx.cents / 100).toFixed(2) : ""}"></label>
    <label class="field"><span>What for?</span><input id="f-note" maxlength="200" placeholder="e.g. Mowed the lawn" value="${esc(tx?.note || "")}"></label>
    <div class="chips" id="chips"></div>
    <label class="field"><span>Date</span><input id="f-date" type="date" value="${esc(tx?.date || todayISO())}"></label>
    <div class="sheet-actions">
      ${editing ? `<button class="btn danger" data-m="delete">Delete</button><span class="spacer"></span>` : ""}
      <button class="btn ghost" data-m="cancel">Cancel</button>
      <button class="btn primary" data-m="save">Save</button>
    </div>`, (sheet) => {
    const sync = () => {
      sheet.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("on", b.dataset.pick === cur.kidId));
      sheet.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("on", b.dataset.type === cur.type));
      $("#chips", sheet).innerHTML = (cur.type === "earn" ? EARN_CHIPS : SPEND_CHIPS).map((c) => `<button type="button" class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join("");
    };
    sync();
    sheet.addEventListener("click", async (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.pick) { cur.kidId = t.dataset.pick; sync(); }
      else if (t.dataset.type) { cur.type = t.dataset.type; sync(); }
      else if (t.dataset.chip) { $("#f-note", sheet).value = t.dataset.chip; }
      else if (t.dataset.m === "cancel") closeModal();
      else if (t.dataset.m === "delete") {
        if (!confirmInline(t, "Tap again to delete")) return;
        await backend.deleteTx(tx.id); closeModal(); toast("Entry deleted");
      } else if (t.dataset.m === "save") {
        const cents = Math.round(parseFloat($("#f-amt", sheet).value.replace(/[$,\s]/g, "")) * 100);
        if (!cur.kidId) return toast("Pick a kid");
        if (!Number.isFinite(cents) || cents <= 0) return toast("Enter an amount above $0");
        const date = $("#f-date", sheet).value || todayISO();
        const note = $("#f-note", sheet).value.trim().slice(0, 200);
        t.disabled = true;
        try {
          await backend.saveTx({ id: tx?.id || newId(), kidId: cur.kidId, type: cur.type, cents, note, date, createdAt: tx?.createdAt || Date.now() });
          closeModal();
          toast(`${cur.type === "earn" ? "Added" : "Spent"} ${money(cents)} for ${kidById(cur.kidId)?.name}`);
        } catch (err) { console.error(err); t.disabled = false; toast("Couldn't save. Try again."); }
      }
    });
    if (!editing) setTimeout(() => $("#f-amt", sheet).focus(), 50);
  });
}

// Two-tap confirm that avoids blocking browser dialogs.
function confirmInline(btn, label) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1";
  btn.textContent = label;
  setTimeout(() => { delete btn.dataset.armed; }, 4000);
  return false;
}

function kidModal(kid) {
  const editing = !!kid;
  let color = kid?.color || COLORS[state.kids.length % COLORS.length];
  openModal(`
    <h3>${editing ? "Edit kid" : "Add a kid"}</h3>
    <label class="field"><span>Name</span><input id="k-name" maxlength="40" value="${esc(kid?.name || "")}" placeholder="Name"></label>
    <div class="field"><span>Color</span><div class="colors">${COLORS.map((c) => `<button type="button" style="background:${c}" data-color="${c}" aria-label="Color ${c}"></button>`).join("")}</div></div>
    ${editing ? "" : `<label class="field"><span>Starting balance (optional)</span><input id="k-start" inputmode="decimal" placeholder="$0.00"></label>`}
    <div class="sheet-actions">
      ${editing ? `<button class="btn danger" data-m="delete">Remove</button><span class="spacer"></span>` : ""}
      <button class="btn ghost" data-m="cancel">Cancel</button>
      <button class="btn primary" data-m="save">Save</button>
    </div>`, (sheet) => {
    const sync = () => sheet.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    sync();
    sheet.addEventListener("click", async (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.color) { color = t.dataset.color; sync(); }
      else if (t.dataset.m === "cancel") closeModal();
      else if (t.dataset.m === "delete") {
        if (!confirmInline(t, "Tap again: removes all their entries")) return;
        await backend.deleteKid(kid.id); closeModal(); location.hash = "#/settings"; toast(`${kid.name} removed`);
      } else if (t.dataset.m === "save") {
        const name = $("#k-name", sheet).value.trim().slice(0, 40);
        if (!name) return toast("Enter a name");
        const id = kid?.id || newId();
        t.disabled = true;
        await backend.saveKid({ id, name, color, createdAt: kid?.createdAt || Date.now() });
        const start = Math.round(parseFloat(($("#k-start", sheet)?.value || "").replace(/[$,\s]/g, "")) * 100);
        if (!editing && Number.isFinite(start) && start > 0) {
          await backend.saveTx({ id: newId(), kidId: id, type: "earn", cents: start, note: "Starting balance", date: todayISO(), createdAt: Date.now() });
        }
        closeModal();
        toast(editing ? "Saved" : `${name} added`);
      }
    });
    setTimeout(() => $("#k-name", sheet).focus(), 50);
  });
}

function pinModal(mode) {
  const title = mode === "unlock" ? "Enter parent PIN" : state.meta.pinHash ? "Change PIN" : "Set a parent PIN";
  openModal(`
    <h3>${title}</h3>
    <label class="field"><span>PIN (4 or more digits)</span><input id="p-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></label>
    ${mode === "unlock" ? "" : `<label class="field"><span>Type it again</span><input id="p-pin2" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></label>`}
    <div class="sheet-actions">
      ${mode !== "unlock" && state.meta.pinHash ? `<button class="btn danger" data-m="remove">Remove PIN</button><span class="spacer"></span>` : ""}
      <button class="btn ghost" data-m="cancel">Cancel</button>
      <button class="btn primary" data-m="ok">${mode === "unlock" ? "Unlock" : "Save PIN"}</button>
    </div>`, (sheet) => {
    sheet.addEventListener("click", async (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.m === "cancel") return closeModal();
      if (t.dataset.m === "remove") {
        if (!confirmInline(t, "Tap again to remove")) return;
        await backend.saveMeta({ pinHash: "" }); store.del("pb-unlocked"); closeModal(); toast("PIN removed"); return;
      }
      if (t.dataset.m !== "ok") return;
      const pin = $("#p-pin", sheet).value.trim();
      if (!/^\d{4,12}$/.test(pin)) return toast("Use 4 to 12 digits");
      const h = await hashPin(pin);
      if (mode === "unlock") {
        if (h !== state.meta.pinHash) return toast("Wrong PIN");
        store.set("pb-unlocked", h); closeModal(); render(); toast("Unlocked on this device");
      } else {
        if (pin !== $("#p-pin2", sheet).value.trim()) return toast("The PINs don't match");
        store.set("pb-unlocked", h);
        await backend.saveMeta({ pinHash: h }); closeModal(); toast("PIN saved");
      }
    });
    sheet.addEventListener("keydown", (e) => { if (e.key === "Enter") $("[data-m=ok]", sheet).click(); });
    setTimeout(() => $("#p-pin", sheet).focus(), 50);
  });
}

// ---------- events ----------

document.addEventListener("click", async (e) => {
  if (e.target.closest("#modal-root")) return;
  const el = e.target.closest("[data-go],[data-act],[data-edit-tx]");
  if (!el) return;
  if (el.dataset.go) { location.hash = el.dataset.go; return; }
  if (el.dataset.editTx) { if (canEdit()) txModal({ tx: state.tx.find((t) => t.id === el.dataset.editTx) }); return; }
  switch (el.dataset.act) {
    case "new-family": familyCode = randomCode(); store.set("pb-family", familyCode); await start(); break;
    case "add-tx": txModal({ kidId: el.dataset.kid, type: el.dataset.type }); break;
    case "add-kid": kidModal(); break;
    case "edit-kid": kidModal(kidById(el.dataset.kid)); break;
    case "set-pin": pinModal("set"); break;
    case "unlock": pinModal("unlock"); break;
    case "lock": store.del("pb-unlocked"); render(); toast("This device is now view-only"); break;
    case "copy":
      try { await navigator.clipboard.writeText(el.dataset.link); toast("Link copied"); }
      catch { toast("Press and hold the link to copy it"); }
      break;
  }
});
window.addEventListener("hashchange", () => { closeModal(); window.scrollTo(0, 0); });

// ---------- start ----------

async function start() {
  render();
  try {
    backend = isDemo() ? localBackend() : await firebaseBackend(familyCode);
  } catch (err) {
    console.error(err);
    $("#app").innerHTML = `<div class="wrap"><div class="empty">Couldn't load the app. Check your internet connection and reload.</div></div>`;
    return;
  }
  backend.subscribe((data) => {
    state.kids = [...data.kids].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    state.tx = data.tx;
    state.meta = data.meta || {};
    state.ready = true;
    if (!$("#modal-root").innerHTML) render();
  });
}

familyCode = readFamilyCode();
if (familyCode) start(); else render();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
