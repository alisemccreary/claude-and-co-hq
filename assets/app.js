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
  var DB = { members: [], clients: [], tasks: [], links: [], timeoff: [], comments: [], activity: [], settings: {},
             hours: [], staff: [], time: [], logins: [] };  // hours/staff/time are private: the server only sends what you may see
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
  function fPlain(s) {
    var d = pDate(s); return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
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

  function toast(msg, bad, action) {
    var t = el('<div class="toast' + (bad ? " bad" : "") + '"><span>' + esc(msg) + "</span>" +
      (action ? '<button class="toast-act">' + esc(action.label) + "</button>" : "") + "</div>");
    $("toast-host").appendChild(t);
    var life = action ? 8000 : 2600;
    var t1 = setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, life);
    var t2 = setTimeout(function () { t.remove(); }, life + 400);
    if (action) t.querySelector(".toast-act").addEventListener("click", function () {
      clearTimeout(t1); clearTimeout(t2); t.remove(); action.run();
    });
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
    plus:    '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    pay:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M14.4 9.6c-.5-.9-1.4-1.4-2.5-1.4-1.4 0-2.5.8-2.5 1.9 0 2.5 5.1 1.4 5.1 4 0 1.1-1.1 1.9-2.6 1.9-1.1 0-2.1-.5-2.6-1.3M12 6.7v10.6"/></svg>'
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
    { id: "pay",     label: "Payroll",  icon: "pay" },
    { id: "sched",   label: "Schedule", icon: "sched" },
    { id: "links",   label: "Links",    icon: "links" }
  ];
  var NAV_TEAM = [
    { id: "mywork",  label: "My work",  icon: "today" },
    { id: "team",    label: "The team", icon: "team" },
    { id: "pay",     label: "My hours", icon: "pay" },
    { id: "sched",   label: "Schedule", icon: "sched" },
    { id: "links",   label: "Links",    icon: "links" }
  ];
  function nav() { return isOwner() ? NAV_OWNER : NAV_TEAM; }
  var TITLES = { today: "Today", mywork: "My work", board: "Board", clients: "Clients", team: "The team",
                 pay: "Payroll", sched: "Schedule", links: "Studio links" };
  // Who the viewer is acting as: their login if they have one, else the picker.
  function viewerId() { return me.memberId || who; }

  /* ══════════ row mappers ══════════ */
  function mMember(r) { return { id: r.id, name: r.name, full: r.full_name || r.name, role: r.role || "", color: r.color || "#c4667c", email: r.email || "", info: r.info || "", isOwner: !!r.is_owner, sort: r.sort || 0, notify: r.notify || {}, shared: r.shared || {} }; }
  function mClient(r) { return { id: r.id, name: r.name, status: r.status || "active", contact: r.contact || "", email: r.email || "", phone: r.phone || "", services: r.services || "", loomly: r.loomly || "", team: Array.isArray(r.team) ? r.team : [], notes: r.notes || "", sort: r.sort || 0 }; }
  function mTask(r) { return { id: r.id, clientId: r.client_id || "", title: r.title, assigneeId: r.assignee_id || "", due: r.due || "", time: r.time_of_day || "", status: r.status || "todo", kind: r.kind || "task", location: r.location || "", notes: r.notes || "", sort: r.sort || 0, archived: !!r.archived, completedAt: r.completed_at }; }
  function mLink(r) { return { id: r.id, name: r.name, emoji: r.emoji || "🔗", desc: r.descr || "", url: r.url || "", sort: r.sort || 0 }; }
  function mOff(r) { return { id: r.id, memberId: r.member_id, start: r.start_day, end: r.end_day, reason: r.reason || "", status: r.status || "requested" }; }
  function mCmt(r) { return { id: r.id, taskId: r.task_id, memberId: r.member_id, body: r.body, at: r.created_at }; }
  function mHours(r) { return { taskId: r.task_id, assigneeId: r.assignee_id || "", hours: Number(r.hours) || 0 }; }
  function mTime(r) {
    return { id: r.id, memberId: r.member_id, date: r.work_date, hours: Number(r.hours) || 0,
      note: r.note || "", taskId: r.task_id || "", status: r.status || "draft" };
  }
  function timeRow(t) {
    return { id: t.id, member_id: t.memberId, work_date: t.date, hours: t.hours,
      note: t.note || "", task_id: t.taskId || null, status: t.status || "draft",
      updated_at: new Date().toISOString() };
  }
  function mStaff(r) {
    return { memberId: r.member_id, rate: Number(r.hourly_rate) || 0, payType: r.pay_type || "hourly",
      phone: r.phone || "", address: r.address || "", emName: r.emergency_name || "", emPhone: r.emergency_phone || "",
      startDate: r.start_date || "", birthday: r.birthday || "", notes: r.notes || "",
      title: r.title || "", weeklyHours: Number(r.weekly_hours) || 0, share: r.share || {},
      payFreq: r.pay_frequency || "biweekly", empType: r.employment_type || "employee" };
  }
  function staffRow(x) {
    return { member_id: x.memberId, hourly_rate: x.rate || 0, pay_type: x.payType || "hourly",
      phone: x.phone || "", address: x.address || "", emergency_name: x.emName || "", emergency_phone: x.emPhone || "",
      start_date: x.startDate || null, birthday: x.birthday || null, notes: x.notes || "",
      title: x.title || "", weekly_hours: x.weeklyHours || 0, share: x.share || {},
      pay_frequency: x.payFreq || "biweekly", employment_type: x.empType || "employee",
      updated_at: new Date().toISOString() };
  }
  function hoursFor(id) { for (var i = 0; i < DB.hours.length; i++) if (DB.hours[i].taskId === id) return DB.hours[i].hours; return null; }
  function staffFor(id) { for (var i = 0; i < DB.staff.length; i++) if (DB.staff[i].memberId === id) return DB.staff[i]; return null; }
  function rateFor(id) { var x = staffFor(id); return x ? x.rate : null; }
  var PAY_FREQ = { weekly: "Every week", biweekly: "Every 2 weeks", semimonthly: "Twice a month", monthly: "Monthly" };
  var EMP_TYPE = { employee: "Employee", contractor: "Contractor", intern: "Intern" };
  function money(n) { return "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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
      email: m.email, info: m.info, is_owner: !!m.isOwner, sort: m.sort || 0, notify: m.notify || {}, shared: m.shared || {} };
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
      sb.from("settings").select("data").eq("id", 1).maybeSingle(),
      sb.from("task_hours").select("*"),
      sb.from("staff_private").select("*"),
      sb.from("time_entries").select("*").order("work_date", { ascending: false }),
      sb.from("app_users").select("member_id,role")
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
      // These two come back empty unless the viewer is allowed to see them.
      DB.hours = (r[8] && !r[8].error && r[8].data ? r[8].data : []).map(mHours);
      DB.staff = (r[9] && !r[9].error && r[9].data ? r[9].data : []).map(mStaff);
      DB.time  = (r[10] && !r[10].error && r[10].data ? r[10].data : []).map(mTime);
      DB.logins = (r[11] && !r[11].error && r[11].data ? r[11].data : []);
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
  function saveHours(taskId, assigneeId, hours) {
    var found = false;
    for (var i = 0; i < DB.hours.length; i++) if (DB.hours[i].taskId === taskId) { DB.hours[i] = { taskId: taskId, assigneeId: assigneeId, hours: hours }; found = true; }
    if (!found) DB.hours.push({ taskId: taskId, assigneeId: assigneeId, hours: hours });
    scheduleRender();
    if (!cloudReady) return Promise.resolve();
    return sb.from("task_hours").upsert({ task_id: taskId, assignee_id: assigneeId, hours: hours, updated_at: new Date().toISOString() })
      .select("task_id").then(function (r) { if (r.error) fail("Couldn't save the hours"); });
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
    return '<span class="avatar ' + (cls || "") + '" role="img" aria-label="' + esc(m.full) + '" title="' + esc(m.full) + '" style="background:' + esc(m.color) + '">' + esc(m.name.slice(0, 2).toUpperCase()) + "</span>";
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
    var hh = hoursFor(t.id);
    if (hh) meta.push('<span class="tc-hrs">⏱ ' + hh + " hr" + (hh === 1 ? "" : "s") + "</span>");

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
    var navItem = nav().filter(function (n) { return n.id === view; })[0];
    $("topbar-title").textContent = navItem ? navItem.label : (TITLES[view] || "");
    $("fab").classList.toggle("hidden", !isOwner() || view === "links");
    paintNav(); paintOwnerBar(); paintWho();
    var v = $("view");
    if (view === "mywork") v.innerHTML = viewMyWork();
    else if (view === "today") v.innerHTML = viewToday();
    else if (view === "board") v.innerHTML = viewBoard();
    else if (view === "clients") v.innerHTML = viewClients();
    else if (view === "team") v.innerHTML = viewTeam();
    else if (view === "sched") v.innerHTML = viewSched();
    else if (view === "pay") v.innerHTML = viewPay();
    else if (view === "links") v.innerHTML = viewLinks();
    if (view === "board") wireDrag();
    if (view === "pay") {
      wireSeg("pay-tabs", function (v) { payTab = v; render(); });
      wireSeg("pay-seg", function (v) { payPeriod = v; render(); });
      $("view").querySelectorAll("[data-week]").forEach(function (b) {
        b.addEventListener("click", function () {
          var d = b.getAttribute("data-week");
          weekOffset = d === "0" ? 0 : weekOffset + parseInt(d, 10);
          render();
        });
      });
      $("view").querySelectorAll("[data-log]").forEach(function (inp) {
        inp.addEventListener("change", function () {
          var parts = inp.getAttribute("data-log").split("|");
          var v = parseFloat(inp.value);
          if (isNaN(v) || v < 0) v = 0;
          if (v > 24) { v = 24; inp.value = 24; }
          logHours(parts[0], parts[1], v);
        });
        inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") inp.blur(); });
      });
      $("view").querySelectorAll("[data-approve-week]").forEach(function (b) {
        b.addEventListener("click", function () { setWeekStatus(b.getAttribute("data-approve-week"), "approved"); });
      });
      var ex = $("view").querySelector("[data-export]");
      if (ex) ex.addEventListener("click", exportTimesheet);
      var sub = $("view").querySelector("[data-submit-week]");
      if (sub) sub.addEventListener("click", function () { setWeekStatus(viewerId(), "submitted"); });
    }
  }

  function viewToday() {
    var m = member(who) || member(me.memberId), td = today();
    var pool = mineOnly ? live().filter(function (t) { return t.assigneeId === who; }) : live();
    var over = sortT(pool.filter(isOverdue));
    var due = sortT(pool.filter(function (t) { return t.due === td && t.status !== "done"; }));
    var prog = pool.filter(function (t) { return t.status === "inprogress"; });
    var shoots = sortT(pool.filter(function (t) { return t.kind === "shoot" && t.status !== "done" && t.due >= td && t.due <= addDays(7); }));
    var pending = DB.timeoff.filter(function (e) { return e.status === "requested"; });
    var offNow = DB.timeoff.filter(function (e) { return e.status === "approved" && e.start <= td && e.end >= td; });
    var celebrate = [];
    DB.members.forEach(function (mm) {
      var pv = staffFor(mm.id);
      var bday = (pv && pv.birthday) || sharedVal(mm, "birthday");
      var start = (pv && pv.startDate) || sharedVal(mm, "startDate");
      function sameDay(iso) {
        if (!iso) return false;
        var d = pDate(iso), n = new Date();
        return d && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
      }
      if (sameDay(bday)) celebrate.push({ m: mm, what: "🎂 birthday today" });
      if (sameDay(start) && pDate(start).getFullYear() < new Date().getFullYear()) {
        var yrs = new Date().getFullYear() - pDate(start).getFullYear();
        celebrate.push({ m: mm, what: "🎉 " + yrs + " year" + (yrs === 1 ? "" : "s") + " with the studio" });
      }
    });
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

    if (celebrate.length) {
      h += celebrate.map(function (c) {
        return '<div class="banner good">' + avatar(c.m, "sm") + " <b>" + esc(c.m.name) + "</b> — " + c.what + "</div>";
      }).join("");
    }
    if (offNow.length) {
      h += '<div class="banner">🌴 Out today: <b>' + offNow.map(function (e) {
        var mm = member(e.memberId); return esc(mm ? mm.name : "?");
      }).join(", ") + "</b></div>";
    }
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
      h += '<div class="empty"><span class="big">🌿</span><b>A clear day</b><span>Nothing is due today' + (mineOnly ? " for you" : "") + ". Anything due today lands here.</span></div>";
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
      if (!items.length) h += '<div class="empty" style="padding:16px 10px;margin:0">Nothing in this column</div>';
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

  /* Fields the owner may choose to share with the rest of the team.
     Anything not listed here is never shared: pay, address, emergency
     contact and private notes stay owner-only, by design. */
  var SHAREABLE = [
    { k: "title",     label: "Job title" },
    { k: "bio",       label: "About / bio" },
    { k: "email",     label: "Email" },
    { k: "phone",     label: "Phone" },
    { k: "startDate", label: "Start date" },
    { k: "birthday",  label: "Birthday" }
  ];
  function loginState(m) {
    var has = DB.logins.filter(function (u) { return u.member_id === m.id; }).length > 0;
    if (has) return { key: "active", label: "Has a login", why: "They can sign in and update their own work." };
    if (!m.email) return { key: "noemail", label: "Add an email first", why: "A login needs an email address on their profile." };
    return { key: "none", label: "No login yet", why: "They can read the studio but can't tick off their own tasks." };
  }
  function profileCompleteness(m) {
    var x = staffFor(m.id) || {};
    var checks = [!!m.full, !!m.email, !!x.title, !!x.phone, !!x.startDate, !!x.rate, !!x.emName];
    var done = checks.filter(Boolean).length;
    return { done: done, total: checks.length, pct: Math.round(done / checks.length * 100) };
  }
  function sharedVal(m, key) {
    var sh = m.shared || {};
    return sh[key] == null || sh[key] === "" ? null : sh[key];
  }
  // What the current viewer is allowed to see about someone.
  function visibleInfo(m) {
    var self = m.id === viewerId();
    var priv = staffFor(m.id);
    var out = [];
    function add(label, val) { if (val) out.push({ label: label, val: val }); }
    if (isOwner() || self) {
      add("Title", (priv && priv.title) || "");
      add("Email", m.email);
      add("Phone", priv && priv.phone);
      add("Started", priv && priv.startDate ? fDate(priv.startDate) : "");
      add("Birthday", priv && priv.birthday ? fDate(priv.birthday) : "");
    } else {
      add("Title", sharedVal(m, "title"));
      add("Email", sharedVal(m, "email"));
      add("Phone", sharedVal(m, "phone"));
      add("Started", sharedVal(m, "startDate") ? fDate(sharedVal(m, "startDate")) : null);
      var b = sharedVal(m, "birthday");
      add("Birthday", b ? new Date(2000, +b.slice(0, 2) - 1, +b.slice(3)).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null);
    }
    return out;
  }
  function visibleBio(m) {
    var self = m.id === viewerId();
    if (isOwner() || self) return m.info || "";
    return sharedVal(m, "bio") || "";
  }

  function viewTeam() {
    var td = today();
    var upcoming = DB.timeoff.filter(function (e) { return e.end >= td; })
      .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });

    var h = '<div class="page-head"><h2>The team</h2><div class="page-sub">' +
      DB.members.length + " people" + (isOwner() ? " · tap anyone to open their profile" : "") + "</div></div>";
    if (isOwner()) h += '<div class="section-actions" style="margin-bottom:16px">' +
      '<button class="btn btn-dark btn-sm" data-newmember>' + ICON.plus + " Add employee</button></div>";

    h += '<div class="people">' + DB.members.map(function (m) {
      var priv = staffFor(m.id);
      var self = m.id === viewerId();
      var title = (isOwner() || self) ? (priv && priv.title) || m.role : (sharedVal(m, "title") || m.role);
      var open = live().filter(function (t) { return t.assigneeId === m.id && t.status !== "done"; }).length;
      var help = live().filter(function (t) { return t.assigneeId === m.id && t.status === "needhelp"; }).length;
      var off = upcoming.filter(function (e) { return e.memberId === m.id && e.status === "approved" && e.start <= td && e.end >= td; }).length;
      return '<div class="person click" data-person="' + esc(m.id) + '">' +
        '<div class="person-top">' + avatar(m, "lg") +
        '<div class="person-id"><h3>' + esc(m.full) + (self ? ' <span class="pill active">you</span>' : "") + "</h3>" +
        '<div class="person-role">' + esc(title || "—") + "</div></div></div>" +
        (m.email ? '<div class="person-line">✉ ' + esc(m.email) + "</div>" : "") +
        '<div class="person-tags">' +
          (isOwner() ? '<span class="pill login-' + loginState(m).key + '">' + loginState(m).label + "</span>" : "") +
          (off ? '<span class="pill approved">🌴 off today</span>' : "") +
          (help ? '<span class="pill needhelp">' + help + " need help</span>" : "") +
          '<span class="pill todo">' + open + " open</span>" +
        "</div></div>";
    }).join("") + "</div>";

    h += '<div class="section"><h3>Time off</h3><div class="section-actions">' +
      (isOwner() ? '<button class="btn btn-dark btn-sm" data-addoff>' + ICON.plus + " Add</button>"
                 : '<button class="btn btn-dark btn-sm" data-reqoff>🌴 Request time off</button>') + "</div></div>";
    h += upcoming.length ? upcoming.map(offHTML).join("") : '<div class="empty"><b>Full house</b><span>Nobody is booked off. Approved time off shows up here.</span></div>';

    if (DB.activity.length) {
      h += '<div class="section"><h3>Recent activity</h3></div><div class="card">';
      h += DB.activity.slice(0, 10).map(function (a) {
        var am = member(a.actorId);
        return '<div class="feed-item">' + avatar(am, "sm") +
          '<div style="flex:1;min-width:0"><div>' + esc(am ? am.name : "Someone") + " " + esc(a.verb) + " <b>" + esc(a.subject) + "</b></div>" +
          '<div class="feed-when">' + ago(a.at) + "</div></div></div>";
      }).join("") + "</div>";
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
    if (!keys.length) h += '<div class="empty"><span class="big">🗓</span><b>Plan the week ahead</b><span>Shoots, deadlines and approved time off appear here.</span></div>';
    keys.forEach(function (d) {
      h += '<div class="day"><div class="day-head"><b>' + fDow(d) + "</b><span>" + fDate(d) + "</span>" +
        (d === td ? '<span class="today-tag">today</span>' : "") + "</div>" +
        days[d].o.map(offHTML).join("") + days[d].t.map(function (t) { return taskHTML(t); }).join("") + "</div>";
    });
    return h;
  }

  var payPeriod = "week";
  function periodRange() {
    var t = new Date(), start;
    if (payPeriod === "week") { var d = t.getDay(); start = addDays(-((d + 6) % 7)); }
    else if (payPeriod === "lastweek") { var d2 = t.getDay(); return { from: addDays(-((d2 + 6) % 7) - 7), to: addDays(-((d2 + 6) % 7) - 1) }; }
    else if (payPeriod === "month") { start = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-01"; }
    else return { from: "0000-01-01", to: "9999-12-31" };
    return { from: start, to: addDays(365) };
  }
  function payRows() {
    var r = periodRange();
    return DB.members.map(function (m) {
      var mine = live().filter(function (t) {
        return t.assigneeId === m.id && t.due && t.due >= r.from && t.due <= r.to;
      });
      var planned = 0, doneH = 0;
      mine.forEach(function (t) {
        var h = hoursFor(t.id);
        if (h == null) return;
        planned += h;
        if (t.status === "done") doneH += h;
      });
      var rate = rateFor(m.id);
      return { m: m, tasks: mine.length, planned: planned, done: doneH, rate: rate,
        earned: rate == null ? null : doneH * rate, projected: rate == null ? null : planned * rate };
    });
  }
  var payTab = "summary";
  function weekStart(offset) {
    var t = new Date(); var d = t.getDay();
    var mondayBack = (d + 6) % 7;
    return addDays(-mondayBack + (offset || 0) * 7);
  }
  var weekOffset = 0;
  function weekDays() {
    var start = weekStart(weekOffset), out = [];
    var sd = pDate(start);
    for (var i = 0; i < 7; i++) {
      var d = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + i);
      out.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
    }
    return out;
  }
  function entryFor(mid, day) {
    for (var i = 0; i < DB.time.length; i++) if (DB.time[i].memberId === mid && DB.time[i].date === day) return DB.time[i];
    return null;
  }
  function logHours(mid, day, hours, status) {
    var ex = entryFor(mid, day);
    if (ex) {
      if (hours === 0) { removeRow("time_entries", ex.id, "time"); return; }
      ex.hours = hours; if (status) ex.status = status;
      scheduleRender();
      if (cloudReady) sb.from("time_entries").update({ hours: hours, status: ex.status, updated_at: new Date().toISOString() })
        .eq("id", ex.id).select("id").then(function (r) { wrote(r, "Couldn't save those hours"); });
      return;
    }
    if (!hours) return;
    var row = { member_id: mid, work_date: day, hours: hours, status: status || "draft" };
    if (!cloudReady) { DB.time.push({ id: uid(), memberId: mid, date: day, hours: hours, note: "", status: "draft" }); scheduleRender(); return; }
    sb.from("time_entries").insert(row).select("*").then(function (r) {
      if (r.error || !r.data || !r.data.length) return fail("Couldn't save those hours");
      DB.time.push(mTime(r.data[0])); scheduleRender();
    });
  }
  function setWeekStatus(mid, status) {
    var days = weekDays();
    var mine = DB.time.filter(function (e) { return e.memberId === mid && days.indexOf(e.date) >= 0; });
    if (!mine.length) return toast("No hours logged that week", true);
    if (!cloudReady) { mine.forEach(function (e) { e.status = status; }); scheduleRender(); return; }
    // Deliberately NOT optimistic: a pay-affecting approval must not look
    // successful before the server has actually accepted it.
    Promise.all(mine.map(function (e) {
      return sb.from("time_entries").update({ status: status }).eq("id", e.id).select("id");
    })).then(function (res) {
      var bad = res.filter(function (r) { return r.error || !r.data || !r.data.length; }).length;
      if (bad) { fail("Couldn't update the timesheet — try signing in again"); loadAll().then(render); return; }
      mine.forEach(function (e) { e.status = status; });
      scheduleRender();
      var mm = member(mid);
      toast(status === "approved" ? "Approved " + (mm ? mm.name : "") + "'s week" : "Sent to Alise for approval");
    });
  }

  function exportTimesheet() {
    var days = weekDays();
    var head = ["Person", "Rate"].concat(days.map(function (d) { return fPlain(d); })).concat(["Total hours", "Gross pay", "Status"]);
    var lines = [head.join(",")];
    DB.members.forEach(function (m) {
      var priv = staffFor(m.id), rate = priv ? priv.rate : 0, total = 0, st = "";
      var cells = days.map(function (d) {
        var e = entryFor(m.id, d);
        if (e) { total += e.hours; if (e.status === "approved") st = "approved"; else if (!st) st = e.status; }
        return e ? e.hours : "";
      });
      lines.push(['"' + m.full.replace(/"/g, '""') + '"', rate || ""].concat(cells)
        .concat([Math.round(total * 10) / 10, rate ? (Math.round(total * rate * 100) / 100) : "", st]).join(","));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "timesheet-" + days[0] + ".csv";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast("Timesheet downloaded — hand it straight to payroll");
  }

  function viewTimesheet() {
    var owner = isOwner();
    var days = weekDays();
    var people = owner ? DB.members : DB.members.filter(function (m) { return m.id === viewerId(); });
    var label = fPlain(days[0]) + " – " + fPlain(days[6]);

    var h = '<div class="ts-bar">' +
      '<button class="btn btn-soft btn-sm" data-week="-1">‹ Prev</button>' +
      '<b>' + label + (weekOffset === 0 ? " · this week" : "") + "</b>" +
      '<button class="btn btn-soft btn-sm" data-week="1">Next ›</button>' +
      (weekOffset !== 0 ? '<button class="btn btn-ghost btn-sm" data-week="0">Today</button>' : "") +
      (owner ? '<button class="btn btn-soft btn-sm" data-export style="margin-left:auto">⬇ Export CSV</button>' : "") +
      "</div>";

    h += '<div class="tswrap"><div class="ts">';
    h += '<div class="ts-row ts-head"><span class="ts-name">Person</span>' +
      days.map(function (d) {
        var dd = pDate(d);
        return '<span class="' + (d === today() ? "is-today" : "") + '">' +
          dd.toLocaleDateString("en-US", { weekday: "short" }) + "<i>" + dd.getDate() + "</i></span>";
      }).join("") + "<span>Total</span></div>";

    people.forEach(function (m) {
      var rowTotal = 0, statuses = {};
      var cells = days.map(function (d) {
        var e = entryFor(m.id, d);
        var v = e ? e.hours : 0;
        rowTotal += v;
        if (e) statuses[e.status] = true;
        var locked = e && e.status === "approved" && !owner;
        return '<span class="ts-cell' + (v ? " has" : "") + (d === today() ? " is-today" : "") + '">' +
          '<input type="text" inputmode="decimal" value="' + (v || "") + '" placeholder="–" ' +
          'data-log="' + esc(m.id) + "|" + d + '"' + (locked ? " disabled" : "") + "></span>";
      }).join("");
      var state = statuses.approved ? "approved" : statuses.submitted ? "submitted" : rowTotal ? "draft" : "";
      h += '<div class="ts-row"><span class="ts-name">' + avatar(m, "sm") +
        '<span class="ts-who"><b>' + esc(m.name) + "</b>" +
        (state ? '<em class="ts-state s-' + state + '">' + state + "</em>" : "") + "</span>" +
        "</span>" + cells + '<span class="ts-total">' + (Math.round(rowTotal * 10) / 10 || "0") + "</span></div>";
    });
    h += "</div></div>";

    if (owner) {
      h += '<div class="section"><h3>Approve</h3></div><div class="approve-row">' +
        DB.members.map(function (m) {
          return '<button class="btn btn-soft btn-sm" data-approve-week="' + esc(m.id) + '">Approve ' + esc(m.name) + "'s week</button>";
        }).join("") + "</div>";
      h += '<div class="hint">Type hours straight into the grid — it saves as you go. Approving locks that week for them.</div>';
    } else {
      h += '<div class="approve-row"><button class="btn btn-primary btn-sm" data-submit-week>Send this week to Alise</button></div>' +
        '<div class="hint">Log what you actually worked. Once Alise approves a week it locks.</div>';
    }
    return h;
  }

  function viewPay() {
    var owner = isOwner();
    var rows = payRows().filter(function (r) { return owner || r.m.id === viewerId(); });
    var h = '<div class="page-head"><h2>' + (owner ? "Payroll" : "My hours") + "</h2>" +
      '<div class="page-sub">' + (owner ? "Hours and labour cost. Only you can see this page's numbers — the database refuses them to anyone else."
                                        : "Your hours and pay. Teammates can't see these.") + "</div></div>";

    h += '<div class="seg" style="margin-bottom:16px;max-width:330px" id="pay-tabs">' +
      '<button data-v="summary" class="' + (payTab === "summary" ? "on" : "") + '">Summary</button>' +
      '<button data-v="sheet" class="' + (payTab === "sheet" ? "on" : "") + '">Timesheet</button></div>';
    if (payTab === "sheet") return h + viewTimesheet();

    h += '<div class="seg" style="margin-bottom:18px;max-width:460px" id="pay-seg">' +
      [["week", "This week"], ["lastweek", "Last week"], ["month", "This month"], ["all", "All time"]].map(function (o) {
        return '<button data-v="' + o[0] + '" class="' + (payPeriod === o[0] ? "on" : "") + '">' + o[1] + "</button>";
      }).join("") + "</div>";

    if (!me.role) {
      return h + '<div class="banner warn">🔒 Sign in to see hours and pay. They are never sent to a browser that isn\'t signed in.</div>';
    }

    var totalH = 0, totalDone = 0, totalCost = 0, totalProj = 0, anyRate = false;
    rows.forEach(function (r) {
      totalH += r.planned; totalDone += r.done;
      if (r.earned != null) { totalCost += r.earned; totalProj += r.projected; anyRate = true; }
    });

    h += '<div class="stats">' +
      '<div class="stat"><div class="n">' + (Math.round(totalH * 10) / 10) + '</div><div class="l">Hours scheduled</div></div>' +
      '<div class="stat good"><div class="n">' + (Math.round(totalDone * 10) / 10) + '</div><div class="l">Hours completed</div></div>' +
      (anyRate ? '<div class="stat warm"><div class="n">' + money(totalProj) + '</div><div class="l">' + (owner ? "Projected cost" : "Projected pay") + '</div></div>' : "") +
      (anyRate ? '<div class="stat good"><div class="n">' + money(totalCost) + '</div><div class="l">' + (owner ? "Earned so far" : "Earned so far") + '</div></div>'
               : '<div class="stat"><div class="n">' + rows.reduce(function (a, r) { return a + r.tasks; }, 0) + '</div><div class="l">Tasks in period</div></div>') + "</div>";

    h += '<div class="section"><h3>' + (owner ? "By person" : "You") + "</h3></div>";
    h += '<div class="paytable">' +
      '<div class="payhead"><span>Person</span><span>Tasks</span><span>Hours</span><span>Done</span><span>Rate</span><span>' + (owner ? "Projected" : "Pay") + "</span></div>" +
      rows.map(function (r) {
        return '<div class="payrow"' + (owner ? ' data-hr="' + esc(r.m.id) + '"' : "") + ">" +
          '<span class="payname">' + avatar(r.m, "sm") + esc(r.m.name) + "</span>" +
          "<span>" + r.tasks + "</span>" +
          "<span>" + (Math.round(r.planned * 10) / 10) + "</span>" +
          "<span>" + (Math.round(r.done * 10) / 10) + "</span>" +
          "<span>" + (r.rate == null ? '<i class="dim">not set</i>' : money(r.rate) + "/hr" +
            (staffFor(r.m.id) ? '<br><i class="dim">' + esc(PAY_FREQ[staffFor(r.m.id).payFreq || "biweekly"]) + "</i>" : "")) + "</span>" +
          "<span><b>" + (r.projected == null ? "—" : money(r.projected)) + "</b>" +
          (r.earned ? '<br><i class="dim">' + money(r.earned) + " earned</i>" : "") + "</span></div>";
      }).join("") + "</div>";
    if (owner) h += '<div class="hint">Tap a row to open that person\'s HR file. Hours come from the amount you set on each task; “done” counts only finished ones.</div>';
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
    $("nav-items").innerHTML = nav().map(function (n, i) {
      var badge = "";
      if (n.id === "today" && (over + needHelp)) badge = '<span class="nav-badge">' + (over + needHelp) + "</span>";
      if (n.id === "mywork") {
        var mineOpen = live().filter(function (t) { return t.assigneeId === viewerId() && t.status !== "done"; }).length;
        if (mineOpen) badge = '<span class="nav-badge">' + mineOpen + "</span>";
      }
      if (n.id === "team" && pending && isOwner()) badge = '<span class="nav-badge">' + pending + "</span>";
      return '<button class="nav-item' + (view === n.id ? " on" : "") + (i >= 4 ? " secondary" : "") +
        '" data-nav="' + n.id + '">' + ICON[n.icon] + "<span>" + n.label + "</span>" + badge + "</button>";
    }).join("") +
    (nav().length > 4 ? '<button class="nav-item nav-more" data-more><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg><span>More</span></button>' : "");
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
      $("owner-bar-label").textContent = "Signed in as " + ((member(me.memberId) || {}).name || "team") +
        (DB.settings.employeesCanCheck !== false
          ? " — you can update your own tasks."
          : " — view only, Alise has locked task updates.");
      $("settings-btn").classList.add("hidden");
    } else if (on) {
      $("owner-bar-label").textContent = window.innerWidth < 700
        ? "Owner mode — saves live" : "Owner mode — changes save live for the team.";
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
      (isOwner() ? "<label>6 · How many hours should this take?</label>" +
        "<input type='text' id='f-hours' inputmode='decimal' value='" + esc(hoursFor(t.id) == null ? "" : hoursFor(t.id)) + "' placeholder='e.g. 2.5'>" +
        "<div class='hint'>Feeds payroll. Only you and the person it's assigned to can see it.</div>" : "") +
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
      var hrsEl = $("f-hours");
      var hrs = hrsEl ? parseFloat(hrsEl.value) : NaN;
      closeModal();
      upsert("tasks", taskRow(t), t, "tasks");
      if (hrsEl) saveHours(t.id, t.assigneeId, isNaN(hrs) ? 0 : hrs);
      logAct(isNew ? "assigned" : "updated", t.title);
      var am = member(t.assigneeId);
      toast(isNew ? "Assigned to " + (am ? am.name : "the team") + " ✳" : "Saved ✳");
    });
    if (!isNew) $("f-del").addEventListener("click", function () {
      var snap = JSON.parse(JSON.stringify(task(t.id) || t));
      closeModal();
      removeRow("tasks", t.id, "tasks");
      logAct("deleted", snap.title);
      toast("Deleted \u201C" + snap.title + "\u201D", false, {
        label: "Undo",
        run: function () { upsert("tasks", taskRow(snap), snap, "tasks"); toast("Task restored"); }
      });
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

  /* ── Person profile. Owner sees and edits everything; a teammate sees
     only what the owner ticked "share with team"; you always see yourself. ── */
  function personProfile(id) {
    var m = member(id); if (!m) return;
    var self = id === viewerId();
    var priv = staffFor(id);
    var info = visibleInfo(m), bio = visibleBio(m);
    var open = sortT(live().filter(function (t) { return t.assigneeId === id && t.status !== "done"; }));

    var h = "<div class='prof-head'>" + avatar(m, "lg") +
      "<div><h3>" + esc(m.full) + "</h3><div class='modal-sub' style='margin:0'>" +
      esc((isOwner() || self ? (priv && priv.title) || m.role : sharedVal(m, "title") || m.role) || "—") + "</div></div></div>";

    if (bio) h += "<div class='note'>" + esc(bio) + "</div>";
    if (info.length) {
      h += "<label>Details</label><div class='deets'>" + info.map(function (d) {
        return "<div class='deet'><span>" + esc(d.label) + "</span><b>" + esc(d.val) + "</b></div>";
      }).join("") + "</div>";
    } else {
      h += "<div class='hint'>No contact details shared.</div>";
    }

    if (isOwner()) {
      var comp = profileCompleteness(m), ls = loginState(m);
      h += "<label>Profile</label>" +
        '<div class="prog-card" style="margin-bottom:8px"><div class="prog-top">' +
        '<span class="prog-name">' + comp.done + " of " + comp.total + " details filled in</span>" +
        '<span class="prog-pct' + (comp.pct === 100 ? " full" : "") + '">' + comp.pct + "%</span></div>" +
        '<div class="bar"><div class="bar-fill' + (comp.pct === 100 ? " full" : "") + '" style="width:' + comp.pct + '%"></div></div></div>' +
        '<div class="login-note login-' + ls.key + '"><b>' + esc(ls.label) + "</b> " + esc(ls.why) +
        (ls.key !== "active" ? ' <button class="linkish" id="p-login">Set one up</button>' : "") + "</div>";
    }
    if (isOwner() || self) {
      var r = payRows().filter(function (q) { return q.m.id === id; })[0];
      var logged = DB.time.filter(function (e) { return e.memberId === id; })
        .reduce(function (a, e) { return a + e.hours; }, 0);
      h += "<label>🔒 " + (self && !isOwner() ? "Your pay" : "Pay & hours") + "</label>" +
        "<div class='deets'>" +
        "<div class='deet'><span>" + (priv && priv.payType === "salary" ? "Salary" : "Rate") + "</span><b>" +
          (priv && priv.rate ? money(priv.rate) + (priv.payType === "salary" ? "/yr" : "/hr") : "not set") + "</b></div>" +
        "<div class='deet'><span>Paid</span><b>" + esc(PAY_FREQ[(priv && priv.payFreq) || "biweekly"]) + "</b></div>" +
        "<div class='deet'><span>Type</span><b>" + esc(EMP_TYPE[(priv && priv.empType) || "employee"]) + "</b></div>" +
        "<div class='deet'><span>Hours logged</span><b>" + (Math.round(logged * 10) / 10) + "</b></div>" +
        (r ? "<div class='deet'><span>Scheduled (period)</span><b>" + (Math.round(r.planned * 10) / 10) + "</b></div>" : "") +
        (r && r.projected != null ? "<div class='deet'><span>Projected</span><b>" + money(r.projected) + "</b></div>" : "") +
        "</div>";
    }

    h += "<label>Open work (" + open.length + ")</label>";
    h += open.length ? open.slice(0, 6).map(function (t) { return taskHTML(t, { hideWho: true, flat: true }); }).join("")
                     : "<div class='hint'>Nothing open.</div>";

    h += "<div class='modal-actions'>" +
      (isOwner() ? "<button class='btn btn-soft' id='p-assign'>Assign task</button>" +
                   "<button class='btn btn-soft' id='p-edit'>Edit profile</button>" : "") +
      "<button class='btn btn-primary' data-close>Close</button></div>";
    if (isOwner()) h += "<div class='danger-zone'><button class='btn btn-ghost' id='p-hr'>🔒 Open HR file</button></div>";

    openModal(h);
    var a = $("p-assign"); if (a) a.addEventListener("click", function () { taskForm(null, { assigneeId: id }); });
    var e = $("p-edit");   if (e) e.addEventListener("click", function () { profileEdit(id); });
    var hr = $("p-hr");    if (hr) hr.addEventListener("click", function () { hrFile(id); });
    var lg = $("p-login");  if (lg) lg.addEventListener("click", function () { loginHelp(m); });
  }

  /* ── Owner-only profile editor with per-field sharing ── */
  function profileEdit(id) {
    if (!isOwner()) return;
    var m = JSON.parse(JSON.stringify(member(id)));
    var priv = staffFor(id);
    var x = priv ? JSON.parse(JSON.stringify(priv))
                 : { memberId: id, rate: 0, payType: "hourly", phone: "", address: "", emName: "", emPhone: "",
                     startDate: "", birthday: "", notes: "", title: "", weeklyHours: 0, share: {} };
    var share = x.share || {};

    function fieldRow(k, label, inputHtml) {
      var can = SHAREABLE.filter(function (f) { return f.k === k; }).length > 0;
      return "<label>" + esc(label) +
        (can ? "<button class='sharebox" + (share[k] ? " on" : "") + "' data-share='" + k + "' type='button'>" +
               "<span class='tick'>✓</span> share with team</button>" : "") +
        "</label>" + inputHtml;
    }

    openModal("<h3>Edit " + esc(m.name) + "'s profile</h3>" +
      "<div class='modal-sub'>Tick <b>share with team</b> on anything the whole studio may see. Everything else stays between you and them.</div>" +
      fieldRow("name", "Display name", "<input type='text' id='pe-name' value='" + esc(m.name) + "'>") +
      fieldRow("full", "Full name", "<input type='text' id='pe-full' value='" + esc(m.full) + "'>") +
      fieldRow("title", "Job title", "<input type='text' id='pe-title' value='" + esc(x.title || m.role) + "'>") +
      fieldRow("bio", "About them", "<textarea id='pe-bio' placeholder='e.g. Leads Kristie Bridgers content'>" + esc(m.info) + "</textarea>") +
      fieldRow("email", "Email", "<input type='text' id='pe-email' value='" + esc(m.email) + "'>") +
      fieldRow("phone", "Phone", "<input type='text' id='pe-phone' value='" + esc(x.phone) + "'>") +
      fieldRow("startDate", "Start date", "<input type='date' id='pe-start' value='" + esc(x.startDate || "") + "'>") +
      fieldRow("birthday", "Birthday", "<input type='date' id='pe-bday' value='" + esc(x.birthday || "") + "'>") +
      "<div class='lockbar'>🔒 Below is never shared with the team</div>" +
      "<label>Employment type</label><select id='pe-emptype'>" + Object.keys(EMP_TYPE).map(function (k) {
        return "<option value='" + k + "'" + (x.empType === k ? " selected" : "") + ">" + EMP_TYPE[k] + "</option>";
      }).join("") + "</select>" +
      "<label>How they're paid</label><select id='pe-paytype'>" +
        ["hourly|Hourly", "salary|Salary", "contract|Per project"].map(function (o) {
          var v = o.split("|");
          return "<option value='" + v[0] + "'" + (x.payType === v[0] ? " selected" : "") + ">" + v[1] + "</option>";
        }).join("") + "</select>" +
      "<label>Pay frequency</label><select id='pe-freq'>" + Object.keys(PAY_FREQ).map(function (k) {
        return "<option value='" + k + "'" + (x.payFreq === k ? " selected" : "") + ">" + PAY_FREQ[k] + "</option>";
      }).join("") + "</select>" +
      "<label>" + (x.payType === "salary" ? "Salary (per year)" : "Hourly rate") + "</label>" +
      "<input type='text' id='pe-rate' inputmode='decimal' value='" + esc(x.rate || "") + "'>" +
      "<label>Usual hours a week</label><input type='text' id='pe-weekly' inputmode='decimal' value='" + esc(x.weeklyHours || "") + "'>" +
      "<label>Home address</label><input type='text' id='pe-address' value='" + esc(x.address) + "'>" +
      "<label>Emergency contact</label><div class='row2'>" +
      "<input type='text' id='pe-emname' value='" + esc(x.emName) + "' placeholder='Name'>" +
      "<input type='text' id='pe-emphone' value='" + esc(x.emPhone) + "' placeholder='Phone'></div>" +
      "<label>Private notes</label><textarea id='pe-notes'>" + esc(x.notes) + "</textarea>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='pe-save'>Save profile</button></div>");

    $("modal").querySelectorAll("[data-share]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-share");
        share[k] = !share[k];
        b.classList.toggle("on", !!share[k]);
      });
    });

    $("pe-save").addEventListener("click", function () {
      m.name = $("pe-name").value.trim() || m.name;
      m.full = $("pe-full").value.trim() || m.name;
      m.info = $("pe-bio").value.trim();
      m.email = $("pe-email").value.trim();
      x.title = $("pe-title").value.trim();
      x.phone = $("pe-phone").value.trim();
      x.startDate = $("pe-start").value || "";
      x.birthday = $("pe-bday").value || "";
      x.rate = parseFloat($("pe-rate").value) || 0;
      x.weeklyHours = parseFloat($("pe-weekly").value) || 0;
      x.payFreq = $("pe-freq").value;
      x.payType = $("pe-paytype").value;
      x.empType = $("pe-emptype").value;
      x.address = $("pe-address").value.trim();
      x.emName = $("pe-emname").value.trim();
      x.emPhone = $("pe-emphone").value.trim();
      x.notes = $("pe-notes").value.trim();
      x.share = share;

      // Only ticked values are copied into the publicly-readable row.
      var vals = { title: x.title, bio: m.info, email: m.email, phone: x.phone, startDate: x.startDate, birthday: x.birthday };
      var pub = {};
      SHAREABLE.forEach(function (f) { if (share[f.k] && vals[f.k]) pub[f.k] = vals[f.k]; });
      // Birthdays are shared as month + day only — the year is never published.
      if (pub.birthday) pub.birthday = String(pub.birthday).slice(5);
      m.shared = pub;
      if (!share.email) m.email = m.email;   // email stays on members for the owner's own use

      var found = false;
      for (var i = 0; i < DB.staff.length; i++) if (DB.staff[i].memberId === id) { DB.staff[i] = x; found = true; }
      if (!found) DB.staff.push(x);

      closeModal();
      upsert("members", memberRow(m), m, "members");
      if (cloudReady) sb.from("staff_private").upsert(staffRow(x)).select("member_id")
        .then(function (res) { if (wrote(res)) toast("Profile saved 🔒"); });
      else toast("Profile saved");
    });
  }

  /* ── HR file: owner-only. Lives in a table the server won't send to anyone else. ── */
  function hrFile(id) {
    if (!isOwner()) return;
    var m = member(id); if (!m) return;
    var x = staffFor(id) || { memberId: id, rate: 0, payType: "hourly", phone: "", address: "", emName: "", emPhone: "", startDate: "", birthday: "", notes: "" };
    var r = payRows().filter(function (q) { return q.m.id === id; })[0];
    openModal("<h3>" + esc(m.full) + "</h3><div class='modal-sub'>🔒 HR file — only you can open this, on any device.</div>" +
      (r ? "<div class='stats' style='grid-template-columns:repeat(3,1fr);margin-bottom:6px'>" +
        "<div class='stat'><div class='n'>" + (Math.round(r.planned * 10) / 10) + "</div><div class='l'>Hrs this period</div></div>" +
        "<div class='stat good'><div class='n'>" + (Math.round(r.done * 10) / 10) + "</div><div class='l'>Completed</div></div>" +
        "<div class='stat warm'><div class='n'>" + (r.earned == null ? "—" : money(r.earned)) + "</div><div class='l'>Earned</div></div></div>" : "") +
      "<label>Pay</label>" +
      "<div class='row2'><input type='text' id='hr-rate' value='" + esc(x.rate || "") + "' placeholder='Hourly rate e.g. 23'>" +
      "<select id='hr-paytype'><option value='hourly'" + (x.payType === "hourly" ? " selected" : "") + ">Hourly</option>" +
      "<option value='salary'" + (x.payType === "salary" ? " selected" : "") + ">Salary</option>" +
      "<option value='contract'" + (x.payType === "contract" ? " selected" : "") + ">Per project</option></select></div>" +
      "<label>Phone</label><input type='text' id='hr-phone' value='" + esc(x.phone) + "'>" +
      "<label>Address</label><input type='text' id='hr-address' value='" + esc(x.address) + "'>" +
      "<label>Emergency contact</label>" +
      "<div class='row2'><input type='text' id='hr-emname' value='" + esc(x.emName) + "' placeholder='Name'>" +
      "<input type='text' id='hr-emphone' value='" + esc(x.emPhone) + "' placeholder='Phone'></div>" +
      "<label>Start date</label><input type='date' id='hr-start' value='" + esc(x.startDate || "") + "'>" +
      "<label>Birthday</label><input type='date' id='hr-bday' value='" + esc(x.birthday || "") + "'>" +
      "<label>Private notes</label><textarea id='hr-notes' placeholder='Reviews, agreements, anything confidential'>" + esc(x.notes) + "</textarea>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='hr-save'>Save file</button></div>" +
      "<div class='danger-zone'><button class='btn btn-ghost' id='hr-login'>How to give " + esc(m.name) + " a login</button></div>");
    $("hr-save").addEventListener("click", function () {
      x.rate = parseFloat($("hr-rate").value) || 0;
      x.payType = $("hr-paytype").value;
      x.phone = $("hr-phone").value.trim(); x.address = $("hr-address").value.trim();
      x.emName = $("hr-emname").value.trim(); x.emPhone = $("hr-emphone").value.trim();
      x.startDate = $("hr-start").value || ""; x.birthday = $("hr-bday").value || "";
      x.notes = $("hr-notes").value.trim();
      var found = false;
      for (var i = 0; i < DB.staff.length; i++) if (DB.staff[i].memberId === id) { DB.staff[i] = x; found = true; }
      if (!found) DB.staff.push(x);
      closeModal(); scheduleRender();
      if (!cloudReady) return;
      sb.from("staff_private").upsert(staffRow(x)).select("member_id")
        .then(function (res) { if (wrote(res)) toast("HR file saved 🔒"); });
    });
    $("hr-login").addEventListener("click", function () { loginHelp(m); });
  }

  function loginHelp(m) {
    var email = m.email || "their email";
    openModal("<h3>Give " + esc(m.name) + " a login</h3>" +
      "<div class='modal-sub'>Two minutes, and then they can tick off their own tasks and see their own hours.</div>" +
      "<ol class='steps'>" +
      "<li>Open <b>supabase.com/dashboard</b> → your <b>studio-hq</b> project → <b>Authentication</b> → <b>Users</b>.</li>" +
      "<li>Click <b>Add user → Create new user</b>. Email: <b>" + esc(email) + "</b>. Pick a password and tick <b>Auto Confirm User</b>.</li>" +
      "<li>Go to <b>SQL Editor</b>, paste the line below, press Run.</li>" +
      "<li>Send " + esc(m.name) + " the password — they sign in with <b>Owner login</b> and get their own screen.</li></ol>" +
      "<label>Paste this into the SQL editor</label>" +
      "<textarea id='lh-sql' readonly rows='3' style='font-family:ui-monospace,monospace;font-size:12.5px'>insert into app_users (user_id, member_id, role)\nselect id, '" + esc(m.id) + "', 'employee' from auth.users where email = '" + esc(email) + "'\non conflict (user_id) do update set member_id = '" + esc(m.id) + "', role = 'employee';</textarea>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Close</button>" +
      "<button class='btn btn-primary' id='lh-copy'>Copy the SQL</button></div>");
    $("lh-copy").addEventListener("click", function () {
      var ta = $("lh-sql"); ta.select();
      try { document.execCommand("copy"); toast("Copied — paste it into Supabase"); } catch (e) { toast("Select and copy the text", true); }
    });
  }

  /* ── member / link / timeoff forms ── */
  var COLORS = ["#c4667c", "#7ea287", "#4f7460", "#b98d6f", "#8a7fa3", "#c9976f"];
  function memberForm(id) {
    var m = id ? member(id) : null, isNew = !m;
    m = m ? JSON.parse(JSON.stringify(m)) : { id: uid(), name: "", full: "", role: "", color: COLORS[DB.members.length % COLORS.length], email: "", info: "", isOwner: false, sort: DB.members.length, notify: {} };
    var n = m.notify || {};
    openModal("<h3>" + (isNew ? "New employee" : "Edit employee") + "</h3>" +
      "<label>First name</label><input type='text' id='m-name' value='" + esc(m.name) + "'>" +
      "<label>Full name</label><input type='text' id='m-full' value='" + esc(m.full) + "'>" +
      "<label>Role</label><input type='text' id='m-role' value='" + esc(m.role) + "'>" +
      "<label>Email</label><input type='text' id='m-email' value='" + esc(m.email) + "'>" +
      "<label>Notes (whole team sees this)</label><textarea id='m-info'>" + esc(m.info) + "</textarea>" +
      "<label>Email them about</label>" +
      "<div class='switch-row'><span class='switch-txt'>The daily plan</span>" +
      "<button class='switch" + (n.daily !== false ? " on" : "") + "' id='m-n-daily'></button></div>" +
      "<div class='switch-row'><span class='switch-txt'>New tasks assigned to them</span>" +
      "<button class='switch" + (n.assigned !== false ? " on" : "") + "' id='m-n-assigned'></button></div>" +
      "<div class='switch-row'><span class='switch-txt'>Upcoming photoshoots</span>" +
      "<button class='switch" + (n.shoots !== false ? " on" : "") + "' id='m-n-shoots'></button></div>" +
      "<div class='hint'>Used when you send the daily plan from Today. They need an email address above.</div>" +
      "<div class='modal-actions'><button class='btn btn-soft' data-close>Cancel</button>" +
      "<button class='btn btn-primary' id='m-save'>" + (isNew ? "Add" : "Save") + "</button></div>" +
      (isNew || m.isOwner ? "" : "<div class='danger-zone'><button class='btn btn-danger' id='m-del'>Remove</button></div>"));
    $("m-name").focus();
    ["m-n-daily", "m-n-assigned", "m-n-shoots"].forEach(function (sid) {
      $(sid).addEventListener("click", function () { this.classList.toggle("on"); });
    });
    $("m-save").addEventListener("click", function () {
      var n = $("m-name").value.trim(); if (!n) return $("m-name").focus();
      m.name = n; m.full = $("m-full").value.trim() || n; m.role = $("m-role").value.trim();
      m.email = $("m-email").value.trim(); m.info = $("m-info").value.trim();
      m.notify = { daily: $("m-n-daily").classList.contains("on"),
                   assigned: $("m-n-assigned").classList.contains("on"),
                   shoots: $("m-n-shoots").classList.contains("on") };
      var wasNew = isNew;
      closeModal(); upsert("members", memberRow(m), m, "members");
      toast(wasNew ? "Welcome aboard, " + m.name + " ✳" : "Saved ✳");
      if (wasNew && isOwner()) setTimeout(function () { loginHelp(m); }, 400);
    });
    var d = $("m-del"); if (d) d.addEventListener("click", function () {
      var openN = live().filter(function (t) { return t.assigneeId === m.id && t.status !== "done"; }).length;
      var hrs = DB.time.filter(function (e) { return e.memberId === m.id; }).reduce(function (a, e) { return a + e.hours; }, 0);
      var bits = [];
      if (openN) bits.push(openN + " open task" + (openN === 1 ? "" : "s") + " will be left unassigned");
      if (hrs) bits.push((Math.round(hrs * 10) / 10) + " logged hours stay in your payroll records");
      if (!confirm("Remove " + m.full + " from the studio?" + (bits.length ? "\n\n" + bits.join(".\n") + "." : "") + "\n\nThis can't be undone.")) return;
      closeModal(); removeRow("members", m.id, "members"); toast(m.name + " removed from the studio");
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
    var to = DB.members.filter(function (m) {
      return m.email && !m.isOwner && (!m.notify || m.notify.daily !== false);
    }).map(function (m) { return m.email; }).join(",");
    if (!to) { toast("Nobody has an email + daily-plan turned on", true); return; }
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
    if ((hit = t.closest("[data-person]"))) return personProfile(hit.getAttribute("data-person"));
    if ((hit = t.closest("[data-hr]"))) return hrFile(hit.getAttribute("data-hr"));
    if ((hit = t.closest("[data-assignto]"))) return taskForm(null, { assigneeId: hit.getAttribute("data-assignto") });
    if (t.closest("[data-newclient]")) return clientForm(null);
    if (t.closest("[data-newmember]")) return memberForm(null);
    if (t.closest("[data-newlink]")) return linkForm(null);
    if (t.closest("[data-newshoot]")) return taskForm(null, { kind: "shoot" });
    if (t.closest("[data-addoff]") || t.closest("[data-reqoff]")) return offForm(null);
    if (t.closest("[data-digest]")) return digest();
    if (t.closest("[data-whopick]")) return whoPicker();
    if (t.closest("[data-more]")) return moreSheet();
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

  function moreSheet() {
    var rest = nav().slice(4);
    openModal("<h3>More</h3>" + rest.map(function (n) {
      return "<button class='sr-item' data-goto='" + n.id + "'><span class='sr-main'><span class='sr-title'>" +
        esc(n.label) + "</span></span></button>";
    }).join("") +
    (isOwner() ? "<button class='sr-item' data-gosettings><span class='sr-main'><span class='sr-title'>Settings</span></span></button>" : "") +
    "<div class='modal-actions'><button class='btn btn-soft' data-close>Close</button></div>");
    $("modal").querySelectorAll("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function () { closeModal(); go(b.getAttribute("data-goto")); });
    });
    var st = $("modal").querySelector("[data-gosettings]");
    if (st) st.addEventListener("click", function () { closeModal(); settingsModal(); });
  }

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
