/* ═══════════════════════════════════════════════════════════
   Claude & Co. Studio HQ — v4

   Every entity is its own database table, so a change writes
   one row instead of re-uploading the whole studio, and every
   screen updates through a live subscription rather than a
   30-second poll. Status toggles patch their own DOM node —
   nothing else re-renders — which is what keeps taps instant.

   Permissions are enforced server-side (Postgres RLS), not by
   hiding buttons: anyone with the studio password can read and
   submit a time-off request; only Alise's signed-in account can
   change anything. Pay/rates exist nowhere in this app.
   ═══════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  var LS_ACCESS = "cco-access-v1";
  var LS_WHO    = "cco-who-v1";

  var cfg = window.CCO_CONFIG || {};
  var cloudReady = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    cfg.SUPABASE_URL.indexOf("PASTE_") < 0 && window.supabase);
  var sb = cloudReady ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    realtime: { params: { eventsPerSecond: 8 } }
  }) : null;

  /* ── local mirror of the database ── */
  var DB = { members: [], clients: [], tasks: [], links: [], timeoff: [], comments: [], activity: [], settings: {} };
  var me = { userId: null, memberId: null, role: null };
  var who = localStorage.getItem(LS_WHO) || "alise";
  var view = null;   // resolved at boot: owners land on Today, the team on My work
  var mineOnly = false;
  var connected = false;
  var loaded = false;
  var searchQ = "";

  /* ══════════ tiny helpers ══════════ */
  function $(id) { return document.getElementById(id); }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function uid() { return "x" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
  function today() {
    var t = new Date();
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }
  function addDays(n) {
    var t = new Date(); t.setDate(t.getDate() + n);
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }
  function pDate(s) { if (!s) return null; var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fDate(s) {
    var d = pDate(s); if (!d) return "";
    if (s === today()) return "Today";
    if (s === addDays(1)) return "Tomorrow";
    if (s === addDays(-1)) return "Yesterday";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function fDow(s) { var d = pDate(s); return d ? d.toLocaleDateString("en-US", { weekday: "long" }) : ""; }
  function fTime(t) {
    if (!t) return "";
    var p = String(t).split(":"), h = +p[0], ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12; return h + ":" + p[1] + " " + ap;
  }
  function ago(iso) {
    if (!iso) return "";
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function member(id) { for (var i = 0; i < DB.members.length; i++) if (DB.members[i].id === id) return DB.members[i]; return null; }
  function client(id) { for (var i = 0; i < DB.clients.length; i++) if (DB.clients[i].id === id) return DB.clients[i]; return null; }
  function task(id) { for (var i = 0; i < DB.tasks.length; i++) if (DB.tasks[i].id === id) return DB.tasks[i]; return null; }
  function live() { return DB.tasks.filter(function (t) { return !t.archived; }); }
  function isOverdue(t) { return t.status !== "done" && t.due && t.due < today(); }
  function isOwner() { return me.role === "owner"; }
  function canCheck(t) {
    if (isOwner()) return true;
    return me.role === "employee" && t.assigneeId === me.memberId &&
      DB.settings.employeesCanCheck !== false;
  }
  // Shown-but-not-yet-permitted: it is their task, they just have no login yet.
  function isMine(t) { return t.assigneeId === viewerId(); }
  function statusLabel(s) { return s === "archived" ? "past client" : s; }

  function toast(msg, bad) {
    var t = el('<div class="toast' + (bad ? " bad" : "") + '">' + esc(msg) + "</div>");
    $("toast-host").appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2600);
    setTimeout(function () { t.remove(); }, 3000);
  }
  function greet() { var h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }

  var ICON = {
    today:   '<svg viewBox="0 0 24 24"><path d="M12 3v2M5.6 5.6l1.4 1.4M3 12h2M19 12h2M17 7l1.4-1.4M12 19v2"/><circle cx="12" cy="12" r="4"/></svg>',
    board:   '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="11" rx="1.5"/><rect x="16" y="4" width="5" height="14" rx="1.5"/></svg>',
    clients: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5.5A1.5 1.5 0 019.5 4h5A1.5 1.5 0 0116 5.5V7"/></svg>',
    team:    '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5"/><path d="M16 11.2A3 3 0 1016 5.4M18 19c0-2-.7-3.6-2-4.6"/></svg>',
    sched:   '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    links:   '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></svg>',
    check:   '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>',
    dots:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
    edit:    '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17v3z"/></svg>',
    chat:    '<svg viewBox="0 0 24 24"><path d="M20 15a2 2 0 01-2 2H8l-4 4V5a2 2 0 012-2h12a2 2 0 012 2z"/></svg>',
    plus:    '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
  };
  var STATUS = {
    todo:       { label: "To do",       verb: "To do",     color: "#b0a8a4" },
    inprogress: { label: "In progress", verb: "Working",   color: "#d98f2b" },
    needhelp:   { label: "Needs help",  verb: "Need help", color: "#c2553f" },
    done:       { label: "Done",        verb: "Done",      color: "#4f7460" }
  };
  function sLabel(s) { return (STATUS[s] || STATUS.todo).label; }

  var NAV_OWNER = [
    { id: "today",   label: "Today",    icon: "today" },
    { id: "board",   label: "Board",    icon: "board" },
    { id: "clients", label: "Clients",  icon: "clients" },
    { id: "team",    label: "Team",     icon: "team" },
    { id: "sched",   label: "Schedule", icon: "sched" },
    { id: "links",   label: "Links",    icon: "links" }
  ];
  var NAV_TEAM = [
    { id: "mywork",  label: "My work",  icon: "today" },
    { id: "team",    label: "The team", icon: "team" },
    { id: "sched",   label: "Schedule", icon: "sched" },
    { id: "links",   label: "Links",    icon: "links" }
  ];
  function nav() { return isOwner() ? NAV_OWNER : NAV_TEAM; }
  var TITLES = { today: "Today", mywork: "My work", board: "Board", clients: "Clients", team: "The team", sched: "Schedule", links: "Studio links" };
  // Who the viewer is acting as: their login if they have one, else the picker.
  function viewerId() { return me.memberId || who; }

  /* ══════════ row mappers ══════════ */
  function mMember(r) { return { id: r.id, name: r.name, full: r.full_name || r.name, role: r.role || "", color: r.color || "#c4667c", email: r.email || "", info: r.info || "", isOwner: !!r.is_owner, sort: r.sort || 0 }; }
  function mClient(r) { return { id: r.id, name: r.name, status: r.status || "active", contact: r.contact || "", email: r.email || "", phone: r.phone || "", services: r.services || "", loomly: r.loomly || "", team: Array.isArray(r.team) ? r.team : [], notes: r.notes || "", sort: r.sort || 0 }; }
  function mTask(r) { return { id: r.id, clientId: r.client_id || "", title: r.title, assigneeId: r.assignee_id || "", due: r.due || "", time: r.time_of_day || "", status: r.status || "todo", kind: r.kind || "task", location: r.location || "", notes: r.notes || "", sort: r.sort || 0, archived: !!r.archived, completedAt: r.completed_at }; }
  function mLink(r) { return { id: r.id, name: r.name, emoji: r.emoji || "🔗", desc: r.descr || "", url: r.url || "", sort: r.sort || 0 }; }
  function mOff(r) { return { id: r.id, memberId: r.member_id, start: r.start_day, end: r.end_day, reason: r.reason || "", status: r.status || "requested" }; }
  function mCmt(r) { return { id: r.id, taskId: r.task_id, memberId: r.member_id, body: r.body, at: r.created_at }; }
  function mAct(r) { return { id: r.id, actorId: r.actor_id, verb: r.verb, subject: r.subject, at: r.created_at }; }

  function taskRow(t) {
    return { id: t.id, client_id: t.clientId || null, title: t.title, assignee_id: t.assigneeId || null,
      due: t.due || null, time_of_day: t.time || "", status: t.status, kind: t.kind,
      location: t.location || "", notes: t.notes || "", sort: t.sort || 0, archived: !!t.archived,
      completed_at: t.status === "done" ? (t.completedAt || new Date().toISOString()) : null };
  }
  function clientRow(c) {
    return { id: c.id, name: c.name, status: c.status, contact: c.contact, email: c.email, phone: c.phone,
      services: c.services, loomly: c.loomly, team: c.team, notes: c.notes, sort: c.sort || 0 };
  }
  function memberRow(m) {
    return { id: m.id, name: m.name, full_name: m.full, role: m.role, color: m.color,
      email: m.email, info: m.info, is_owner: !!m.isOwner, sort: m.sort || 0 };
  }
  function linkRow(l) { return { id: l.id, name: l.name, emoji: l.emoji, descr: l.desc, url: l.url, sort: l.sort || 0 }; }

  /* ══════════ data loading ══════════ */
  function loadAll() {
    if (!cloudReady) { seedFromFile(); return Promise.resolve(); }
    return Promise.all([
      sb.from("members").select("*").order("sort"),
      sb.from("clients").select("*").order("sort"),
      sb.from("tasks").select("*").order("sort"),
      sb.from("links").select("*").order("sort"),
      sb.from("timeoff").select("*").order("start_day"),
      sb.from("comments").select("*").order("created_at"),
      sb.from("activity").select("*").order("created_at", { ascending: false }).limit(60),
      sb.from("settings").select("data").eq("id", 1).maybeSingle()
    ]).then(function (r) {
      if (r[0].error) { connected = false; seedFromFile(); return; }
      connected = true;
      DB.members  = (r[0].data || []).map(mMember);
      DB.clients  = (r[1].data || []).map(mClient);
      DB.tasks    = (r[2].data || []).map(mTask);
      DB.links    = (r[3].data || []).map(mLink);
      DB.timeoff  = (r[4].data || []).map(mOff);
      DB.comments = (r[5].data || []).map(mCmt);
      DB.activity = (r[6].data || []).map(mAct);
      DB.settings = (r[7].data && r[7].data.data) || {};
    }).catch(function () { connected = false; seedFromFile(); });
  }
  function seedFromFile() {
    var s = window.CCO_SEED; if (!s) return;
    DB.members = (s.team || []).map(function (m) { return { id: m.id, name: m.name, full: m.full || m.name, role: m.role || "", color: m.color || "#c4667c", email: m.email || "", info: m.info || "", isOwner: !!m.isOwner }; });
    DB.clients = (s.clients || []).map(function (c) { return { id: c.id, name: c.name, status: c.status, contact: c.contact || "", email: c.email || "", phone: c.phone || "", services: c.services || "", loomly: c.loomly || "", team: c.team || [], notes: c.notes || "" }; });
    DB.tasks = (s.tasks || []).map(function (t) { return { id: t.id, clientId: t.clientId, title: t.title, assigneeId: t.assigneeId, due: t.due, time: t.time || "", status: t.status, kind: t.kind, location: t.location || "", notes: t.notes || "", archived: false }; });
    DB.links = (s.links || []).map(function (l) { return { id: l.id || uid(), name: l.name, emoji: l.emoji, desc: l.desc, url: l.url }; });
    DB.timeoff = (s.timeoff || []).slice();
    DB.settings = s.settings || {};
  }

  /* ══════════ realtime ══════════ */
  var TABLES = {
    members: { arr: "members", map: mMember }, clients: { arr: "clients", map: mClient },
    tasks: { arr: "tasks", map: mTask }, links: { arr: "links", map: mLink },
    timeoff: { arr: "timeoff", map: mOff }, comments: { arr: "comments", map: mCmt },
    activity: { arr: "activity", map: mAct }
  };
  function subscribe() {
    if (!cloudReady) return;
    var ch = sb.channel("studio-hq");
    Object.keys(TABLES).forEach(function (tbl) {
      ch.on("postgres_changes", { event: "*", schema: "public", table: tbl }, function (p) {
        var spec = TABLES[tbl], arr = DB[spec.arr];
        if (p.eventType === "DELETE") {
          var oid = p.old && p.old.id;
          for (var i = 0; i < arr.length; i++) if (arr[i].id === oid) { arr.splice(i, 1); break; }
        } else {
          var row = spec.map(p.new), found = false;
          for (var j = 0; j < arr.length; j++) if (arr[j].id === row.id) { arr[j] = row; found = true; break; }
          if (!found) arr.push(row);
        }
        scheduleRender();
      });
    });
    ch.on("postgres_changes", { event: "*", schema: "public", table: "settings" }, function (p) {
      if (p.new && p.new.data) { DB.settings = p.new.data; scheduleRender(); }
    });
    ch.subscribe(function (status) {
      connected = status === "SUBSCRIBED";
      paintConnection();
    });
  }
  var renderPending = false;
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () { renderPending = false; render(); });
  }

  /* ══════════ writes ══════════ */
  function fail(e) { toast(e || "Couldn't save — check your connection", true); }
  // A row blocked by RLS comes back as success-with-nothing-changed, so an
  // expired session would otherwise look like it saved. Ask for the row back
  // and treat "no rows" as the failure it really is.
  function wrote(res, msg) {
    if (res.error || !res.data || !res.data.length) {
      fail(msg || "Couldn't save — try signing in again");
      loadAll().then(render);
      return false;
    }
    return true;
  }
  function logAct(verb, subject) {
    if (!cloudReady || !isOwner()) return;
    sb.from("activity").insert({ actor_id: me.memberId || "alise", verb: verb, subject: subject }).then(function () {});
  }
  function upsert(table, row, mapped, arrName) {
    // optimistic: local first, server second — the UI never waits on the network
    var arr = DB[arrName], found = false;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === mapped.id) { arr[i] = mapped; found = true; break; }
    if (!found) arr.push(mapped);
    scheduleRender();
    if (!cloudReady) return Promise.resolve();
    return sb.from(table).upsert(row).select("id").then(function (r) { wrote(r); });
  }
  function removeRow(table, id, arrName) {
    var arr = DB[arrName];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) { arr.splice(i, 1); break; }
    scheduleRender();
    if (!cloudReady) return Promise.resolve();
    return sb.from(table).delete().eq("id", id).select("id").then(function (r) { wrote(r, "Couldn't delete — try signing in again"); });
  }
  function saveSettings() {
    if (!cloudReady) return Promise.resolve();
    return sb.from("settings").upsert({ id: 1, data: DB.settings, updated_at: new Date().toISOString() }).select("id")
      .then(function (r) { wrote(r); });
  }

  /* ══════════ status toggle (targeted, no full re-render) ══════════ */
  function cycle(s) { return s === "todo" ? "inprogress" : s === "inprogress" ? "done" : "todo"; }

  function setStatus(id, status) {
    var t = task(id); if (!t) return;
    if (!canCheck(t)) {
      if (isMine(t) && !me.role) return needLogin(t);   // their task, no login yet
      return toast("Only Alise can change this one", true);
    }
    if (t.status === status) return;
    t.status = status;
    t.completedAt = status === "done" ? new Date().toISOString() : null;
    scheduleRender();
    if (status === "done") logAct("completed", t.title);
    if (status === "needhelp") logAct("flagged for help on", t.title);
    if (!cloudReady) return;
    sb.from("tasks").update({ status: t.status, completed_at: t.completedAt }).eq("id", t.id).select("id")
      .then(function (r) { wrote(r, "Couldn't update — are you still signed in?"); });
  }
  function needLogin(t) {
    var m = member(t.assigneeId);
    openModal("<h3>Sign in to update your tasks</h3>" +
      "<div class='modal-sub'>This is your task, " + esc(m ? m.name : "") +
      " — you just need a login so the studio knows it's you.</div>" +
      "<div class='hint'>Ask Alise to set one up. Until then she can mark it off for you.</div>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Close</button>" +
      "<button class='btn btn-primary' id='nl-go'>I have a login</button></div>");
    $("nl-go").addEventListener("click", function () { closeModal(); login(); });
  }
  function toggleStatus(id) {
    var t = task(id); if (!t) return;
    setStatus(id, cycle(t.status));
  }

  function patchTaskNodes(t) {
    document.querySelectorAll('[data-task="' + t.id + '"]').forEach(function (node) {
      node.classList.toggle("is-done", t.status === "done");
      var btn = node.querySelector(".check");
      if (btn) {
        btn.className = "check " + t.status;
        btn.innerHTML = t.status === "done" ? ICON.check : t.status === "inprogress" ? "" : "";
      }
      var pill = node.querySelector(".pill.status-pill");
      if (pill) { pill.className = "pill status-pill " + t.status; pill.textContent = t.status === "inprogress" ? "in progress" : t.status === "todo" ? "to do" : "done"; }
    });
    if (view === "board") scheduleRender();
  }
  function patchProgress() {
    document.querySelectorAll("[data-prog]").forEach(function (node) {
      var scope = node.getAttribute("data-prog");
      var list = scope === "team" ? live()
        : scope.indexOf("client-") === 0
          ? live().filter(function (t) { return t.clientId === scope.slice(7); })
          : live().filter(function (t) { return t.assigneeId === scope; });
      var p = pct(list);
      var fill = node.querySelector(".bar-fill"), lab = node.querySelector(".prog-pct"), sub = node.querySelector(".prog-sub");
      if (fill) { fill.style.width = p.pct + "%"; fill.classList.toggle("full", p.full); }
      if (lab) { lab.textContent = p.full ? "100% 🎉" : p.pct + "%"; lab.classList.toggle("full", p.full); }
      if (sub) sub.textContent = p.done + " of " + p.total + " task" + (p.total === 1 ? "" : "s") + " done";
    });
  }
  function pct(list) {
    var total = list.length, done = list.filter(function (t) { return t.status === "done"; }).length;
    return { total: total, done: done, pct: total ? Math.round(done / total * 100) : 0, full: total > 0 && done === total };
  }

  /* ══════════ shared bits ══════════ */
  function avatar(m, cls) {
    if (!m) return '<span class="avatar sm" style="background:#c9c2bf">?</span>';
    return '<span class="avatar ' + (cls || "") + '" style="background:' + esc(m.color) + '" title="' + esc(m.full) + '">' + esc(m.name.slice(0, 2).toUpperCase()) + "</span>";
  }
  function progCard(label, list, scope, m) {
    var p = pct(list);
    return '<div class="prog-card" data-prog="' + esc(scope) + '">' +
      '<div class="prog-top"><span class="prog-name">' + (m ? avatar(m, "sm") : "") + esc(label) + "</span>" +
      '<span class="prog-pct' + (p.full ? " full" : "") + '">' + (p.full ? "100% 🎉" : p.pct + "%") + "</span></div>" +
      '<div class="bar"><div class="bar-fill' + (p.full ? " full" : "") + '" style="width:' + p.pct + '%"></div></div>' +
      '<div class="prog-sub">' + p.done + " of " + p.total + " task" + (p.total === 1 ? "" : "s") + " done</div></div>";
  }
  function taskHTML(t, opt) {
    opt = opt || {};
    var m = member(t.assigneeId), c = client(t.clientId);
    var late = isOverdue(t);
    var n = DB.comments.filter(function (x) { return x.taskId === t.id; }).length;
    var mine = isMine(t), actionable = canCheck(t) || (mine && !isOwner());

    var meta = [];
    if (m && !opt.hideWho) meta.push('<span class="tc-who">' + avatar(m, "sm") + esc(m.name) + "</span>");
    if (t.due) meta.push('<span' + (late ? ' class="tc-late"' : "") + ">" + (late ? "⚠ " : "") + fDate(t.due) + (t.time ? " · " + fTime(t.time) : "") + "</span>");
    if (t.kind === "shoot") meta.push('<span class="tc-tag">📷 Photoshoot</span>');
    if (t.location) meta.push("<span>📍 " + esc(t.location) + "</span>");

    var acts = "";
    if (actionable && !opt.flat) {
      acts = '<div class="tc-actions">' +
        ["inprogress", "needhelp", "done"].map(function (st) {
          if (t.status === st) return "";
          return '<button class="tc-act a-' + st + '" data-set="' + st + '|' + esc(t.id) + '">' + STATUS[st].verb + "</button>";
        }).join("") +
        (t.status !== "todo" ? '<button class="tc-act a-todo" data-set="todo|' + esc(t.id) + '">Reset</button>' : "") +
        '<button class="tc-act a-chat" data-open="' + esc(t.id) + '">💬' + (n ? " " + n : "") + "</button>" +
        (isOwner() ? '<button class="tc-act a-edit" data-edit="' + esc(t.id) + '">Edit</button>' : "") +
        "</div>";
    } else {
      acts = '<div class="tc-actions">' +
        '<button class="tc-act a-chat" data-open="' + esc(t.id) + '">💬' + (n ? " " + n : "") + "</button>" +
        (isOwner() ? '<button class="tc-act a-edit" data-edit="' + esc(t.id) + '">Edit</button>' : "") +
        "</div>";
    }

    return '<div class="tcard s-' + t.status + (t.status === "done" ? " is-done" : "") + (late ? " is-late" : "") +
      '" data-task="' + esc(t.id) + '">' +
      '<span class="tc-bar"></span>' +
      '<div class="tc-body">' +
        '<div class="tc-top">' +
          (!opt.hideClient && c ? '<span class="tc-client">' + esc(c.name) + "</span>" : "<span></span>") +
          '<span class="pill status-pill ' + t.status + '">' + sLabel(t.status) + "</span>" +
        "</div>" +
        '<div class="tc-title">' + esc(t.title) + "</div>" +
        (meta.length ? '<div class="tc-meta">' + meta.join("") + "</div>" : "") +
        (t.notes ? '<div class="tc-note">' + esc(t.notes) + "</div>" : "") +
        acts +
      "</div></div>";
  }

  function sortT(list) {
    return list.slice().sort(function (a, b) {
      return String(a.due || "9999").localeCompare(String(b.due || "9999")) ||
             String(a.time || "").localeCompare(String(b.time || "")) || (a.sort || 0) - (b.sort || 0);
    });
  }
  function quickAdd(placeholder, attrs) {
    if (!isOwner()) return "";
    return '<div class="quick-add">' + ICON.plus +
      '<input type="text" placeholder="' + esc(placeholder) + '" data-quick="1" ' + (attrs || "") + ' enterkeyhint="done">' + "</div>";
  }

  /* ══════════ views ══════════ */
  function render() {
    if (!loaded) return;
    var allowed = nav().map(function (n) { return n.id; });
    if (allowed.indexOf(view) < 0) view = allowed[0];
    $("skeleton").classList.add("hidden");
    $("view").classList.remove("hidden");
    $("topbar-title").textContent = TITLES[view];
    $("fab").classList.toggle("hidden", !isOwner() || view === "links");
    paintNav(); paintOwnerBar(); paintWho();
    var v = $("view");
    if (view === "mywork") v.innerHTML = viewMyWork();
    else if (view === "today") v.innerHTML = viewToday();
    else if (view === "board") v.innerHTML = viewBoard();
    else if (view === "clients") v.innerHTML = viewClients();
    else if (view === "team") v.innerHTML = viewTeam();
    else if (view === "sched") v.innerHTML = viewSched();
    else if (view === "links") v.innerHTML = viewLinks();
    if (view === "board") wireDrag();
  }

  function viewToday() {
    var m = member(who) || member(me.memberId), td = today();
    var pool = mineOnly ? live().filter(function (t) { return t.assigneeId === who; }) : live();
    var over = sortT(pool.filter(isOverdue));
    var due = sortT(pool.filter(function (t) { return t.due === td && t.status !== "done"; }));
    var prog = pool.filter(function (t) { return t.status === "inprogress"; });
    var shoots = sortT(pool.filter(function (t) { return t.kind === "shoot" && t.status !== "done" && t.due >= td && t.due <= addDays(7); }));
    var pending = DB.timeoff.filter(function (e) { return e.status === "requested"; });
    var helpNeeded = sortT(pool.filter(function (t) { return t.status === "needhelp"; }));

    var h = '<div class="page-head"><h2>' + greet() + ", " + esc(m ? m.name : "there") + " 🌸</h2>" +
      '<div class="page-sub">' + new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + "</div></div>";

    h += '<div class="seg" style="margin-bottom:18px;max-width:290px">' +
      '<button data-mine="0" class="' + (mineOnly ? "" : "on") + '">Everyone</button>' +
      '<button data-mine="1" class="' + (mineOnly ? "on" : "") + '">Just ' + esc(m ? m.name : "me") + "</button></div>";

    h += '<div class="stats">' +
      '<div class="stat ' + (over.length ? "late" : "good") + '" data-jump="over"><div class="n">' + over.length + '</div><div class="l">Overdue</div></div>' +
      '<div class="stat warm" data-jump="due"><div class="n">' + due.length + '</div><div class="l">Due today</div></div>' +
      '<div class="stat"><div class="n">' + prog.length + '</div><div class="l">In progress</div></div>' +
      '<div class="stat"><div class="n">' + shoots.length + '</div><div class="l">Shoots this week</div></div></div>';

    h += '<div class="section"><h3>Progress</h3>' +
      (isOwner() ? '<div class="section-actions"><button class="btn btn-soft btn-sm" data-digest>Email today\'s plan</button></div>' : "") + "</div>";
    h += progCard(m ? m.name : "You", live().filter(function (t) { return t.assigneeId === who; }), who, m);
    h += progCard("The whole team", live(), "team", null);

    if (helpNeeded.length) {
      h += '<div class="section"><h3>🙋 Someone needs help</h3></div>' +
        helpNeeded.map(function (t) { return taskHTML(t); }).join("");
    }
    if (isOwner() && pending.length) {
      h += '<div class="section"><h3>Waiting on you</h3></div>';
      h += pending.map(offHTML).join("");
    }
    if (over.length) {
      h += '<div class="section" id="over"><h3>Overdue</h3></div>' + over.map(function (t) { return taskHTML(t); }).join("");
    }

    h += '<div class="section" id="due"><h3>Today, client by client</h3></div>';
    var todays = sortT(pool.filter(function (t) { return t.due === td; }));
    if (!todays.length) {
      h += '<div class="empty"><span class="big">🌿</span>Nothing due today' + (mineOnly ? " for you" : "") + ". Enjoy it.</div>";
    } else {
      var by = {};
      todays.forEach(function (t) { (by[t.clientId] = by[t.clientId] || []).push(t); });
      DB.clients.forEach(function (c) {
        if (!by[c.id]) return;
        h += '<div class="card"><div class="card-head"><div><h3 class="card-title">' + esc(c.name) + "</h3></div>" +
          '<span class="avatars">' + c.team.map(function (id) { return avatar(member(id), "sm"); }).join("") + "</span></div>" +
          '<div style="margin-top:10px">' + by[c.id].map(function (t) { return taskHTML(t, { hideClient: true, nested: true }); }).join("") + "</div></div>";
      });
      if (by[""]) h += by[""].map(function (t) { return taskHTML(t); }).join("");
    }
    h += quickAdd("Add a task for today…", 'data-due="' + td + '"');

    if (shoots.length) h += '<div class="section"><h3>Shoots this week</h3></div>' + shoots.map(function (t) { return taskHTML(t); }).join("");
    return h;
  }

  function viewMyWork() {
    var id = viewerId(), m = member(id), td = today();
    var all = live().filter(function (t) { return t.assigneeId === id; });
    var open = all.filter(function (t) { return t.status !== "done"; });
    var over = sortT(open.filter(isOverdue));
    var todayT = sortT(open.filter(function (t) { return t.due === td; }));
    var week = sortT(open.filter(function (t) { return t.due > td && t.due <= addDays(7); }));
    var later = sortT(open.filter(function (t) { return !t.due || t.due > addDays(7); }));
    var doneRecent = sortT(all.filter(function (t) { return t.status === "done"; })).slice(-5).reverse();
    var help = open.filter(function (t) { return t.status === "needhelp"; });
    var offToday = DB.timeoff.filter(function (e) { return e.memberId === id && e.status === "approved" && e.start <= td && e.end >= td; });

    var h = '<div class="page-head"><h2>' + greet() + ", " + esc(m ? m.name : "there") + " 🌸</h2>" +
      '<div class="page-sub">' + new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + "</div></div>";

    if (offToday.length) h += '<div class="banner good">🌴 You\'re booked off today — enjoy it.</div>';
    if (!me.role) h += '<div class="banner">👋 Viewing as <b>' + esc(m ? m.name : "") +
      '</b>. <button class="linkish" data-whopick>Not you?</button> Sign in to tick off your own tasks.</div>';
    if (help.length) h += '<div class="banner warn">🙋 You flagged ' + help.length + " task" + (help.length === 1 ? "" : "s") + " for help — Alise can see it.</div>";

    h += progCard("Your progress", all, id, m);

    h += '<div class="stats" style="margin-top:14px">' +
      '<div class="stat ' + (over.length ? "late" : "good") + '"><div class="n">' + over.length + '</div><div class="l">Overdue</div></div>' +
      '<div class="stat warm"><div class="n">' + todayT.length + '</div><div class="l">Due today</div></div>' +
      '<div class="stat"><div class="n">' + week.length + '</div><div class="l">This week</div></div>' +
      '<div class="stat good"><div class="n">' + all.filter(function (t) { return t.status === "done"; }).length + '</div><div class="l">Done</div></div></div>';

    function block(title, list, emptyMsg) {
      if (!list.length) return emptyMsg ? '<div class="section"><h3>' + title + "</h3></div><div class='empty'>" + emptyMsg + "</div>" : "";
      return '<div class="section"><h3>' + title + "</h3></div>" + list.map(function (t) { return taskHTML(t, { hideWho: true }); }).join("");
    }
    h += block("⚠ Overdue", over);
    h += block("Today", todayT, "Nothing due today.");
    h += block("This week", week);
    h += block("Later", later);
    if (doneRecent.length) h += block("Recently finished", doneRecent);
    return h;
  }

  var COLS = [
    { id: "todo", label: "To do" },
    { id: "inprogress", label: "In progress" },
    { id: "needhelp", label: "Needs help" },
    { id: "done", label: "Done" }
  ];
  function viewBoard() {
    var pool = mineOnly ? live().filter(function (t) { return t.assigneeId === who; }) : live();
    var m = member(who);
    var h = '<div class="page-head"><h2>Board</h2><div class="page-sub">' +
      (isOwner() ? "Drag a card between columns to change its status." : "Everything the studio is working on.") + "</div></div>";
    h += '<div class="seg" style="margin-bottom:18px;max-width:290px">' +
      '<button data-mine="0" class="' + (mineOnly ? "" : "on") + '">Everyone</button>' +
      '<button data-mine="1" class="' + (mineOnly ? "on" : "") + '">Just ' + esc(m ? m.name : "me") + "</button></div>";
    h += '<div class="board">';
    COLS.forEach(function (col) {
      var items = sortT(pool.filter(function (t) { return t.status === col.id; }));
      h += '<div class="col" data-col="' + col.id + '"><div class="col-head">' +
        '<span class="col-dot" style="background:' + STATUS[col.id].color + '"></span><h4>' + col.label + "</h4>" +
        '<span class="col-count">' + items.length + "</span></div>";
      h += items.map(bcardHTML).join("");
      if (!items.length) h += '<div class="empty" style="padding:16px 10px;margin:0">Nothing here</div>';
      if (isOwner() && col.id === "todo") h += quickAdd("Add a task…", "");
      h += "</div>";
    });
    h += "</div>";
    return h;
  }
  function bcardHTML(t) {
    var c = client(t.clientId), m = member(t.assigneeId);
    var n = DB.comments.filter(function (x) { return x.taskId === t.id; }).length;
    return '<div class="bcard" data-card="' + esc(t.id) + '" data-task="' + esc(t.id) + '">' +
      (c ? '<div class="bcard-client">' + esc(c.name) + "</div>" : "") +
      '<div class="bcard-title">' + esc(t.title) + "</div>" +
      '<div class="bcard-meta">' + (m ? avatar(m, "sm") : "") +
      (t.due ? "<span" + (isOverdue(t) ? ' style="color:var(--late);font-weight:700"' : "") + ">" + fDate(t.due) + "</span>" : "") +
      (t.kind === "shoot" ? '<span class="pill shoot">📷</span>' : "") +
      (n ? "<span>💬 " + n + "</span>" : "") + "</div></div>";
  }

  function viewClients() {
    var act = DB.clients.filter(function (c) { return c.status !== "archived"; });
    var past = DB.clients.filter(function (c) { return c.status === "archived"; });
    var h = '<div class="page-head"><h2>Clients</h2><div class="page-sub">' + act.length + " on the books</div></div>";
    if (isOwner()) h += '<div class="section-actions" style="margin-bottom:14px"><button class="btn btn-dark btn-sm" data-newclient>' + ICON.plus + " New client</button></div>";
    h += '<div class="grid-2">' + act.map(clientCard).join("") + "</div>";
    if (past.length) h += '<div class="section"><h3>Past clients</h3></div><div class="grid-2">' + past.map(clientCard).join("") + "</div>";
    return h;
  }
  function clientCard(c) {
    var open = live().filter(function (t) { return t.clientId === c.id && t.status !== "done"; });
    var late = open.filter(isOverdue).length;
    return '<div class="card click" data-client="' + esc(c.id) + '">' +
      '<div class="card-head"><div style="min-width:0"><h3 class="card-title">' + esc(c.name) + "</h3>" +
      '<div class="card-sub">' + esc(c.services || "—") + "</div></div>" +
      '<span class="pill ' + c.status + '">' + statusLabel(c.status) + "</span></div>" +
      '<div class="row" style="margin-top:10px;display:flex;align-items:center;gap:8px">' +
      '<span class="avatars">' + c.team.map(function (id) { return avatar(member(id), "sm"); }).join("") + "</span>" +
      "<span>" + open.length + " open" + (late ? ' · <b style="color:var(--late)">' + late + " late</b>" : "") + "</span></div></div>";
  }

  function viewTeam() {
    var td = today();
    var upcoming = DB.timeoff.filter(function (e) { return e.end >= td; })
      .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });
    var h = '<div class="page-head"><h2>The team</h2><div class="page-sub">Who\'s carrying what</div></div>';
    h += progCard("Team progress", live(), "team", null);

    h += '<div class="section"><h3>Time off</h3><div class="section-actions">' +
      (isOwner() ? '<button class="btn btn-dark btn-sm" data-addoff>' + ICON.plus + " Add</button>"
                 : '<button class="btn btn-dark btn-sm" data-reqoff>🌴 Request time off</button>') + "</div></div>";
    h += upcoming.length ? upcoming.map(offHTML).join("") : '<div class="empty">No time off coming up.</div>';

    h += '<div class="section"><h3>Everyone</h3>' + (isOwner() ? '<div class="section-actions"><button class="btn btn-dark btn-sm" data-newmember>' + ICON.plus + " Employee</button></div>" : "") + "</div>";
    DB.members.forEach(function (m) {
      var all = live().filter(function (t) { return t.assigneeId === m.id; });
      var open = sortT(all.filter(function (t) { return t.status !== "done"; }));
      var help = open.filter(function (t) { return t.status === "needhelp"; }).length;
      var lateN = open.filter(isOverdue).length;
      h += '<div class="card"><div class="person-head">' + avatar(m, "lg") +
        '<div class="who-meta"><h3>' + esc(m.full) + (m.id === viewerId() ? ' <span class="pill active">you</span>' : "") + "</h3>" +
        '<div class="card-sub">' + esc(m.role || "—") + "</div></div>" +
        '<div style="display:flex;align-items:center;gap:5px;flex-shrink:0">' +
        (help ? '<span class="pill needhelp">' + help + " need help</span>" : "") +
        (lateN ? '<span class="pill overdue">' + lateN + " late</span>" : "") +
        '<span class="pill todo">' + open.length + " open</span>" +
        (isOwner() ? '<button class="mini-btn" data-editmember="' + esc(m.id) + '">' + ICON.edit + "</button>" : "") +
        (isOwner() ? '<button class="mini-btn" data-assignto="' + esc(m.id) + '" title="Assign a task">' + ICON.plus + "</button>" : "") +
        "</div></div>";
      if (m.email) h += '<div class="row" style="margin-top:8px"><a href="mailto:' + esc(m.email) + '">' + esc(m.email) + "</a></div>";
      if (m.info) h += '<div class="note">' + esc(m.info) + "</div>";
      h += '<div style="margin-top:11px">' + progCard(m.name, all, m.id, null) + "</div>";
      h += open.length ? open.map(function (t) { return taskHTML(t, { hideWho: true, nested: true }); }).join("")
                       : '<div class="empty" style="padding:14px">All clear 🌿</div>';
      h += "</div>";
    });

    if (DB.activity.length) {
      h += '<div class="section"><h3>Recent activity</h3></div><div class="card">';
      h += DB.activity.slice(0, 12).map(function (a) {
        var am = member(a.actorId);
        return '<div class="feed-item">' + avatar(am, "sm") +
          '<div style="flex:1;min-width:0"><div>' + esc(am ? am.name : "Someone") + " " + esc(a.verb) + ' <b>' + esc(a.subject) + "</b></div>" +
          '<div class="feed-when">' + ago(a.at) + "</div></div></div>";
      }).join("");
      h += "</div>";
    }
    return h;
  }
  function offHTML(e) {
    var m = member(e.memberId);
    return '<div class="off-row" data-off="' + esc(e.id) + '">🌴' + avatar(m, "sm") +
      '<span class="flex"><b>' + esc(m ? m.name : "?") + "</b> " + fDate(e.start) + (e.end !== e.start ? " – " + fDate(e.end) : "") +
      (e.reason ? ' <span style="color:var(--muted)">· ' + esc(e.reason) + "</span>" : "") + "</span>" +
      '<span class="pill ' + e.status + '">' + e.status + "</span>" +
      (isOwner() ? (e.status === "requested"
        ? '<button class="btn btn-dark btn-sm" data-approve="' + esc(e.id) + '">Approve</button>' +
          '<button class="btn btn-soft btn-sm" data-deny="' + esc(e.id) + '">Deny</button>' : "") +
        '<button class="mini-btn" data-editoff="' + esc(e.id) + '">' + ICON.edit + "</button>" : "") + "</div>";
  }

  function viewSched() {
    var td = today();
    var pool = mineOnly ? live().filter(function (t) { return t.assigneeId === who; }) : live();
    var up = sortT(pool.filter(function (t) { return t.status !== "done" && t.due && t.due >= td; }));
    var days = {};
    up.forEach(function (t) { (days[t.due] = days[t.due] || { t: [], o: [] }).t.push(t); });
    DB.timeoff.forEach(function (e) {
      if (e.status !== "approved" || e.end < td) return;
      if (mineOnly && e.memberId !== who) return;
      var k = e.start >= td ? e.start : td;
      (days[k] = days[k] || { t: [], o: [] }).o.push(e);
    });
    var keys = Object.keys(days).sort();
    var h = '<div class="page-head"><h2>Schedule</h2><div class="page-sub">Shoots, deadlines and time off</div></div>';
    var m = member(who);
    h += '<div class="seg" style="margin-bottom:18px;max-width:290px">' +
      '<button data-mine="0" class="' + (mineOnly ? "" : "on") + '">Everyone</button>' +
      '<button data-mine="1" class="' + (mineOnly ? "on" : "") + '">Just ' + esc(m ? m.name : "me") + "</button></div>";
    if (isOwner()) h += '<div class="section-actions" style="margin-bottom:14px"><button class="btn btn-dark btn-sm" data-newshoot>📷 Schedule a shoot</button></div>';
    if (!keys.length) h += '<div class="empty"><span class="big">🗓</span>Nothing on the calendar yet.</div>';
    keys.forEach(function (d) {
      h += '<div class="day"><div class="day-head"><b>' + fDow(d) + "</b><span>" + fDate(d) + "</span>" +
        (d === td ? '<span class="today-tag">today</span>' : "") + "</div>" +
        days[d].o.map(offHTML).join("") + days[d].t.map(function (t) { return taskHTML(t); }).join("") + "</div>";
    });
    return h;
  }

  function viewLinks() {
    var h = '<div class="page-head"><h2>Studio links</h2><div class="page-sub">Every tool, one tap away</div></div>';
    if (isOwner()) h += '<div class="section-actions" style="margin-bottom:14px"><button class="btn btn-dark btn-sm" data-newlink>' + ICON.plus + " Add link</button></div>";
    h += '<div class="links">' + DB.links.map(function (l) {
      return '<a class="link" href="' + esc(l.url) + '" target="_blank" rel="noopener">' +
        '<div class="emo">' + esc(l.emoji) + '</div><div class="nm">' + esc(l.name) + "</div>" +
        '<div class="ds">' + esc(l.desc) + "</div>" +
        (isOwner() ? '<button class="mini-btn edit" data-editlink="' + esc(l.id) + '">' + ICON.edit + "</button>" : "") + "</a>";
    }).join("") + "</div>";
    return h;
  }

  /* ══════════ chrome painters ══════════ */
  function paintNav() {
    var pending = DB.timeoff.filter(function (e) { return e.status === "requested"; }).length;
    var over = live().filter(isOverdue).length;
    var needHelp = live().filter(function (t) { return t.status === "needhelp"; }).length;
    $("nav-items").innerHTML = nav().map(function (n) {
      var badge = "";
      if (n.id === "today" && (over + needHelp)) badge = '<span class="nav-badge">' + (over + needHelp) + "</span>";
      if (n.id === "mywork") {
        var mineOpen = live().filter(function (t) { return t.assigneeId === viewerId() && t.status !== "done"; }).length;
        if (mineOpen) badge = '<span class="nav-badge">' + mineOpen + "</span>";
      }
      if (n.id === "team" && pending && isOwner()) badge = '<span class="nav-badge">' + pending + "</span>";
      return '<button class="nav-item' + (view === n.id ? " on" : "") + '" data-nav="' + n.id + '">' +
        ICON[n.icon] + "<span>" + n.label + "</span>" + badge + "</button>";
    }).join("");
  }
  function paintConnection() {
    var f = $("nav-foot");
    if (!f) return;
    f.innerHTML = '<div class="live"><span class="live-dot' + (connected ? "" : " off") + '"></span>' +
      (connected ? "Live — synced" : cloudReady ? "Reconnecting…" : "Offline copy") + "</div>";
  }
  function paintOwnerBar() {
    var on = isOwner();
    $("owner-bar").classList.toggle("hidden", !on && me.role !== "employee");
    $("owner-btn").classList.toggle("hidden", !!me.role);
    if (me.role === "employee") {
      $("owner-bar-label").textContent = "Signed in as " + (member(me.memberId) || {}).name + (DB.settings.employeesCanCheck ? " — you can tick off your own tasks." : " — view only.");
      $("settings-btn").classList.add("hidden");
    } else if (on) {
      $("owner-bar-label").textContent = "Owner mode — changes save live for the team.";
      $("settings-btn").classList.remove("hidden");
    }
  }
  function paintWho() {
    var m = member(who);
    if (me.role) {
      var mm = member(me.memberId) || m;
      $("who-wrap").innerHTML = mm ? '<span class="who-chip">' + avatar(mm, "sm") + esc(mm.name) + "</span>" : "";
      return;
    }
    $("who-wrap").innerHTML = '<button class="who-chip" data-whopick>' + avatar(m, "sm") + esc(m ? m.name : "Who?") + "</button>";
  }

  /* ══════════ modal ══════════ */
  function openModal(html) {
    $("modal").innerHTML = html;
    $("modal-backdrop").classList.remove("hidden");
    $("modal").querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", closeModal); });
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    $("modal-backdrop").classList.add("hidden");
    $("modal").innerHTML = "";
    document.body.style.overflow = "";
  }
  $("modal-backdrop").addEventListener("click", function (e) { if (e.target === this) closeModal(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeModal(); closeSearch(); }
    if (e.key === "/" && document.activeElement === document.body) { e.preventDefault(); focusSearch(); }
  });

  function segHTML(id, opts, cur) {
    return '<div class="seg" id="' + id + '">' + opts.map(function (o) {
      return '<button data-v="' + esc(o.v) + '" class="' + (o.v === cur ? "on" : "") + '">' + esc(o.l) + "</button>";
    }).join("") + "</div>";
  }
  function wireSeg(id, cb) {
    var box = $(id); if (!box) return;
    box.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        box.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        cb(b.getAttribute("data-v"));
      });
    });
  }

  /* ── task form ── */
  function taskForm(id, preset) {
    var t = id ? task(id) : null, isNew = !t;
    t = t ? JSON.parse(JSON.stringify(t)) : {
      id: uid(), clientId: (preset && preset.clientId) || "", title: "",
      assigneeId: (preset && preset.assigneeId) || me.memberId || who, due: (preset && preset.due) || today(), time: "",
      status: "todo", kind: (preset && preset.kind) || "task", location: "", notes: "", sort: Date.now() % 100000
    };
    openModal(
      "<h3>" + (isNew ? "Assign a task" : "Edit task") + "</h3>" +
      (isNew ? "<div class='modal-sub'>It appears under their name on the Team tab and on their own My-work screen.</div>" : "") +
      "<label>1 · What needs doing?</label><input type='text' id='f-title' value='" + esc(t.title) + "' placeholder='e.g. Draft this week&#39;s captions'>" +
      "<label>2 · Who's doing it?</label>" +
      "<div class='pickers' id='f-whopick'>" + DB.members.map(function (mm) {
        return "<button data-v='" + esc(mm.id) + "' class='picker" + (mm.id === t.assigneeId ? " on" : "") + "'>" +
          avatar(mm, "sm") + "<span>" + esc(mm.name) + "</span></button>";
      }).join("") + "</div>" +
      "<label>3 · Type</label>" + segHTML("f-kind", [{ v: "task", l: "✓ Task" }, { v: "shoot", l: "📷 Photoshoot" }], t.kind) +
      "<label>4 · Which client?</label><select id='f-client'><option value=''>— none / internal —</option>" +
        DB.clients.filter(function (c) { return c.status !== "archived"; }).map(function (c) {
          return "<option value='" + esc(c.id) + "'" + (c.id === t.clientId ? " selected" : "") + ">" + esc(c.name) + "</option>";
        }).join("") + "</select>" +
      "<label>5 · Due</label><input type='date' id='f-due' value='" + esc(t.due) + "'>" +
      "<div id='f-shoot' class='" + (t.kind === "shoot" ? "" : "hidden") + "'>" +
        "<label>Time</label><input type='time' id='f-time' value='" + esc(t.time) + "'>" +
        "<label>Location</label><input type='text' id='f-loc' value='" + esc(t.location) + "'>" + "</div>" +
      "<label>Status</label>" + segHTML("f-status", [{ v: "todo", l: "To do" }, { v: "inprogress", l: "In progress" }, { v: "needhelp", l: "Needs help" }, { v: "done", l: "Done" }], t.status) +
      "<label>Notes for them</label><textarea id='f-notes' placeholder='Anything they need to know — links, context, who to ask'>" + esc(t.notes) + "</textarea>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='f-save'>" + (isNew ? "Add task" : "Save") + "</button></div>" +
      (isNew ? "" : "<div class='danger-zone'><button class='btn btn-danger' id='f-del'>Delete task</button></div>")
    );
    var kind = t.kind, status = t.status, assignee = t.assigneeId;
    wireSeg("f-kind", function (v) { kind = v; $("f-shoot").classList.toggle("hidden", v !== "shoot"); });
    wireSeg("f-status", function (v) { status = v; });
    $("f-whopick").querySelectorAll(".picker").forEach(function (b) {
      b.addEventListener("click", function () {
        assignee = b.getAttribute("data-v");
        $("f-whopick").querySelectorAll(".picker").forEach(function (x) { x.classList.toggle("on", x === b); });
      });
    });
    $("f-title").focus();
    $("f-save").addEventListener("click", function () {
      var title = $("f-title").value.trim();
      if (!title) return $("f-title").focus();
      t.title = title; t.kind = kind; t.status = status;
      t.clientId = $("f-client").value; t.assigneeId = assignee; t.due = $("f-due").value;
      t.time = kind === "shoot" ? $("f-time").value : "";
      t.location = kind === "shoot" ? $("f-loc").value.trim() : "";
      t.notes = $("f-notes").value.trim();
      t.completedAt = status === "done" ? new Date().toISOString() : null;
      closeModal();
      upsert("tasks", taskRow(t), t, "tasks");
      logAct(isNew ? "assigned" : "updated", t.title);
      var am = member(t.assigneeId);
      toast(isNew ? "Assigned to " + (am ? am.name : "the team") + " ✳" : "Saved ✳");
    });
    if (!isNew) $("f-del").addEventListener("click", function () {
      if (!confirm("Delete this task?")) return;
      closeModal(); removeRow("tasks", t.id, "tasks"); logAct("deleted", t.title); toast("Deleted");
    });
  }

  /* ── task detail + comments ── */
  function taskDetail(id) {
    var t = task(id); if (!t) return;
    var c = client(t.clientId), m = member(t.assigneeId);
    var cs = DB.comments.filter(function (x) { return x.taskId === id; })
      .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    var h = "<h3>" + esc(t.title) + "</h3><div class='modal-sub'>" +
      (c ? esc(c.name) + " · " : "") + (t.due ? fDate(t.due) : "no date") + (t.time ? " · " + fTime(t.time) : "") + "</div>";
    h += "<div style='display:flex;gap:7px;flex-wrap:wrap;margin-bottom:6px'>" +
      "<span class='pill " + t.status + "'>" + (t.status === "inprogress" ? "in progress" : t.status) + "</span>" +
      (t.kind === "shoot" ? "<span class='pill shoot'>📷 shoot</span>" : "") +
      (isOverdue(t) ? "<span class='pill overdue'>late</span>" : "") + "</div>";
    if (m) h += "<div class='row' style='display:flex;align-items:center;gap:7px;margin-top:8px'>" + avatar(m, "sm") + esc(m.full) + "</div>";
    if (t.location) h += "<div class='row'>📍 " + esc(t.location) + "</div>";
    if (t.notes) h += "<div class='note'>" + esc(t.notes) + "</div>";

    h += "<label>Comments</label><div id='cmt-list'>" +
      (cs.length ? cs.map(function (x) {
        var cm = member(x.memberId);
        return "<div class='cmt'>" + avatar(cm, "sm") + "<div class='cmt-body'>" +
          "<div><span class='cmt-who'>" + esc(cm ? cm.name : "Someone") + "</span><span class='cmt-when'>" + ago(x.at) + "</span></div>" +
          "<div class='cmt-text'>" + esc(x.body) + "</div></div></div>";
      }).join("") : "<div class='hint'>No comments yet.</div>") + "</div>";
    h += "<div class='quick-add' style='margin-top:10px'>" + ICON.chat +
      "<input type='text' id='cmt-in' placeholder='Add a comment…' enterkeyhint='send'></div>";
    h += "<div class='modal-actions'>" +
      (canCheck(t) ? "<button class='btn btn-soft' id='d-cycle'>Move to " + (cycle(t.status) === "inprogress" ? "in progress" : cycle(t.status)) + "</button>" : "") +
      (isOwner() ? "<button class='btn btn-soft' id='d-edit'>Edit</button>" : "") +
      "<button class='btn btn-primary' data-close>Close</button></div>";
    openModal(h);
    var input = $("cmt-in");
    function send() {
      var body = input.value.trim(); if (!body) return;
      input.value = "";
      var row = { task_id: id, member_id: me.memberId || who, body: body };
      if (!cloudReady) { DB.comments.push({ id: uid(), taskId: id, memberId: who, body: body, at: new Date().toISOString() }); taskDetail(id); return; }
      sb.from("comments").insert(row).then(function (r) {
        if (r.error) return fail("Couldn't post that comment");
        return sb.from("comments").select("*").eq("task_id", id).then(function (res) {
          if (!res.error) {
            DB.comments = DB.comments.filter(function (x) { return x.taskId !== id; }).concat((res.data || []).map(mCmt));
          }
          taskDetail(id);
        });
      });
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
    var dc = $("d-cycle");
    if (dc) dc.addEventListener("click", function () { toggleStatus(id); closeModal(); });
    var de = $("d-edit");
    if (de) de.addEventListener("click", function () { taskForm(id); });
  }

  /* ── client form + detail ── */
  function clientForm(id) {
    var c = id ? client(id) : null, isNew = !c;
    c = c ? JSON.parse(JSON.stringify(c)) : { id: uid(), name: "", status: "active", contact: "", email: "", phone: "", services: "", loomly: "", team: [], notes: "", sort: Date.now() % 100000 };
    openModal(
      "<h3>" + (isNew ? "New client" : "Edit client") + "</h3>" +
      "<label>Business name</label><input type='text' id='c-name' value='" + esc(c.name) + "'>" +
      "<label>Status</label>" + segHTML("c-status", [{ v: "active", l: "Active" }, { v: "pending", l: "Pending" }, { v: "archived", l: "Past client" }], c.status) +
      "<label>Contact</label><input type='text' id='c-contact' value='" + esc(c.contact) + "'>" +
      "<label>Email</label><input type='text' id='c-email' value='" + esc(c.email) + "'>" +
      "<label>Phone</label><input type='text' id='c-phone' value='" + esc(c.phone) + "'>" +
      "<label>Services</label><input type='text' id='c-serv' value='" + esc(c.services) + "'>" +
      "<label>Calendar name</label><input type='text' id='c-loomly' value='" + esc(c.loomly) + "'>" +
      "<label>Team on this client</label>" +
      "<div class='seg' id='c-team'>" + DB.members.map(function (m) {
        return "<button data-m='" + esc(m.id) + "' class='" + (c.team.indexOf(m.id) >= 0 ? "on" : "") + "'>" + esc(m.name) + "</button>";
      }).join("") + "</div>" +
      "<label>Notes</label><textarea id='c-notes'>" + esc(c.notes) + "</textarea>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='c-save'>" + (isNew ? "Add client" : "Save") + "</button></div>" +
      (isNew ? "" : "<div class='danger-zone'><button class='btn btn-danger' id='c-del'>Delete client</button></div>")
    );
    var status = c.status, team = c.team.slice();
    wireSeg("c-status", function (v) { status = v; });
    $("c-team").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        var mid = b.getAttribute("data-m"), i = team.indexOf(mid);
        if (i >= 0) team.splice(i, 1); else team.push(mid);
        b.classList.toggle("on", i < 0);
      });
    });
    $("c-name").focus();
    $("c-save").addEventListener("click", function () {
      var name = $("c-name").value.trim(); if (!name) return $("c-name").focus();
      c.name = name; c.status = status; c.team = team;
      c.contact = $("c-contact").value.trim(); c.email = $("c-email").value.trim();
      c.phone = $("c-phone").value.trim(); c.services = $("c-serv").value.trim();
      c.loomly = $("c-loomly").value.trim(); c.notes = $("c-notes").value.trim();
      closeModal(); upsert("clients", clientRow(c), c, "clients");
      logAct(isNew ? "added client" : "updated client", c.name);
      toast(isNew ? "Client added ✳" : "Saved ✳");
    });
    if (!isNew) $("c-del").addEventListener("click", function () {
      if (!confirm("Delete " + c.name + "? Their tasks stay but lose the client label.")) return;
      closeModal(); removeRow("clients", c.id, "clients"); toast("Deleted");
    });
  }
  function clientDetail(id) {
    var c = client(id); if (!c) return;
    var list = sortT(live().filter(function (t) { return t.clientId === id; }));
    var open = list.filter(function (t) { return t.status !== "done"; });
    var done = list.filter(function (t) { return t.status === "done"; });
    var h = "<div class='card-head'><h3>" + esc(c.name) + "</h3><span class='pill " + c.status + "'>" + statusLabel(c.status) + "</span></div>";
    if (c.contact) h += "<div class='row'><b>Contact:</b> " + esc(c.contact) + "</div>";
    if (c.email) h += "<div class='row'><b>Email:</b> <a href='mailto:" + esc(c.email) + "'>" + esc(c.email) + "</a></div>";
    if (c.phone) h += "<div class='row'><b>Phone:</b> <a href='tel:" + esc(c.phone.replace(/[^0-9+]/g, "")) + "'>" + esc(c.phone) + "</a></div>";
    if (c.services) h += "<div class='row'><b>Services:</b> " + esc(c.services) + "</div>";
    if (c.loomly) h += "<div class='row'><b>Calendar:</b> " + esc(c.loomly) + "</div>";
    if (c.team.length) h += "<div class='row' style='display:flex;align-items:center;gap:8px;margin-top:8px'><span class='avatars'>" +
      c.team.map(function (i) { return avatar(member(i), "sm"); }).join("") + "</span>" +
      c.team.map(function (i) { var m = member(i); return m ? m.name : ""; }).filter(Boolean).join(" · ") + "</div>";
    if (c.notes) h += "<div class='note'>" + esc(c.notes) + "</div>";
    if (list.length) h += "<div style='margin-top:14px'>" + progCard("Progress", list, "client-" + id, null) + "</div>";
    h += "<label>Open work</label>";
    h += open.length ? open.map(function (t) { return taskHTML(t, { hideClient: true }); }).join("") : "<div class='hint'>Nothing open.</div>";
    if (done.length) h += "<label>Done</label>" + done.map(function (t) { return taskHTML(t, { hideClient: true }); }).join("");
    h += "<div class='modal-actions'>" +
      (isOwner() ? "<button class='btn btn-soft' id='cd-add'>+ Task</button><button class='btn btn-soft' id='cd-edit'>Edit</button>" : "") +
      "<button class='btn btn-primary' data-close>Close</button></div>";
    if (isOwner()) h += "<div class='danger-zone'><button class='btn btn-ghost' id='cd-arch'>" +
      (c.status === "archived" ? "🌱 Make active again" : "📁 Move to past clients") + "</button></div>";
    openModal(h);
    var a = $("cd-add"); if (a) a.addEventListener("click", function () { taskForm(null, { clientId: id }); });
    var e = $("cd-edit"); if (e) e.addEventListener("click", function () { clientForm(id); });
    var ar = $("cd-arch"); if (ar) ar.addEventListener("click", function () {
      var real = client(id);
      real.status = real.status === "archived" ? "active" : "archived";
      closeModal(); upsert("clients", clientRow(real), real, "clients");
      logAct(real.status === "archived" ? "archived client" : "reactivated client", real.name);
      toast(real.status === "archived" ? real.name + " → past clients 📁" : real.name + " is active again 🌱");
    });
  }

  /* ── member / link / timeoff forms ── */
  var COLORS = ["#c4667c", "#7ea287", "#4f7460", "#b98d6f", "#8a7fa3", "#c9976f"];
  function memberForm(id) {
    var m = id ? member(id) : null, isNew = !m;
    m = m ? JSON.parse(JSON.stringify(m)) : { id: uid(), name: "", full: "", role: "", color: COLORS[DB.members.length % COLORS.length], email: "", info: "", isOwner: false, sort: DB.members.length };
    openModal("<h3>" + (isNew ? "New employee" : "Edit employee") + "</h3>" +
      "<label>First name</label><input type='text' id='m-name' value='" + esc(m.name) + "'>" +
      "<label>Full name</label><input type='text' id='m-full' value='" + esc(m.full) + "'>" +
      "<label>Role</label><input type='text' id='m-role' value='" + esc(m.role) + "'>" +
      "<label>Email</label><input type='text' id='m-email' value='" + esc(m.email) + "'>" +
      "<label>Notes (whole team sees this)</label><textarea id='m-info'>" + esc(m.info) + "</textarea>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='m-save'>" + (isNew ? "Add" : "Save") + "</button></div>" +
      (isNew || m.isOwner ? "" : "<div class='danger-zone'><button class='btn btn-danger' id='m-del'>Remove</button></div>"));
    $("m-name").focus();
    $("m-save").addEventListener("click", function () {
      var n = $("m-name").value.trim(); if (!n) return $("m-name").focus();
      m.name = n; m.full = $("m-full").value.trim() || n; m.role = $("m-role").value.trim();
      m.email = $("m-email").value.trim(); m.info = $("m-info").value.trim();
      closeModal(); upsert("members", memberRow(m), m, "members"); toast(isNew ? "Welcome, " + m.name + " ✳" : "Saved ✳");
    });
    var d = $("m-del"); if (d) d.addEventListener("click", function () {
      if (!confirm("Remove " + m.name + "?")) return;
      closeModal(); removeRow("members", m.id, "members"); toast("Removed");
    });
  }
  function linkForm(id) {
    var l = id ? DB.links.filter(function (x) { return x.id === id; })[0] : null, isNew = !l;
    l = l ? JSON.parse(JSON.stringify(l)) : { id: uid(), name: "", emoji: "🔗", desc: "", url: "", sort: DB.links.length };
    openModal("<h3>" + (isNew ? "Add link" : "Edit link") + "</h3>" +
      "<label>Name</label><input type='text' id='l-name' value='" + esc(l.name) + "'>" +
      "<label>Emoji</label><input type='text' id='l-emoji' value='" + esc(l.emoji) + "'>" +
      "<label>What is it for?</label><input type='text' id='l-desc' value='" + esc(l.desc) + "'>" +
      "<label>Web address</label><input type='text' id='l-url' value='" + esc(l.url) + "' placeholder='https://…'>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='l-save'>" + (isNew ? "Add" : "Save") + "</button></div>" +
      (isNew ? "" : "<div class='danger-zone'><button class='btn btn-danger' id='l-del'>Delete</button></div>"));
    $("l-name").focus();
    $("l-save").addEventListener("click", function () {
      var n = $("l-name").value.trim(), u = $("l-url").value.trim();
      if (!n) return $("l-name").focus();
      if (!u) return $("l-url").focus();
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      l.name = n; l.url = u; l.emoji = $("l-emoji").value.trim() || "🔗"; l.desc = $("l-desc").value.trim();
      closeModal(); upsert("links", linkRow(l), l, "links"); toast(isNew ? "Link added ✳" : "Saved ✳");
    });
    var d = $("l-del"); if (d) d.addEventListener("click", function () {
      if (!confirm("Delete the " + l.name + " link?")) return;
      closeModal(); removeRow("links", l.id, "links"); toast("Deleted");
    });
  }
  function offForm(id) {
    var owner = isOwner();
    var e0 = id ? DB.timeoff.filter(function (x) { return x.id === id; })[0] : null, isNew = !e0;
    var e = e0 ? JSON.parse(JSON.stringify(e0)) : { id: uid(), memberId: owner ? DB.members[0].id : (me.memberId || who), start: today(), end: today(), reason: "", status: owner ? "approved" : "requested" };
    openModal("<h3>" + (owner ? (isNew ? "Add time off" : "Edit time off") : "Request time off") + "</h3>" +
      (owner ? "<label>Who</label><select id='o-who'>" + DB.members.map(function (m) {
        return "<option value='" + esc(m.id) + "'" + (m.id === e.memberId ? " selected" : "") + ">" + esc(m.name) + "</option>";
      }).join("") + "</select>"
      : "<div class='modal-sub'>This goes straight to Alise's Team tab for approval.</div>") +
      "<label>First day</label><input type='date' id='o-start' value='" + esc(e.start) + "'>" +
      "<label>Last day</label><input type='date' id='o-end' value='" + esc(e.end) + "'>" +
      "<label>Reason (optional)</label><input type='text' id='o-reason' value='" + esc(e.reason) + "'>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='o-save'>" + (owner ? "Save" : "Send request") + "</button></div>" +
      (owner && !isNew ? "<div class='danger-zone'><button class='btn btn-danger' id='o-del'>Delete</button></div>" : ""));
    $("o-save").addEventListener("click", function () {
      var s = $("o-start").value, en = $("o-end").value || s;
      if (!s) return $("o-start").focus();
      if (en < s) en = s;
      e.start = s; e.end = en; e.reason = $("o-reason").value.trim();
      if (owner) e.memberId = $("o-who").value; else { e.memberId = me.memberId || who; e.status = "requested"; }
      closeModal();
      var row = { member_id: e.memberId, start_day: e.start, end_day: e.end, reason: e.reason, status: e.status };
      if (!cloudReady) { if (isNew) DB.timeoff.push(e); render(); return; }
      var q = isNew ? sb.from("timeoff").insert(row) : sb.from("timeoff").update(row).eq("id", e.id);
      q.then(function (r) {
        if (r.error) return fail(owner ? "Couldn't save" : "Couldn't send — try again");
        toast(owner ? "Saved 🌴" : "Request sent 🌴 — Alise will see it");
        return refreshOff();
      });
    });
    var d = $("o-del"); if (d) d.addEventListener("click", function () {
      if (!confirm("Delete this time off?")) return;
      closeModal(); removeRow("timeoff", e.id, "timeoff"); toast("Deleted");
    });
  }
  function refreshOff() {
    if (!cloudReady) return Promise.resolve();
    return sb.from("timeoff").select("*").order("start_day").then(function (r) {
      if (!r.error) { DB.timeoff = (r.data || []).map(mOff); render(); }
    });
  }
  function decideOff(id, status) {
    var e = DB.timeoff.filter(function (x) { return x.id === id; })[0];
    if (e) { e.status = status; scheduleRender(); }
    var m = e && member(e.memberId);
    logAct(status === "approved" ? "approved time off for" : "denied time off for", m ? m.name : "");
    if (!cloudReady) return;
    sb.from("timeoff").update({ status: status, decided_at: new Date().toISOString() }).eq("id", id).select("id")
      .then(function (r) { if (wrote(r, "Couldn't update — are you still signed in?")) toast(status === "approved" ? "Approved 🌴" : "Denied — let them know"); });
  }

  /* ── settings ── */
  function settingsModal() {
    var doneOld = live().filter(function (t) { return t.status === "done" && t.completedAt && (Date.now() - new Date(t.completedAt).getTime()) > 30 * 864e5; }).length;
    openModal("<h3>Settings</h3>" +
      "<label>Studio password (whole team)</label><input type='text' id='s-code' value='" + esc(DB.settings.accessCode || "") + "'>" +
      "<label>Owner email (for notifications)</label><input type='text' id='s-email' value='" + esc(DB.settings.ownerEmail || "") + "'>" +
      "<div class='switch-row' style='margin-top:18px'><div><div class='switch-txt'>Let employees tick off their own tasks</div>" +
      "<div class='hint' style='margin:2px 0 0'>They still can't edit or delete anything.</div></div>" +
      "<button class='switch" + (DB.settings.employeesCanCheck ? " on" : "") + "' id='s-emp'></button></div>" +
      "<label>Housekeeping</label>" +
      "<button class='btn btn-soft btn-block' id='s-tidy'" + (doneOld ? "" : " disabled") + ">Archive " + doneOld + " task" + (doneOld === 1 ? "" : "s") + " finished over 30 days ago</button>" +
      "<div class='hint'>Archiving keeps your progress bars honest — archived tasks stay in the database but drop off the boards.</div>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='s-save'>Save</button></div>" +
      "<div class='danger-zone'><button class='btn btn-ghost' id='s-backup'>Download a backup</button></div>");
    var emp = !!DB.settings.employeesCanCheck;
    $("s-emp").addEventListener("click", function () { emp = !emp; this.classList.toggle("on", emp); });
    $("s-tidy").addEventListener("click", function () {
      var olds = live().filter(function (t) { return t.status === "done" && t.completedAt && (Date.now() - new Date(t.completedAt).getTime()) > 30 * 864e5; });
      olds.forEach(function (t) { t.archived = true; });
      closeModal(); scheduleRender();
      if (cloudReady) Promise.all(olds.map(function (t) { return sb.from("tasks").update({ archived: true }).eq("id", t.id); }))
        .then(function () { toast("Archived " + olds.length + " old task" + (olds.length === 1 ? "" : "s")); });
    });
    $("s-save").addEventListener("click", function () {
      DB.settings.accessCode = $("s-code").value.trim() || DB.settings.accessCode;
      DB.settings.ownerEmail = $("s-email").value.trim();
      DB.settings.employeesCanCheck = emp;
      closeModal(); saveSettings().then(function () { toast("Settings saved 🌸"); render(); });
    });
    $("s-backup").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(DB, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "studio-hq-backup.json";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
      toast("Backup downloaded");
    });
  }

  /* ── daily digest email ── */
  function digest() {
    var td = today(), lines = [];
    DB.members.forEach(function (m) {
      var mine = sortT(live().filter(function (t) { return t.assigneeId === m.id && t.status !== "done" && t.due && t.due <= td; }));
      if (!mine.length) return;
      lines.push(m.name + ":");
      mine.forEach(function (t) {
        var c = client(t.clientId);
        lines.push("  • " + t.title + (c ? " (" + c.name + ")" : "") +
          (isOverdue(t) ? " — OVERDUE " + fDate(t.due) : "") + (t.time ? " at " + fTime(t.time) : ""));
      });
      lines.push("");
    });
    var offToday = DB.timeoff.filter(function (e) { return e.status === "approved" && e.start <= td && e.end >= td; });
    if (offToday.length) {
      lines.push("Out today: " + offToday.map(function (e) { var m = member(e.memberId); return m ? m.name : ""; }).join(", "));
    }
    if (!lines.length) lines.push("Nothing outstanding — enjoy the day!");
    var body = "Morning team,\n\nHere's today (" + new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + "):\n\n" +
      lines.join("\n") + "\n— Alise\n";
    var to = DB.members.filter(function (m) { return m.email && !m.isOwner; }).map(function (m) { return m.email; }).join(",");
    window.location.href = "mailto:" + encodeURIComponent(to) + "?subject=" +
      encodeURIComponent("Studio HQ — today's plan") + "&body=" + encodeURIComponent(body);
  }

  /* ══════════ board drag (mouse + touch) ══════════ */
  var drag = null;
  function wireDrag() {
    if (!isOwner()) return;
    $("view").querySelectorAll(".bcard").forEach(function (card) {
      card.addEventListener("pointerdown", function (ev) {
        if (ev.button != null && ev.button !== 0) return;
        var startX = ev.clientX, startY = ev.clientY, moved = false, ghost = null;
        var id = card.getAttribute("data-card");
        card.setPointerCapture(ev.pointerId);

        function onMove(e) {
          var dx = e.clientX - startX, dy = e.clientY - startY;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 7) return;
          if (!moved) {
            moved = true;
            var r = card.getBoundingClientRect();
            ghost = card.cloneNode(true);
            ghost.className = "bcard bcard-ghost";
            ghost.style.width = r.width + "px";
            ghost.style.left = r.left + "px";
            ghost.style.top = r.top + "px";
            document.body.appendChild(ghost);
            card.classList.add("dragging");
            drag = { id: id, ghost: ghost, offX: startX - r.left, offY: startY - r.top };
          }
          ghost.style.left = (e.clientX - drag.offX) + "px";
          ghost.style.top = (e.clientY - drag.offY) + "px";
          ghost.style.display = "none";
          var under = document.elementFromPoint(e.clientX, e.clientY);
          ghost.style.display = "";
          var col = under && under.closest ? under.closest(".col") : null;
          $("view").querySelectorAll(".col").forEach(function (c) { c.classList.toggle("drop", c === col); });
        }
        function onUp(e) {
          card.releasePointerCapture(ev.pointerId);
          card.removeEventListener("pointermove", onMove);
          card.removeEventListener("pointerup", onUp);
          card.removeEventListener("pointercancel", onUp);
          if (!moved) { taskDetail(id); return; }
          if (drag && drag.ghost) drag.ghost.remove();
          card.classList.remove("dragging");
          drag.ghost.style.display = "none";
          var under = document.elementFromPoint(e.clientX, e.clientY);
          var col = under && under.closest ? under.closest(".col") : null;
          $("view").querySelectorAll(".col").forEach(function (c) { c.classList.remove("drop"); });
          drag = null;
          if (!col) return render();
          var status = col.getAttribute("data-col");
          var t = task(id);
          if (!t || t.status === status) return render();
          t.status = status;
          t.completedAt = status === "done" ? new Date().toISOString() : null;
          t.sort = Date.now() % 100000;
          render();
          if (status === "done") logAct("completed", t.title);
          if (cloudReady) sb.from("tasks").update({ status: status, completed_at: t.completedAt, sort: t.sort }).eq("id", id).select("id")
            .then(function (r) { wrote(r, "Couldn't move that — are you still signed in?"); });
        }
        card.addEventListener("pointermove", onMove);
        card.addEventListener("pointerup", onUp);
        card.addEventListener("pointercancel", onUp);
      });
    });
  }

  /* ══════════ search ══════════ */
  function searchAll(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    var out = [];
    DB.clients.forEach(function (c) {
      if ((c.name + " " + c.contact + " " + c.services).toLowerCase().indexOf(q) >= 0)
        out.push({ kind: "client", title: c.name, sub: c.services || statusLabel(c.status), go: function () { clientDetail(c.id); } });
    });
    live().forEach(function (t) {
      var c = client(t.clientId);
      if ((t.title + " " + t.notes + " " + (c ? c.name : "")).toLowerCase().indexOf(q) >= 0)
        out.push({ kind: t.kind === "shoot" ? "shoot" : "task", title: t.title, sub: (c ? c.name + " · " : "") + (t.due ? fDate(t.due) : ""), go: function () { taskDetail(t.id); } });
    });
    DB.members.forEach(function (m) {
      if ((m.name + " " + m.full + " " + m.role).toLowerCase().indexOf(q) >= 0)
        out.push({ kind: "person", title: m.full, sub: m.role, go: function () { go("team"); } });
    });
    DB.links.forEach(function (l) {
      if ((l.name + " " + l.desc).toLowerCase().indexOf(q) >= 0)
        out.push({ kind: "link", title: l.name, sub: l.desc, go: function () { window.open(l.url, "_blank", "noopener"); } });
    });
    return out.slice(0, 24);
  }
  function resultsHTML(res) {
    if (!res.length) return "<div class='empty'>Nothing matches that.</div>";
    return res.map(function (r, i) {
      return "<button class='sr-item' data-res='" + i + "'><span class='sr-kind'>" + r.kind + "</span>" +
        "<span class='sr-main'><span class='sr-title'>" + esc(r.title) + "</span>" +
        "<span class='sr-sub'>" + esc(r.sub || "") + "</span></span></button>";
    }).join("");
  }
  var lastRes = [];
  function runSearch(q, host) {
    lastRes = searchAll(q);
    host.innerHTML = resultsHTML(lastRes);
    host.querySelectorAll("[data-res]").forEach(function (b) {
      b.addEventListener("click", function () {
        var r = lastRes[+b.getAttribute("data-res")];
        closeSearch(); if (r) r.go();
      });
    });
  }
  var panel = null;
  function focusSearch() {
    if (window.innerWidth < 900) { openSearch(); return; }
    $("search").focus();
  }
  function openSearch() {
    $("search-overlay").classList.remove("hidden");
    $("search-mobile").value = "";
    $("search-results").innerHTML = "";
    setTimeout(function () { $("search-mobile").focus(); }, 40);
  }
  function closeSearch() {
    $("search-overlay").classList.add("hidden");
    if (panel) { panel.remove(); panel = null; }
  }
  $("search-btn").addEventListener("click", openSearch);
  $("search-close").addEventListener("click", closeSearch);
  $("search-mobile").addEventListener("input", function () { runSearch(this.value, $("search-results")); });
  $("search").addEventListener("input", function () {
    var q = this.value;
    if (!q.trim()) { if (panel) { panel.remove(); panel = null; } return; }
    if (!panel) { panel = el("<div class='search-panel'></div>"); $("search").parentNode.appendChild(panel); }
    runSearch(q, panel);
  });
  $("search").addEventListener("blur", function () { setTimeout(function () { if (panel) { panel.remove(); panel = null; } }, 180); });

  /* ══════════ navigation & delegated events ══════════ */
  function go(v) { view = v; closeSearch(); render(); window.scrollTo(0, 0); }

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target : ev.target.parentElement;
    if (!t || !t.closest) return;
    var hit;
    if ((hit = t.closest("[data-nav]"))) return go(hit.getAttribute("data-nav"));
    if ((hit = t.closest("[data-toggle]"))) { ev.stopPropagation(); return toggleStatus(hit.getAttribute("data-toggle")); }
    if ((hit = t.closest("[data-set]"))) {
      ev.stopPropagation();
      var parts = hit.getAttribute("data-set").split("|");
      return setStatus(parts[1], parts[0]);
    }
    if ((hit = t.closest("[data-open]"))) { ev.stopPropagation(); return taskDetail(hit.getAttribute("data-open")); }
    if ((hit = t.closest("[data-edit]"))) { ev.stopPropagation(); return taskForm(hit.getAttribute("data-edit")); }
    if ((hit = t.closest("[data-client]"))) return clientDetail(hit.getAttribute("data-client"));
    if ((hit = t.closest("[data-editmember]"))) return memberForm(hit.getAttribute("data-editmember"));
    if ((hit = t.closest("[data-editlink]"))) { ev.preventDefault(); ev.stopPropagation(); return linkForm(hit.getAttribute("data-editlink")); }
    if ((hit = t.closest("[data-editoff]"))) return offForm(hit.getAttribute("data-editoff"));
    if ((hit = t.closest("[data-approve]"))) return decideOff(hit.getAttribute("data-approve"), "approved");
    if ((hit = t.closest("[data-deny]"))) return decideOff(hit.getAttribute("data-deny"), "denied");
    if ((hit = t.closest("[data-mine]"))) { mineOnly = hit.getAttribute("data-mine") === "1"; return render(); }
    if ((hit = t.closest("[data-assignto]"))) return taskForm(null, { assigneeId: hit.getAttribute("data-assignto") });
    if (t.closest("[data-newclient]")) return clientForm(null);
    if (t.closest("[data-newmember]")) return memberForm(null);
    if (t.closest("[data-newlink]")) return linkForm(null);
    if (t.closest("[data-newshoot]")) return taskForm(null, { kind: "shoot" });
    if (t.closest("[data-addoff]") || t.closest("[data-reqoff]")) return offForm(null);
    if (t.closest("[data-digest]")) return digest();
    if (t.closest("[data-whopick]")) return whoPicker();
    if ((hit = t.closest("[data-jump]"))) {
      var el2 = $(hit.getAttribute("data-jump"));
      if (el2) el2.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    var inp = ev.target;
    if (!inp || !inp.matches || !inp.matches("[data-quick]")) return;
    var title = inp.value.trim(); if (!title) return;
    inp.value = "";
    var t = { id: uid(), clientId: "", title: title, assigneeId: me.memberId || who,
      due: inp.getAttribute("data-due") || today(), time: "", status: "todo", kind: "task",
      location: "", notes: "", sort: Date.now() % 100000, archived: false };
    upsert("tasks", taskRow(t), t, "tasks");
    logAct("added", title);
    toast("Added ✳");
  });

  function whoPicker() {
    openModal("<h3>Who's looking?</h3><div class='modal-sub'>This only changes what “just me” filters to.</div>" +
      DB.members.map(function (m) {
        return "<button class='sr-item' data-pick='" + esc(m.id) + "'>" + avatar(m, "sm") +
          "<span class='sr-main'><span class='sr-title'>" + esc(m.full) + "</span><span class='sr-sub'>" + esc(m.role) + "</span></span></button>";
      }).join("") +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Close</button></div>");
    $("modal").querySelectorAll("[data-pick]").forEach(function (b) {
      b.addEventListener("click", function () {
        who = b.getAttribute("data-pick");
        localStorage.setItem(LS_WHO, who);
        closeModal(); render();
      });
    });
  }

  $("fab").addEventListener("click", function () { taskForm(null); });
  $("settings-btn").addEventListener("click", settingsModal);
  $("lock-btn").addEventListener("click", function () {
    if (cloudReady) sb.auth.signOut();
    me = { userId: null, memberId: null, role: null };
    toast("Locked — view only");
    render();
  });
  $("owner-btn").addEventListener("click", function () { login(); });

  function login(after) {
    openModal("<h3>Sign in</h3><div class='modal-sub'>Alise signs in here to edit. Employees can sign in too if you've made them an account.</div>" +
      "<label>Email</label><input type='text' id='li-email' value='" + esc(cfg.OWNER_LOGIN_EMAIL || "") + "' autocomplete='username'>" +
      "<label>Password</label><input type='password' id='li-pw' autocomplete='current-password'>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='li-go'>Sign in</button></div>");
    var pw = $("li-pw"); pw.focus();
    function attempt() {
      var email = $("li-email").value.trim(), p = pw.value;
      if (!email || !p) return;
      $("li-go").textContent = "…";
      sb.auth.signInWithPassword({ email: email, password: p }).then(function (r) {
        if (r.error) { $("li-go").textContent = "Sign in"; pw.value = ""; pw.placeholder = "Didn't work — try again"; return; }
        closeModal();
        return resolveRole().then(function () {
          toast(isOwner() ? "Owner mode on ✳" : "Signed in ✳");
          render(); if (after) after();
        });
      });
    }
    $("li-go").addEventListener("click", attempt);
    pw.addEventListener("keydown", function (e) { if (e.key === "Enter") attempt(); });
  }
  function resolveRole() {
    if (!cloudReady) return Promise.resolve();
    return sb.auth.getUser().then(function (r) {
      var u = r.data && r.data.user;
      if (!u) { me = { userId: null, memberId: null, role: null }; return; }
      me.userId = u.id;
      return sb.from("app_users").select("member_id,role").eq("user_id", u.id).maybeSingle().then(function (res) {
        if (res.data) { me.memberId = res.data.member_id; me.role = res.data.role; who = me.memberId || who; }
        else { me.memberId = null; me.role = null; }
      });
    });
  }

  /* ══════════ gate ══════════ */
  function gateOK() { return localStorage.getItem(LS_ACCESS) === "1"; }
  function showGate() {
    $("gate").classList.remove("hidden");
    $("app").classList.add("hidden");
  }
  function hideGate() {
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
  }
  function tryGate() {
    var v = $("gate-input").value.trim().toLowerCase();
    var code = String(DB.settings.accessCode || (window.CCO_SEED && window.CCO_SEED.settings.accessCode) || "goldenhour").toLowerCase();
    if (v === code) { localStorage.setItem(LS_ACCESS, "1"); hideGate(); render(); }
    else $("gate-err").classList.remove("hidden");
  }
  $("gate-btn").addEventListener("click", tryGate);
  $("gate-input").addEventListener("keydown", function (e) { if (e.key === "Enter") tryGate(); });

  /* ══════════ boot ══════════ */
  function boot() {
    if (gateOK()) hideGate(); else showGate();
    Promise.resolve()
      .then(function () { return cloudReady ? resolveRole() : null; })
      .then(loadAll)
      .then(function () {
        loaded = true;
        if (!DB.members.length) seedFromFile();
        if (me.memberId) who = me.memberId;
        if (!view) view = isOwner() ? "today" : "mywork";
        paintConnection();
        render();
        subscribe();
        handleRequestLink();
      });
    // refresh when the tab comes back, in case the socket dropped
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && cloudReady) loadAll().then(render);
    });
  }

  /* legacy ?req= approval links from the old email flow */
  function handleRequestLink() {
    var raw = new URLSearchParams(location.search).get("req");
    if (!raw) return;
    history.replaceState(null, "", location.pathname);
    var d;
    try { d = JSON.parse(decodeURIComponent(escape(atob(raw)))); } catch (e) { return; }
    if (!d || !d.s) return;
    var m = member(d.m);
    openModal("<h3>🌴 Time off request</h3>" +
      "<div class='off-row'>🌴" + avatar(m, "sm") + "<span class='flex'><b>" + esc(m ? m.name : "Someone") +
      "</b> " + fDate(d.s) + (d.e && d.e !== d.s ? " – " + fDate(d.e) : "") +
      (d.r ? " <span style='color:var(--muted)'>· " + esc(d.r) + "</span>" : "") + "</span></div>" +
      "<div class='modal-actions'><button class='btn btn-soft' id='rq-deny'>Deny</button>" +
      "<button class='btn btn-primary' id='rq-ok'>Approve 🌴</button></div>");
    function decide(status) {
      if (!isOwner()) { closeModal(); return login(function () { handleReq(status); }); }
      handleReq(status);
    }
    function handleReq(status) {
      closeModal();
      var row = { member_id: d.m, start_day: d.s, end_day: d.e || d.s, reason: d.r || "", status: status };
      if (!cloudReady) return;
      sb.from("timeoff").insert(row).then(function (r) {
        if (r.error) return fail();
        toast(status === "approved" ? "Approved 🌴" : "Denied");
        refreshOff();
      });
    }
    $("rq-ok").addEventListener("click", function () { decide("approved"); });
    $("rq-deny").addEventListener("click", function () { decide("denied"); });
  }

  boot();
})();
