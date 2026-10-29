document.getElementById("si-form").addEventListener("submit", (e) => e.preventDefault());

(() => {
  const COLS = ["todo", "doing", "done"];
  const COLORS = ["pink", "yellow", "blue", "green", "orange", "lilac", "mint"];
  const COLOR_NAMES = { pink: "Pink", yellow: "Yellow", blue: "Blue", green: "Green", orange: "Orange", lilac: "Lilac", mint: "Mint" };
  const WIP_LIMIT = 3;
  const DAY = 864e5;
  const LOCAL_KEY = "sticky-desk-v2";
  // Your projects and notes from the photo, used only when the board is opened without your account.
  const SAMPLE = {
    projects: [
      { id: "p-beevo", name: "Beevo Partner Portal", color: "pink", order: 1 },
      { id: "p-notif", name: "Notification UX", color: "yellow", order: 2 },
      { id: "p-general", name: "General", color: "blue", order: 3 },
    ],
    notes: [
      { id: "s1", text: "PDF feedback", column: "doing", projectId: "p-general", order: 1, due: "+1" },
      { id: "s2", text: "START\nBeevo Partner Portal", column: "todo", projectId: "p-beevo", order: 1, priority: 2, flagged: true },
      { id: "s3", text: "Complete Notification UX", column: "todo", projectId: "p-notif", order: 2 },
    ],
  };

  const $ = (s) => document.querySelector(s);
  const board = $("#board"), trash = $("#trash"), hand = $("#hand"), editText = $("#edit-text");
  let notes = [], projects = [];
  let mode = "loading"; // "account" | "local"
  let db = null;
  let view = { project: "all", filter: "all", q: "", group: false, collapsed: [] };
  let drag = null, editing = null, projEditing = null, renderPending = false, lastDeleted = null, toastTimer = null;

  try { const v = JSON.parse(localStorage.getItem("sticky-desk-view") || "null"); if (v) view = { ...view, ...v, q: "" }; } catch (e) {}
  const saveView = () => { try { localStorage.setItem("sticky-desk-view", JSON.stringify({ project: view.project, filter: view.filter, group: view.group, collapsed: view.collapsed })); } catch (e) {} };

  /* ---------- dates ---------- */
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return ymd(d); };
  function dueInfo(due) {
    if (!due) return null;
    const n = diffDays(today(), due), d = parse(due);
    let label;
    if (n === 0) label = "Today";
    else if (n === 1) label = "TMR";
    else if (n === -1) label = "Yesterday";
    else if (n > 1 && n < 7) label = d.toLocaleDateString(undefined, { weekday: "short" });
    else label = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return { label, state: n < 0 ? "due-late" : n === 0 ? "due-today" : "" };
  }
  function advance(due, repeat) {
    let d = parse(due);
    const step = () => {
      if (repeat === "daily") d.setDate(d.getDate() + 1);
      else if (repeat === "weekdays") { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
      else if (repeat === "weekly") d.setDate(d.getDate() + 7);
      else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
    };
    step();
    while (ymd(d) < today()) step();
    return ymd(d);
  }

  /* ---------- helpers ---------- */
  const hash = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
  const tiltFor = (id) => ((hash(id) % 9) - 4) * 0.75 + "deg";
  const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sizeClass = (t) => { const n = (t || "").length; return n > 80 ? "xl" : n > 48 ? "l" : n > 22 ? "m" : ""; };
  const projOf = (n) => projects.find((p) => p.id === n.projectId);
  const colorOf = (n) => { const c = projOf(n)?.color; return COLORS.includes(c) ? c : "pink"; };
  const sortedProjects = () => [...projects].sort((a, b) => (a.order || 0) - (b.order || 0));
  const isToday = (ts) => ts && ymd(new Date(ts)) === today();

  function matches(n, filter = view.filter) {
    if (view.project !== "all" && n.projectId !== view.project) return false;
    if (filter === "today") { if (n.column === "done") return isToday(n.doneAt); if (!n.due || n.due > today()) return false; }
    if (filter === "scheduled" && (!n.due || n.column === "done")) return false;
    if (filter === "flagged" && !n.flagged) return false;
    if (filter === "waiting" && (!n.waitingOn || n.column === "done")) return false;
    if (view.q) {
      const q = view.q.toLowerCase();
      const hay = [n.text, n.details, ...(n.checklist || []).map((s) => s.t), projOf(n)?.name].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }
  const inCol = (c) => notes.filter((n) => n.column === c && !isArchived(n) && matches(n)).sort((a, b) => a.order - b.order);
  const grouped = () => view.group && view.project === "all" && projects.length > 1;
  const projRank = (n) => { const i = sortedProjects().findIndex((p) => p.id === n.projectId); return i < 0 ? 1e9 : i; };
  // what the column actually shows, in screen order
  const shownInCol = (c) => !grouped() ? inCol(c)
    : inCol(c).sort((a, b) => projRank(a) - projRank(b) || a.order - b.order).filter((n) => !view.collapsed.includes(n.projectId));

  let toastAction = null;
  // toast(msg, true) offers Undo; toast(msg, false, { label, run }) offers another action instead
  function toast(msg, undo, action) {
    $("#toast-msg").textContent = msg;
    toastAction = action || null;
    $("#toast-undo").textContent = action ? action.label : "Undo";
    $("#toast-undo").hidden = !undo && !action;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("#toast").hidden = true; lastDeleted = null; toastAction = null; }, action ? 9000 : undo ? 6000 : 4200);
  }
  // Only say something when notes stay in this browser, and only the first time.
  function setStatus() {
    if (mode !== "local") return;
    try {
      if (localStorage.getItem("sticky-desk-told-local")) return;
      localStorage.setItem("sticky-desk-told-local", "1");
    } catch (e) { return; }
    toast("Your notes are saved in this browser.");
  }

  /* ---------- storage ---------- */
  function saveLocal() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ notes, projects })); } catch (e) { toast("This browser is out of space, so the last change wasn't saved. Remove a few photo notes, then try again."); } }
  const strip = ({ id, ...body }) => body;
  async function put(kind, obj) {
    if (kind === "notes" && !undoing) obj = { ...obj, touchedAt: Date.now() };
    const list = kind === "notes" ? notes : projects;
    const i = list.findIndex((x) => x.id === obj.id);
    if (!undoing) remember(kind, i >= 0 ? list[i] : null, obj.id);
    if (i >= 0) list[i] = obj; else list.push(obj);
    render();
    if (mode === "account") {
      try { await db.collection(kind).doc(obj.id).set(strip(obj)); }
      catch (e) { toast("Couldn't save that change. Check your connection, then try again."); }
    } else { saveLocal(); queueSync(kind, obj.id, obj); }
  }
  async function del(kind, id) {
    const old = (kind === "notes" ? notes : projects).find((x) => x.id === id);
    if (old && !undoing) remember(kind, old, id);
    if (kind === "notes") notes = notes.filter((n) => n.id !== id); else projects = projects.filter((p) => p.id !== id);
    render();
    if (mode === "account") {
      try { await db.collection(kind).doc(id).delete(); }
      catch (e) { toast("Couldn't delete that. Check your connection, then try again."); }
    } else { saveLocal(); queueSync(kind, id, null, true); }
  }
  function removeNote(id) {
    const n = notes.find((x) => x.id === id); if (!n) return;
    lastDeleted = n; del("notes", id); toast("Note thrown away.", true);
  }

  function startLocal() {
    mode = "local";
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch (e) {}
    if (stored && Array.isArray(stored.notes)) { notes = stored.notes; projects = stored.projects || []; }
    else {
      projects = SAMPLE.projects.map((p) => ({ ...p }));
      notes = SAMPLE.notes.map((n) => ({ ...n, due: n.due === "+1" ? addDays(today(), 1) : n.due }));
    }
    setStatus(); render();
  }
  async function start() {
    const c = window.claude;
    if (!c || !c.use) return startLocal();
    try {
      const [d, user] = await Promise.all([c.use("db"), c.use("user")]);
      const owner = user ? await user.isOwner() : false;
      if (!d || !owner) return startLocal();
      db = d; mode = "account"; setStatus();
      const fail = () => toast("Couldn't load your notes. Check your connection, then reload the page.");
      db.collection("projects").onSnapshot((snap) => { projects = snap.docs.map((x) => ({ id: x.id, ...x.data() })); render(); }, fail);
      db.collection("notes").onSnapshot((snap) => { notes = snap.docs.map((x) => ({ id: x.id, ...x.data() })); render(); }, fail);
      db.doc("settings/board").onSnapshot((snap) => { if (snap.exists) { settings = { ...snap.data() }; onSettings(); } });
    } catch (e) { startLocal(); }
  }

  /* ---------- moving between columns (Done side effects) ---------- */
  function withColumn(note, col) {
    const n = { ...note, column: col };
    if (col === "doing" && note.column !== "doing") n.startedAt = Date.now();
    if (col === "done" && note.column !== "done") {
      n.doneAt = Date.now();
      if (n.checklist) n.checklist = n.checklist.map((s) => ({ ...s, done: true }));
    } else if (col !== "done") n.doneAt = null;
    return n;
  }
  function afterDone(prev, next) {
    if (next.column !== "done" || prev.column === "done") return;
    celebrate(next.id);
    if (next.repeat && next.due) {
      const top = notes.filter((x) => x.column === "todo").sort((a, b) => a.order - b.order)[0];
      const copy = {
        ...strip(next), id: newId("n"), column: "todo", doneAt: null, due: advance(next.due, next.repeat),
        order: top ? top.order - 1 : 1, createdAt: Date.now(),
        checklist: (next.checklist || []).map((s) => ({ ...s, done: false })),
      };
      put("notes", { ...next, repeat: "" });
      put("notes", copy);
      toast(`Done. The next one is in To do for ${dueInfo(copy.due).label}.`);
    } else toast("Nice. That one's done.", true);
  }
  // A project can set its own limit; otherwise the desk-wide one counts every note in Doing.
  function wipFor(projectId) {
    const own = projects.find((p) => p.id === projectId)?.wip;
    const limit = own || settings.wip || WIP_LIMIT;
    const list = notes.filter((x) => x.column === "doing" && !isArchived(x) && (!own || x.projectId === projectId));
    return { limit, list, own: !!own };
  }
  let wipPending = null;
  function checkWip(prev, next) {
    if (next.column !== "doing" || prev.column === "doing") return;
    const { limit, list, own } = wipFor(next.projectId);
    if (list.length <= limit) return;
    wipPending = { prev, next };
    $("#wip-text").textContent = `You already had ${limit} ${limit === 1 ? "note" : "notes"} in Doing${own ? " for " + (projOf(next)?.name || "this project") : ""}. Finishing one first keeps you focused. Done with one of these?`;
    const host = $("#wip-list");
    host.replaceChildren(...list.filter((x) => x.id !== next.id).map((n) => {
      const row = document.createElement("div"); row.className = "sp-row";
      const sw = document.createElement("span"); sw.className = "sp-swatch"; sw.style.setProperty("--c", `var(--n-${colorOf(n)})`);
      const t = document.createElement("span"); t.className = "sp-text";
      const a = document.createElement("span"); a.className = "sp-title"; a.textContent = (n.text || "Photo note").replace(/\n/g, " ");
      const c = document.createElement("span"); c.className = "sp-sub"; const d = n.startedAt ? Math.floor((Date.now() - n.startedAt) / DAY) : null;
      c.textContent = [projOf(n)?.name, d == null ? "" : d < 1 ? "started today" : `in Doing ${d} day${d > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
      t.append(a, c);
      const b = document.createElement("button"); b.type = "button"; b.className = "btn quiet"; b.textContent = "Done ✓";
      b.setAttribute("aria-label", `Mark "${a.textContent}" done`);
      b.addEventListener("click", () => { const moved = withColumn(n, "done"); put("notes", moved); closeWip(); afterDone(n, moved); });
      row.append(sw, t, b); return row;
    }));
    $("#wip-sheet").hidden = false;
    setTimeout(() => $("#wip-anyway").focus(), 60);
  }
  function closeWip() { $("#wip-sheet").hidden = true; wipPending = null; }
  $("#wip-anyway").addEventListener("click", closeWip);
  $("#wip-back").addEventListener("click", () => {
    const w = wipPending; closeWip(); if (!w) return;
    put("notes", { ...w.next, column: w.prev.column, order: w.prev.order, startedAt: w.prev.startedAt ?? null });
    toast("Put back. One thing at a time.", true);
  });
  $("#wip-sheet").addEventListener("click", (e) => { if (e.target.id === "wip-sheet") closeWip(); });

  /* ---------- paper that ages: notes nobody has touched in a while ---------- */
  function ageOf(n) {
    if (n.column === "done" || n.waitingOn) return { days: 0, level: 0 };
    if (n.column === "todo" && n.due && n.due > today()) return { days: 0, level: 0 };
    const t = n.touchedAt || n.createdAt; if (!t) return { days: 0, level: 0 };
    const days = Math.floor((Date.now() - t) / DAY);
    const [a, b] = n.column === "doing" ? [3, 7] : [14, 28];
    return { days, level: days >= b ? 2 : days >= a ? 1 : 0 };
  }
  const sinceLabel = (ts) => {
    const d = Math.floor((Date.now() - ts) / DAY);
    return d < 1 ? "today" : d < 7 ? new Date(ts).toLocaleDateString(undefined, { weekday: "short" }) : new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };

  /* ---------- render ---------- */
  function noteEl(n) {
    const el = document.createElement("div");
    el.className = "note " + sizeClass(n.text) + (n.column === "done" ? " done" : "");
    el.dataset.id = n.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    const di = dueInfo(n.due);
    const steps = n.checklist || [];
    const stepsDone = steps.filter((s) => s.done).length;
    el.setAttribute("aria-label", [n.text || (photoSrc(n) ? "Photo note" : "Empty note"), projOf(n)?.name, di && "due " + di.label, n.priority ? ["", "low", "medium", "high"][n.priority] + " priority" : "", n.flagged && "flagged", steps.length && `${stepsDone} of ${steps.length} steps done`].filter(Boolean).join(", ") + ". Tap to edit.");
    el.style.setProperty("--c", `var(--n-${colorOf(n)})`);
    el.style.setProperty("--tilt", tiltFor(n.id));
    if (n.flagged) { const f = document.createElement("span"); f.className = "flag"; el.append(f); }
    const age = ageOf(n);
    if (age.level) {
      el.classList.add("aged-" + age.level);
      if (age.level === 2) { const c = document.createElement("span"); c.className = "curl"; c.setAttribute("aria-hidden", "true"); el.append(c); }
      el.setAttribute("aria-label", el.getAttribute("aria-label").replace(/\. Tap to edit\.$/, `, untouched for ${age.days} days. Tap to edit.`));
    }
    if (n.waitingOn && n.column !== "done") {
      const w = document.createElement("span"); w.className = "wait-tape";
      w.textContent = `Waiting on ${n.waitingOn}` + (n.waitingSince ? ` · ${sinceLabel(n.waitingSince)}` : "");
      el.append(w); el.classList.add("is-waiting");
      el.setAttribute("aria-label", el.getAttribute("aria-label").replace(/\. Tap to edit\.$/, `, waiting on ${n.waitingOn}. Tap to edit.`));
    }

    const paper = document.createElement("div"); paper.className = "paper";
    const top = document.createElement("div"); top.className = "ntop";
    const pr = document.createElement("span"); pr.className = "prio"; pr.textContent = "!".repeat(n.priority || 0);
    top.append(pr);
    if (n.column === "done") top.insertAdjacentHTML("beforeend", '<svg class="tick" viewBox="0 0 100 100" aria-hidden="true"><path d="M14 56c8 6 16 15 24 26 13-27 29-50 50-68"/></svg>');
    const t = document.createElement("div"); t.className = "text"; t.textContent = n.text;
    const src = photoSrc(n);
    if (src) {
      el.classList.add("has-photo");
      const img = document.createElement("img"); img.className = "ph"; img.src = src; img.alt = ""; img.loading = "lazy"; img.draggable = false;
      paper.append(img);
    }
    const meta = document.createElement("div"); meta.className = "meta";
    const due = document.createElement("span");
    if (di && n.column !== "done") { due.className = "due " + di.state; due.textContent = (di.state === "due-late" ? "Late · " : "") + di.label + (n.repeat ? " ↻" : ""); }
    const sub = document.createElement("span"); sub.className = "sub";
    sub.textContent = [steps.length ? `${stepsDone}/${steps.length} ☐` : "", n.focusCount ? `⏱${n.focusCount}` : ""].filter(Boolean).join("  ");
    if (age.level) { const a = document.createElement("span"); a.className = "age"; a.textContent = `${age.days} days`; sub.prepend(a); }
    if (n.nextStep && n.column !== "done") {
      el.setAttribute("aria-label", el.getAttribute("aria-label").replace(/\. Tap to edit\.$/, `, next step: ${n.nextStep}. Tap to edit.`));
    }
    meta.append(due, sub);
    paper.prepend(top); paper.append(t, meta);
    if (n.nextStep && n.column !== "done") { const ns = document.createElement("div"); ns.className = "next-step"; ns.textContent = "→ " + n.nextStep; t.after(ns); }
    el.append(paper);
    return el;
  }
  const EMPTY = {
    all: {
      todo: ["A clean desk!", "Tap to stick your first note"],
      doing: ["Nothing on the go", "Tap to start something"],
      done: ["Wins pile up here", "Already did something? Log it"],
    },
    today: {
      todo: ["Your day is wide open", "Tap to plan something for today"],
      doing: ["Nothing in progress today", "Tap to start one now"],
      done: ["Nothing finished today yet", "Small win? Tap to log it"],
    },
    scheduled: {
      todo: ["No dates on the calendar", "Tap to add a note for today"],
      doing: ["Nothing dated in progress", "Tap to start a dated note"],
      done: ["Finished notes hide in Scheduled", ""],
    },
    flagged: {
      todo: ["No flags up", "Tap to add something important"],
      doing: ["No flagged work going", "Tap to start an important one"],
      done: ["No flagged wins yet", "Tap to log one"],
    },
  };
  // hand-drawn doodles for each column's empty slot
  const DOODLE = {
    todo: '<path d="M14 40c6-1 14-2 22-1M14 30c7-1 16-1 26 0M14 20c5-1 10-1 15 0"/><path d="M38 12l8 8-16 16-9 2 1-9z"/><path d="M34 16l8 8"/>',
    doing: '<path d="M12 22h24v10a10 10 0 0 1-10 10h-4a10 10 0 0 1-10-10z"/><path d="M36 25h3a4 4 0 0 1 0 8h-4"/><path d="M18 9c-2 3 2 4 0 7M25 8c-2 3 2 4 0 7M32 9c-2 3 2 4 0 7"/>',
    done: '<path d="M24 7l4.6 10 10.4 1.2-7.8 7.2 2.2 10.4L24 30.6l-9.4 5.2 2.2-10.4L9 18.2l10.4-1.2z"/><path d="M8 42c4-2 8 1 12-1s8 1 12-1 8 1 10 0"/>',
  };
  function renderTabs() {
    const tabs = $("#tabs");
    const open = (pid) => notes.filter((n) => n.column !== "done" && (pid === "all" || n.projectId === pid)).length;
    const mk = (id, name, color) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "tab"; b.dataset.p = id;
      if (color) b.style.setProperty("--c", `var(--n-${color})`);
      const active = view.project === id;
      b.setAttribute("aria-pressed", String(active));
      const nm = document.createElement("span"); nm.textContent = name;
      const ct = document.createElement("span"); ct.className = "n"; ct.textContent = open(id);
      b.append(nm, ct);
      if (active && id !== "all") { const e = document.createElement("span"); e.className = "edit"; e.textContent = "Edit"; b.append(e); b.title = "Tap again to edit this project"; }
      return b;
    };
    const kids = [mk("all", "All projects")];
    for (const p of sortedProjects()) kids.push(mk(p.id, p.name, p.color));
    const add = document.createElement("button"); add.type = "button"; add.className = "tab add"; add.dataset.p = "+"; add.textContent = "+ Project";
    kids.push(add);
    tabs.replaceChildren(...kids);
    const cur = projects.find((p) => p.id === view.project);
    $("#pad").style.setProperty("--pad", `var(--n-${cur?.color || sortedProjects()[0]?.color || "pink"})`);
  }
  function renderFilters() {
    const defs = [["all", "Everything"], ["today", "Today"], ["scheduled", "Scheduled"], ["flagged", "Flagged"]];
    if (notes.some((x) => matches(x, "waiting")) || view.filter === "waiting") defs.push(["waiting", "Waiting"]);
    const chips = defs.map(([id, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.dataset.f = id;
      b.setAttribute("aria-pressed", String(view.filter === id));
      b.textContent = label;
      if (id !== "all") {
        const n = notes.filter((x) => matches(x, id) && (id !== "today" || x.column !== "done")).length;
        const s = document.createElement("span"); s.className = "n"; s.textContent = n; b.append(s);
      }
      return b;
    });
    if (view.project === "all" && projects.length > 1) {
      const g = document.createElement("button"); g.type = "button"; g.className = "chip group-toggle"; g.id = "group-toggle";
      g.setAttribute("aria-pressed", String(!!view.group)); g.title = "Group notes into rows by project (G)";
      g.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>Rows by project';
      chips.push(g);
    }
    $("#filters").replaceChildren(...chips);
  }
  function render(settleId) {
    if ((drag && drag.active) || editing) { renderPending = true; return; }
    renderPending = false;
    if (view.project !== "all" && mode !== "loading" && !projects.some((p) => p.id === view.project) && projects.length) view.project = "all";
    renderTabs(); renderFilters();
    for (const c of COLS) {
      const section = board.querySelector(`[data-col="${c}"]`);
      const list = inCol(c);
      let kids;
      if (grouped()) {
        kids = [];
        for (const p of sortedProjects()) {
          const own = list.filter((n) => n.projectId === p.id); if (!own.length) continue;
          const shut = view.collapsed.includes(p.id);
          const h = document.createElement("button"); h.type = "button"; h.className = "lane-head"; h.dataset.lane = p.id;
          h.style.setProperty("--c", `var(--n-${COLORS.includes(p.color) ? p.color : "pink"})`);
          h.setAttribute("aria-expanded", String(!shut));
          h.innerHTML = '<span class="lane-dot" aria-hidden="true"></span>';
          const nm = document.createElement("span"); nm.className = "lane-name"; nm.textContent = p.name;
          const ct = document.createElement("span"); ct.className = "lane-n"; ct.textContent = own.length;
          const cv = document.createElement("span"); cv.className = "lane-chev"; cv.setAttribute("aria-hidden", "true"); cv.textContent = "›";
          h.append(nm, ct, cv); kids.push(h);
          if (!shut) kids.push(...own.sort((a, b) => a.order - b.order).map(noteEl));
        }
        const loose = list.filter((n) => !projects.some((p) => p.id === n.projectId)); kids.push(...loose.map(noteEl));
      } else kids = list.map(noteEl);
      if (!kids.length && mode !== "loading") {
        const [line, cta] = view.q ? ["No notes match your search", ""] : EMPTY[view.filter][c];
        const e = document.createElement(cta ? "button" : "p");
        e.className = "empty"; if (cta) { e.type = "button"; e.dataset.add = c; e.classList.add("is-add"); }
        e.innerHTML = `<svg class="empty-doodle" viewBox="0 0 48 48" aria-hidden="true">${DOODLE[c]}</svg>`;
        const l = document.createElement("span"); l.className = "empty-line"; l.textContent = line; e.append(l);
        if (cta) { const t = document.createElement("span"); t.className = "empty-cta"; t.textContent = "+ " + cta; e.append(t); }
        kids.push(e);
      }
      section.querySelector(".notes").replaceChildren(...kids);
      section.querySelector(".count").textContent = list.length;
    }
    const archN = notes.filter((n) => isArchived(n) && matches(n)).length;
    $("#archive-btn").hidden = !archN; $("#archive-btn").textContent = `Archive · ${archN}`;
    const w = wipFor(view.project === "all" ? null : view.project);
    const used = w.list.length, over = used > w.limit;
    $("#wip").textContent = `${used}/${w.limit}`;
    $("#wip").setAttribute("aria-label", `${used} of ${w.limit} in Doing`); $("#wip").title = `${used} of ${w.limit} in Doing`;
    $("#wip").classList.toggle("is-over", over);
    board.querySelector('[data-col="doing"] .col-head').classList.toggle("over-limit", over);
    if (settleId) board.querySelector(`[data-id="${settleId}"]`)?.classList.add("settle");
  }

  $("#tabs").addEventListener("dragstart", (e) => e.preventDefault());
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab"); if (!b) return;
    const id = b.dataset.p;
    if (id === "+") return openProject(null);
    if (id === view.project && id !== "all") return openProject(projects.find((p) => p.id === id));
    view.project = id; saveView(); render();
  });
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    if (b.id === "group-toggle") { view.group = !view.group; saveView(); render(); return; }
    view.filter = b.dataset.f; saveView(); render();
  });


  /* ---------- floating options button ---------- */
  const fab = $("#fab");
  function setFab(open) {
    fab.classList.toggle("open", open);
    $("#fab-main").setAttribute("aria-expanded", String(open));
    $("#fab-main").setAttribute("aria-label", open ? "Close options" : "Options");
    $("#fab-items").inert = !open;
  }
  setFab(false);
  $("#fab-main").addEventListener("click", () => setFab(!fab.classList.contains("open")));
  $("#fab-items").addEventListener("click", (e) => { if (e.target.closest(".fab-item")) setFab(false); });
  document.addEventListener("click", (e) => { if (fab.classList.contains("open") && !e.target.closest("#fab")) setFab(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && fab.classList.contains("open")) setFab(false); });

  /* ---------- Spotlight-style search ---------- */
  const COL_NAME = { todo: "To do", doing: "Doing", done: "Done" };
  const sp = $("#spotlight"), spInput = $("#sp-input"), spBody = $("#sp-body");
  function openSpotlight() { sp.hidden = false; spInput.value = ""; renderSpotlight(); setTimeout(() => spInput.focus(), 30); }
  function closeSpotlight() { sp.hidden = true; }
  function hiText(text, q) {
    const frag = document.createDocumentFragment();
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0) { frag.append(text); return frag; }
    const m = document.createElement("mark"); m.textContent = text.slice(i, i + q.length);
    frag.append(text.slice(0, i), m, text.slice(i + q.length));
    return frag;
  }
  function spSection(title, kids, cls = "sp-list") {
    const sec = document.createElement("section"); sec.className = "sp-sec";
    const h = document.createElement("h3"); h.textContent = title;
    const box = document.createElement("div"); box.className = cls; box.append(...kids);
    sec.append(h, box); return sec;
  }
  function spRow({ color, title, sub, q, onPick, label }) {
    const b = document.createElement("button"); b.type = "button"; b.className = "sp-row";
    const sw = document.createElement("span"); sw.className = "sp-swatch"; sw.style.setProperty("--c", `var(--n-${color})`);
    const t = document.createElement("span"); t.className = "sp-text";
    const a = document.createElement("span"); a.className = "sp-title"; a.append(hiText(title, q));
    const c = document.createElement("span"); c.className = "sp-sub"; c.textContent = sub;
    t.append(a, c);
    const chev = document.createElement("span"); chev.className = "sp-chev"; chev.setAttribute("aria-hidden", "true"); chev.textContent = "›";
    b.append(sw, t, chev);
    if (label) b.setAttribute("aria-label", label);
    b.addEventListener("click", onPick);
    return b;
  }
  function renderSpotlight() {
    const q = spInput.value.trim().toLowerCase();
    $("#sp-clear").hidden = !q;
    if (!q) {
      const count = (f) => notes.filter((n) => { const keep = view.project; view.project = "all"; const r = matches(n, f) && (f !== "today" || n.column !== "done"); view.project = keep; return r; }).length;
      const tiles = [["today", "Today", "Due today or late"], ["flagged", "Flagged", "Marked with a flag"], ["scheduled", "Scheduled", "Has a date"], ["all", "Everything", "Every note"]].map(([f, name, hint]) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "sp-tile sp-" + f;
        const n = document.createElement("span"); n.className = "sp-num"; n.textContent = f === "all" ? notes.length : count(f);
        const l = document.createElement("span"); l.className = "sp-tname"; l.textContent = name;
        const h = document.createElement("span"); h.className = "sp-thint"; h.textContent = hint;
        b.append(n, l, h);
        b.addEventListener("click", () => { view.filter = f; view.project = "all"; saveView(); render(); closeSpotlight(); });
        return b;
      });
      const projRows = sortedProjects().map((p) => spRow({
        color: p.color, title: p.name, q: "",
        sub: `${notes.filter((n) => n.projectId === p.id && n.column !== "done").length} open`,
        onPick: () => { view.project = p.id; view.filter = "all"; saveView(); render(); closeSpotlight(); },
      }));
      spBody.replaceChildren(spSection("Shortcuts", tiles, "sp-tiles"), ...(projRows.length ? [spSection("Projects", projRows)] : []));
      return;
    }
    const hay = (n) => [n.text, n.details, ...(n.checklist || []).map((x) => x.t), projOf(n)?.name].join(" ").toLowerCase();
    const hits = notes.filter((n) => hay(n).includes(q));
    const projHits = sortedProjects().filter((p) => p.name.toLowerCase().includes(q));
    const secs = [];
    if (projHits.length) secs.push(spSection("Projects", projHits.map((p) => spRow({ color: p.color, title: p.name, q, sub: "Project", onPick: () => { view.project = p.id; view.filter = "all"; saveView(); render(); closeSpotlight(); } }))));
    for (const c of COLS) {
      const list = hits.filter((n) => n.column === c).sort((a, b) => a.order - b.order);
      if (!list.length) continue;
      secs.push(spSection(COL_NAME[c], list.map((n) => {
        const di = dueInfo(n.due);
        const step = (n.checklist || []).find((x) => x.t.toLowerCase().includes(q));
        const sub = [projOf(n)?.name, di && n.column !== "done" ? di.label : "", step && !n.text.toLowerCase().includes(q) ? "Step: " + step.t : ""].filter(Boolean).join(" · ");
        return spRow({ color: colorOf(n), title: (n.text || "Photo note").replace(/\n/g, " "), q, sub, onPick: () => { closeSpotlight(); openEditor(n, false); } });
      })));
    }
    if (!secs.length) {
      const p = document.createElement("p"); p.className = "sp-none";
      p.textContent = `No notes match “${spInput.value.trim()}”.`;
      spBody.replaceChildren(p); return;
    }
    spBody.replaceChildren(...secs);
  }
  $("#search-btn").addEventListener("click", openSpotlight);
  spInput.addEventListener("input", renderSpotlight);
  spInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); spBody.querySelector(".sp-row")?.click(); } });
  $("#sp-clear").addEventListener("click", () => { spInput.value = ""; renderSpotlight(); spInput.focus(); });
  $("#sp-cancel").addEventListener("click", closeSpotlight);
  // tapping empty space around the results closes search, like tapping outside a sheet
  sp.addEventListener("click", (e) => {
    if (e.target === sp || e.target.id === "sp-body" || e.target.classList.contains("sp-bar") || e.target.classList.contains("sp-sec")) closeSpotlight();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sp.hidden) closeSpotlight();
    // ⌘K / Ctrl+K opens search on a keyboard
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); sp.hidden ? openSpotlight() : closeSpotlight(); }
  });

  /* ---------- segmented controls ---------- */
  function seg(host, get, set) {
    const sync = () => host.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === String(get()))));
    host.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; set(b.dataset.v); sync(); };
    sync();
    return sync;
  }

  /* ---------- note in hand ---------- */
  let syncCols, syncPrio, syncDue, syncProj, syncQuick = () => {};
  function paintHand() {
    const p = projects.find((x) => x.id === editing.note.projectId), c = p?.color || "pink";
    $("#flip").style.setProperty("--c", `var(--n-${c})`); hand.style.setProperty("--c", `var(--n-${c})`);
    document.querySelectorAll(".face").forEach((f) => f.style.setProperty("--c", `var(--n-${c})`));
    document.querySelectorAll("#proj-dots .pdot").forEach((d) => d.setAttribute("aria-checked", String(d.dataset.p === editing.note.projectId)));
    const nm = $("#pdot-name"); if (nm) nm.textContent = p?.name || "";
  }
  function openEditor(note, isNew) {
    editing = { note: { checklist: [], ...note, checklist: (note.checklist || []).map((s) => ({ ...s })) }, isNew, prev: note };
    const N = editing.note;
    const cs = $("#edit-col");
    cs.value = N.column;
    cs.onchange = () => {
      const v = cs.value;
      const list = notes.filter((n) => n.column === v && n.id !== N.id).sort((a, b) => a.order - b.order);
      N.order = list.length ? list[list.length - 1].order + 1 : 1;
      Object.assign(N, withColumn(N, v)); renderSteps();
    };
    const ps = $("#edit-project");
    ps.replaceChildren(...sortedProjects().map((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; return o; }));
    ps.value = N.projectId;
    ps.onchange = () => { N.projectId = ps.value; paintHand(); };
    const dots = $("#proj-dots");
    dots.hidden = projects.length < 2;
    dots.replaceChildren(...sortedProjects().map((p, i) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "pdot"; b.dataset.p = p.id;
      b.setAttribute("role", "radio"); b.setAttribute("aria-label", p.name); b.title = p.name;
      b.style.setProperty("--c", `var(--n-${COLORS.includes(p.color) ? p.color : "pink"})`); b.style.setProperty("--t", [-6, 4, -3, 5, -4, 3, -5][i % 7] + "deg");
      b.addEventListener("click", () => { N.projectId = p.id; ps.value = p.id; paintHand(); });
      return b;
    }), Object.assign(document.createElement("span"), { className: "pdot-name", id: "pdot-name" }));
    syncPrio = seg($("#edit-prio"), () => N.priority || 0, (v) => { N.priority = Number(v); });
    syncDue = () => {};
    syncQuick = seg($("#quick-due"), () => N.due === today() ? "0" : N.due === addDays(today(), 1) ? "1" : "none", (v) => {
      const d = addDays(today(), Number(v));
      N.due = N.due === d ? "" : d;
      setDueField(N.due);
      if (!N.due) { N.repeat = ""; $("#edit-repeat").value = ""; }
      syncDue();
    });
    setDueField(N.due);
    $("#edit-repeat").value = N.repeat || "";
    $("#edit-waiting").value = N.waitingOn || "";
    $("#edit-next").value = N.nextStep || "";
    $("#quick-flag").setAttribute("aria-pressed", String(!!N.flagged));
    $("#more").hidden = true; $("#more-btn").setAttribute("aria-expanded", "false"); $("#more-btn").lastChild.textContent = "More"; hand.classList.remove("more-open");
    editText.value = N.text || "";
    showEditorPhoto();
    prepEditorExtras(isNew);
    $("#edit-details").value = N.details || "";
    $("#add-step").value = "";
    renderSteps();
    setFlip(false);
    paintHand();
    $("#hand-delete").textContent = isNew ? "Discard" : "Throw away";
    hand.hidden = false;
    setTimeout(() => { editText.focus(); editText.setSelectionRange(editText.value.length, editText.value.length); }, 60);
  }
  function setDueField(v) { $("#edit-due").value = v || ""; $("#date-wrap").classList.toggle("has-value", !!v); }
  $("#edit-due").addEventListener("change", (e) => { $("#date-wrap").classList.toggle("has-value", !!e.target.value); editing.note.due = e.target.value; if (!e.target.value) { editing.note.repeat = ""; $("#edit-repeat").value = ""; } syncDue(); syncQuick(); });
  $("#more-btn").addEventListener("click", (e) => {
    const open = $("#more").hidden;
    hand.classList.toggle("more-open", open);
    $("#more").hidden = !open;
    e.currentTarget.setAttribute("aria-expanded", String(open));
    e.currentTarget.lastChild.textContent = open ? "Less" : "More";
  });
  // Return sticks the note; Shift+Return starts a new line.
  editText.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); closeEditor(true); } });
  $("#edit-repeat").addEventListener("change", (e) => {
    editing.note.repeat = e.target.value;
    if (e.target.value && !editing.note.due) { editing.note.due = today(); setDueField(editing.note.due); syncDue(); syncQuick(); }
  });
  $("#quick-flag").addEventListener("click", (e) => { editing.note.flagged = !editing.note.flagged; e.currentTarget.setAttribute("aria-pressed", String(editing.note.flagged)); });
  $("#edit-details").addEventListener("input", (e) => { editing.note.details = e.target.value; });
  $("#edit-next").addEventListener("input", (e) => { editing.note.nextStep = e.target.value.trim(); });
  $("#edit-waiting").addEventListener("input", (e) => {
    const N = editing.note, v = e.target.value.trim();
    if (v && !N.waitingOn) N.waitingSince = Date.now();
    N.waitingOn = v; if (!v) N.waitingSince = null;
  });

  function renderSteps() {
    const ul = $("#steps");
    ul.replaceChildren(...editing.note.checklist.map((s, i) => {
      const li = document.createElement("li"); if (s.done) li.className = "checked";
      const box = document.createElement("button"); box.type = "button"; box.className = "box"; box.textContent = s.done ? "✓" : "";
      box.setAttribute("aria-label", s.done ? "Mark step not done" : "Mark step done");
      box.onclick = () => { s.done = !s.done; renderSteps(); };
      const inp = document.createElement("input"); inp.type = "text"; inp.value = s.t; inp.maxLength = 120; inp.setAttribute("aria-label", "Step");
      inp.oninput = () => { s.t = inp.value; };
      const x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "×"; x.setAttribute("aria-label", "Remove step");
      x.onclick = () => { editing.note.checklist.splice(i, 1); renderSteps(); };
      li.append(box, inp, x); return li;
    }));
  }
  $("#add-step").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = e.target.value.trim(); if (!v) return;
    editing.note.checklist.push({ t: v, done: false }); e.target.value = ""; renderSteps();
  });
  function setFlip(on) {
    $("#flip").classList.toggle("flipped", on);
    $("#flip-btn").textContent = on ? "Flip to front" : "Flip to back";
    $(".face.front").inert = on; $(".face.back").inert = !on;
    if (on) setTimeout(() => $("#edit-details").focus({ preventScroll: true }), 300);
  }
  $("#flip-btn").addEventListener("click", () => setFlip(!$("#flip").classList.contains("flipped")));

  function closeEditor(save) {
    if (!editing) return;
    const { note, isNew, prev } = editing;
    const pending = $("#add-step").value.trim();
    if (pending) note.checklist.push({ t: pending, done: false });
    const parsed = parseQuick(editText.value);
    note.text = parsed.text;
    for (const k of ["due", "priority", "projectId", "repeat", "flagged"]) if (parsed[k] !== undefined) note[k] = parsed[k];
    if (note.repeat && !note.due) note.due = today();
    note.checklist = note.checklist.filter((s) => s.t.trim());
    editing = null; hand.hidden = true;
    if (!save) { if (!isNew) removeNote(note.id); else render(); return; }
    if (!note.text && !photoSrc(note)) { if (isNew) render(); else removeNote(note.id); return; }
    if (JSON.stringify(prev) !== JSON.stringify(note) || isNew) {
      put("notes", note);
      afterDone(prev, note); checkWip(prev, note);
    } else if (ageOf(note).level) { put("notes", note); toast("Freshened up.", true); }
    else render();
    board.querySelector(`[data-id="${note.id}"]`)?.focus({ preventScroll: true });
  }
  $("#hand-close").addEventListener("click", () => closeEditor(true));
  $("#hand-x").addEventListener("click", () => closeEditor(true));
  $("#hand-delete").addEventListener("click", () => closeEditor(false));
  hand.addEventListener("click", (e) => { if (e.target === hand) closeEditor(true); });

  function blankNote(col = "todo") {
    const pid = view.project !== "all" ? view.project : sortedProjects()[0].id;
    const top = notes.filter((n) => n.column === col).sort((a, b) => a.order - b.order)[0];
    return withColumn({
      id: newId("n"), text: "", column: "todo", projectId: pid, order: top ? top.order - 1 : 1, createdAt: Date.now(),
      due: view.filter === "today" || view.filter === "scheduled" ? today() : "", flagged: view.filter === "flagged", priority: 0, repeat: "", details: "", checklist: [],
    }, col);
  }
  board.addEventListener("click", (e) => {
    const lane = e.target.closest(".lane-head");
    if (lane) { const id = lane.dataset.lane; view.collapsed = view.collapsed.includes(id) ? view.collapsed.filter((x) => x !== id) : [...view.collapsed, id]; saveView(); render(); return; }
    const b = e.target.closest(".empty.is-add, .col-add"); if (!b) return;
    if (!projects.length) { toast("Make a project first, then tear off a note."); return openProject(null); }
    openEditor(blankNote(b.dataset.add), true);
  });
  $("#pad").addEventListener("click", () => {
    if (!projects.length) { toast("Make a project first, then tear off a note."); return openProject(null); }
    openEditor(blankNote(), true);
  });

  /* ---------- photo notes: camera → note, and Claude reads the handwriting when it can ---------- */
  function photoSrc(n) { return n.photoId ? "/_blob/" + n.photoId : (n.photoData || ""); }
  async function shrinkPhoto(file, max = 1100, quality = 0.82) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", quality));
  }
  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  async function readHandwriting(blob) {
    if (mode !== "account" || !window.claude?.use) return;
    const s = await window.claude.use("sample").catch(() => null); if (!s) return;
    const lim = await s.limits().catch(() => null); if (!lim?.images) return;
    const ph = editText.placeholder; editText.placeholder = "Reading the handwriting…";
    try {
      const r = await s("This image is a photo of a handwritten sticky note or a to-do. Reply with only the words written on it, keeping its line breaks, and nothing else. If no writing is readable, reply with a single dash.", { images: [blob], modelTier: "quick" });
      const t = (r.text || "").trim();
      if (editing && !editText.value.trim() && t && t !== "-") { editText.value = t.slice(0, 160); toast("Read the note from your photo. Check it, then tap Stick it."); }
    } catch (e) { /* a declined or failed read just leaves the field for typing */ }
    finally { editText.placeholder = ph; }
  }
  $("#quick-cam").addEventListener("click", () => $("#cam-input").click());
  function showEditorPhoto() {
    const src = editing ? photoSrc(editing.note) : "";
    $("#edit-photo").hidden = !src; if (src) $("#edit-photo").src = src;
    $(".face.front").classList.toggle("has-photo", !!src);
    $("#remove-photo").hidden = !src;
    $("#quick-cam").setAttribute("aria-label", src ? "Retake the photo" : "Add a photo to this note");
  }
  $("#cam-input").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    let blob;
    try { blob = await shrinkPhoto(f); } catch (err) { toast("Couldn't open that photo. Try taking it again."); return; }
    if (!editing) return;
    const assets = mode === "account" && window.claude?.use ? await window.claude.use("assets").catch(() => null) : null;
    try {
      if (assets) { const r = await assets.upload(blob, { type: "image/jpeg" }); delete editing.note.photoData; editing.note.photoId = r.id; }
      else { delete editing.note.photoId; editing.note.photoData = await blobToDataURL(blob); }
    } catch (err) { toast("Couldn't save that photo. Check your connection, then try again."); return; }
    showEditorPhoto();
    readHandwriting(blob);
  });
  $("#remove-photo").addEventListener("click", () => {
    if (!editing) return;
    delete editing.note.photoId; delete editing.note.photoData;
    showEditorPhoto();
  });

  $("#toast-undo").addEventListener("click", () => {
    if (toastAction) { const a = toastAction; toastAction = null; $("#toast").hidden = true; a.run(); }
    else undo();
  });

  /* ---------- project sheet ---------- */
  let syncSw, deleteArmed = false;
  function openProject(p) {
    const used = projects.map((x) => x.color);
    projEditing = p ? { ...p } : { id: newId("p"), name: "", color: COLORS.find((c) => !used.includes(c)) || "pink", order: (Math.max(0, ...projects.map((x) => x.order || 0)) + 1), isNew: true };
    $("#proj-title").textContent = p ? "Edit project" : "New project";
    $("#proj-name").value = projEditing.name;
    $("#proj-delete").hidden = !p;
    deleteArmed = false; $("#proj-delete").textContent = "Delete project";
    const host = $("#proj-swatches");
    host.replaceChildren(...COLORS.map((c, i) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "swatch"; b.dataset.v = c;
      b.style.setProperty("--c", `var(--n-${c})`); b.style.setProperty("--t", [-4, 2, -1, 3, -2, 1, -3][i] + "deg");
      b.setAttribute("aria-label", COLOR_NAMES[c]); return b;
    }));
    syncSw = seg(host, () => projEditing.color, (v) => { projEditing.color = v; });
    const desk = settings.wip || WIP_LIMIT;
    $("#proj-wip").replaceChildren(...[["", `Same as the desk (${desk})`], ...[1, 2, 3, 4, 5, 6, 8].map((n) => [String(n), `${n} at a time`])].map(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; return o; }));
    $("#proj-wip").value = projEditing.wip ? String(projEditing.wip) : "";
    $("#proj-sheet").hidden = false;
    setTimeout(() => $("#proj-name").focus(), 60);
  }
  function closeProject() { $("#proj-sheet").hidden = true; projEditing = null; }
  $("#proj-cancel").addEventListener("click", closeProject);
  $("#proj-sheet").addEventListener("click", (e) => { if (e.target.id === "proj-sheet") closeProject(); });
  $("#proj-save").addEventListener("click", () => {
    const name = $("#proj-name").value.trim();
    if (!name) { toast("Give the project a name first."); $("#proj-name").focus(); return; }
    const wip = Number($("#proj-wip").value) || null;
    const { isNew, ...p } = { ...projEditing, name, wip };
    if (!p.wip) delete p.wip;
    closeProject();
    put("projects", p);
    if (isNew) { view.project = p.id; saveView(); render(); }
  });
  $("#proj-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#proj-save").click(); });
  $("#proj-delete").addEventListener("click", () => {
    const p = projEditing; const own = notes.filter((n) => n.projectId === p.id);
    if (!deleteArmed) {
      deleteArmed = true;
      $("#proj-delete").textContent = own.length ? `Tap again to delete it and its ${own.length} note${own.length > 1 ? "s" : ""}` : "Tap again to delete";
      return;
    }
    closeProject();
    own.forEach((n) => del("notes", n.id));
    del("projects", p.id);
    view.project = "all"; saveView(); render();
    toast(`Deleted ${p.name}.`);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (editing) closeEditor(true); else if (projEditing) closeProject(); }
    const onNote = !editing && !projEditing && e.target.classList?.contains("note") && e.target.dataset.id;
    if (onNote && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      const n = notes.find((x) => x.id === e.target.dataset.id); if (n) openEditor(n, false);
    }
    if (onNote && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const n = notes.find((x) => x.id === e.target.dataset.id); if (!n) return;
      const to = COLS[COLS.indexOf(n.column) + (e.key === "ArrowRight" ? 1 : -1)]; if (to) keyMove(n, to, "end");
    }
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || editing || projEditing || anySheetOpen()) return;
    const n = onNote && notes.find((x) => x.id === e.target.dataset.id);
    if (n && ["1", "2", "3"].includes(e.key)) { e.preventDefault(); const to = COLS[Number(e.key) - 1]; if (to !== n.column) keyMove(n, to, "end"); }
    else if (n && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); keyMove(n, n.column, e.key === "ArrowUp" ? "top" : "end"); }
    else if (n && (e.key === "f" || e.key === "F")) { e.preventDefault(); put("notes", { ...n, flagged: !n.flagged }); toast(n.flagged ? "Flag removed." : "Flagged.", true); refocus(n.id); }
    else if (n && (e.key === "Backspace" || e.key === "Delete")) { e.preventDefault(); removeNote(n.id); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); $("#pad").click(); }
    else if (e.key === "/") { e.preventDefault(); openSpotlight(); }
    else if (e.key === "?") { e.preventDefault(); openKeys(); }
    else if (e.key === "w" || e.key === "W") { e.preventDefault(); openWeek(); }
    else if (e.key === "s" || e.key === "S") { e.preventDefault(); openStandup(); }
    else if ((e.key === "g" || e.key === "G") && view.project === "all") { e.preventDefault(); view.group = !view.group; saveView(); render(); toast(view.group ? "Rows by project." : "One list per column.", true); }
  });
  const typing = (e) => e.target.closest?.("input, textarea, select, [contenteditable]");
  const anySheetOpen = () => [...document.querySelectorAll(".overlay, .spotlight, .today")].some((x) => !x.hidden);
  const refocus = (id) => requestAnimationFrame(() => board.querySelector(`[data-id="${id}"]`)?.focus());
  function keyMove(n, to, where) {
    const list = notes.filter((x) => x.column === to && x.id !== n.id).sort((a, b) => a.order - b.order);
    const order = !list.length ? 1 : where === "top" ? list[0].order - 1 : list[list.length - 1].order + 1;
    const moved = { ...withColumn(n, to), order };
    put("notes", moved); afterDone(n, moved); checkWip(n, moved);
    if (to !== n.column && to !== "done") toast(`Moved to ${{ todo: "To do", doing: "Doing" }[to]}.`, true);
    else if (to === n.column) toast(where === "top" ? "Moved to the top." : "Moved to the bottom.", true);
    refocus(n.id);
  }

  /* ---------- the IT day: standup in the morning, wrap-up in the evening ---------- */
  // Bangladesh work week: Friday and Saturday are the weekend
  const isWorkday = (d) => d.getDay() !== 5 && d.getDay() !== 6;
  function lastWorkdayStart() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    do d.setDate(d.getDate() - 1); while (!isWorkday(d));
    return d;
  }
  const noteLine = (n) => (n.text || "Photo note").replace(/\s+/g, " ").trim();
  function standupData() {
    const since = lastWorkdayStart();
    const done = notes.filter((n) => n.column === "done" && n.doneAt >= since.getTime()).sort((a, b) => a.doneAt - b.doneAt);
    const doing = notes.filter((n) => n.column === "doing" && !n.waitingOn).sort((a, b) => a.order - b.order);
    const dueToday = notes.filter((n) => n.column === "todo" && n.due && n.due <= today() && !n.waitingOn);
    const blocked = notes.filter((n) => n.waitingOn && n.column !== "done");
    return { since, done, today: [...doing, ...dueToday], blocked };
  }
  function standupText() {
    const d = standupData();
    const list = (arr, fmt) => arr.length ? arr.map((n) => "• " + fmt(n)).join("\n") : "• Nothing";
    return [
      `*Since ${d.since.toLocaleDateString(undefined, { weekday: "long" })}*`, list(d.done, noteLine),
      "*Today*", list(d.today, (n) => noteLine(n) + (n.nextStep ? ` (next: ${n.nextStep})` : "")),
      "*Blockers*", d.blocked.length ? list(d.blocked, (n) => `${noteLine(n)} — waiting on ${n.waitingOn}`) : "• None",
    ].join("\n");
  }
  function openStandup() {
    const d = standupData();
    $("#su-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    const sec = (title, arr, fmt, empty) => {
      const box = document.createElement("section"); box.className = "su-sec";
      const h = document.createElement("h4"); h.textContent = title; box.append(h);
      const ul = document.createElement("ul");
      if (!arr.length) { const li = document.createElement("li"); li.className = "su-empty"; li.textContent = empty; ul.append(li); }
      for (const n of arr) {
        const li = document.createElement("li");
        const sw = document.createElement("span"); sw.className = "su-dot"; sw.style.setProperty("--c", `var(--n-${colorOf(n)})`);
        const t = document.createElement("span"); t.textContent = noteLine(n);
        li.append(sw, t);
        const extra = fmt(n); if (extra) { const x = document.createElement("small"); x.textContent = extra; li.append(x); }
        ul.append(li);
      }
      box.append(ul); return box;
    };
    $("#su-body").replaceChildren(
      sec(`Since ${d.since.toLocaleDateString(undefined, { weekday: "long" })}`, d.done, () => "", "Nothing finished yet. That's fine."),
      sec("Today", d.today, (n) => n.nextStep ? "next: " + n.nextStep : n.column === "todo" ? "due today" : "", "Nothing in Doing. Pick something to start."),
      sec("Blockers", d.blocked, (n) => `waiting on ${n.waitingOn}` + (n.waitingSince ? ` since ${sinceLabel(n.waitingSince)}` : ""), "No blockers"),
    );
    setFab(false);
    $("#standup-sheet").hidden = false; setTimeout(() => $("#su-copy").focus(), 60);
  }
  const closeStandup = () => { $("#standup-sheet").hidden = true; };
  $("#standup-btn").addEventListener("click", openStandup);
  $("#su-close").addEventListener("click", closeStandup);
  $("#standup-sheet").addEventListener("click", (e) => { if (e.target.id === "standup-sheet") closeStandup(); });
  $("#su-copy").addEventListener("click", async () => {
    const text = standupText();
    try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into Slack or Teams."); }
    catch (e) { toast("Couldn't copy here. Select the notes and copy them."); }
  });
  $("#su-wrap").addEventListener("click", () => { closeStandup(); openWrap(); });

  // Wrap-up: write where you stopped on each note in Doing, so tomorrow starts in seconds, not half an hour
  function openWrap() {
    const doing = notes.filter((n) => n.column === "doing").sort((a, b) => a.order - b.order);
    const doneToday = notes.filter((n) => n.column === "done" && isToday(n.doneAt)).length;
    $("#wrap-text").textContent = (doneToday ? `You finished ${doneToday} today. ` : "") +
      (doing.length ? "Before you go, jot down where you stopped on each one. Tomorrow you'll start from that line." : "Nothing in Doing. Clear desk, clear head.");
    $("#wrap-list").replaceChildren(...doing.map((n) => {
      const row = document.createElement("label"); row.className = "wrap-row";
      const top = document.createElement("span"); top.className = "wrap-note";
      const sw = document.createElement("span"); sw.className = "su-dot"; sw.style.setProperty("--c", `var(--n-${colorOf(n)})`);
      const t = document.createElement("span"); t.textContent = noteLine(n); top.append(sw, t);
      const inp = document.createElement("input"); inp.className = "field"; inp.type = "text"; inp.maxLength = 80; inp.dataset.id = n.id;
      inp.placeholder = "Next step, e.g. test on Safari"; inp.value = n.nextStep || ""; inp.setAttribute("aria-label", `Next step for ${t.textContent}`);
      row.append(top, inp); return row;
    }));
    setFab(false);
    $("#wrap-sheet").hidden = false;
    setTimeout(() => ($("#wrap-list input") || $("#wrap-done")).focus(), 60);
  }
  function saveWrap() {
    document.querySelectorAll("#wrap-list input").forEach((inp) => {
      const n = notes.find((x) => x.id === inp.dataset.id); const v = inp.value.trim();
      if (n && v !== (n.nextStep || "")) put("notes", { ...n, nextStep: v });
    });
  }
  $("#wrap-done").addEventListener("click", () => {
    saveWrap(); $("#wrap-sheet").hidden = true;
    try { localStorage.setItem("sticky-desk-wrapped", today()); } catch (e) {}
    toast("Done for today. Your next steps will be waiting tomorrow.");
  });
  $("#wrap-later").addEventListener("click", () => { saveWrap(); $("#wrap-sheet").hidden = true; });
  $("#wrap-sheet").addEventListener("click", (e) => { if (e.target.id === "wrap-sheet") { saveWrap(); $("#wrap-sheet").hidden = true; } });

  // gentle nudges: a standup offer in the morning, a wrap-up offer after 5 PM, once each per workday
  function dailyNudge() {
    if (editing || anySheetOpen() || document.body.classList.contains("desk")) return;
    const now = new Date(); if (!isWorkday(now)) return;
    const seen = (k) => { try { return localStorage.getItem(k) === today(); } catch (e) { return true; } };
    const mark = (k) => { try { localStorage.setItem(k, today()); } catch (e) {} };
    if (now.getHours() >= 17 && !seen("sticky-desk-wrapped") && !seen("sticky-desk-wrap-asked") && notes.some((n) => n.column === "doing")) {
      mark("sticky-desk-wrap-asked");
      toast("Wrapping up? Leave yourself a note for tomorrow.", false, { label: "Wrap up", run: openWrap });
    } else if (now.getHours() >= 8 && now.getHours() < 12 && !seen("sticky-desk-standup-asked") && notes.some((n) => n.column === "doing" || n.doneAt)) {
      mark("sticky-desk-standup-asked");
      toast("Morning. Your standup notes are ready.", false, { label: "Standup", run: openStandup });
    }
  }
  setTimeout(dailyNudge, 2500);
  setInterval(dailyNudge, 5 * 60000);

  // welcome back: after a long break, show where you left off
  const ACTIVE_KEY = "sticky-desk-last-active";
  function welcomeBack() {
    let last = 0; try { last = Number(localStorage.getItem(ACTIVE_KEY)) || 0; } catch (e) {}
    try { localStorage.setItem(ACTIVE_KEY, String(Date.now())); } catch (e) {}
    if (!last || Date.now() - last < 45 * 60000 || editing || anySheetOpen()) return;
    const n = notes.filter((x) => x.column === "doing" && x.nextStep).sort((a, b) => (b.touchedAt || 0) - (a.touchedAt || 0))[0];
    if (n) toast(`Welcome back. You were on "${noteLine(n)}". Next: ${n.nextStep}`, false, { label: "Open", run: () => openEditor(n, false) });
  }
  setTimeout(welcomeBack, 1800);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") welcomeBack();
    else { try { localStorage.setItem(ACTIVE_KEY, String(Date.now())); } catch (e) {} }
  });

  /* ---------- keyboard shortcut sheet ---------- */
  const KEYS = [
    ["N", "New note"], ["/", "Search"], ["S", "Standup notes"], ["W", "Your week"], ["G", "Rows by project"], ["?", "This list"],
    ["Tab", "Move between notes"], ["Enter", "Open the note"], ["← →", "Move it to the next column"],
    ["1 2 3", "Send it to To do, Doing or Done"], ["⇧ ↑  ⇧ ↓", "Send it to the top or bottom"],
    ["F", "Flag or unflag"], ["⌫", "Throw it away (Undo is in the toast)"], ["⌘ Z", "Undo"], ["Esc", "Close a sheet"],
  ];
  function openKeys() {
    $("#keys-list").replaceChildren(...KEYS.flatMap(([k, t]) => {
      const dt = document.createElement("dt"); dt.append(...k.split(/\s{1,2}/).map((x) => { const kb = document.createElement("kbd"); kb.textContent = x; return kb; }));
      const dd = document.createElement("dd"); dd.textContent = t; return [dt, dd];
    }));
    $("#keys-sheet").hidden = false; setTimeout(() => $("#keys-done").focus(), 60);
  }
  const closeKeys = () => { $("#keys-sheet").hidden = true; };
  $("#keys-done").addEventListener("click", closeKeys);
  $("#keys-sheet").addEventListener("click", (e) => { if (e.target.id === "keys-sheet") closeKeys(); });
  $("#set-keys").addEventListener("click", () => { $("#bg-sheet").hidden = true; openKeys(); });

  /* ---------- your week: a torn notebook page of what moved ---------- */
  const weekKey = (d = new Date()) => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return ymd(x); };
  function weekReady() {
    const d = new Date();
    return d.getDay() === 4 && d.getHours() >= 15 && settings.weekSeen !== weekKey() && notes.some((n) => n.doneAt && Date.now() - n.doneAt < 7 * DAY);
  }
  function openWeek() {
    const now = Date.now(), from = now - 7 * DAY;
    const done = notes.filter((n) => n.doneAt && n.doneAt >= from);
    const started = notes.filter((n) => n.startedAt && n.startedAt >= from);
    const spans = notes.filter((n) => n.doneAt && n.startedAt && n.doneAt >= now - 30 * DAY && n.doneAt > n.startedAt).map((n) => (n.doneAt - n.startedAt) / DAY).sort((a, b) => a - b);
    const med = spans.length ? spans[Math.floor((spans.length - 1) / 2)] : null;
    const medText = med == null ? "–" : med < 1 ? "under a day" : `${Math.round(med * 2) / 2} day${Math.round(med * 2) / 2 === 1 ? "" : "s"}`;
    const waiting = notes.filter((n) => n.waitingOn && n.column !== "done").length;
    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    $("#week-range").textContent = `${fmt(from + DAY)} – ${fmt(now)}`;
    const stat = (num, label) => { const d = document.createElement("div"); d.className = "week-stat"; const b = document.createElement("b"); b.textContent = num; const s = document.createElement("span"); s.textContent = label; d.append(b, s); return d; };
    $("#week-stats").replaceChildren(stat(done.length, done.length === 1 ? "finished" : "finished"), stat(started.length, "started"), stat(medText, "usually in Doing"), stat(waiting, "waiting on others"));
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 6 + i); return d; });
    const counts = days.map((d) => done.filter((n) => ymd(new Date(n.doneAt)) === ymd(d)).length);
    const max = Math.max(1, ...counts);
    $("#week-bars").replaceChildren(...days.map((d, i) => {
      const col = document.createElement("div"); col.className = "wbar";
      const bar = document.createElement("span"); bar.className = "wbar-fill"; bar.style.setProperty("--h", (counts[i] / max) * 100 + "%"); if (!counts[i]) bar.classList.add("is-zero");
      const n = document.createElement("span"); n.className = "wbar-n"; n.textContent = counts[i] || "";
      const l = document.createElement("span"); l.className = "wbar-day"; l.textContent = d.toLocaleDateString(undefined, { weekday: "narrow" });
      col.append(n, bar, l); return col;
    }));
    $("#week-bars").setAttribute("aria-label", "Finished each day: " + days.map((d, i) => `${d.toLocaleDateString(undefined, { weekday: "long" })} ${counts[i]}`).join(", "));
    renderWeekList();
    $("#week-sheet").hidden = false; $("#fab-dot").hidden = true;
    if (settings.weekSeen !== weekKey()) saveSettings({ weekSeen: weekKey() });
    setTimeout(() => $("#week-done").focus(), 60);
  }
  function renderWeekList() {
    const stale = notes.filter((n) => n.column !== "done" && (ageOf(n).level || (n.waitingOn && n.waitingSince && Date.now() - n.waitingSince > 5 * DAY)))
      .sort((a, b) => (a.touchedAt || a.createdAt || 0) - (b.touchedAt || b.createdAt || 0)).slice(0, 6);
    const host = $("#week-list");
    if (!stale.length) { const p = document.createElement("p"); p.className = "sp-none"; p.textContent = "Nothing gathering dust. Nice."; host.replaceChildren(p); return; }
    host.replaceChildren(...stale.map((n) => {
      const row = document.createElement("div"); row.className = "sp-row week-row";
      const sw = document.createElement("span"); sw.className = "sp-swatch"; sw.style.setProperty("--c", `var(--n-${colorOf(n)})`);
      const t = document.createElement("span"); t.className = "sp-text";
      const a = document.createElement("span"); a.className = "sp-title"; a.textContent = (n.text || "Photo note").replace(/\n/g, " ");
      const c = document.createElement("span"); c.className = "sp-sub";
      c.textContent = n.waitingOn ? `Waiting on ${n.waitingOn} since ${sinceLabel(n.waitingSince)}` : `${{ todo: "To do", doing: "Doing" }[n.column]} · untouched ${ageOf(n).days} days`;
      t.append(a, c);
      const acts = document.createElement("span"); acts.className = "week-acts";
      const mk = (label, aria, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn quiet"; b.textContent = label; b.setAttribute("aria-label", `${aria} "${a.textContent}"`); b.addEventListener("click", fn); return b; };
      acts.append(
        mk("Done", "Mark done:", () => { const moved = withColumn(n, "done"); put("notes", moved); afterDone(n, moved); renderWeekList(); }),
        mk("Next week", "Move to next week:", () => { put("notes", { ...n, due: addDays(today(), 7 - new Date().getDay()) }); renderWeekList(); toast("See you next week.", true); }),
        mk("Open", "Open", () => { $("#week-sheet").hidden = true; openEditor(n, false); }),
      );
      row.append(sw, t, acts); return row;
    }));
  }
  $("#week-btn").addEventListener("click", openWeek);
  $("#week-done").addEventListener("click", () => { $("#week-sheet").hidden = true; });
  $("#week-sheet").addEventListener("click", (e) => { if (e.target.id === "week-sheet") $("#week-sheet").hidden = true; });
  setInterval(() => { if (weekReady()) $("#fab-dot").hidden = false; }, 60000);
  setTimeout(() => { if (weekReady()) $("#fab-dot").hidden = false; }, 1500);
  // stale notes yellow a little more each day even if the board just sits open
  setInterval(() => { if (!drag && !editing) render(); }, 30 * 60000);

  /* ---------- drag: hold to pick up on touch, drag right away with a mouse ---------- */
  board.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".note");
    if (!el || e.button > 0 || editing) return;
    drag = { id: el.dataset.id, el, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType !== "mouse" };
    if (drag.touch) drag.timer = setTimeout(() => drag && !drag.active && lift(), 230);
  });
  function lift() {
    const r = drag.el.getBoundingClientRect();
    const g = drag.el.cloneNode(true);
    g.classList.add("ghost"); g.classList.remove("settle");
    g.style.width = drag.el.offsetWidth + "px";
    g.removeAttribute("tabindex");
    document.body.append(g);
    drag.ghost = g; drag.dx = drag.x - (r.left + r.width / 2); drag.dy = drag.y - (r.top + r.height / 2);
    drag.half = drag.el.offsetWidth / 2;
    drag.active = true;
    drag.el.classList.add("placeholder");
    document.body.classList.add("dragging");
    moveGhost();
    requestAnimationFrame(edgeScroll);
  }
  // While a note is held near an edge, scroll the board (phone) or the page so you can reach other columns.
  function edgeScroll() {
    if (!drag || !drag.active) return;
    const r = board.getBoundingClientRect();
    if (board.scrollWidth > board.clientWidth) {
      if (drag.x < r.left + 40) board.scrollLeft -= 12;
      else if (drag.x > r.right - 40) board.scrollLeft += 12;
    }
    const list = drag.target && drag.target !== "trash" ? board.querySelector(`[data-col="${drag.target}"] .notes`) : null;
    if (list && list.scrollHeight > list.clientHeight) {
      const lr = list.getBoundingClientRect();
      if (drag.y < lr.top + 40) list.scrollTop -= 10;
      else if (drag.y > lr.bottom - 40) list.scrollTop += 10;
    }
    if (drag.y < 60) window.scrollBy(0, -12);
    else if (drag.y > innerHeight - 60) window.scrollBy(0, 12);
    moveGhost();
    requestAnimationFrame(edgeScroll);
  }
  function moveGhost() {
    const { ghost, x, y } = drag;
    ghost.style.transform = `translate(${x - drag.dx - drag.half}px, ${y - drag.dy - drag.half}px) rotate(${(x - drag.x0) > 0 ? 4 : -4}deg) scale(1.07)`;
    const hit = document.elementFromPoint(x, y);
    const overTrash = !!hit?.closest("#trash");
    trash.classList.toggle("over", overTrash);
    const c = overTrash ? null : hit?.closest(".col");
    board.querySelectorAll(".col").forEach((s) => s.classList.toggle("over", s === c));
    drag.target = overTrash ? "trash" : c?.dataset.col || null;
  }
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    const dist = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
    if (!drag.active) {
      if (!drag.touch && dist > 5) lift();
      else if (drag.touch && dist > 10) { clearTimeout(drag.timer); drag = null; } // it's a scroll
      return;
    }
    moveGhost();
  });
  // Stop iPad Safari from scrolling while a note is held.
  document.addEventListener("touchmove", (e) => { if (drag && drag.active) e.preventDefault(); }, { passive: false });
  document.addEventListener("contextmenu", (e) => { if (e.target.closest?.(".note")) e.preventDefault(); });

  function endDrag(commit) {
    const d = drag; drag = null;
    clearTimeout(d.timer);
    if (!d.active) {
      if (commit && Math.hypot(d.x - d.x0, d.y - d.y0) < 10) { const n = notes.find((x) => x.id === d.id); if (n) openEditor(n, false); }
      return;
    }
    d.ghost.remove();
    document.body.classList.remove("dragging");
    trash.classList.remove("over");
    board.querySelectorAll(".col").forEach((s) => s.classList.remove("over"));
    d.el.classList.remove("placeholder");
    const note = notes.find((n) => n.id === d.id);
    if (!commit || !note || !d.target) { render(); return; }
    if (d.target === "trash") { removeNote(note.id); return; }
    const others = [...board.querySelectorAll(`[data-col="${d.target}"] .note`)].filter((el) => el.dataset.id !== d.id);
    let idx = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (d.y < r.top || (d.y <= r.bottom && d.x < r.left + r.width / 2)) { idx = i; break; }
    }
    const list = shownInCol(d.target).filter((n) => n.id !== d.id);
    const prev = list[idx - 1]?.order, next = list[idx]?.order;
    const order = prev == null && next == null ? 1 : prev == null ? next - 1 : next == null ? prev + 1 : (prev + next) / 2;
    if (note.column === d.target && note.order === order) { render(note.id); return; }
    const moved = { ...withColumn(note, d.target), order };
    notes[notes.findIndex((n) => n.id === d.id)] = moved;
    render(moved.id);
    put("notes", moved);
    afterDone(note, moved); checkWip(note, moved);
  }
  window.addEventListener("pointerup", () => drag && endDrag(true));
  window.addEventListener("pointercancel", () => drag && endDrag(false));

  /* ---------- background ---------- */
  const BGS = [
    { id: "auto", name: "Wood (follows light/dark)", swatch: "linear-gradient(90deg, #d8bf98 50%, #4a3727 50%)" },
    { id: "oak", name: "Light oak", swatch: "#d8bf98" },
    { id: "walnut", name: "Walnut", swatch: "#4a3727" },
    { id: "cork", name: "Cork board", swatch: "#c8965e" },
    { id: "white", name: "Whiteboard", swatch: "#eceeec" },
    { id: "linen", name: "Linen", swatch: "#e8dfcf" },
    { id: "felt", name: "Green felt", swatch: "#2f5443" },
    { id: "slate", name: "Chalkboard", swatch: "#2d3134" },
    { id: "night", name: "Wood, dark after Maghrib", swatch: "linear-gradient(135deg, #d8bf98 50%, #4a3727 50%)" },
  ];
  let bg = "auto";
  function applyBg(id) {
    bg = id;
    if (id === "auto") delete document.documentElement.dataset.bg;
    else document.documentElement.dataset.bg = id === "night" ? (isNightNow() ? "walnut" : "oak") : id;
    document.querySelectorAll(".bg-opt").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === id)));
  }
  try { const b = localStorage.getItem("sticky-desk-bg"); if (BGS.some((x) => x.id === b)) applyBg(b); } catch (e) {}
  $("#bgs").replaceChildren(...BGS.map((o) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "bg-opt"; b.dataset.v = o.id;
    const sw = document.createElement("span"); sw.className = "bg-sw"; sw.style.background = o.swatch;
    const l = document.createElement("span"); l.textContent = o.name;
    b.append(sw, l); b.setAttribute("aria-pressed", String(o.id === bg)); return b;
  }));
  $("#bgs").addEventListener("click", async (e) => {
    const b = e.target.closest(".bg-opt"); if (!b) return;
    applyBg(b.dataset.v);
    try { localStorage.setItem("sticky-desk-bg", bg); } catch (err) {}
    saveSettings({ bg });
  });
  $("#bg-btn").addEventListener("click", () => { $("#bg-sheet").hidden = false; $("#bgs .bg-opt[aria-pressed='true']")?.focus(); });
  const closeBg = () => { $("#bg-sheet").hidden = true; };
  $("#bg-done").addEventListener("click", closeBg);
  $("#bg-sheet").addEventListener("click", (e) => { if (e.target.id === "bg-sheet") closeBg(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#bg-sheet").hidden) closeBg(); });

  /* ---------- settings shared by background, Quran and azan ---------- */
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem("sticky-desk-settings") || "{}") || {}; } catch (e) {}
  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    try { localStorage.setItem("sticky-desk-settings", JSON.stringify(settings)); } catch (e) {}
    if (mode === "account") {
      try { await db.doc("settings/board").set(settings); }
      catch (e) { toast("Couldn't save that setting to your account. It's kept on this device."); }
    } else queueSync("settings", "board", settings);
  }
  function syncWipSetting() { const v = settings.wip || WIP_LIMIT; $("#set-wip").textContent = v; $("#set-wip-down").disabled = v <= 1; $("#set-wip-up").disabled = v >= 9; }
  const stepWip = (d) => { const v = Math.min(9, Math.max(1, (settings.wip || WIP_LIMIT) + d)); saveSettings({ wip: v }); syncWipSetting(); render(); };
  $("#set-wip-down").addEventListener("click", () => stepWip(-1));
  $("#set-wip-up").addEventListener("click", () => stepWip(1));
  syncWipSetting();
  function onSettings() {
    syncWipSetting(); syncRail();
    if (BGS.some((x) => x.id === settings.bg)) applyBg(settings.bg);
    renderQuran(); loadAzanSource();
  }

  /* ---------- prayer times for Dhaka ---------- */
  const DHAKA = { lat: 23.8103, lng: 90.4125, tz: "Asia/Dhaka" };
  const PRAYERS = [["fajr", "ফজর", "Fajr"], ["sunrise", "সূর্যোদয়", "Sunrise"], ["dhuhr", "যোহর", "Dhuhr"], ["asr", "আসর", "Asr"], ["maghrib", "মাগরিব", "Maghrib"], ["isha", "এশা", "Isha"]];
  const bnDigits = (s) => String(s).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);
  const arDigits = (s) => String(s).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
  const fmtTime = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: DHAKA.tz });
  function dhakaYMD(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: DHAKA.tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
    return [Number(p.year), Number(p.month), Number(p.day)];
  }
  function timesFor(offset) {
    const [y, m, d] = dhakaYMD(offset);
    const params = adhan.CalculationMethod.Karachi();
    params.madhab = adhan.Madhab.Hanafi;
    return new adhan.PrayerTimes(new adhan.Coordinates(DHAKA.lat, DHAKA.lng), new Date(y, m - 1, d), params);
  }
  let pt = null, ptDay = "";
  function renderPrayer() {
    if (!window.adhan) { $("#pr-next").textContent = "Prayer times couldn't load. Check your connection, then reload the page."; return; }
    const key = dhakaYMD().join("-");
    if (key !== ptDay) { pt = timesFor(0); ptDay = key; }
    const now = new Date();
    const friday = isFridayDhaka();
    const pname = (k, bn) => (friday && k === "dhuhr" ? "জুমা" : bn);
    const today5 = PRAYERS.filter(([k]) => k !== "sunrise");
    const next = today5.find(([k]) => pt[k] > now);
    const nextTime = next ? pt[next[0]] : timesFor(1).fajr;
    const name = next ? pname(next[0], next[1]) : "ফজর (আগামীকাল)";
    const mins = Math.max(0, Math.round((nextTime - now) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    $("#pr-next").textContent = `পরের নামাজ ${name} · ${h ? bnDigits(h) + " ঘণ্টা " : ""}${bnDigits(m)} মিনিট পর`;
    $("#pr-date").textContent = now.toLocaleDateString("bn-BD", { weekday: "long", day: "numeric", month: "long", timeZone: DHAKA.tz });
    // The rail shows only the upcoming prayer; the full list stays in the Prayer & Quran sheet.
    const railMain = document.createElement("span"); railMain.textContent = `${next ? pname(next[0], next[1]) : "ফজর"} ${fmtTime(nextTime)}`;
    const railCount = document.createElement("span"); railCount.className = "rn-count"; railCount.textContent = ` · ${h ? bnDigits(h) + " ঘণ্টা " : ""}${bnDigits(m)} মিনিট পর`;
    if (isRamadan()) {
      // Ramadan: the rail counts down to sehri's end or iftar instead
      const fajrNext = now < pt.fajr ? pt.fajr : timesFor(1).fajr;
      const [lab, at] = now >= pt.fajr && now < pt.maghrib ? ["ইফতার", pt.maghrib] : ["সেহরি শেষ", fajrNext];
      const rm = Math.max(0, Math.round((at - now) / 60000)), rh = Math.floor(rm / 60);
      railMain.textContent = `${lab} ${fmtTime(at)}`;
      railCount.textContent = ` · ${rh ? bnDigits(rh) + " ঘণ্টা " : ""}${bnDigits(rm % 60)} মিনিট পর`;
    }
    $("#rail-next").replaceChildren(railMain, railCount);
    $("#rail-label").setAttribute("aria-label", `Next prayer ${next ? next[2] : "Fajr"} at ${fmtTime(nextTime)}, in ${h ? h + " hours " : ""}${m} minutes. Opens prayer times and today's Quran.`);
    ticker.prayer = friday ? [{ t: "জুমা মোবারক · আজ সূরা আল-কাহফ পড়ার দিন", cls: "head" }, { t: "◆", cls: "sep" }] : [];
    updateTicker();
    $("#pr-times").replaceChildren(...PRAYERS.map(([k, bn, en]) => {
      const li = document.createElement("li");
      if (next && k === next[0]) li.className = "is-next"; else if (pt[k] <= now) li.className = "is-past";
      const a = document.createElement("span"); a.className = "pn"; a.textContent = `${pname(k, bn)} · ${friday && k === "dhuhr" ? "Jumu'ah" : en}`;
      const b = document.createElement("span"); b.className = "pt"; b.textContent = fmtTime(pt[k]);
      li.append(a, b); return li;
    }));
    if (bg === "night") applyBg("night");
    renderRamadanInfo(now);
    focusPrayerCheck(now);
    checkAzan(now);
  }

  /* ---------- azan: plays while this page is open ---------- */
  const audio = new Audio();
  audio.preload = "auto";
  let audioReady = false, actx = null, playedKey = "", localAzanUrl = "";
  const azanOn = () => !!settings.azanOn;
  function syncAzanBtn() {
    const b = $("#azan-toggle");
    b.setAttribute("aria-pressed", String(azanOn()));
    b.textContent = azanOn() ? "আযান চালু ✓" : "আযান চালু করুন";
  }
  function loadAzanSource() {
    const src = localAzanUrl || (settings.azanId ? "/_blob/" + settings.azanId : "");
    if (src && audio.dataset.src !== src) { audio.src = src; audio.dataset.src = src; audioReady = false; }
    $("#azan-current").textContent = src
      ? `Using: ${settings.azanName || "your azan recording"}`
      : "No azan added yet, so a soft bell plays at prayer time.";
    syncAzanBtn();
  }
  // Apple only lets a page play sound after a tap, so every tap quietly gets the audio ready.
  function unlockAudio() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {}
    if (audio.src && !audioReady) {
      audio.muted = true;
      const p = audio.play();
      if (p) p.then(() => { audio.pause(); audio.currentTime = 0; audio.muted = false; audioReady = true; }).catch(() => { audio.muted = false; });
    }
  }
  ["click", "touchend"].forEach((t) => document.addEventListener(t, () => { if (azanOn()) unlockAudio(); }, { capture: true, passive: true }));
  function chime() {
    if (!actx) return;
    const t0 = actx.currentTime + 0.05;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      const t = t0 + i * 0.9;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 2.4);
      o.start(t); o.stop(t + 2.5);
    });
  }
  function playAzan() {
    if (audio.src) { audio.muted = false; audio.currentTime = 0; audio.play().catch(() => chime()); }
    else chime();
  }
  function checkAzan(now) {
    if (!azanOn() || !pt) return;
    for (const [k, bn, en] of PRAYERS) {
      if (k === "sunrise") continue;
      const key = ptDay + k, dt = now - pt[k];
      if (dt >= 0 && dt < 120000 && playedKey !== key) {
        playedKey = key;
        playAzan();
        $("#banner-msg").textContent = `${bn} (${en}) এর সময় হয়েছে`;
        $("#banner").hidden = false;
      }
    }
  }
  $("#banner-stop").addEventListener("click", () => { audio.pause(); $("#banner").hidden = true; });
  $("#azan-toggle").addEventListener("click", () => {
    const on = !azanOn();
    unlockAudio();
    saveSettings({ azanOn: on }); syncAzanBtn();
    toast(on ? "Azan is on. Keep this page open, ideally in Focus mode, and it plays at each prayer time."
             : "Azan is off.");
  });
  $("#azan-settings").addEventListener("click", () => { $("#azan-sheet").hidden = false; });
  const closeAzan = () => { $("#azan-sheet").hidden = true; };
  $("#azan-done").addEventListener("click", closeAzan);
  $("#azan-sheet").addEventListener("click", (e) => { if (e.target.id === "azan-sheet") closeAzan(); });
  $("#azan-test").addEventListener("click", () => {
    unlockAudio();
    if (audio.src) { audio.muted = false; audio.currentTime = 0; audio.play().then(() => { audioReady = true; }).catch(() => toast("Couldn't play that file. Try an MP3 or M4A recording.")); }
    else chime();
  });
  $("#azan-stop").addEventListener("click", () => audio.pause());
  $("#azan-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast("That file is over 20 MB. Choose a shorter recording."); return; }
    const assets = mode === "account" && window.claude?.use ? await window.claude.use("assets") : null;
    if (assets) {
      $("#azan-current").textContent = "Uploading…";
      try {
        const r = await assets.upload(f, { type: f.type || "audio/mpeg" });
        await saveSettings({ azanId: r.id, azanName: f.name });
        loadAzanSource();
        toast("Azan saved. Tap Play to test it.");
      } catch (err) { toast("Couldn't upload that file. Try an MP3, then try again."); loadAzanSource(); }
    } else {
      localAzanUrl = URL.createObjectURL(f);
      settings.azanName = f.name;
      loadAzanSource();
      toast("Azan added for this visit. Open the board signed in to claude.ai to keep it.");
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#azan-sheet").hidden) closeAzan(); });

  /* ---------- daily Quran: about one minute a day, in order ---------- */
  let qIndex = null, qShown = -1;
  const qCache = {};
  async function loadQIndex() {
    if (!qIndex) { const r = await fetch("q/index.json"); if (!r.ok) throw new Error("index"); qIndex = await r.json(); }
    return qIndex;
  }
  async function surah(s) {
    if (!qCache[s]) { const r = await fetch(`q/${String(s).padStart(3, "0")}.json`); if (!r.ok) throw new Error("surah"); qCache[s] = await r.json(); }
    return qCache[s];
  }
  const todayDhaka = () => dhakaYMD().join("-");
  function qState() {
    const pos = Math.max(0, Number(settings.quranPos) || 0);
    const done = settings.quranDoneOn === todayDhaka();
    return { pos, done, show: done ? Math.max(0, pos - 1) : pos };
  }
  async function renderQuran() {
    try {
      const idx = await loadQIndex();
      const st = qState(), n = idx.portions.length, i = (qBrowse ?? st.show) % n;
      const [s, a, b] = idx.portions[i];
      const ch = idx.chapters[s - 1];
      $("#qr-ref").textContent = `${ch[0]} · ${ch[1]} · আয়াত ${bnDigits(a)}${b > a ? "–" + bnDigits(b) : ""}`;
      const streak = qStreakNow();
      $("#qr-progress").textContent = qBrowse != null ? "সূরা আল-কাহফ" : `পর্ব ${bnDigits(i + 1)} / ${bnDigits(n)}` + (streak > 1 ? ` · টানা ${bnDigits(streak)} দিন` : "") + ramadanGoal(n - st.pos);
      $("#qr-done").textContent = qBrowse != null ? "পরের অংশ →" : st.done ? "আজ পড়া হয়েছে ✓ · আরও পড়ুন" : "পড়া হয়েছে ✓";
      $("#qr-done").classList.toggle("primary", qBrowse == null && !st.done);
      $("#qr-kahf").hidden = !(isFridayDhaka() && qBrowse == null);
      $("#qr-back").hidden = qBrowse == null;
      $("#qr-prev").disabled = i === 0;
      if (i === qShown) return;
      qShown = i;
      const verses = await surah(s);
      const kids = [];
      if (a === 1 && s !== 1 && s !== 9) {
        const bism = document.createElement("p"); bism.className = "ar"; bism.lang = "ar"; bism.dir = "rtl"; bism.style.textAlign = "center";
        bism.textContent = (await surah(1))[0][0];
        kids.push(bism);
      }
      for (let v = a; v <= b; v++) {
        const [ar, bn] = verses[v - 1];
        const box = document.createElement("div"); box.className = "ayah";
        const pa = document.createElement("p"); pa.className = "ar"; pa.lang = "ar"; pa.dir = "rtl";
        const na = document.createElement("span"); na.className = "num"; na.textContent = ` ﴿${arDigits(v)}﴾`;
        pa.append(ar, na);
        const pb = document.createElement("p"); pb.className = "bn"; pb.lang = "bn";
        const nb = document.createElement("span"); nb.className = "num"; nb.textContent = `(${bnDigits(v)}) `;
        pb.append(nb, bn);
        box.append(pa, pb); kids.push(box);
      }
      ticker.quran = [{ t: `আজকের কুরআন · ${ch[1]} ${bnDigits(a)}${b > a ? "–" + bnDigits(b) : ""}`, cls: "head" }];
      for (let v = a; v <= Math.min(b, a + 2); v++) {
        ticker.quran.push({ t: `${verses[v - 1][0]} ﴿${arDigits(v)}﴾`, ar: true }, { t: `(${bnDigits(v)}) ${verses[v - 1][1]}` }, { t: "◆", cls: "sep" });
      }
      updateTicker();
      $("#qr-body").replaceChildren(...kids);
      $("#qr-body").scrollTop = 0;
    } catch (e) {
      const p = document.createElement("p"); p.className = "qr-empty";
      p.textContent = "আজকের আয়াত লোড করা যায়নি। ইন্টারনেট সংযোগ দেখে পেজটি আবার খুলুন।";
      $("#qr-body").replaceChildren(p);
    }
  }
  $("#qr-done").addEventListener("click", async () => {
    if (qBrowse != null) {
      const idx = await loadQIndex(); const nx = qBrowse + 1;
      if (idx.portions[nx]?.[0] === 18) qBrowse = nx; else { qBrowse = null; toast("সূরা আল-কাহফ শেষ। মাশাআল্লাহ!"); }
      renderQuran(); return;
    }
    const st = qState();
    const patch = { quranPos: st.pos + 1, quranDoneOn: todayDhaka() };
    if (!st.done) {
      const y = dhakaYMD(-1).join("-");
      patch.qStreak = settings.qLastDay === y ? (settings.qStreak || 0) + 1 : settings.qLastDay === todayDhaka() ? (settings.qStreak || 1) : 1;
      patch.qLastDay = todayDhaka();
    }
    saveSettings(patch);
    renderQuran();
    if (!st.done) toast(patch.qStreak > 1 ? `মাশাআল্লাহ! টানা ${bnDigits(patch.qStreak)} দিন পড়লেন।` : "মাশাআল্লাহ! আজকের পড়া শেষ।");
  });
  $("#qr-prev").addEventListener("click", async () => {
    if (qBrowse != null) { const idx = await loadQIndex(); if (idx.portions[qBrowse - 1]?.[0] === 18) qBrowse--; renderQuran(); return; }
    saveSettings({ quranPos: Math.max(0, qState().show - 1), quranDoneOn: "" });
    renderQuran();
  });

  /* ---------- show or hide the prayer & Quran strip ---------- */
  let stripOn = false;
  function setStrip(on) {
    stripOn = on; $("#today").hidden = !on;
    $("#today-btn").setAttribute("aria-expanded", String(on));
    if (on) renderPrayer();
  }
  setStrip(false);
  $("#today-btn").addEventListener("click", () => setStrip(!stripOn));
  $("#today-close").addEventListener("click", () => setStrip(false));
  $("#today").addEventListener("click", (e) => { if (e.target.id === "today") setStrip(false); });
  $("#rail").addEventListener("click", () => setStrip(true));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stripOn) setStrip(false); });

  /* ---------- news rail ---------- */
  $("#rail-pause").addEventListener("click", (e) => {
    e.stopPropagation();
    const paused = !$("#rail").classList.contains("paused");
    $("#rail").classList.toggle("paused", paused);
    e.currentTarget.setAttribute("aria-pressed", String(paused));
    e.currentTarget.setAttribute("aria-label", paused ? "Play scrolling verses" : "Pause scrolling verses");
    e.currentTarget.innerHTML = paused ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
  });

  /* ---------- sheets: keep focus inside, return it to where you were ---------- */
  if (!document.documentElement.lang) document.documentElement.lang = "en";
  const SHEETS = ["#hand", "#proj-sheet", "#bg-sheet", "#azan-sheet", "#today", "#spotlight", "#archive-sheet", "#ai-sheet", "#onboard", "#signin"].map((q) => $(q));
  const BEHIND = () => [...document.querySelectorAll(".wrap > *:not(#today):not(#today-close), #fab, #rail, #searchbar, #exit-desk, #trash")];
  const openers = new Map();
  new MutationObserver(() => {
    const anyOpen = SHEETS.some((el) => !el.hidden);
    BEHIND().forEach((el) => { el.inert = anyOpen; });
    for (const el of SHEETS) {
      if (!el.hidden && !openers.has(el)) {
        openers.set(el, document.activeElement);
        setTimeout(() => { if (!el.contains(document.activeElement)) el.querySelector("textarea, input, select, button, [tabindex='0']")?.focus({ preventScroll: true }); }, 120);
      } else if (el.hidden && openers.has(el)) {
        let back = openers.get(el); openers.delete(el);
        // the board redraws on save, so find the same note again by its id
        if (back && !back.isConnected && back.dataset?.id) back = board.querySelector(`[data-id="${back.dataset.id}"]`);
        if (back && back.isConnected) setTimeout(() => back.focus({ preventScroll: true }), 0);
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  // Tab and Shift+Tab loop inside an open sheet
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const sheet = SHEETS.find((el) => !el.hidden); if (!sheet) return;
    const items = [...sheet.querySelectorAll("button, input, select, textarea, [tabindex='0']")].filter((x) => !x.disabled && !x.closest("[hidden], [inert]") && x.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  const ticker = { prayer: [], quran: [] };
  let tickerKey = "";
  function updateTicker() {
    const parts = [...ticker.prayer, ...ticker.quran];
    const key = JSON.stringify(parts);
    if (key === tickerKey) return;
    tickerKey = key;
    const seq = () => {
      const d = document.createElement("div"); d.className = "rail-seq";
      for (const p of parts) {
        const s = document.createElement("span"); s.className = "rail-item " + (p.cls || "");
        if (p.ar) { s.lang = "ar"; s.dir = "rtl"; }
        s.textContent = p.t; d.append(s);
      }
      return d;
    };
    const move = $("#rail-move");
    move.replaceChildren(seq(), seq());
    requestAnimationFrame(() => move.style.setProperty("--dur", Math.max(25, move.firstChild.scrollWidth / 55) + "s"));
  }

  /* ---------- focus mode: full screen, screen kept awake, nothing but the board ---------- */
  let wake = null, clockTimer = null, lastDay = today();
  async function requestWake() { try { wake = await navigator.wakeLock.request("screen"); return true; } catch (e) { return false; } }
  function tick() {
    const d = new Date();
    $("#clock").textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  // Date and time under the title, kept current to the minute
  const showDate = () => {
    const d = new Date();
    $("#clock").textContent = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };
  showDate();
  setTimeout(() => { showDate(); setInterval(showDate, 60000); }, (60 - new Date().getSeconds()) * 1000);
  // Re-draw at midnight so "Today", "TMR" and "Late" stay right on a board left open.
  setInterval(() => { if (today() !== lastDay) { lastDay = today(); render(); if (!document.body.classList.contains("desk")) showDate(); } }, 60000);
  const root = document.documentElement;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  // must run straight from the tap: browsers only allow full screen from a user gesture
  function enterFullscreen() {
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req) return Promise.resolve(false);
    try { return Promise.resolve(req.call(root, { navigationUI: "hide" })).then(() => true, () => false); } catch (e) { return Promise.resolve(false); }
  }
  function leaveFullscreen() {
    if (!fsElement()) return;
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
  }
  async function setDesk(on) {
    if (on === document.body.classList.contains("desk")) return;
    const full = on ? enterFullscreen() : (leaveFullscreen(), Promise.resolve(false));
    document.body.classList.toggle("desk", on);
    setFab(false);
    if (on) {
      tick(); clearInterval(clockTimer); clockTimer = setInterval(tick, 15000);
      const [isFull, awake] = await Promise.all([full, requestWake()]);
      const how = isFull ? "Press Esc or tap Exit focus mode to leave." : "This browser can't go full screen. On iPhone, Add to Home Screen opens it without the browser bars.";
      toast(`Focus mode is on. ${how}` + (awake ? "" : " Your screen may still lock on its own."));
    } else {
      clearInterval(clockTimer); showDate();
      $("#clock").style.fontVariantNumeric = "tabular-nums";
      try { await wake?.release(); } catch (e) {}
      wake = null;
    }
  }
  // leaving full screen with Esc or the browser's own control ends focus mode too
  const onFsChange = () => { if (!fsElement() && document.body.classList.contains("desk")) setDesk(false); };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("desk") && !fsElement() && !editing && !anySheetOpen()) setDesk(false); });
  $("#desk-btn").addEventListener("click", () => setDesk(true));
  $("#exit-desk").addEventListener("click", () => setDesk(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.body.classList.contains("desk")) requestWake();
  });

  /* =====================================================================
     Premium features
     ===================================================================== */

  /* ---------- undo history (⌘Z / Ctrl+Z, and Undo in messages) ---------- */
  const undoStack = [];
  let undoing = false;
  function remember(kind, before, id) {
    undoStack.push({ kind, id, before: before ? JSON.parse(JSON.stringify(before)) : null });
    if (undoStack.length > 60) undoStack.shift();
  }
  function undo() {
    const h = undoStack.pop();
    $("#toast").hidden = true;
    if (!h) { toast("Nothing to undo."); return; }
    undoing = true;
    try { if (h.before) put(h.kind, h.before); else del(h.kind, h.id); } finally { undoing = false; }
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    e.preventDefault(); undo();
  });

  /* ---------- archive: Done notes older than a week ---------- */
  function isArchived(n) { return n.column === "done" && n.doneAt && Date.now() - n.doneAt > 7 * 864e5; }
  function renderArchive() {
    const list = notes.filter(isArchived).sort((a, b) => b.doneAt - a.doneAt);
    const host = $("#arch-list");
    if (!list.length) { const p = document.createElement("p"); p.className = "sp-none"; p.textContent = "Nothing archived yet."; host.replaceChildren(p); return; }
    host.replaceChildren(...list.map((n) => {
      const row = document.createElement("div"); row.className = "sp-row arch-row";
      const sw = document.createElement("span"); sw.className = "sp-swatch"; sw.style.setProperty("--c", `var(--n-${colorOf(n)})`);
      const t = document.createElement("span"); t.className = "sp-text";
      const a = document.createElement("span"); a.className = "sp-title"; a.textContent = (n.text || "Photo note").replace(/\n/g, " ");
      const c = document.createElement("span"); c.className = "sp-sub"; c.textContent = `${projOf(n)?.name || ""} · finished ${new Date(n.doneAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
      t.append(a, c);
      const back = document.createElement("button"); back.type = "button"; back.className = "btn quiet"; back.textContent = "Put back";
      back.setAttribute("aria-label", `Put "${a.textContent}" back in To do`);
      back.addEventListener("click", () => { put("notes", { ...withColumn(n, "todo") }); renderArchive(); toast("Back in To do.", true); });
      row.append(sw, t, back); return row;
    }));
  }
  $("#archive-btn").addEventListener("click", () => { renderArchive(); $("#archive-sheet").hidden = false; });
  $("#arch-done").addEventListener("click", () => { $("#archive-sheet").hidden = true; });
  $("#archive-sheet").addEventListener("click", (e) => { if (e.target.id === "archive-sheet") $("#archive-sheet").hidden = true; });

  /* ---------- smart typing: "PDF feedback tmr !! #beevo" ---------- */
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const REPEAT_NAME = { daily: "every day", weekdays: "every weekday", weekly: "every week", monthly: "every month" };
  function parseQuick(raw) {
    const out = {};
    let t = " " + (raw || "") + " ";
    const take = (re, fn) => { t = t.replace(re, (m, ...g) => (fn(...g) === false ? m : " ")); };
    take(/(?<=\s)(every ?weekday|weekdays|every ?day|daily|every ?week|weekly|every ?month|monthly)(?=\s)/gi, (w) => {
      w = w.toLowerCase().replace(/\s/g, "");
      out.repeat = /weekday/.test(w) ? "weekdays" : /day|daily/.test(w) ? "daily" : /week/.test(w) ? "weekly" : "monthly";
    });
    take(/(?<=\s)(today|tonight)(?=\s)/gi, () => { out.due = today(); });
    take(/(?<=\s)(tmr|tmrw|tomorrow)(?=\s)/gi, () => { out.due = addDays(today(), 1); });
    take(/(?<=\s)next week(?=\s)/gi, () => { out.due = nextMonday(); });
    take(/(?<=\s)in (\d{1,2}) days?(?=\s)/gi, (n) => { out.due = addDays(today(), Number(n)); });
    take(/(?<=\s)(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?=\s)/gi, (d) => {
      const want = WEEKDAYS.indexOf(d.toLowerCase()), now = new Date().getDay();
      out.due = addDays(today(), ((want - now + 7) % 7) || 7);
    });
    take(/(?<=\s)(!{1,3})(?=\s)/g, (b) => { out.priority = b.length; });
    take(/(?<=\s)\*(?=\s)/g, () => { out.flagged = true; });
    take(/(?<=\s)#([^\s#]+)(?=\s)/g, (tag) => {
      const key = tag.toLowerCase();
      const p = sortedProjects().find((x) => x.name.toLowerCase().replace(/\s+/g, "").startsWith(key));
      if (!p) return false;
      out.projectId = p.id;
    });
    out.text = t.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
    out.changed = ["due", "priority", "projectId", "repeat", "flagged"].some((k) => out[k] !== undefined);
    return out;
  }
  function hintFor(p) {
    const bits = [];
    if (p.due) bits.push(dueInfo(p.due).label);
    if (p.repeat) bits.push(REPEAT_NAME[p.repeat]);
    if (p.priority) bits.push("!".repeat(p.priority));
    if (p.flagged) bits.push("flagged");
    if (p.projectId) bits.push(projects.find((x) => x.id === p.projectId)?.name);
    return bits.join(" · ");
  }
  function updateHint() {
    const h = $("#nlp-hint"), v = editText.value;
    const p = parseQuick(v);
    if (p.changed) { h.hidden = false; h.classList.remove("tip"); h.textContent = "Sets " + hintFor(p); }
    else if (editing?.isNew && !v.trim()) { h.hidden = false; h.classList.add("tip"); h.textContent = "Tip: add tmr, friday, !!, * or #project as you type."; }
    else h.hidden = true;
    $("#tpl-row").hidden = !(editing?.isNew && !v.trim());
  }
  editText.addEventListener("input", updateHint);

  /* ---------- templates for new notes ---------- */
  const TEMPLATES = [
    ["Design review", "Design review", ["Check it against the brief", "Review spacing and type", "Test on iPhone and iPad", "Collect feedback", "Write next steps"]],
    ["Bug fix", "Fix bug", ["Reproduce it", "Find the cause", "Fix and test", "Ask for review"]],
    ["Meeting prep", "Meeting prep", ["Set the agenda", "Gather the files", "Write three questions", "Share notes after"]],
    ["Weekly plan", "Plan the week", ["Review last week", "Pick three big tasks", "Block focus time", "Check deadlines"]],
  ];
  $("#tpl-row").replaceChildren(...TEMPLATES.map(([label, text, steps]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "tpl"; b.textContent = label;
    b.addEventListener("click", () => {
      if (!editing) return;
      editText.value = text;
      editing.note.checklist = steps.map((x) => ({ t: x, done: false }));
      renderSteps(); updateHint();
      toast(`Added ${steps.length} steps on the back of the note.`);
      editText.focus();
    });
    return b;
  }));

  /* ---------- Claude: steps, plan my day, weekly review (claude.ai only) ---------- */
  let sampler = null, samplerChecked = false;
  async function getSampler() {
    if (samplerChecked) return sampler;
    samplerChecked = true;
    if (mode !== "account" || !window.claude?.use) return null;
    sampler = await window.claude.use("sample").catch(() => null);
    return sampler;
  }
  const aiError = (e) => toast(e?.code === "not_granted" ? "Claude isn't allowed on this page. You can allow it in the page's Permissions." : e?.code === "rate_limited" ? "Claude is busy. Try again in a minute." : "Couldn't reach Claude right now. Try again in a moment.");
  function prepEditorExtras(isNew) {
    updateHint();
    $("#ai-steps").hidden = !sampler;
    $("#focus-btn").textContent = focus && focus.noteId === editing?.note.id ? "⏱ Focusing on this" : "⏱ Focus 25 min";
  }
  $("#ai-steps").addEventListener("click", async () => {
    const s = await getSampler(); if (!s || !editing) return;
    const task = parseQuick(editText.value).text;
    if (!task) { toast("Write the task first, then Claude can split it into steps."); return; }
    const btn = $("#ai-steps"); btn.disabled = true; btn.textContent = "Thinking…";
    try {
      const r = await s(`Break this task into 3 to 6 short, concrete steps someone can tick off. Task: "${task}".${editing.note.details ? " Extra notes: " + editing.note.details : ""} Reply with one step per line, no numbers, no bullets, nothing else.`, { modelTier: "quick" });
      const steps = (r.text || "").split("\n").map((x) => x.replace(/^[\s\-*•\d.)]+/, "").trim()).filter(Boolean).slice(0, 8);
      if (steps.length && editing) { editing.note.checklist.push(...steps.map((x) => ({ t: x, done: false }))); renderSteps(); setFlip(true); }
    } catch (e) { aiError(e); }
    finally { btn.disabled = false; btn.textContent = "✨ Break into steps"; }
  });
  function boardSummary() {
    return notes.map((n) => ({
      task: (n.text || "(photo)").replace(/\n/g, " "), column: COL_NAME[n.column], project: projOf(n)?.name || "",
      due: n.due || undefined, priority: n.priority || undefined, flagged: n.flagged || undefined,
      steps: (n.checklist || []).length ? `${n.checklist.filter((x) => x.done).length}/${n.checklist.length}` : undefined,
      finished: n.doneAt ? new Date(n.doneAt).toISOString().slice(0, 10) : undefined,
    }));
  }
  async function askClaude(kind) {
    const s = await getSampler(); if (!s) return;
    const out = $("#ai-out"); const p = document.createElement("p"); p.className = "ai-text"; p.textContent = "Thinking…"; out.replaceChildren(p);
    const prayers = pt ? "Prayer times in Dhaka today: " + PRAYERS.map(([k, , en]) => `${en} ${fmtTime(pt[k])}`).join(", ") + "." : "";
    const when = new Date().toLocaleString("en-GB", { timeZone: DHAKA.tz, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
    const prompt = kind === "plan"
      ? `It is ${when} in Dhaka. ${prayers} My tasks as JSON: ${JSON.stringify(boardSummary())}. Suggest a realistic plan for the rest of today. Pick at most four open tasks, late and high-priority first, and put them in time blocks that fit between the prayers. One line per block, like "2:00–3:30 PM · Task". Plain text, no markdown. End with one short, warm sentence.`
      : `It is ${when}. My tasks as JSON, with finish dates: ${JSON.stringify(boardSummary())}. Write a short weekly review in plain text with three short sections: Finished this week, Still open or late, Focus next week (three items). No markdown symbols.`;
    try {
      const r = await s(prompt, { modelTier: "default", onText: ({ text }) => { p.textContent = text; } });
      p.textContent = r.text;
    } catch (e) { p.textContent = ""; aiError(e); }
  }
  $("#ai-btn").addEventListener("click", () => { $("#ai-sheet").hidden = false; });
  $("#ai-plan").addEventListener("click", () => askClaude("plan"));
  $("#ai-review").addEventListener("click", () => askClaude("review"));
  $("#ai-done").addEventListener("click", () => { $("#ai-sheet").hidden = true; });
  $("#ai-sheet").addEventListener("click", (e) => { if (e.target.id === "ai-sheet") $("#ai-sheet").hidden = true; });
  // Show the Claude features once we know this view can use them
  setTimeout(async () => { const s = await getSampler(); $("#ai-btn").hidden = !s; }, 1500);

  /* ---------- sounds and the Done celebration ---------- */
  function ensureAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {} return actx; }
  ["pointerdown", "keydown"].forEach((t) => document.addEventListener(t, () => { if (settings.sounds !== false) ensureAudio(); }, { capture: true, passive: true, once: true }));
  function paperSound() {
    if (settings.sounds === false) return;
    const ac = ensureAudio(); if (!ac) return;
    const t0 = ac.currentTime + 0.01, len = 0.32;
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = "bandpass"; f.frequency.setValueAtTime(2400, t0); f.frequency.exponentialRampToValueAtTime(900, t0 + len); f.Q.value = 0.8;
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    src.connect(f); f.connect(g); g.connect(ac.destination); src.start(t0);
    const o = ac.createOscillator(), og = ac.createGain(); o.type = "sine"; o.frequency.value = 1046.5;
    og.gain.setValueAtTime(0.0001, t0 + 0.12); og.gain.exponentialRampToValueAtTime(0.12, t0 + 0.14); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
    o.connect(og); og.connect(ac.destination); o.start(t0 + 0.12); o.stop(t0 + 0.75);
  }
  function celebrate(id) {
    paperSound();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    requestAnimationFrame(() => {
      const el = board.querySelector(`[data-id="${id}"]`);
      const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 3;
      const cs = getComputedStyle(document.documentElement);
      const colors = ["--n-pink", "--n-yellow", "--n-blue", "--n-green", "--n-orange", "--n-lilac"].map((v) => cs.getPropertyValue(v).trim());
      const dpr = Math.min(2, devicePixelRatio || 1);
      const cv = document.createElement("canvas"); cv.className = "confetti"; cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      document.body.append(cv);
      const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
      const bits = Array.from({ length: 46 }, () => ({
        x: cx, y: cy, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3, w: 6 + Math.random() * 7, h: 6 + Math.random() * 7,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: colors[Math.floor(Math.random() * colors.length)],
      }));
      const start = performance.now();
      const step = (now) => {
        const k = (now - start) / 1300;
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        for (const b of bits) {
          b.vy += 0.32; b.vx *= 0.985; b.x += b.vx; b.y += b.vy; b.r += b.vr;
          ctx.save(); ctx.globalAlpha = Math.max(0, 1 - k); ctx.translate(b.x, b.y); ctx.rotate(b.r);
          ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
        }
        if (k < 1) requestAnimationFrame(step); else cv.remove();
      };
      requestAnimationFrame(step);
    });
  }

  /* ---------- focus timer that steps aside for prayer ---------- */
  const FOCUS_MIN = 25;
  let focus = null, focusTimer = null;
  try { focus = JSON.parse(localStorage.getItem("sticky-desk-focus") || "null"); } catch (e) {}
  const saveFocus = () => { try { focus ? localStorage.setItem("sticky-desk-focus", JSON.stringify(focus)) : localStorage.removeItem("sticky-desk-focus"); } catch (e) {} };
  const focusLeft = () => (focus ? (focus.paused ? focus.left : focus.endsAt - Date.now()) : 0);
  function renderFocus() {
    const pill = $("#focus-pill");
    if (!focus) { pill.hidden = true; clearInterval(focusTimer); focusTimer = null; return; }
    const n = notes.find((x) => x.id === focus.noteId);
    const left = Math.max(0, focusLeft()), mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    pill.hidden = false;
    pill.classList.toggle("paused", !!focus.paused);
    $("#fp-label").textContent = focus.paused && focus.reason ? focus.reason : (n?.text || "Focus").split("\n")[0].slice(0, 28);
    $("#fp-time").textContent = `${mm}:${String(ss).padStart(2, "0")}`;
    $("#fp-toggle").textContent = focus.paused ? "Resume" : "Pause";
    if (!focus.paused && left <= 0) finishFocus();
  }
  function startFocus(noteId) {
    ensureAudio();
    focus = { noteId, endsAt: Date.now() + FOCUS_MIN * 60000, paused: false, left: 0, skip: "" };
    saveFocus(); renderFocus();
    clearInterval(focusTimer); focusTimer = setInterval(renderFocus, 1000);
    toast(`Focus for ${FOCUS_MIN} minutes. It pauses itself before the next prayer.`);
  }
  function finishFocus() {
    const n = notes.find((x) => x.id === focus.noteId);
    if (n) put("notes", { ...n, focusCount: (n.focusCount || 0) + 1 });
    focus = null; saveFocus(); renderFocus();
    chime(); toast("Focus session done. Take a five-minute break.");
  }
  function focusPrayerCheck(now) {
    if (!focus || focus.paused || !pt) return;
    for (const [k, bn] of PRAYERS) {
      if (k === "sunrise") continue;
      const until = pt[k] - now, key = ptDay + k;
      if (until <= 5 * 60000 && until > -20 * 60000 && focus.skip !== key) {
        focus.left = focus.endsAt - Date.now(); focus.paused = true; focus.reason = `${bn}-এর জন্য বিরতি`; focus.skip = key;
        saveFocus(); renderFocus(); toast(`Focus paused for ${bn}. Tap Resume after salah.`); return;
      }
    }
  }
  $("#fp-toggle").addEventListener("click", () => {
    if (!focus) return;
    if (focus.paused) { focus.endsAt = Date.now() + focus.left; focus.paused = false; focus.reason = ""; }
    else { focus.left = focus.endsAt - Date.now(); focus.paused = true; focus.reason = ""; }
    saveFocus(); renderFocus();
  });
  $("#fp-stop").addEventListener("click", () => { focus = null; saveFocus(); renderFocus(); });
  $("#focus-btn").addEventListener("click", () => {
    if (!editing) return;
    const id = editing.note.id;
    closeEditor(true);
    if (notes.some((n) => n.id === id)) startFocus(id);
  });
  if (focus) { renderFocus(); focusTimer = setInterval(renderFocus, 1000); }

  /* ---------- night desk, Ramadan, Jumu'ah, Quran streak ---------- */
  function isNightNow() {
    const now = new Date();
    if (pt) return now >= pt.maghrib || now < pt.fajr;
    const h = now.getHours(); return h >= 18 || h < 6;
  }
  function hijri() {
    try {
      const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { day: "numeric", month: "numeric", timeZone: DHAKA.tz }).formatToParts(new Date());
      const get = (t) => Number(parts.find((x) => x.type === t)?.value);
      return { month: get("month"), day: get("day") };
    } catch (e) { return { month: 0, day: 0 }; }
  }
  function isRamadan() {
    const m = settings.ramadan || "auto";
    return m === "on" || (m === "auto" && hijri().month === 9);
  }
  function isFridayDhaka() {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: DHAKA.tz }).format(new Date()) === "Fri";
  }
  function renderRamadanInfo() {
    const info = $("#ramadan-info");
    info.textContent = isRamadan() && pt ? `ইফতার ${fmtTime(pt.maghrib)} · সেহরি শেষ ${fmtTime(pt.fajr)}` : "";
    syncRamadan?.();
  }
  let syncRamadan = null;
  syncRamadan = seg($("#ramadan-seg"), () => settings.ramadan || "auto", (v) => { saveSettings({ ramadan: v }); renderPrayer(); renderQuran(); });
  function ramadanGoal(left) {
    if (!isRamadan()) return "";
    const daysLeft = Math.max(1, 30 - (hijri().month === 9 ? hijri().day : 0) + 1);
    return ` · খতমের জন্য দিনে ${bnDigits(Math.ceil(left / daysLeft))} পর্ব`;
  }
  function qStreakNow() {
    const last = settings.qLastDay;
    return last === todayDhaka() || last === dhakaYMD(-1).join("-") ? settings.qStreak || 0 : 0;
  }
  let qBrowse = null;
  $("#qr-kahf").addEventListener("click", async () => { const idx = await loadQIndex(); qBrowse = idx.portions.findIndex((x) => x[0] === 18); renderQuran(); });
  $("#qr-back").addEventListener("click", () => { qBrowse = null; renderQuran(); });

  /* ---------- settings: sounds, backup, welcome ---------- */
  const syncSoundBox = () => { $("#set-sounds").checked = settings.sounds !== false; };
  function syncRail() {
    const on = settings.rail === true;
    document.body.classList.toggle("show-rail", on); $("#set-rail").checked = on;
    const move = $("#rail-move");
    if (on && move.firstChild) requestAnimationFrame(() => move.style.setProperty("--dur", Math.max(25, move.firstChild.scrollWidth / 55) + "s"));
  }
  syncRail();
  $("#set-rail").addEventListener("change", (e) => { saveSettings({ rail: e.target.checked }); syncRail(); });
  $("#bg-btn").addEventListener("click", syncSoundBox);
  $("#set-sounds").addEventListener("change", (e) => { saveSettings({ sounds: e.target.checked }); if (e.target.checked) paperSound(); });
  $("#backup-export").addEventListener("click", async () => {
    const data = JSON.stringify({ app: "sticky-desk", version: 1, exportedAt: new Date().toISOString(), projects, notes, settings }, null, 2);
    const filename = `sticky-desk-backup-${today()}.json`;
    const dl = window.claude?.use ? await window.claude.use("downloads").catch(() => null) : null;
    if (dl) {
      try { await dl.save({ filename, data }); $("#backup-msg").textContent = "Backup saved."; }
      catch (e) { if (e?.code !== "cancelled" && e?.code !== "declined") $("#backup-msg").textContent = "Couldn't save the backup file. Try again."; }
      return;
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: "application/json" })); a.download = filename;
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    $("#backup-msg").textContent = `Saved ${filename}.`;
  });
  let pendingRestore = null;
  $("#backup-import").addEventListener("click", () => {
    if (pendingRestore) {
      const { notes: ns, projects: ps } = pendingRestore; pendingRestore = null;
      ps.forEach((x) => put("projects", x)); ns.forEach((x) => put("notes", x));
      $("#backup-import-label").textContent = "Restore from backup";
      $("#backup-msg").textContent = `Restored ${ns.length} notes and ${ps.length} projects.`;
      return;
    }
    $("#backup-file").click();
  });
  $("#backup-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "sticky-desk" || !Array.isArray(data.notes) || !Array.isArray(data.projects)) throw new Error("shape");
      pendingRestore = data;
      $("#backup-import-label").textContent = `Tap again to restore ${data.notes.length} notes`;
      $("#backup-msg").textContent = "Notes with the same name in the backup replace the ones on your board. Others are added.";
    } catch (err) { $("#backup-msg").textContent = "That file isn't a Sticky Desk backup. Choose the .json file you saved from here."; }
  });

  /* ---------- welcome (first visit) ---------- */
  const ob = $("#onboard"), obTrack = $("#ob-track");
  const obIndex = () => Math.round(obTrack.scrollLeft / Math.max(1, obTrack.clientWidth));
  function syncOb() {
    const i = obIndex();
    $("#ob-dots").querySelectorAll("span").forEach((d, k) => d.classList.toggle("on", k === i));
    $("#ob-next").textContent = i >= 2 ? "Start" : "Next";
  }
  function closeOb() { ob.hidden = true; try { localStorage.setItem("sticky-desk-onboarded", "1"); } catch (e) {} setTimeout(maybeSignIn, 300); }
  obTrack.addEventListener("scroll", syncOb, { passive: true });
  $("#ob-next").addEventListener("click", () => {
    const i = obIndex();
    if (i >= 2) closeOb(); else obTrack.scrollTo({ left: (i + 1) * obTrack.clientWidth, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  $("#ob-skip").addEventListener("click", closeOb);
  $("#show-welcome").addEventListener("click", () => { $("#bg-sheet").hidden = true; ob.hidden = false; obTrack.scrollLeft = 0; syncOb(); });
  let seen = false; try { seen = !!localStorage.getItem("sticky-desk-onboarded"); } catch (e) { seen = true; }
  if (!seen) setTimeout(() => { ob.hidden = false; syncOb(); }, 500);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!ob.hidden) closeOb();
    ["#archive-sheet", "#ai-sheet"].forEach((q) => { if (!$(q).hidden) $(q).hidden = true; });
  });

  /* =====================================================================
     Cloud sync with name + PIN (Supabase). Website only: claude.ai blocks
     outside connections, and there the board already syncs through claude.ai.
     ===================================================================== */
  const SB_URL = "https://gxeatllskccthzunvzbp.supabase.co";
  const SB_KEY = "sb_publishable_bbnTx_OR9QFv6_ZpoYx0DA_QcUQDngC";
  const CLOUD_OK = !window.claude;
  const SYNC_KIND = { notes: "note", projects: "project", settings: "settings" };
  let cloud = null;
  try { cloud = JSON.parse(localStorage.getItem("sticky-desk-cloud") || "null"); } catch (e) {}
  const saveCloud = () => { try { cloud ? localStorage.setItem("sticky-desk-cloud", JSON.stringify(cloud)) : localStorage.removeItem("sticky-desk-cloud"); } catch (e) {} };
  const outbox = new Map();
  try { for (const x of JSON.parse(localStorage.getItem("sticky-desk-outbox") || "[]")) outbox.set(x.kind + ":" + x.id, x); } catch (e) {}
  const saveOutbox = () => { try { localStorage.setItem("sticky-desk-outbox", JSON.stringify([...outbox.values()])); } catch (e) {} };
  let pushTimer = null, applying = false, busy = false, lastSyncAt = 0, syncProblem = "";

  async function rpc(fn, args) {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify(args),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(body?.message || `HTTP ${r.status}`); e.status = r.status; e.code = body?.code; throw e; }
    return body;
  }
  function syncStatusText() {
    if (!cloud) return "";
    if (syncProblem) return syncProblem;
    if (outbox.size) return "Saving changes…";
    if (!lastSyncAt) return "Connecting…";
    const s = Math.round((Date.now() - lastSyncAt) / 1000);
    return s < 60 ? "Synced just now" : `Synced ${Math.round(s / 60)} min ago`;
  }
  const showSyncStatus = () => { const el = $("#acct-status"); if (el) el.textContent = syncStatusText(); };
  function handleCloudError(e) {
    if (e.code === "P0002" || /unknown sync code/.test(e.message)) {
      cloud = null; saveCloud(); outbox.clear(); saveOutbox(); renderAccount();
      toast("You were signed out of sync. Sign in again to keep your devices in step.");
      return;
    }
    syncProblem = "Offline. Changes sync when you're back online.";
    showSyncStatus();
  }
  function queueSync(kind, id, data, deleted) {
    if (!CLOUD_OK || !cloud || applying) return;
    const k = SYNC_KIND[kind] || kind;
    outbox.set(k + ":" + id, { kind: k, id, data: deleted ? null : data, deleted: !!deleted });
    saveOutbox(); showSyncStatus();
    clearTimeout(pushTimer); pushTimer = setTimeout(flush, 700);
  }
  function applyItems(items) {
    applying = true;
    let changed = false;
    try {
      for (const it of items || []) {
        if (outbox.has(it.kind + ":" + it.id)) continue; // this device's newer change wins until it's sent
        if (it.kind === "settings") {
          if (!it.deleted && it.data) { settings = { ...settings, ...it.data }; try { localStorage.setItem("sticky-desk-settings", JSON.stringify(settings)); } catch (e) {} onSettings(); }
          continue;
        }
        const list = it.kind === "note" ? notes : projects;
        const i = list.findIndex((x) => x.id === it.id);
        if (it.deleted) { if (i >= 0) { list.splice(i, 1); changed = true; } }
        else { const obj = { ...it.data, id: it.id }; if (i >= 0) list[i] = obj; else list.push(obj); changed = true; }
      }
      if (changed) { saveLocal(); render(); }
    } finally { applying = false; }
    if (notes.some((x) => x.parse)) setTimeout(tidyIncoming, 0);
  }
  async function flush() {
    if (!cloud || !outbox.size || busy) return;
    busy = true;
    const batch = [...outbox.values()].slice(0, 100);
    try {
      await rpc("sd_push", { p_key: cloud.token, p_items: batch });
      for (const x of batch) { const key = x.kind + ":" + x.id; if (outbox.get(key) === x) outbox.delete(key); }
      saveOutbox(); syncProblem = ""; lastSyncAt = Date.now();
    } catch (e) { handleCloudError(e); }
    finally { busy = false; showSyncStatus(); }
    if (cloud && outbox.size && !syncProblem) setTimeout(flush, 800);
  }
  async function pull() {
    if (!cloud || busy) return;
    busy = true;
    try {
      const res = await rpc("sd_pull", { p_key: cloud.token, p_since: cloud.since || null });
      applyItems(res.items);
      cloud.since = res.now; saveCloud(); syncProblem = ""; lastSyncAt = Date.now();
    } catch (e) { handleCloudError(e); }
    finally { busy = false; showSyncStatus(); }
    if (cloud && outbox.size) flush();
  }
  async function afterSignIn(res) {
    cloud = { token: res.token, name: res.name, since: null }; saveCloud();
    const remote = await rpc("sd_pull", { p_key: cloud.token, p_since: null });
    const onBoard = new Set((remote.items || []).map((it) => it.kind + ":" + it.id));
    // anything on this device the board hasn't seen goes up; the board's own copy (and its deletions) win
    for (const p of projects) if (!onBoard.has("project:" + p.id)) outbox.set("project:" + p.id, { kind: "project", id: p.id, data: p, deleted: false });
    for (const n of notes) if (!onBoard.has("note:" + n.id)) outbox.set("note:" + n.id, { kind: "note", id: n.id, data: n, deleted: false });
    if (!onBoard.has("settings:board")) outbox.set("settings:board", { kind: "settings", id: "board", data: settings, deleted: false });
    saveOutbox();
    applyItems(remote.items);
    cloud.since = remote.now; saveCloud(); lastSyncAt = Date.now(); syncProblem = "";
    renderAccount(); startCloudLoop(); flush();
  }
  let loopStarted = false;
  function startCloudLoop() {
    if (loopStarted) return; loopStarted = true;
    setInterval(() => { if (document.visibilityState === "visible") { flush(); pull(); } }, 20000);
    setInterval(showSyncStatus, 15000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { flush(); pull(); } });
    addEventListener("online", () => { syncProblem = ""; flush(); pull(); });
  }

  /* ---------- works offline: the service worker keeps a copy of the app ---------- */
  const SW_OK = CLOUD_OK && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost");
  if (SW_OK) addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  addEventListener("offline", () => toast("You're offline. Notes still save here and sync when you're back."));

  /* ---------- lock screen notifications (Web Push) ---------- */
  const PUSH_KEY = "sticky-desk-push";
  let pushPrefs = { on: false, prayer: true, due: true, hour: 9 };
  try { pushPrefs = { ...pushPrefs, ...JSON.parse(localStorage.getItem(PUSH_KEY) || "{}") }; } catch (e) {}
  const savePush = () => { try { localStorage.setItem(PUSH_KEY, JSON.stringify(pushPrefs)); } catch (e) {} };
  const isiOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = () => SW_OK && "PushManager" in window && "Notification" in window;
  const b64ToBytes = (b64) => { const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
  function pushBlocker() {
    if (!CLOUD_OK || location.protocol === "chrome-extension:") return "Turn these on from the Sticky Desk website or the Home Screen app.";
    if (isiOS && !standalone) return "First add Sticky Desk to your Home Screen (Share › Add to Home Screen), then open it from there.";
    if (!pushSupported()) return "This browser can't show notifications from websites.";
    if (!cloud) return "Sign in above first. Notifications come from your synced board.";
    if (Notification.permission === "denied") return "Notifications are blocked for this site. Allow them in your browser or iPhone Settings › Notifications.";
    return "";
  }
  function renderPush() {
    const block = pushBlocker();
    $("#push-on").checked = !block && pushPrefs.on;
    $("#push-on").disabled = !!block && !pushPrefs.on;
    $("#push-status").textContent = block || (pushPrefs.on ? "On for this device" : "Due notes and prayer times, even with the app closed");
    $("#push-opts").hidden = !!block || !pushPrefs.on;
    $("#push-prayer").checked = pushPrefs.prayer; $("#push-due").checked = pushPrefs.due; $("#push-hour").value = String(pushPrefs.hour);
  }
  if (!CLOUD_OK) $("#alerts-section").hidden = true;
  $("#push-hour").replaceChildren(...[5, 6, 7, 8, 9, 10, 11, 12].map((h) => { const o = document.createElement("option"); o.value = String(h); o.textContent = h === 12 ? "12 PM" : h + " AM"; return o; }));
  async function pushSubscription() { const reg = await navigator.serviceWorker.ready; return { reg, sub: await reg.pushManager.getSubscription() }; }
  async function sendPrefs(sub) {
    const r = await rpc("sd_push_subscribe", { p_key: cloud.token, p_sub: sub.toJSON(), p_prefs: { prayer: pushPrefs.prayer, due: pushPrefs.due, hour: pushPrefs.hour } });
    if (!r.ok) throw new Error(r.error);
  }
  async function turnPushOn() {
    $("#push-status").textContent = "Asking for permission…";
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { pushPrefs.on = false; savePush(); renderPush(); return; }
    try {
      $("#push-status").textContent = "Connecting…";
      const key = await rpc("sd_push_public_key", {});
      const { reg } = await pushSubscription();
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      await sendPrefs(sub);
      pushPrefs.on = true; savePush(); renderPush();
      toast("Notifications are on. Tap Send a test to check.");
    } catch (e) {
      pushPrefs.on = false; savePush(); renderPush();
      $("#push-status").textContent = "Couldn't turn notifications on. Check your connection, then try again.";
    }
  }
  async function turnPushOff() {
    pushPrefs.on = false; savePush(); renderPush();
    try { const { sub } = await pushSubscription(); if (sub) { await rpc("sd_push_unsubscribe", { p_key: cloud.token, p_endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); } } catch (e) {}
  }
  $("#push-on").addEventListener("change", (e) => { if (e.target.checked) turnPushOn(); else turnPushOff(); });
  const changePref = async (patch) => {
    pushPrefs = { ...pushPrefs, ...patch }; savePush();
    try { const { sub } = await pushSubscription(); if (sub) await sendPrefs(sub); } catch (e) { toast("Couldn't save that. Check your connection."); }
  };
  $("#push-prayer").addEventListener("change", (e) => changePref({ prayer: e.target.checked }));
  $("#push-due").addEventListener("change", (e) => changePref({ due: e.target.checked }));
  $("#push-hour").addEventListener("change", (e) => changePref({ hour: Number(e.target.value), due: true }).then(renderPush));
  $("#push-test").addEventListener("click", async () => {
    try {
      const r = await rpc("sd_push_test", { p_key: cloud.token });
      if (r.ok) toast("Test sent. It should arrive in a few seconds.");
      else toast(r.error === "slow_down" ? "That's a lot of tests. Try again in a few minutes." : r.error === "no_devices" ? "Turn notifications off and on again, then retry." : "Couldn't send a test.");
    } catch (e) { toast("Couldn't send a test. Check your connection."); }
  });

  renderPush();

  /* ---------- Siri: an Apple Shortcut posts dictated text to sd_quick_add ---------- */
  function siriFields(token) {
    const rows = [["Address", `${SB_URL}/rest/v1/rpc/sd_quick_add`], ["apikey header", SB_KEY], ["p_key", token]];
    $("#siri-fields").replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement("div"); row.className = "copy-row";
      const b = document.createElement("b"); b.textContent = label;
      const c = document.createElement("code"); c.textContent = value;
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn quiet"; btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy " + label);
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(value); toast(`${label} copied.`); }
        catch (e) { const r = document.createRange(); r.selectNodeContents(c); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selected. Copy it from the menu."); }
      });
      row.append(b, c, btn); return row;
    }));
  }
  $("#set-siri").addEventListener("click", () => {
    const box = $("#siri-box"), open = box.hidden;
    box.hidden = !open; $("#set-siri").setAttribute("aria-expanded", String(open));
    if (open && !cloud) { $("#siri-fields").replaceChildren(); $("#siri-make").textContent = "Sign in first"; $("#siri-make").disabled = true; }
    else if (open) { $("#siri-make").disabled = false; $("#siri-make").textContent = $("#siri-fields").childElementCount ? "Make a new key" : "Make my Siri key"; }
  });
  $("#siri-make").addEventListener("click", async () => {
    const b = $("#siri-make"); b.disabled = true; b.textContent = "Making a key…";
    try {
      const r = await rpc("sd_new_token", { p_key: cloud.token, p_label: "siri" });
      if (!r.ok) throw new Error(r.error);
      siriFields(r.token); b.textContent = "Make a new key";
    } catch (e) { b.textContent = "Couldn't make a key. Try again"; }
    b.disabled = false;
  });

  // Notes from Siri arrive as plain words; tidy them with the same smart typing as the note sheet
  function tidyIncoming() {
    for (const n of notes.filter((x) => x.parse)) {
      const p = parseQuick(n.text);
      const next = { ...n, text: p.text || n.text };
      for (const k of ["due", "priority", "projectId", "repeat", "flagged"]) if (p[k] !== undefined) next[k] = p[k];
      if (next.repeat && !next.due) next.due = today();
      delete next.parse;
      put("notes", next);
      if (n.source === "siri") toast(`Added from Siri: ${next.text}`);
    }
  }

  /* ---------- sign-in sheet ---------- */
  let createMode = false;
  function openSignIn() {
    createMode = false;
    $("#si-msg").textContent = ""; $("#si-go").textContent = "Sign in"; $("#si-pin").value = "";
    $("#signin").hidden = false;
    setTimeout(() => ($("#si-name").value ? $("#si-pin") : $("#si-name")).focus(), 60);
  }
  function maybeSignIn() {
    if (!CLOUD_OK || cloud) return;
    try { if (localStorage.getItem("sticky-desk-signin-later")) return; } catch (e) { return; }
    openSignIn();
  }
  const SI_ERR = {
    bad_name: "Use 3 to 40 letters, numbers, spaces, dots or dashes for the name.",
    bad_pin: "A PIN is 4 to 8 digits.",
    name_taken: "That name is already taken. Try another, or sign in if it's yours.",
  };
  async function submitSignIn() {
    const name = $("#si-name").value.trim(), pinTyped = $("#si-pin").value.trim();
    const pin = pinTyped || (createMode ? "1111" : "");
    const msg = $("#si-msg");
    if (name.length < 3) { msg.textContent = SI_ERR.bad_name; $("#si-name").focus(); return; }
    if (!pin) { msg.textContent = "Enter your PIN."; $("#si-pin").focus(); return; }
    const btn = $("#si-go"); btn.disabled = true; msg.textContent = createMode ? "Creating your board…" : "Signing in…";
    try {
      const res = await rpc(createMode ? "sd_register" : "sd_sign_in", { p_name: name, p_pin: pin });
      if (res.ok) {
        $("#signin").hidden = true;
        await afterSignIn(res);
        toast(pin === "1111" ? "Signed in. Your PIN is still 1111, so change it in Settings to keep your board private." : "Signed in. This board now syncs across your devices.");
        return;
      }
      if (res.error === "not_found") {
        createMode = true; btn.textContent = "Create board";
        msg.textContent = `There's no board called “${name}” yet. Tap Create board to make it with ${pinTyped ? "this PIN" : "PIN 1111"}.`;
      } else if (res.error === "wrong_pin") {
        msg.textContent = `That PIN isn't right. ${res.tries_left} ${res.tries_left === 1 ? "try" : "tries"} left before a short lock.`;
        $("#si-pin").select();
      } else if (res.error === "locked") {
        msg.textContent = `Too many wrong PINs. Try again in ${res.wait_minutes} minutes.`;
      } else msg.textContent = SI_ERR[res.error] || "Couldn't sign in. Try again.";
    } catch (e) {
      msg.textContent = "Can't reach the sync server. Check your connection, then try again.";
    } finally { btn.disabled = false; }
  }
  $("#si-go").addEventListener("click", submitSignIn);
  $("#si-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") submitSignIn(); });
  $("#si-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#si-pin").focus(); });
  $("#si-name").addEventListener("input", () => { if (createMode) { createMode = false; $("#si-go").textContent = "Sign in"; $("#si-msg").textContent = ""; } });
  $("#si-later").addEventListener("click", () => { try { localStorage.setItem("sticky-desk-signin-later", "1"); } catch (e) {} $("#signin").hidden = true; });
  $("#signin").addEventListener("click", (e) => { if (e.target.id === "signin") $("#signin").hidden = true; });

  /* ---------- account section in Settings ---------- */
  function renderAccount() {
    $("#acct-section").hidden = !CLOUD_OK;
    if (!CLOUD_OK) return;
    $("#acct-out").hidden = !!cloud; $("#acct-in").hidden = !cloud;
    if (cloud) { $("#acct-name").textContent = cloud.name; showSyncStatus(); }
    $("#pin-change").hidden = true; $("#widget-box").hidden = true;
  }
  $("#acct-signin").addEventListener("click", () => { $("#bg-sheet").hidden = true; openSignIn(); });
  $("#acct-signout").addEventListener("click", async () => {
    const t = cloud?.token;
    cloud = null; saveCloud(); outbox.clear(); saveOutbox(); renderAccount();
    toast("Signed out. Your notes stay on this device.");
    if (t) rpc("sd_sign_out", { p_key: t }).catch(() => {});
  });
  $("#acct-pin").addEventListener("click", () => { $("#pin-change").hidden = !$("#pin-change").hidden; $("#pc-msg").textContent = ""; $("#pc-old").focus(); });
  $("#pc-save").addEventListener("click", async () => {
    const msg = $("#pc-msg"), o = $("#pc-old").value.trim(), n = $("#pc-new").value.trim();
    if (!/^\d{4,8}$/.test(n)) { msg.textContent = SI_ERR.bad_pin; return; }
    try {
      const r = await rpc("sd_change_pin", { p_key: cloud.token, p_old: o, p_new: n });
      if (r.ok) { msg.textContent = "PIN changed. Use the new PIN on your other devices."; $("#pc-old").value = ""; $("#pc-new").value = ""; }
      else msg.textContent = r.error === "wrong_pin" ? "Your current PIN isn't right." : SI_ERR[r.error] || "Couldn't change the PIN.";
    } catch (e) { msg.textContent = "Can't reach the sync server. Try again."; }
  });
  function widgetScript(token) {
    return [
      "// Sticky Desk widget for Scriptable",
      'const KEY = "' + token + '";',
      'const req = new Request("' + SB_URL + '/rest/v1/rpc/sd_widget");',
      'req.method = "POST";',
      'req.headers = { apikey: "' + SB_KEY + '", "Content-Type": "application/json" };',
      "req.body = JSON.stringify({ p_key: KEY });",
      "const d = await req.loadJSON();",
      'const paper = { pink: "#f4888c", yellow: "#f8de78", blue: "#92cfe9", green: "#b9de8c", orange: "#f7b06a", lilac: "#cdb6ec", mint: "#9fe0c9" };',
      "const w = new ListWidget();",
      'w.url = "' + (location.protocol.startsWith("http") ? location.origin : "https://sticky-desk-ochre.vercel.app") + '";',
      'const fam = config.widgetFamily || "medium";',
      'if (fam.startsWith("accessory")) {',
      '  const t = w.addText((d.doing || 0) + " doing · " + (d.todo || 0) + " to do");',
      "  t.font = Font.semiboldSystemFont(13);",
      "} else {",
      '  w.backgroundColor = new Color("#d8bf98");',
      '  const h = w.addText("Sticky Desk"); h.font = Font.boldSystemFont(13); h.textColor = new Color("#3b2f21");',
      '  const c = w.addText((d.doing || 0) + " doing · " + (d.todo || 0) + " to do"); c.font = Font.systemFont(11); c.textColor = new Color("#6b5a45");',
      "  w.addSpacer(6);",
      '  const max = fam === "large" ? 6 : fam === "small" ? 2 : 3;',
      "  for (const n of (d.notes || []).slice(0, max)) {",
      "    const s = w.addStack(); s.backgroundColor = new Color(paper[n.color] || paper.pink); s.cornerRadius = 3; s.setPadding(5, 8, 5, 8);",
      '    const t = s.addText((n.priority ? "!".repeat(n.priority) + " " : "") + n.text); t.font = Font.mediumSystemFont(12); t.textColor = new Color("#1c1f3a"); t.lineLimit = 1;',
      "    s.addSpacer(); w.addSpacer(4);",
      "  }",
      "}",
      "Script.setWidget(w);",
      "Script.complete();",
    ].join("\n");
  }
  $("#acct-widget").addEventListener("click", async () => {
    const box = $("#widget-box");
    if (!box.hidden) { box.hidden = true; return; }
    $("#widget-code").value = "Making a widget key…"; box.hidden = false;
    try {
      const r = await rpc("sd_new_token", { p_key: cloud.token, p_label: "widget" });
      if (!r.ok) throw new Error(r.error);
      $("#widget-code").value = widgetScript(r.token);
    } catch (e) { $("#widget-code").value = "Couldn't make a widget key. Check your connection, then try again."; }
  });
  $("#widget-copy").addEventListener("click", async () => {
    const ta = $("#widget-code");
    try { await navigator.clipboard.writeText(ta.value); toast("Widget script copied. Paste it into a new Scriptable script."); }
    catch (e) { ta.focus(); ta.select(); toast("Select all and copy the script."); }
  });
  $("#bg-btn").addEventListener("click", () => { renderAccount(); renderPush(); });

  function cloudBoot() {
    renderAccount();
    if (!CLOUD_OK) return;
    if (cloud) { startCloudLoop(); pull(); flush(); }
    else {
      let seenWelcome = false; try { seenWelcome = !!localStorage.getItem("sticky-desk-onboarded"); } catch (e) {}
      if (seenWelcome) setTimeout(maybeSignIn, 700);
    }
  }


  /* ---------- settings page details ---------- */
  function syncSettingsPage() {
    $("#set-bg-value").textContent = (BGS.find((x) => x.id === bg) || BGS[0]).name.replace(/ \(.*\)$/, "");
    $("#set-azan-value").textContent = settings.azanOn ? (settings.azanName ? "On · own recording" : "On · soft bell") : "Off";
    if (cloud) $("#acct-avatar").textContent = (cloud.name || "?").trim().charAt(0).toUpperCase();
    $("#set-sounds").checked = settings.sounds !== false;
  }
  $("#bg-btn").addEventListener("click", () => { syncSettingsPage(); $("#bgs-wrap").hidden = true; $("#set-bg-row").setAttribute("aria-expanded", "false"); });
  $("#set-bg-row").addEventListener("click", () => {
    const open = $("#bgs-wrap").hidden;
    $("#bgs-wrap").hidden = !open; $("#set-bg-row").setAttribute("aria-expanded", String(open));
  });
  $("#bgs").addEventListener("click", () => setTimeout(syncSettingsPage, 0));
  $("#set-azan").addEventListener("click", () => { $("#bg-sheet").hidden = true; $("#azan-sheet").hidden = false; });

  render();
  // Measure where the board starts so its columns can fill the rest of the screen.
  const sizeBoard = () => document.documentElement.style.setProperty("--board-top", Math.round(board.getBoundingClientRect().top + window.scrollY) + "px");
  sizeBoard();
  addEventListener("resize", sizeBoard);
  new ResizeObserver(sizeBoard).observe($(".top"));
  new ResizeObserver(sizeBoard).observe($("#tabs"));
  new ResizeObserver(sizeBoard).observe($("#filters"));
  onSettings();
  renderPrayer();
  setInterval(renderPrayer, 15000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") renderPrayer(); });
  start();
  cloudBoot();
})();
