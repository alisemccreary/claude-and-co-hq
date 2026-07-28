/* Claude & Co. Studio HQ — app logic.
   Plain JS, no dependencies. State lives in localStorage on each device;
   the shipped assets/data.js is the shared baseline for the whole team.
   Owner mode (PIN) is the only way to edit. */

(function () {
  "use strict";

  var LS_STATE = "cco-hq-state-v1";
  var LS_ACCESS = "cco-hq-access-v1";
  var LS_WHO = "cco-hq-who-v1";
  var SS_OWNER = "cco-hq-owner-v1";

  var state = loadState();
  var who = localStorage.getItem(LS_WHO) || "alise";
  var activeTab = "today";
  var mineOnly = { today: false, schedule: false };

  // ---------- state ----------
  function seedCopy() {
    var s = JSON.parse(JSON.stringify(window.CCO_SEED));
    if (!s.publishedAt) s.publishedAt = 0;
    return s;
  }
  function loadState() {
    var seed = seedCopy();
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_STATE)); } catch (e) { raw = null; }
    if (!raw) return seed;
    // A newer published baseline replaces older local edits (the owner's
    // edits are what got published, so nothing is lost).
    if ((seed.publishedAt || 0) > (raw.publishedAt || 0)) return seed;
    return raw;
  }
  function save() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch (e) {}
  }
  function isOwner() { return sessionStorage.getItem(SS_OWNER) === "1"; }

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function uid() { return "x" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
  function todayStr() {
    var t = new Date();
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }
  function parseDate(s) {
    if (!s) return null;
    var p = s.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function fmtDate(s) {
    var dt = parseDate(s);
    if (!dt) return "no date";
    var opts = { month: "short", day: "numeric" };
    return dt.toLocaleDateString("en-US", opts);
  }
  function fmtDow(s) {
    var dt = parseDate(s);
    return dt ? dt.toLocaleDateString("en-US", { weekday: "long" }) : "";
  }
  function fmtTime(t) {
    if (!t) return "";
    var p = t.split(":");
    var h = +p[0], m = p[1];
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + m + " " + ap;
  }
  function isOverdue(task) {
    return task.status !== "done" && task.due && task.due < todayStr();
  }
  function member(id) {
    for (var i = 0; i < state.team.length; i++) if (state.team[i].id === id) return state.team[i];
    return null;
  }
  function client(id) {
    for (var i = 0; i < state.clients.length; i++) if (state.clients[i].id === id) return state.clients[i];
    return null;
  }
  function toast(msg) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }
  function greeting() {
    var h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  }

  // ---------- access gate ----------
  function checkGate() {
    if (localStorage.getItem(LS_ACCESS) === "1") {
      $("gate").classList.add("hidden");
      $("app").classList.remove("hidden");
      return;
    }
    $("gate").classList.remove("hidden");
    $("app").classList.add("hidden");
  }
  $("gate-btn").addEventListener("click", tryGate);
  $("gate-input").addEventListener("keydown", function (e) { if (e.key === "Enter") tryGate(); });
  function tryGate() {
    var v = $("gate-input").value.trim().toLowerCase();
    if (v === String(state.settings.accessCode).toLowerCase()) {
      localStorage.setItem(LS_ACCESS, "1");
      $("gate-err").classList.add("hidden");
      checkGate();
      renderAll();
    } else {
      $("gate-err").classList.remove("hidden");
    }
  }

  // ---------- header / tabs ----------
  function renderWho() {
    var sel = $("who");
    sel.innerHTML = state.team.map(function (m) {
      return '<option value="' + m.id + '"' + (m.id === who ? " selected" : "") + ">" + esc(m.name) + "</option>";
    }).join("");
  }
  $("who").addEventListener("change", function () {
    who = this.value;
    localStorage.setItem(LS_WHO, who);
    renderAll();
  });

  document.querySelectorAll("#tabs .tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeTab = btn.dataset.tab;
      document.querySelectorAll("#tabs .tab").forEach(function (b) { b.classList.toggle("active", b === btn); });
      ["today", "clients", "team", "schedule", "links"].forEach(function (v) {
        $("view-" + v).classList.toggle("hidden", v !== activeTab);
      });
      renderAll();
      window.scrollTo(0, 0);
    });
  });

  // ---------- owner mode ----------
  $("owner-btn").addEventListener("click", function () {
    if (isOwner()) return;
    openModal(
      "<h3>Owner login</h3>" +
      '<label>PIN</label><input type="password" id="pin-in" inputmode="numeric" autocomplete="off">' +
      '<div class="modal-actions"><button class="btn btn-outline-dark" data-close>Cancel</button>' +
      '<button class="btn btn-gold" id="pin-go">Unlock</button></div>'
    );
    var input = $("pin-in");
    input.focus();
    function go() {
      if (input.value.trim() === String(state.settings.ownerPin)) {
        sessionStorage.setItem(SS_OWNER, "1");
        closeModal();
        toast("Owner mode on — edit away ✳");
        renderAll();
      } else {
        input.value = "";
        input.placeholder = "Nope — try again";
      }
    }
    $("pin-go").addEventListener("click", go);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  });
  $("lock-btn").addEventListener("click", function () {
    sessionStorage.removeItem(SS_OWNER);
    toast("Locked. View-only now.");
    renderAll();
  });

  function renderOwnerUI() {
    $("owner-bar").classList.toggle("hidden", !isOwner());
    $("owner-btn").classList.toggle("hidden", isOwner());
  }

  // ---------- modal plumbing ----------
  function openModal(html) {
    $("modal").innerHTML = html;
    $("modal-backdrop").classList.remove("hidden");
    $("modal").querySelectorAll("[data-close]").forEach(function (b) {
      b.addEventListener("click", closeModal);
    });
  }
  function closeModal() {
    $("modal-backdrop").classList.add("hidden");
    $("modal").innerHTML = "";
  }
  $("modal-backdrop").addEventListener("click", function (e) {
    if (e.target === this) closeModal();
  });

  // ---------- task rendering ----------
  function statusIcon(st) { return st === "done" ? "✓" : st === "inprogress" ? "…" : ""; }
  function cycleStatus(st) { return st === "todo" ? "inprogress" : st === "inprogress" ? "done" : "todo"; }

  function taskRow(t, opts) {
    opts = opts || {};
    var m = member(t.assigneeId);
    var c = client(t.clientId);
    var overdue = isOverdue(t);
    var bits = [];
    if (!opts.hideClient && c) bits.push("<b>" + esc(c.name) + "</b>");
    if (t.due) bits.push((overdue ? '<span class="pill overdue">overdue</span> ' : "") + fmtDate(t.due) + (t.time ? " · " + fmtTime(t.time) : ""));
    if (t.kind === "shoot") bits.push('<span class="pill shoot">📷 shoot</span>');
    if (t.location) bits.push("📍 " + esc(t.location));
    if (m && !opts.hideWho) bits.push('<span class="who-chip" style="color:' + m.color + '">' + esc(m.name) + "</span>");
    bits.push('<span class="pill ' + t.status + '">' + (t.status === "inprogress" ? "in progress" : t.status === "todo" ? "to do" : "done") + "</span>");

    return '<div class="task' + (opts.inCard ? " in-card" : "") + (t.status === "done" ? " done-task" : "") + '" data-task="' + t.id + '">' +
      '<button class="task-status-btn ' + t.status + '" data-cycle="' + t.id + '"' + (isOwner() ? "" : " disabled") +
      ' title="' + (isOwner() ? "Click to move: to do → in progress → done" : "Only Alise can update status") + '">' + statusIcon(t.status) + "</button>" +
      '<div class="task-main">' +
        '<div class="task-title">' + esc(t.title) + "</div>" +
        '<div class="task-meta">' + bits.join(" ") + "</div>" +
        (t.notes ? '<div class="task-notes">' + esc(t.notes) + "</div>" : "") +
      "</div>" +
      (isOwner() ? '<button class="task-edit" data-edit="' + t.id + '" title="Edit">✎</button>' : "") +
      "</div>";
  }

  function bindTaskButtons(root) {
    root.querySelectorAll("[data-cycle]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!isOwner()) return;
        var t = state.tasks.find(function (x) { return x.id === b.dataset.cycle; });
        if (!t) return;
        t.status = cycleStatus(t.status);
        save();
        renderAll();
      });
    });
    root.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function () { taskForm(b.dataset.edit); });
    });
  }

  // ---------- task form (owner) ----------
  function taskForm(taskId, presetClientId) {
    var t = taskId ? state.tasks.find(function (x) { return x.id === taskId; }) : null;
    var isNew = !t;
    t = t || { id: uid(), clientId: presetClientId || (state.clients[0] && state.clients[0].id), title: "", assigneeId: "alise", due: todayStr(), time: "", status: "todo", kind: "task", location: "", notes: "" };

    openModal(
      "<h3>" + (isNew ? "New task" : "Edit task") + "</h3>" +
      "<label>What needs doing?</label>" +
      '<input type="text" id="tf-title" value="' + esc(t.title) + '" placeholder="e.g. Draft captions for next week">' +
      "<label>Type</label>" +
      '<div class="seg" id="tf-kind">' +
        '<button data-k="task" class="' + (t.kind === "task" ? "on" : "") + '">✓ Task</button>' +
        '<button data-k="shoot" class="' + (t.kind === "shoot" ? "on" : "") + '">📷 Photoshoot</button>' +
      "</div>" +
      "<label>Client</label>" +
      '<select id="tf-client">' + state.clients.filter(function (c) { return c.status !== "archived"; }).map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === t.clientId ? " selected" : "") + ">" + esc(c.name) + "</option>";
      }).join("") + "</select>" +
      "<label>Assigned to</label>" +
      '<select id="tf-who">' + state.team.map(function (m) {
        return '<option value="' + m.id + '"' + (m.id === t.assigneeId ? " selected" : "") + ">" + esc(m.name) + "</option>";
      }).join("") + "</select>" +
      "<label>Due date</label>" +
      '<input type="date" id="tf-due" value="' + esc(t.due) + '">' +
      '<div id="tf-shoot-fields" class="' + (t.kind === "shoot" ? "" : "hidden") + '">' +
        "<label>Time</label>" + '<input type="time" id="tf-time" value="' + esc(t.time) + '">' +
        "<label>Location</label>" + '<input type="text" id="tf-loc" value="' + esc(t.location) + '" placeholder="Where?">' +
      "</div>" +
      "<label>Status</label>" +
      '<div class="seg" id="tf-status">' +
        '<button data-s="todo" class="' + (t.status === "todo" ? "on" : "") + '">To do</button>' +
        '<button data-s="inprogress" class="' + (t.status === "inprogress" ? "on" : "") + '">In progress</button>' +
        '<button data-s="done" class="' + (t.status === "done" ? "on" : "") + '">Done</button>' +
      "</div>" +
      "<label>Notes</label>" +
      '<textarea id="tf-notes" placeholder="Anything the team should know">' + esc(t.notes) + "</textarea>" +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline-dark" data-close>Cancel</button>' +
        '<button class="btn btn-gold" id="tf-save">' + (isNew ? "Add it" : "Save") + "</button>" +
      "</div>" +
      (isNew ? "" : '<div class="danger-zone"><button class="btn-ghost" id="tf-del">Delete this task</button></div>')
    );

    var kind = t.kind, status = t.status;
    $("tf-kind").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        kind = b.dataset.k;
        $("tf-kind").querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        $("tf-shoot-fields").classList.toggle("hidden", kind !== "shoot");
      });
    });
    $("tf-status").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        status = b.dataset.s;
        $("tf-status").querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
      });
    });
    $("tf-save").addEventListener("click", function () {
      var title = $("tf-title").value.trim();
      if (!title) { $("tf-title").focus(); return; }
      t.title = title;
      t.kind = kind;
      t.status = status;
      t.clientId = $("tf-client").value;
      t.assigneeId = $("tf-who").value;
      t.due = $("tf-due").value;
      t.time = kind === "shoot" ? $("tf-time").value : "";
      t.location = kind === "shoot" ? $("tf-loc").value.trim() : "";
      t.notes = $("tf-notes").value.trim();
      if (isNew) state.tasks.push(t);
      save();
      closeModal();
      toast(isNew ? "Added ✳" : "Saved ✳");
      renderAll();
    });
    if (!isNew) {
      $("tf-del").addEventListener("click", function () {
        if (!confirm("Delete this task for good?")) return;
        state.tasks = state.tasks.filter(function (x) { return x.id !== t.id; });
        save();
        closeModal();
        toast("Deleted");
        renderAll();
      });
    }
  }

  // ---------- client form (owner) ----------
  function clientForm(clientId) {
    var c = clientId ? client(clientId) : null;
    var isNew = !c;
    c = c || { id: uid(), name: "", status: "active", contact: "", email: "", phone: "", rate: "", services: "", loomly: "", team: [], notes: "" };

    openModal(
      "<h3>" + (isNew ? "New client" : "Edit client") + "</h3>" +
      "<label>Business name</label>" + '<input type="text" id="cf-name" value="' + esc(c.name) + '">' +
      "<label>Status</label>" +
      '<div class="seg" id="cf-status">' +
        '<button data-s="active" class="' + (c.status === "active" ? "on" : "") + '">Active</button>' +
        '<button data-s="pending" class="' + (c.status === "pending" ? "on" : "") + '">Pending</button>' +
        '<button data-s="archived" class="' + (c.status === "archived" ? "on" : "") + '">Archived</button>' +
      "</div>" +
      "<label>Contact person</label>" + '<input type="text" id="cf-contact" value="' + esc(c.contact) + '">' +
      "<label>Email</label>" + '<input type="text" id="cf-email" value="' + esc(c.email) + '">' +
      "<label>Phone</label>" + '<input type="text" id="cf-phone" value="' + esc(c.phone) + '">' +
      "<label>Monthly rate</label>" + '<input type="text" id="cf-rate" value="' + esc(c.rate) + '" placeholder="e.g. $850/mo">' +
      "<label>Services</label>" + '<input type="text" id="cf-services" value="' + esc(c.services) + '">' +
      "<label>Loomly / calendar name</label>" + '<input type="text" id="cf-loomly" value="' + esc(c.loomly) + '">' +
      "<label>Team on this client</label>" +
      '<div class="seg" id="cf-team">' + state.team.map(function (m) {
        return '<button data-m="' + m.id + '" class="' + (c.team.indexOf(m.id) >= 0 ? "on" : "") + '">' + esc(m.name) + "</button>";
      }).join("") + "</div>" +
      "<label>Notes</label>" + '<textarea id="cf-notes">' + esc(c.notes) + "</textarea>" +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline-dark" data-close>Cancel</button>' +
        '<button class="btn btn-gold" id="cf-save">' + (isNew ? "Add client" : "Save") + "</button>" +
      "</div>"
    );

    var status = c.status;
    var teamSel = c.team.slice();
    $("cf-status").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        status = b.dataset.s;
        $("cf-status").querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
      });
    });
    $("cf-team").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.m;
        var i = teamSel.indexOf(id);
        if (i >= 0) teamSel.splice(i, 1); else teamSel.push(id);
        b.classList.toggle("on", i < 0);
      });
    });
    $("cf-save").addEventListener("click", function () {
      var name = $("cf-name").value.trim();
      if (!name) { $("cf-name").focus(); return; }
      c.name = name;
      c.status = status;
      c.contact = $("cf-contact").value.trim();
      c.email = $("cf-email").value.trim();
      c.phone = $("cf-phone").value.trim();
      c.rate = $("cf-rate").value.trim();
      c.services = $("cf-services").value.trim();
      c.loomly = $("cf-loomly").value.trim();
      c.team = teamSel;
      c.notes = $("cf-notes").value.trim();
      if (isNew) state.clients.push(c);
      save();
      closeModal();
      toast(isNew ? "Client added ✳" : "Saved ✳");
      renderAll();
    });
  }

  // ---------- views ----------
  function avatarHtml(m, big) {
    if (!m) return "";
    return '<span class="avatar' + (big ? " big" : "") + '" style="background:' + m.color + '" title="' + esc(m.full) + '">' +
      esc(m.name.slice(0, 2).toUpperCase()) + "</span>";
  }
  function openTasks() { return state.tasks.filter(function (t) { return t.status !== "done"; }); }
  function mineFilter(list) {
    return list.filter(function (t) { return t.assigneeId === who; });
  }
  function sortTasks(list) {
    return list.slice().sort(function (a, b) {
      return (a.due || "9999").localeCompare(b.due || "9999") || (a.time || "").localeCompare(b.time || "");
    });
  }
  function mineToggle(view) {
    var m = member(who);
    return '<div class="filter-row">' +
      '<button class="chip-toggle' + (mineOnly[view] ? "" : " on") + '" data-mine="0">Everyone</button>' +
      '<button class="chip-toggle' + (mineOnly[view] ? " on" : "") + '" data-mine="1">Just ' + esc(m ? m.name : "me") + "</button>" +
      "</div>";
  }
  function bindMineToggle(root, view) {
    root.querySelectorAll("[data-mine]").forEach(function (b) {
      b.addEventListener("click", function () {
        mineOnly[view] = b.dataset.mine === "1";
        renderAll();
      });
    });
  }

  function renderToday() {
    var v = $("view-today");
    var m = member(who);
    var today = todayStr();
    var all = state.tasks;
    var pool = mineOnly.today ? mineFilter(all) : all;

    var dueToday = sortTasks(pool.filter(function (t) { return t.due === today && t.status !== "done"; }));
    var overdue = sortTasks(pool.filter(isOverdue));
    var inprog = pool.filter(function (t) { return t.status === "inprogress"; });
    var weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
    var weekEndStr = weekEnd.getFullYear() + "-" + String(weekEnd.getMonth() + 1).padStart(2, "0") + "-" + String(weekEnd.getDate()).padStart(2, "0");
    var shootsWeek = sortTasks(pool.filter(function (t) { return t.kind === "shoot" && t.status !== "done" && t.due && t.due >= today && t.due <= weekEndStr; }));

    var dateLine = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

    var html =
      "<h2>" + greeting() + ", " + esc(m ? m.name : "friend") + " ☀</h2>" +
      '<p class="view-sub">' + dateLine + "</p>" +
      mineToggle("today") +
      '<div class="stats">' +
        '<div class="stat' + (overdue.length ? " warn" : " go") + '"><div class="n">' + overdue.length + '</div><div class="l">Overdue</div></div>' +
        '<div class="stat gold"><div class="n">' + dueToday.length + '</div><div class="l">Due today</div></div>' +
        '<div class="stat"><div class="n">' + inprog.length + '</div><div class="l">In progress</div></div>' +
        '<div class="stat"><div class="n">' + shootsWeek.length + '</div><div class="l">Shoots this week</div></div>' +
      "</div>";

    if (overdue.length) {
      html += '<div class="section-label">Needs attention</div>' + overdue.map(function (t) { return taskRow(t); }).join("");
    }

    html += '<div class="section-label">Today, client by client' +
      (isOwner() ? ' <button class="btn btn-dark btn-sm" data-newtask>+ Task</button>' : "") + "</div>";

    var todays = sortTasks(pool.filter(function (t) { return t.due === today; }));
    if (!todays.length) {
      html += '<div class="empty">Nothing due today' + (mineOnly.today ? " for you" : "") + ". Golden. ✳</div>";
    } else {
      var byClient = {};
      todays.forEach(function (t) { (byClient[t.clientId] = byClient[t.clientId] || []).push(t); });
      state.clients.forEach(function (c) {
        var list = byClient[c.id];
        if (!list) return;
        html += '<div class="card"><div class="card-head"><h3 class="card-title">' + esc(c.name) + "</h3>" +
          '<span class="avatars">' + c.team.map(function (id) { return avatarHtml(member(id)); }).join("") + "</span></div>" +
          list.map(function (t) { return taskRow(t, { hideClient: true, inCard: true }); }).join("") +
          "</div>";
      });
    }

    if (shootsWeek.length) {
      html += '<div class="section-label">Shoots this week</div>' +
        shootsWeek.map(function (t) { return taskRow(t); }).join("");
    }

    v.innerHTML = html;
    bindTaskButtons(v);
    bindMineToggle(v, "today");
    var nb = v.querySelector("[data-newtask]");
    if (nb) nb.addEventListener("click", function () { taskForm(null); });
  }

  function renderClients() {
    var v = $("view-clients");
    var actives = state.clients.filter(function (c) { return c.status !== "archived"; });
    var archived = state.clients.filter(function (c) { return c.status === "archived"; });

    var html = "<h2>Clients</h2>" +
      '<p class="view-sub">' + actives.length + " on the books · tap a card to see everything</p>";
    if (isOwner()) html += '<div class="filter-row"><button class="btn btn-dark btn-sm" data-newclient>+ New client</button></div>';

    html += '<div class="client-grid">' + actives.map(clientCard).join("") + "</div>";

    if (archived.length) {
      html += '<div class="section-label">Archived</div><div class="client-grid">' + archived.map(clientCard).join("") + "</div>";
    }
    v.innerHTML = html;

    function clientCard(c) {
      var open = openTasks().filter(function (t) { return t.clientId === c.id; });
      var od = open.filter(isOverdue).length;
      return '<div class="card" data-client="' + c.id + '" style="cursor:pointer">' +
        '<div class="card-head"><div><h3 class="card-title">' + esc(c.name) + "</h3>" +
        '<div class="card-sub">' + esc(c.services || "") + "</div></div>" +
        '<span class="pill ' + c.status + '">' + c.status + "</span></div>" +
        '<div class="meta-row"><span class="avatars">' + c.team.map(function (id) { return avatarHtml(member(id)); }).join("") + "</span> " +
        "&nbsp;" + open.length + " open task" + (open.length === 1 ? "" : "s") +
        (od ? ' · <span style="color:var(--rust);font-weight:700">' + od + " overdue</span>" : "") + "</div>" +
        "</div>";
    }

    v.querySelectorAll("[data-client]").forEach(function (card) {
      card.addEventListener("click", function () { clientDetail(card.dataset.client); });
    });
    var nb = v.querySelector("[data-newclient]");
    if (nb) nb.addEventListener("click", function () { clientForm(null); });
  }

  function clientDetail(cid) {
    var c = client(cid);
    if (!c) return;
    var list = sortTasks(state.tasks.filter(function (t) { return t.clientId === cid; }));
    var open = list.filter(function (t) { return t.status !== "done"; });
    var done = list.filter(function (t) { return t.status === "done"; });

    var html = '<div class="card-head"><h3 style="margin:0;font-size:22px">' + esc(c.name) + "</h3>" +
      '<span class="pill ' + c.status + '">' + c.status + "</span></div>";
    if (c.contact) html += '<div class="meta-row"><b>Contact:</b> ' + esc(c.contact) + "</div>";
    if (c.email) html += '<div class="meta-row"><b>Email:</b> <a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a></div>";
    if (c.phone) html += '<div class="meta-row"><b>Phone:</b> <a href="tel:' + esc(c.phone.replace(/[^0-9+]/g, "")) + '">' + esc(c.phone) + "</a></div>";
    if (isOwner() && c.rate) html += '<div class="meta-row"><b>Rate:</b> ' + esc(c.rate) + " <span style='color:var(--muted);font-size:11px'>(owner-only)</span></div>";
    if (c.services) html += '<div class="meta-row"><b>Services:</b> ' + esc(c.services) + "</div>";
    if (c.loomly) html += '<div class="meta-row"><b>Calendar:</b> ' + esc(c.loomly) + "</div>";
    if (c.team.length) html += '<div class="meta-row" style="margin-top:6px"><span class="avatars">' + c.team.map(function (id) { return avatarHtml(member(id)); }).join("") + "</span> &nbsp;" +
      c.team.map(function (id) { var mm = member(id); return mm ? mm.name : ""; }).join(" · ") + "</div>";
    if (c.notes) html += '<div class="task-notes" style="margin-top:8px">' + esc(c.notes) + "</div>";

    html += '<div class="section-label" style="margin-top:16px">Open' +
      (isOwner() ? ' <button class="btn btn-dark btn-sm" id="cd-add">+ Task</button>' : "") + "</div>";
    html += open.length ? open.map(function (t) { return taskRow(t, { hideClient: true }); }).join("") : '<div class="empty">Nothing open.</div>';
    if (done.length) {
      html += '<div class="section-label">Done</div>' + done.map(function (t) { return taskRow(t, { hideClient: true }); }).join("");
    }
    html += '<div class="modal-actions">' +
      (isOwner() ? '<button class="btn btn-outline-dark" id="cd-edit">Edit client</button>' : "") +
      '<button class="btn btn-gold" data-close>Close</button></div>';

    openModal(html);
    bindTaskButtons($("modal"));
    var add = $("cd-add");
    if (add) add.addEventListener("click", function () { taskForm(null, cid); });
    var ed = $("cd-edit");
    if (ed) ed.addEventListener("click", function () { clientForm(cid); });
    // Re-open detail after inline status changes so the modal stays fresh:
    $("modal").querySelectorAll("[data-cycle]").forEach(function (b) {
      b.addEventListener("click", function () { setTimeout(function () { clientDetail(cid); }, 0); });
    });
  }

  function renderTeam() {
    var v = $("view-team");
    var html = "<h2>The team</h2>" +
      '<p class="view-sub">Who\'s carrying what right now</p>';
    state.team.forEach(function (m) {
      var mine = sortTasks(openTasks().filter(function (t) { return t.assigneeId === m.id; }));
      var shoots = mine.filter(function (t) { return t.kind === "shoot"; });
      html += '<div class="card">' +
        '<div class="card-head"><div style="display:flex;align-items:center;gap:10px">' + avatarHtml(m, true) +
        "<div><h3 class='card-title'>" + esc(m.full) + "</h3><div class='card-sub'>" + esc(m.role) + "</div></div></div>" +
        '<span class="pill todo">' + mine.length + " open</span></div>" +
        (mine.length
          ? mine.map(function (t) { return taskRow(t, { hideWho: true, inCard: true }); }).join("")
          : '<div class="empty">All clear ✳</div>') +
        (shoots.length ? '<div class="card-sub" style="margin-top:4px">📷 ' + shoots.length + " shoot" + (shoots.length === 1 ? "" : "s") + " coming up</div>" : "") +
        "</div>";
    });
    v.innerHTML = html;
    bindTaskButtons(v);
  }

  function renderSchedule() {
    var v = $("view-schedule");
    var today = todayStr();
    var pool = mineOnly.schedule ? mineFilter(state.tasks) : state.tasks;
    var upcoming = sortTasks(pool.filter(function (t) { return t.status !== "done" && t.due && t.due >= today; }));
    var byDay = {};
    upcoming.forEach(function (t) { (byDay[t.due] = byDay[t.due] || []).push(t); });
    var days = Object.keys(byDay).sort();

    var html = "<h2>Schedule</h2>" +
      '<p class="view-sub">Shoots and deadlines, day by day</p>' +
      mineToggle("schedule") +
      (isOwner() ? '<div class="filter-row"><button class="btn btn-dark btn-sm" data-newshoot>+ Schedule a shoot</button></div>' : "");

    if (!days.length) {
      html += '<div class="empty">Nothing on the calendar yet.</div>';
    }
    days.forEach(function (day) {
      var isToday = day === today;
      html += '<div class="day-group"><div class="day-head' + (isToday ? " today-head" : "") + '">' +
        '<span class="dow">' + fmtDow(day) + "</span> " + fmtDate(day) +
        (isToday ? ' <span class="today-flag">today</span>' : "") + "</div>" +
        byDay[day].map(function (t) { return taskRow(t); }).join("") + "</div>";
    });
    v.innerHTML = html;
    bindTaskButtons(v);
    bindMineToggle(v, "schedule");
    var nb = v.querySelector("[data-newshoot]");
    if (nb) nb.addEventListener("click", function () {
      taskForm(null);
      // preset to shoot
      var shootBtn = document.querySelector('#tf-kind [data-k="shoot"]');
      if (shootBtn) shootBtn.click();
    });
  }

  function renderLinks() {
    var v = $("view-links");
    v.innerHTML = "<h2>Studio links</h2>" +
      '<p class="view-sub">Every tool we use, one tap away</p>' +
      '<div class="links-grid">' + state.links.map(function (l) {
        return '<a class="link-card" href="' + esc(l.url) + '" target="_blank" rel="noopener">' +
          '<div class="emoji">' + l.emoji + '</div><div class="name">' + esc(l.name) + '</div>' +
          '<div class="desc">' + esc(l.desc) + "</div></a>";
      }).join("") + "</div>";
  }

  // ---------- publish / settings (owner) ----------
  function download(filename, text) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  $("publish-btn").addEventListener("click", function () {
    state.publishedAt = Date.now();
    save();
    var out = JSON.parse(JSON.stringify(state));
    var file = "/* Claude & Co. Studio HQ — published data (" + new Date().toLocaleString() + ") */\n" +
      "(function () { window.CCO_SEED = " + JSON.stringify(out, null, 2) + "; })();\n";
    download("cco-hq-data.js", file);
    openModal(
      "<h3>Almost published ✳</h3>" +
      "<p style='font-size:14px'>A file called <b>cco-hq-data.js</b> just downloaded. It has everything you changed.</p>" +
      "<p style='font-size:14px'>Now just tell Claude:</p>" +
      "<p style='background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:12px;font-weight:700'>“Publish my Studio HQ updates”</p>" +
      "<p style='font-size:14px'>Claude grabs the file from Downloads, updates the site, and the whole team sees it after you push in GitHub Desktop.</p>" +
      '<div class="modal-actions"><button class="btn btn-gold" data-close>Got it</button></div>'
    );
  });

  $("settings-btn").addEventListener("click", function () {
    openModal(
      "<h3>Settings</h3>" +
      "<label>Studio password (whole team)</label>" +
      '<input type="text" id="st-access" value="' + esc(state.settings.accessCode) + '">' +
      "<label>Owner PIN (just you)</label>" +
      '<input type="text" id="st-pin" value="' + esc(state.settings.ownerPin) + '">' +
      '<p class="hint">If you change these, hit Publish so the live site gets the new ones — and tell the team the new password.</p>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline-dark" data-close>Cancel</button>' +
        '<button class="btn btn-gold" id="st-save">Save</button>' +
      "</div>" +
      '<div class="danger-zone">' +
        '<button class="btn-ghost" id="st-export">Download a backup</button><br>' +
        '<button class="btn-ghost" id="st-reset">Reset my device to the published version</button>' +
      "</div>"
    );
    $("st-save").addEventListener("click", function () {
      var ac = $("st-access").value.trim();
      var pin = $("st-pin").value.trim();
      if (ac) state.settings.accessCode = ac;
      if (pin) state.settings.ownerPin = pin;
      save();
      closeModal();
      toast("Settings saved ✳");
    });
    $("st-export").addEventListener("click", function () {
      download("cco-hq-backup.json", JSON.stringify(state, null, 2));
      toast("Backup downloaded");
    });
    $("st-reset").addEventListener("click", function () {
      if (!confirm("Replace what's on this device with the published version?")) return;
      localStorage.removeItem(LS_STATE);
      state = loadState();
      closeModal();
      toast("Back to the published version");
      renderAll();
    });
  });

  // ---------- boot ----------
  function renderAll() {
    renderOwnerUI();
    renderWho();
    if (activeTab === "today") renderToday();
    if (activeTab === "clients") renderClients();
    if (activeTab === "team") renderTeam();
    if (activeTab === "schedule") renderSchedule();
    if (activeTab === "links") renderLinks();
  }

  checkGate();
  renderAll();
})();
