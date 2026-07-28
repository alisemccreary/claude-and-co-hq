/* Claude & Co. Studio HQ — app logic (v3, cloud-synced).
   Data lives in Supabase when assets/config.js has real values:
   - app_state table: one JSON row, readable by all, writable only by
     Alise's signed-in owner account (enforced server-side by RLS).
   - timeoff table: readable by all; anyone can INSERT a 'requested' row
     (that's how employees submit); only the owner can approve/deny/delete.
   Everyone's screen refreshes on tab focus and every 30 seconds.
   Without config values the app falls back to the old local-only mode
   (localStorage + Publish-to-team), so nothing breaks mid-upgrade.
   Pay/rates are intentionally absent from the entire app. */

(function () {
  "use strict";

  var LS_STATE = "cco-hq-state-v1";
  var LS_ACCESS = "cco-hq-access-v1";
  var LS_WHO = "cco-hq-who-v1";
  var SS_OWNER = "cco-hq-owner-v1";

  // ---------- cloud setup ----------
  var cfg = window.CCO_CONFIG || {};
  var cloud = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    cfg.SUPABASE_URL.indexOf("PASTE_") < 0 && cfg.SUPABASE_ANON_KEY.indexOf("PASTE_") < 0 &&
    window.supabase);
  var sb = cloud ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  var ownerFlag = false;          // cloud mode: true when signed in as Alise
  var lastLocalEdit = 0;          // guards polling from clobbering in-flight edits
  var pendingCloudState = null;   // cloud refresh arriving while a modal is open

  var state = loadState();
  var who = localStorage.getItem(LS_WHO) || "alise";
  var activeTab = "today";
  var mineOnly = { today: false, schedule: false };

  // ---------- state (local cache layer) ----------
  function seedCopy() {
    var s = JSON.parse(JSON.stringify(window.CCO_SEED));
    if (!s.publishedAt) s.publishedAt = 0;
    if (!s.timeoff) s.timeoff = [];
    if (!s.links) s.links = [];
    return s;
  }
  function loadState() {
    var seed = seedCopy();
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_STATE)); } catch (e) { raw = null; }
    if (!raw) return seed;
    if ((seed.version || 1) > (raw.version || 1)) return seed;
    if (!cloud && (seed.publishedAt || 0) > (raw.publishedAt || 0)) return seed;
    if (!raw.timeoff) raw.timeoff = [];
    if (!raw.links) raw.links = seed.links;
    return raw;
  }
  function cacheLocal() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch (e) {}
  }
  function save() {
    lastLocalEdit = Date.now();
    cacheLocal();
    if (cloud && ownerFlag) pushStateSoon();
  }

  // ---------- cloud sync ----------
  var pushTimer = null;
  function stateForCloud() {
    var out = JSON.parse(JSON.stringify(state));
    delete out.timeoff; // lives in its own table
    return out;
  }
  function pushStateSoon() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushStateNow, 700);
  }
  function pushStateNow() {
    clearTimeout(pushTimer);
    pushTimer = null;
    return sb.from("app_state").upsert({ id: 1, data: stateForCloud(), updated_at: new Date().toISOString() })
      .then(function (res) {
        if (res.error) toast("⚠️ Couldn't save to the cloud — check your internet");
      });
  }
  function rowToEntry(r) {
    return { id: r.id, memberId: r.member_id, start: r.start_day, end: r.end_day, reason: r.reason || "", status: r.status };
  }
  function refreshCloud() {
    if (!cloud) return Promise.resolve();
    if (pushTimer || (ownerFlag && Date.now() - lastLocalEdit < 5000)) return Promise.resolve();
    return Promise.all([
      sb.from("app_state").select("data").eq("id", 1).maybeSingle(),
      sb.from("timeoff").select("*").order("start_day")
    ]).then(function (results) {
      var stateRes = results[0], toRes = results[1];
      if (stateRes.error || toRes.error) return;
      var next = stateRes.data ? stateRes.data.data : stateForCloud();
      next.timeoff = (toRes.data || []).map(rowToEntry);
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      if (!$("modal-backdrop").classList.contains("hidden")) {
        pendingCloudState = next; // don't yank a form out from under anyone
        return;
      }
      state = next;
      cacheLocal();
      renderAll();
    });
  }
  function seedCloudIfEmpty() {
    // First owner sign-in: if the cloud is empty, upload this device's
    // data as the starting point (including migrating old local time off).
    return sb.from("app_state").select("id").eq("id", 1).maybeSingle().then(function (res) {
      if (res.error || res.data) return;
      var oldOff = (state.timeoff || []).map(function (e) {
        return { member_id: e.memberId, start_day: e.start, end_day: e.end || e.start, reason: e.reason || "", status: e.status || "approved" };
      });
      return pushStateNow().then(function () {
        if (oldOff.length) return sb.from("timeoff").insert(oldOff);
      }).then(function () {
        toast("Cloud is set up — everything now syncs live ✨");
        refreshCloud();
      });
    });
  }

  // ---------- time off data access (works in both modes) ----------
  function toSubmitRequest(e) {
    if (cloud) {
      return sb.from("timeoff").insert({ member_id: e.memberId, start_day: e.start, end_day: e.end, reason: e.reason, status: "requested" })
        .then(function (res) {
          if (res.error) { toast("⚠️ Couldn't send — check your internet"); return; }
          refreshCloudForce();
        });
    }
    state.timeoff.push(e); save(); renderAll();
    return Promise.resolve();
  }
  function toOwnerUpsert(e, isNew) {
    if (cloud) {
      var row = { member_id: e.memberId, start_day: e.start, end_day: e.end, reason: e.reason, status: e.status };
      var q = isNew ? sb.from("timeoff").insert(row) : sb.from("timeoff").update(row).eq("id", e.id);
      return q.then(function (res) {
        if (res.error) { toast("⚠️ Couldn't save — are you logged in as owner?"); return; }
        refreshCloudForce();
      });
    }
    if (isNew) state.timeoff.push(e);
    save(); renderAll();
    return Promise.resolve();
  }
  function toSetStatus(id, status, msg) {
    if (cloud) {
      return sb.from("timeoff").update({ status: status }).eq("id", id).then(function (res) {
        if (res.error) { toast("⚠️ Couldn't update — are you logged in as owner?"); return; }
        toast(msg);
        refreshCloudForce();
      });
    }
    var e = state.timeoff.find(function (x) { return x.id === id; });
    if (e) { e.status = status; save(); toast(msg); renderAll(); }
    return Promise.resolve();
  }
  function toDelete(id) {
    if (cloud) {
      return sb.from("timeoff").delete().eq("id", id).then(function (res) {
        if (res.error) { toast("⚠️ Couldn't delete — are you logged in as owner?"); return; }
        toast("Deleted");
        refreshCloudForce();
      });
    }
    state.timeoff = state.timeoff.filter(function (x) { return x.id !== id; });
    save(); toast("Deleted"); renderAll();
    return Promise.resolve();
  }
  function refreshCloudForce() {
    lastLocalEdit = 0;
    var t = pushTimer;
    if (t) { pushStateNow().then(function () { refreshCloud(); }); return; }
    refreshCloud();
  }

  // ---------- owner status ----------
  function isOwner() {
    return cloud ? ownerFlag : sessionStorage.getItem(SS_OWNER) === "1";
  }

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
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  function statusLabel(s) {
    return s === "archived" ? "past client" : s;
  }
  function toast(msg) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
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
  function ownerLogin(onSuccess) {
    var label = cloud ? "Owner password" : "PIN";
    openModal(
      "<h3>Owner login</h3>" +
      "<label>" + label + "</label>" +
      '<input type="password" id="pin-in" autocomplete="current-password">' +
      (cloud ? '<p class="hint">This is your Supabase owner password — it stays signed in on this device.</p>' : "") +
      '<div class="modal-actions"><button class="btn btn-outline-dark" data-close>Cancel</button>' +
      '<button class="btn btn-gold" id="pin-go">Unlock</button></div>'
    );
    var input = $("pin-in");
    input.focus();
    function done() {
      closeModal();
      toast("Owner mode on — edit away ✳");
      renderAll();
      if (onSuccess) onSuccess();
    }
    function go() {
      var v = input.value.trim();
      if (!v) return;
      if (cloud) {
        $("pin-go").textContent = "…";
        sb.auth.signInWithPassword({ email: cfg.OWNER_LOGIN_EMAIL || state.settings.ownerEmail || "alise@claudeandco.design", password: v })
          .then(function (res) {
            if (res.error) {
              $("pin-go").textContent = "Unlock";
              input.value = "";
              input.placeholder = "Nope — try again";
              return;
            }
            ownerFlag = true;
            seedCloudIfEmpty();
            done();
          });
      } else {
        if (v === String(state.settings.ownerPin)) {
          sessionStorage.setItem(SS_OWNER, "1");
          done();
        } else {
          input.value = "";
          input.placeholder = "Nope — try again";
        }
      }
    }
    $("pin-go").addEventListener("click", go);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }
  $("owner-btn").addEventListener("click", function () {
    if (isOwner()) return;
    ownerLogin();
  });
  $("lock-btn").addEventListener("click", function () {
    if (cloud) { ownerFlag = false; sb.auth.signOut(); }
    else sessionStorage.removeItem(SS_OWNER);
    toast("Locked. View-only now.");
    renderAll();
  });

  function renderOwnerUI() {
    $("owner-bar").classList.toggle("hidden", !isOwner());
    $("owner-btn").classList.toggle("hidden", isOwner());
    $("publish-btn").classList.toggle("hidden", cloud || !isOwner());
    $("owner-bar-text").textContent = cloud
      ? "✳ Owner mode — edits save live for the whole team."
      : "✳ Owner mode — you can edit everything.";
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
    if (pendingCloudState) {
      state = pendingCloudState;
      pendingCloudState = null;
      cacheLocal();
      renderAll();
    }
  }
  $("modal-backdrop").addEventListener("click", function (e) {
    if (e.target === this) closeModal();
  });

  // ---------- progress ----------
  function progressFor(list) {
    var total = list.length;
    var done = list.filter(function (t) { return t.status === "done"; }).length;
    return { done: done, total: total, pct: total ? Math.round(done / total * 100) : 0 };
  }
  function progressCard(label, list, avatarM, mini) {
    var p = progressFor(list);
    var full = p.total > 0 && p.done === p.total;
    return '<div class="progress-card">' +
      '<div class="progress-top">' +
        '<span class="progress-name">' + (avatarM ? avatarHtml(avatarM) + " " : "") + esc(label) + "</span>" +
        '<span class="progress-pct' + (full ? " full" : "") + '">' + (full ? "100% 🎉" : p.pct + "%") + "</span>" +
      "</div>" +
      '<div class="bar' + (mini ? " mini" : "") + '"><div class="bar-fill' + (full ? " full" : "") + '" style="width:' + p.pct + '%"></div></div>' +
      '<div class="progress-sub">' + p.done + " of " + p.total + " task" + (p.total === 1 ? "" : "s") + " done" + "</div>" +
      "</div>";
  }

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
    c = c || { id: uid(), name: "", status: "active", contact: "", email: "", phone: "", services: "", loomly: "", team: [], notes: "" };

    openModal(
      "<h3>" + (isNew ? "New client" : "Edit client") + "</h3>" +
      "<label>Business name</label>" + '<input type="text" id="cf-name" value="' + esc(c.name) + '">' +
      "<label>Status</label>" +
      '<div class="seg" id="cf-status">' +
        '<button data-s="active" class="' + (c.status === "active" ? "on" : "") + '">Active</button>' +
        '<button data-s="pending" class="' + (c.status === "pending" ? "on" : "") + '">Pending</button>' +
        '<button data-s="archived" class="' + (c.status === "archived" ? "on" : "") + '">Past client</button>' +
      "</div>" +
      "<label>Contact person</label>" + '<input type="text" id="cf-contact" value="' + esc(c.contact) + '">' +
      "<label>Email</label>" + '<input type="text" id="cf-email" value="' + esc(c.email) + '">' +
      "<label>Phone</label>" + '<input type="text" id="cf-phone" value="' + esc(c.phone) + '">' +
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

  // ---------- employee form (owner) ----------
  var AVATAR_COLORS = ["#c96f85", "#7fa387", "#5b7f68", "#b98d6f", "#8a7fa3", "#c9976f"];
  function memberForm(memberId) {
    var m = memberId ? member(memberId) : null;
    var isNew = !m;
    m = m || { id: uid(), name: "", full: "", role: "", color: AVATAR_COLORS[state.team.length % AVATAR_COLORS.length], isOwner: false, email: "", info: "" };

    openModal(
      "<h3>" + (isNew ? "New employee" : "Edit employee") + "</h3>" +
      "<label>First name (shows on tasks)</label>" + '<input type="text" id="mf-name" value="' + esc(m.name) + '">' +
      "<label>Full name</label>" + '<input type="text" id="mf-full" value="' + esc(m.full) + '">' +
      "<label>Role</label>" + '<input type="text" id="mf-role" value="' + esc(m.role) + '" placeholder="e.g. Photoshoots · captions">' +
      "<label>Email</label>" + '<input type="text" id="mf-email" value="' + esc(m.email || "") + '">' +
      "<label>Info / notes (visible to the whole team)</label>" +
      '<textarea id="mf-info">' + esc(m.info || "") + "</textarea>" +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline-dark" data-close>Cancel</button>' +
        '<button class="btn btn-gold" id="mf-save">' + (isNew ? "Add employee" : "Save") + "</button>" +
      "</div>" +
      (isNew || m.isOwner ? "" : '<div class="danger-zone"><button class="btn-ghost" id="mf-del">Remove this employee</button></div>')
    );

    $("mf-save").addEventListener("click", function () {
      var name = $("mf-name").value.trim();
      if (!name) { $("mf-name").focus(); return; }
      m.name = name;
      m.full = $("mf-full").value.trim() || name;
      m.role = $("mf-role").value.trim();
      m.email = $("mf-email").value.trim();
      m.info = $("mf-info").value.trim();
      if (isNew) state.team.push(m);
      save();
      closeModal();
      toast(isNew ? "Welcome aboard, " + m.name + " ✳" : "Saved ✳");
      renderAll();
    });
    var del = $("mf-del");
    if (del) del.addEventListener("click", function () {
      var open = state.tasks.filter(function (t) { return t.assigneeId === m.id && t.status !== "done"; }).length;
      if (!confirm("Remove " + m.name + "?" + (open ? " They still have " + open + " open task(s) — those will show as unassigned until you reassign them." : ""))) return;
      state.team = state.team.filter(function (x) { return x.id !== m.id; });
      state.clients.forEach(function (c) { c.team = c.team.filter(function (id) { return id !== m.id; }); });
      if (who === m.id) { who = "alise"; localStorage.setItem(LS_WHO, who); }
      save();
      closeModal();
      toast("Removed");
      renderAll();
    });
  }

  // ---------- link form (owner) ----------
  function linkForm(linkId) {
    var l = linkId ? state.links.find(function (x) { return x.id === linkId; }) : null;
    var isNew = !l;
    l = l || { id: uid(), name: "", emoji: "🔗", desc: "", url: "" };

    openModal(
      "<h3>" + (isNew ? "Add a link" : "Edit link") + "</h3>" +
      "<label>Name</label>" + '<input type="text" id="lf-name" value="' + esc(l.name) + '" placeholder="e.g. Dropbox">' +
      "<label>Emoji</label>" + '<input type="text" id="lf-emoji" value="' + esc(l.emoji) + '" placeholder="📁">' +
      "<label>What is it for?</label>" + '<input type="text" id="lf-desc" value="' + esc(l.desc) + '">' +
      "<label>Web address</label>" + '<input type="text" id="lf-url" value="' + esc(l.url) + '" placeholder="https://…">' +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline-dark" data-close>Cancel</button>' +
        '<button class="btn btn-gold" id="lf-save">' + (isNew ? "Add link" : "Save") + "</button>" +
      "</div>" +
      (isNew ? "" : '<div class="danger-zone"><button class="btn-ghost" id="lf-del">Delete this link</button></div>')
    );

    $("lf-save").addEventListener("click", function () {
      var name = $("lf-name").value.trim();
      var url = $("lf-url").value.trim();
      if (!name) { $("lf-name").focus(); return; }
      if (!url) { $("lf-url").focus(); return; }
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      l.name = name;
      l.emoji = $("lf-emoji").value.trim() || "🔗";
      l.desc = $("lf-desc").value.trim();
      l.url = url;
      if (isNew) state.links.push(l);
      save();
      closeModal();
      toast(isNew ? "Link added ✳" : "Saved ✳");
      renderAll();
    });
    var del = $("lf-del");
    if (del) del.addEventListener("click", function () {
      if (!confirm("Delete the " + l.name + " link?")) return;
      state.links = state.links.filter(function (x) { return x.id !== l.id; });
      save();
      closeModal();
      toast("Deleted");
      renderAll();
    });
  }

  // ---------- time off ----------
  function fmtRange(a, b) {
    return a === b || !b ? fmtDate(a) : fmtDate(a) + " – " + fmtDate(b);
  }
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) { return decodeURIComponent(escape(atob(s))); }

  function timeoffForm(entryId) {
    var owner = isOwner();
    var e0 = entryId ? state.timeoff.find(function (x) { return x.id === entryId; }) : null;
    var isNew = !e0;
    var e = e0 ? JSON.parse(JSON.stringify(e0)) : { id: uid(), memberId: owner ? state.team[0].id : who, start: todayStr(), end: todayStr(), reason: "", status: owner ? "approved" : "requested" };

    openModal(
      "<h3>" + (owner ? (isNew ? "Add time off" : "Edit time off") : "Request time off") + "</h3>" +
      (owner
        ? "<label>Who</label><select id='to-who'>" + state.team.map(function (m) {
            return '<option value="' + m.id + '"' + (m.id === e.memberId ? " selected" : "") + ">" + esc(m.name) + "</option>";
          }).join("") + "</select>"
        : (cloud
            ? "<p style='font-size:14px;margin:0 0 4px'>Your request goes straight to Alise's Team tab — she'll approve or deny it there.</p>"
            : "<p style='font-size:14px;margin:0 0 4px'>This sends an email to Alise and notes your request here on your device.</p>")) +
      "<label>First day off</label>" + '<input type="date" id="to-start" value="' + esc(e.start) + '">' +
      "<label>Last day off</label>" + '<input type="date" id="to-end" value="' + esc(e.end) + '">' +
      "<label>Reason (optional)</label>" + '<input type="text" id="to-reason" value="' + esc(e.reason) + '" placeholder="e.g. family trip">' +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline-dark" data-close>Cancel</button>' +
        '<button class="btn btn-gold" id="to-save">' + (owner ? "Save" : "Send request") + "</button>" +
      "</div>" +
      (owner && !isNew ? '<div class="danger-zone"><button class="btn-ghost" id="to-del">Delete</button></div>' : "")
    );

    $("to-save").addEventListener("click", function () {
      var start = $("to-start").value;
      var end = $("to-end").value || start;
      if (!start) { $("to-start").focus(); return; }
      if (end < start) end = start;
      e.start = start;
      e.end = end;
      e.reason = $("to-reason").value.trim();
      if (owner) {
        e.memberId = $("to-who").value;
        if (isNew) e.status = "approved";
        closeModal();
        toOwnerUpsert(e, isNew).then(function () { if (!cloud) toast("Time off saved ✳"); else toast("Saved 🌴"); });
      } else {
        e.memberId = who;
        e.status = "requested";
        closeModal();
        toSubmitRequest(e).then(function () {
          var m = member(who);
          var subject = "Time off request — " + (m ? m.full : "team");
          var body;
          if (cloud) {
            body = "Hi Alise!\n\nJust a heads-up — I submitted a time off request in Studio HQ:\n\nFrom: " + fmtDate(start) +
              "\nThrough: " + fmtDate(end) +
              (e.reason ? "\nReason: " + e.reason : "") +
              "\n\nIt's waiting on your Team tab.\n\nThank you!\n" + (m ? m.name : "");
            toast("Request sent 🌴 — an email heads-up just opened too");
          } else {
            var reqLink = location.origin + location.pathname + "?req=" +
              encodeURIComponent(b64e(JSON.stringify({ m: who, s: start, e: end, r: e.reason })));
            body = "Hi Alise!\n\nI'd like to request time off:\n\nFrom: " + fmtDate(start) +
              "\nThrough: " + fmtDate(end) +
              (e.reason ? "\nReason: " + e.reason : "") +
              "\n\nApprove or deny it here:\n" + reqLink +
              "\n\nThank you!\n" + (m ? m.name : "");
            toast("Almost done — hit Send in the email that just opened ✉️");
          }
          window.location.href = "mailto:" + encodeURIComponent(state.settings.ownerEmail || "alise@claudeandco.design") +
            "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
        });
      }
    });
    var del = $("to-del");
    if (del) del.addEventListener("click", function () {
      if (!confirm("Delete this time off entry?")) return;
      closeModal();
      toDelete(e.id);
    });
  }

  function timeoffRow(e) {
    var m = member(e.memberId);
    return '<div class="timeoff-row">' +
      '<span class="to-emoji">🌴</span>' +
      (m ? avatarHtml(m) : "") +
      '<span style="flex:1"><b>' + esc(m ? m.name : "?") + "</b> off " + fmtRange(e.start, e.end) +
      (e.reason ? ' <span style="color:var(--muted)">· ' + esc(e.reason) + "</span>" : "") + "</span>" +
      '<span class="pill ' + (e.status === "approved" ? "timeoff" : e.status === "denied" ? "denied" : "requested") + '">' + e.status + "</span>" +
      (isOwner()
        ? (e.status === "requested"
            ? '<button class="btn btn-dark btn-sm" data-to-approve="' + e.id + '">Approve</button>' +
              '<button class="btn btn-rust btn-sm" data-to-deny="' + e.id + '">Deny</button>'
            : "") +
          '<button class="task-edit" data-to-edit="' + e.id + '" title="Edit">✎</button>'
        : "") +
      "</div>";
  }
  function bindTimeoffButtons(root) {
    root.querySelectorAll("[data-to-approve]").forEach(function (b) {
      b.addEventListener("click", function () { toSetStatus(b.dataset.toApprove, "approved", "Approved 🌴"); });
    });
    root.querySelectorAll("[data-to-deny]").forEach(function (b) {
      b.addEventListener("click", function () { toSetStatus(b.dataset.toDeny, "denied", "Denied — let them know 💬"); });
    });
    root.querySelectorAll("[data-to-edit]").forEach(function (b) {
      b.addEventListener("click", function () { timeoffForm(b.dataset.toEdit); });
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
      "<h2>" + greeting() + ", " + esc(m ? m.name : "friend") + " 🌸</h2>" +
      '<p class="view-sub">' + dateLine + "</p>" +
      mineToggle("today") +
      '<div class="stats">' +
        '<div class="stat' + (overdue.length ? " warn" : " go") + '"><div class="n">' + overdue.length + '</div><div class="l">Overdue</div></div>' +
        '<div class="stat gold"><div class="n">' + dueToday.length + '</div><div class="l">Due today</div></div>' +
        '<div class="stat"><div class="n">' + inprog.length + '</div><div class="l">In progress</div></div>' +
        '<div class="stat"><div class="n">' + shootsWeek.length + '</div><div class="l">Shoots this week</div></div>' +
      "</div>" +
      '<div class="section-label">Progress to 100%</div>' +
      progressCard((m ? m.name : "You"), state.tasks.filter(function (t) { return t.assigneeId === who; }), m) +
      progressCard("The whole team", state.tasks, null);

    if (overdue.length) {
      html += '<div class="section-label">Needs attention</div>' + overdue.map(function (t) { return taskRow(t); }).join("");
    }

    html += '<div class="section-label">Today, client by client' +
      (isOwner() ? ' <button class="btn btn-dark btn-sm" data-newtask>+ Task</button>' : "") + "</div>";

    var todays = sortTasks(pool.filter(function (t) { return t.due === today; }));
    if (!todays.length) {
      html += '<div class="empty">Nothing due today' + (mineOnly.today ? " for you" : "") + ". Lovely. 🌿</div>";
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
      html += '<div class="section-label">Past clients</div><div class="client-grid">' + archived.map(clientCard).join("") + "</div>";
    }
    v.innerHTML = html;

    function clientCard(c) {
      var open = openTasks().filter(function (t) { return t.clientId === c.id; });
      var od = open.filter(isOverdue).length;
      return '<div class="card" data-client="' + c.id + '" style="cursor:pointer">' +
        '<div class="card-head"><div><h3 class="card-title">' + esc(c.name) + "</h3>" +
        '<div class="card-sub">' + esc(c.services || "") + "</div></div>" +
        '<span class="pill ' + c.status + '">' + statusLabel(c.status) + "</span></div>" +
        '<div class="meta-row"><span class="avatars">' + c.team.map(function (id) { return avatarHtml(member(id)); }).join("") + "</span> " +
        "&nbsp;" + open.length + " open task" + (open.length === 1 ? "" : "s") +
        (od ? ' · <span style="color:var(--rose-deep);font-weight:700">' + od + " overdue</span>" : "") + "</div>" +
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
      '<span class="pill ' + c.status + '">' + statusLabel(c.status) + "</span></div>";
    if (c.contact) html += '<div class="meta-row"><b>Contact:</b> ' + esc(c.contact) + "</div>";
    if (c.email) html += '<div class="meta-row"><b>Email:</b> <a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a></div>";
    if (c.phone) html += '<div class="meta-row"><b>Phone:</b> <a href="tel:' + esc(c.phone.replace(/[^0-9+]/g, "")) + '">' + esc(c.phone) + "</a></div>";
    if (c.services) html += '<div class="meta-row"><b>Services:</b> ' + esc(c.services) + "</div>";
    if (c.loomly) html += '<div class="meta-row"><b>Calendar:</b> ' + esc(c.loomly) + "</div>";
    if (c.team.length) html += '<div class="meta-row" style="margin-top:6px"><span class="avatars">' + c.team.map(function (id) { return avatarHtml(member(id)); }).join("") + "</span> &nbsp;" +
      c.team.map(function (id) { var mm = member(id); return mm ? mm.name : ""; }).filter(Boolean).join(" · ") + "</div>";
    if (c.notes) html += '<div class="task-notes" style="margin-top:8px">' + esc(c.notes) + "</div>";

    if (list.length) html += progressCard("Progress for " + c.name, list, null, true);

    html += '<div class="section-label" style="margin-top:16px">Open' +
      (isOwner() ? ' <button class="btn btn-dark btn-sm" id="cd-add">+ Task</button>' : "") + "</div>";
    html += open.length ? open.map(function (t) { return taskRow(t, { hideClient: true }); }).join("") : '<div class="empty">Nothing open.</div>';
    if (done.length) {
      html += '<div class="section-label">Done</div>' + done.map(function (t) { return taskRow(t, { hideClient: true }); }).join("");
    }
    html += '<div class="modal-actions">' +
      (isOwner() ? '<button class="btn btn-outline-dark" id="cd-edit">Edit client</button>' : "") +
      '<button class="btn btn-gold" data-close>Close</button></div>';
    if (isOwner()) {
      html += '<div class="danger-zone"><button class="btn-ghost" id="cd-archive">' +
        (c.status === "archived" ? "🌱 Make active again" : "📁 Move to past clients") + "</button></div>";
    }

    openModal(html);
    bindTaskButtons($("modal"));
    var add = $("cd-add");
    if (add) add.addEventListener("click", function () { taskForm(null, cid); });
    var ed = $("cd-edit");
    if (ed) ed.addEventListener("click", function () { clientForm(cid); });
    var arch = $("cd-archive");
    if (arch) arch.addEventListener("click", function () {
      c.status = c.status === "archived" ? "active" : "archived";
      save();
      closeModal();
      toast(c.status === "archived" ? c.name + " moved to past clients 📁" : c.name + " is active again 🌱");
      renderAll();
    });
    $("modal").querySelectorAll("[data-cycle]").forEach(function (b) {
      b.addEventListener("click", function () { setTimeout(function () { clientDetail(cid); }, 0); });
    });
  }

  function renderTeam() {
    var v = $("view-team");
    var today = todayStr();
    var upcomingOff = state.timeoff
      .filter(function (e) { return e.end >= today; })
      .sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });

    var html = "<h2>The team</h2>" +
      '<p class="view-sub">Who\'s carrying what, and how far along everyone is</p>';

    html += progressCard("Team progress", state.tasks, null);

    html += '<div class="section-label">Time off' +
      (isOwner()
        ? ' <button class="btn btn-dark btn-sm" id="to-add">+ Add time off</button>'
        : ' <button class="btn btn-dark btn-sm" id="to-request">🌴 Request time off</button>') +
      "</div>";
    html += upcomingOff.length
      ? upcomingOff.map(timeoffRow).join("")
      : '<div class="empty">No time off coming up.</div>';

    html += '<div class="section-label">Everyone' +
      (isOwner() ? ' <button class="btn btn-dark btn-sm" id="mf-add">+ Employee</button>' : "") + "</div>";

    state.team.forEach(function (m) {
      var mineAll = state.tasks.filter(function (t) { return t.assigneeId === m.id; });
      var mine = sortTasks(mineAll.filter(function (t) { return t.status !== "done"; }));
      var shoots = mine.filter(function (t) { return t.kind === "shoot"; });
      html += '<div class="card">' +
        '<div class="card-head"><div style="display:flex;align-items:center;gap:10px">' + avatarHtml(m, true) +
        "<div><h3 class='card-title'>" + esc(m.full) + "</h3><div class='card-sub'>" + esc(m.role) + "</div></div></div>" +
        '<span style="display:flex;gap:6px;align-items:center">' +
          '<span class="pill todo">' + mine.length + " open</span>" +
          (isOwner() ? '<button class="task-edit" data-mf-edit="' + m.id + '" title="Edit">✎</button>' : "") +
        "</span></div>" +
        (m.email ? '<div class="meta-row"><b>Email:</b> <a href="mailto:' + esc(m.email) + '">' + esc(m.email) + "</a></div>" : "") +
        (m.info ? '<div class="task-notes" style="margin-bottom:8px">' + esc(m.info) + "</div>" : "") +
        progressCard(m.name + "'s progress", mineAll, null, true) +
        (mine.length
          ? mine.map(function (t) { return taskRow(t, { hideWho: true, inCard: true }); }).join("")
          : '<div class="empty">All clear 🌿</div>') +
        (shoots.length ? '<div class="card-sub" style="margin-top:4px">📷 ' + shoots.length + " shoot" + (shoots.length === 1 ? "" : "s") + " coming up</div>" : "") +
        "</div>";
    });
    v.innerHTML = html;
    bindTaskButtons(v);
    bindTimeoffButtons(v);
    var toAdd = $("to-add");
    if (toAdd) toAdd.addEventListener("click", function () { timeoffForm(null); });
    var toReq = $("to-request");
    if (toReq) toReq.addEventListener("click", function () { timeoffForm(null); });
    var mfAdd = $("mf-add");
    if (mfAdd) mfAdd.addEventListener("click", function () { memberForm(null); });
    v.querySelectorAll("[data-mf-edit]").forEach(function (b) {
      b.addEventListener("click", function () { memberForm(b.dataset.mfEdit); });
    });
  }

  function renderSchedule() {
    var v = $("view-schedule");
    var today = todayStr();
    var pool = mineOnly.schedule ? mineFilter(state.tasks) : state.tasks;
    var upcoming = sortTasks(pool.filter(function (t) { return t.status !== "done" && t.due && t.due >= today; }));
    var byDay = {};
    upcoming.forEach(function (t) { (byDay[t.due] = byDay[t.due] || { tasks: [], off: [] }).tasks.push(t); });
    state.timeoff.forEach(function (e) {
      if (e.status !== "approved" || e.end < today) return;
      if (mineOnly.schedule && e.memberId !== who) return;
      var key = e.start >= today ? e.start : today;
      (byDay[key] = byDay[key] || { tasks: [], off: [] }).off.push(e);
    });
    var days = Object.keys(byDay).sort();

    var html = "<h2>Schedule</h2>" +
      '<p class="view-sub">Shoots, deadlines, and time off — day by day</p>' +
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
        byDay[day].off.map(timeoffRow).join("") +
        byDay[day].tasks.map(function (t) { return taskRow(t); }).join("") + "</div>";
    });
    v.innerHTML = html;
    bindTaskButtons(v);
    bindTimeoffButtons(v);
    bindMineToggle(v, "schedule");
    var nb = v.querySelector("[data-newshoot]");
    if (nb) nb.addEventListener("click", function () {
      taskForm(null);
      var shootBtn = document.querySelector('#tf-kind [data-k="shoot"]');
      if (shootBtn) shootBtn.click();
    });
  }

  function renderLinks() {
    var v = $("view-links");
    v.innerHTML = "<h2>Studio links</h2>" +
      '<p class="view-sub">Every tool we use, one tap away</p>' +
      (isOwner() ? '<div class="filter-row"><button class="btn btn-dark btn-sm" id="lf-add">+ Add link</button></div>' : "") +
      '<div class="links-grid">' + state.links.map(function (l) {
        return '<a class="link-card" href="' + esc(l.url) + '" target="_blank" rel="noopener">' +
          '<div class="emoji">' + esc(l.emoji) + '</div><div class="name">' + esc(l.name) + '</div>' +
          '<div class="desc">' + esc(l.desc) + "</div>" +
          (isOwner() ? '<button class="link-edit" data-lf-edit="' + l.id + '" title="Edit">✎</button>' : "") +
          "</a>";
      }).join("") + "</div>";
    var add = $("lf-add");
    if (add) add.addEventListener("click", function () { linkForm(null); });
    v.querySelectorAll("[data-lf-edit]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        linkForm(b.dataset.lfEdit);
      });
    });
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
    // Local-only mode fallback (cloud mode saves live and hides this button).
    state.publishedAt = Date.now();
    save();
    var out = JSON.parse(JSON.stringify(state));
    var file = "/* Claude & Co. Studio HQ — published data (" + new Date().toLocaleString() + ") */\n" +
      "(function () { window.CCO_SEED = " + JSON.stringify(out, null, 2) + "; })();\n";
    download("cco-hq-data.js", file);
    openModal(
      "<h3>Almost published 🌸</h3>" +
      "<p style='font-size:14px'>A file called <b>cco-hq-data.js</b> just downloaded. It has everything you changed.</p>" +
      "<p style='font-size:14px'>Now just tell Claude:</p>" +
      "<p style='background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:12px;font-weight:700'>“Publish my Studio HQ updates”</p>" +
      '<div class="modal-actions"><button class="btn btn-gold" data-close>Got it</button></div>'
    );
  });

  $("settings-btn").addEventListener("click", function () {
    openModal(
      "<h3>Settings</h3>" +
      "<label>Studio password (whole team)</label>" +
      '<input type="text" id="st-access" value="' + esc(state.settings.accessCode) + '">' +
      (cloud
        ? '<p class="hint">Your owner password is managed in Supabase (Authentication → Users), not here.</p>'
        : "<label>Owner PIN (just you)</label>" +
          '<input type="text" id="st-pin" value="' + esc(state.settings.ownerPin) + '">') +
      "<label>Owner email (time-off requests go here)</label>" +
      '<input type="text" id="st-email" value="' + esc(state.settings.ownerEmail || "") + '">' +
      (cloud
        ? '<p class="hint">Changes save live for everyone — tell the team if you change the studio password.</p>'
        : '<p class="hint">If you change these, hit Publish so the live site gets the new ones — and tell the team the new password.</p>') +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline-dark" data-close>Cancel</button>' +
        '<button class="btn btn-gold" id="st-save">Save</button>' +
      "</div>" +
      '<div class="danger-zone">' +
        '<button class="btn-ghost" id="st-export">Download a backup</button>' +
        (cloud ? "" : '<br><button class="btn-ghost" id="st-reset">Reset my device to the published version</button>') +
      "</div>"
    );
    $("st-save").addEventListener("click", function () {
      var ac = $("st-access").value.trim();
      var em = $("st-email").value.trim();
      if (ac) state.settings.accessCode = ac;
      if (em) state.settings.ownerEmail = em;
      if (!cloud) {
        var pin = $("st-pin").value.trim();
        if (pin) state.settings.ownerPin = pin;
      }
      save();
      closeModal();
      toast("Settings saved 🌸");
    });
    $("st-export").addEventListener("click", function () {
      download("cco-hq-backup.json", JSON.stringify(state, null, 2));
      toast("Backup downloaded");
    });
    var rst = $("st-reset");
    if (rst) rst.addEventListener("click", function () {
      if (!confirm("Replace what's on this device with the published version?")) return;
      localStorage.removeItem(LS_STATE);
      state = loadState();
      closeModal();
      toast("Back to the published version");
      renderAll();
    });
  });

  // ---------- incoming time-off request link (old emails, local mode) ----------
  function handleRequestLink() {
    var raw = new URLSearchParams(location.search).get("req");
    if (!raw) return;
    history.replaceState(null, "", location.pathname);
    var req;
    try { req = JSON.parse(b64d(raw)); } catch (err) { return; }
    if (!req || !req.s) return;
    var m = member(req.m);
    var name = m ? m.full : "Someone";

    function decide(approve) {
      if (!isOwner()) { ownerLogin(function () { decide(approve); }); return; }
      var entry = { id: uid(), memberId: req.m, start: req.s, end: req.e || req.s, reason: req.r || "", status: approve ? "approved" : "denied" };
      closeModal();
      toOwnerUpsert(entry, true).then(function () {
        toast(approve ? "Approved 🌴 — it's on the schedule" : "Denied — let them know 💬");
      });
    }

    openModal(
      "<h3>🌴 Time off request</h3>" +
      '<div class="timeoff-row"><span class="to-emoji">🌴</span>' + (m ? avatarHtml(m) : "") +
      "<span style='flex:1'><b>" + esc(name) + "</b> asks for " + fmtRange(req.s, req.e || req.s) +
      (req.r ? ' <span style="color:var(--muted)">· ' + esc(req.r) + "</span>" : "") + "</span></div>" +
      "<p class='hint'>You'll be asked for your owner login if it's off.</p>" +
      '<div class="modal-actions">' +
        '<button class="btn btn-rust" id="req-deny">Deny</button>' +
        '<button class="btn btn-gold" id="req-approve">Approve 🌴</button>' +
      "</div>" +
      '<div class="danger-zone"><button class="btn-ghost" data-close>Decide later</button></div>'
    );
    $("req-approve").addEventListener("click", function () { decide(true); });
    $("req-deny").addEventListener("click", function () { decide(false); });
  }

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

  if (cloud) {
    sb.auth.getSession().then(function (res) {
      ownerFlag = !!(res.data && res.data.session);
      renderAll();
    });
    sb.auth.onAuthStateChange(function (event, session) {
      ownerFlag = !!session;
      renderOwnerUI();
    });
    refreshCloud().then(handleRequestLink);
    setInterval(function () {
      if (document.visibilityState === "visible") refreshCloud();
    }, 30000);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") refreshCloud();
    });
  } else {
    handleRequestLink();
  }
})();
