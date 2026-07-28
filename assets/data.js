/* Claude & Co. Studio HQ — seed data.
   This is the baseline everyone sees on first visit. Alise's in-app edits
   save on her device and go live for the team via "Publish to team"
   (see README.md). Dates below are relative to today so the board always
   looks current until real dates are set in the app. */

(function () {
  function d(offsetDays) {
    var t = new Date();
    t.setDate(t.getDate() + offsetDays);
    var m = String(t.getMonth() + 1).padStart(2, "0");
    var day = String(t.getDate()).padStart(2, "0");
    return t.getFullYear() + "-" + m + "-" + day;
  }

  window.CCO_SEED = {
    version: 1,
    settings: {
      accessCode: "goldenhour",
      ownerPin: "2026"
    },
    team: [
      { id: "alise",   name: "Alise",   full: "Alise McCreary",         role: "Owner · creative director", color: "#d99a1e", isOwner: true },
      { id: "hannah",  name: "Hannah",  full: "Hannah Edmunds",         role: "Photoshoots · captions · Loomly drafts", color: "#c75b24", isOwner: false },
      { id: "brailey", name: "Brailey", full: "Brailey Connor",         role: "Loomly scheduling · photoshoots", color: "#7d8450", isOwner: false },
      { id: "maddie",  name: "Maddie",  full: "Madison Taylor Newsom",  role: "Client outreach · JM Services Loomly", color: "#8a6f4e", isOwner: false }
    ],
    clients: [
      {
        id: "kristie", name: "Kristie Bridgers", status: "active",
        contact: "Kristie Bridgers", email: "kbridgers@mac.com", phone: "(662) 801-4712",
        rate: "$927/mo", services: "Social media content · lead outreach · brand collabs",
        loomly: "Kristie Bridgers", team: ["hannah", "brailey"],
        notes: "Hannah leads captions + content. Collabs inbox: kbridgerscollabs@gmail.com (DM outreach only). Tends to pay late — remind 2–3 days before due."
      },
      {
        id: "rightway", name: "Right-Way Realty", status: "active",
        contact: "April White", email: "april@right-wayrealty.com", phone: "(662) 801-6806",
        rate: "$850/mo", services: "Social media content · real estate marketing",
        loomly: "April Wright", team: ["brailey"],
        notes: "Brailey leads. April is very collaborative — “I'm going to let you make the call.”"
      },
      {
        id: "jm", name: "JM Services", status: "active",
        contact: "Mike Jones", email: "mjones@jmservices.biz", phone: "(662) 554-1056",
        rate: "$500–540/mo", services: "Monthly social media · CU project collab",
        loomly: "JM Services", team: ["maddie"],
        notes: "VIP — longest-running client, never missed a payment. Maddie owns the Loomly calendar. CU project with Cara (cara@odie-bs.com)."
      },
      {
        id: "ggfry", name: "G&G Fry Co.", status: "active",
        contact: "Brashonda", email: "gg.fryco@gmail.com", phone: "(662) 801-4604",
        rate: "$463.50/mo", services: "Social media content · occasional design",
        loomly: "G&G Fry Co.", team: ["brailey"],
        notes: "Pays late consistently — send reminders 2–3 days before due."
      },
      {
        id: "ellas-lambeth", name: "Ella's Table + Lambeth Lounge", status: "active",
        contact: "Danielle", email: "", phone: "",
        rate: "$400/mo", services: "Social media for both venues",
        loomly: "Hey Orca — Ella's & Lambeth", team: ["alise", "hannah"],
        notes: "Kickoff July 13. Paid by mailed corporate check every Wednesday. Ella's = refined classic Southern dining; Lambeth = hotel lounge, 40+ alumni crowd — lean into “romanticize campus.”"
      },
      {
        id: "anchorbay", name: "Anchor Bay Therapy", status: "active",
        contact: "Brandice Valentino", email: "", phone: "",
        rate: "Project-based", services: "Social media · brand strategy · domains",
        loomly: "", team: ["alise"],
        notes: "Two brands: Anchor Bay Therapy + Creativity People. Calm, clean, minimalist + San Miguel + bright/happy. GoDaddy customer ID 17196504."
      },
      {
        id: "windowjoe", name: "Window Joe Oxford", status: "pending",
        contact: "Joe Climer", email: "windowjoeoxford@gmail.com", phone: "(662) 281-6936",
        rate: "$500/mo (proposed)", services: "Social media · Squarespace landing page",
        loomly: "", team: ["hannah", "alise"],
        notes: "Contract pending. Wants a Squarespace landing page tied to Google Ads. Tech dinosaur — extra hand-holding."
      }
    ],
    tasks: [
      // ---- today ----
      { id: "t1", clientId: "kristie", title: "Draft this week's captions in Loomly", assigneeId: "hannah", due: d(0), time: "", status: "inprogress", kind: "task", location: "", notes: "" },
      { id: "t2", clientId: "rightway", title: "Schedule this week's Loomly posts", assigneeId: "brailey", due: d(0), time: "", status: "todo", kind: "task", location: "", notes: "" },
      { id: "t3", clientId: "ellas-lambeth", title: "Send Danielle the weekly recap + this week's post plan", assigneeId: "alise", due: d(0), time: "", status: "todo", kind: "task", location: "", notes: "" },
      { id: "t4", clientId: "jm", title: "10 outreach emails — Oxford market", assigneeId: "maddie", due: d(0), time: "", status: "inprogress", kind: "task", location: "", notes: "Log follow-ups in the prospect sheet." },
      // ---- overdue example ----
      { id: "t5", clientId: "windowjoe", title: "Answer Joe's timeline question + send contract", assigneeId: "alise", due: d(-2), time: "", status: "todo", kind: "task", location: "", notes: "Hold the June invoice until signed." },
      // ---- this week ----
      { id: "t6", clientId: "ggfry", title: "Payment reminder (due date coming up)", assigneeId: "alise", due: d(1), time: "", status: "todo", kind: "task", location: "", notes: "" },
      { id: "t7", clientId: "kristie", title: "August content calendar draft", assigneeId: "hannah", due: d(3), time: "", status: "todo", kind: "task", location: "", notes: "" },
      { id: "t8", clientId: "anchorbay", title: "Check GoDaddy for overpayments + domain status", assigneeId: "alise", due: d(2), time: "", status: "todo", kind: "task", location: "", notes: "" },
      { id: "t9", clientId: "ellas-lambeth", title: "Build first round of post drafts — both venues", assigneeId: "hannah", due: d(4), time: "", status: "inprogress", kind: "task", location: "", notes: "" },
      { id: "t10", clientId: "jm", title: "CU project outline — call Mike for data", assigneeId: "alise", due: d(2), time: "", status: "todo", kind: "task", location: "", notes: "Loop in Cara." },
      // ---- shoots ----
      { id: "s1", clientId: "ellas-lambeth", title: "Brunch + porch shoot — Ella's & Lambeth", assigneeId: "hannah", due: d(2), time: "09:30", status: "todo", kind: "shoot", location: "Ella's Table, Oxford", notes: "Golden-hour porch shots at Lambeth after brunch service." },
      { id: "s2", clientId: "rightway", title: "New listing shoot", assigneeId: "brailey", due: d(4), time: "15:00", status: "todo", kind: "shoot", location: "Oxford — address from April", notes: "" },
      { id: "s3", clientId: "kristie", title: "Fall lookbook content shoot", assigneeId: "hannah", due: d(8), time: "10:00", status: "todo", kind: "shoot", location: "Studio", notes: "" },
      // ---- done example ----
      { id: "t11", clientId: "rightway", title: "July invoice sent", assigneeId: "alise", due: d(-1), time: "", status: "done", kind: "task", location: "", notes: "" }
    ],
    links: [
      { name: "Loomly", emoji: "📅", desc: "Social scheduling — Brailey owns calendars, Maddie owns JM", url: "https://www.loomly.com/" },
      { name: "Hey Orca", emoji: "🐳", desc: "Ella's Table + Lambeth Lounge calendar", url: "https://www.heyorca.com/" },
      { name: "Square Invoices", emoji: "💸", desc: "Invoicing + payments", url: "https://squareup.com/dashboard/invoices" },
      { name: "Canva", emoji: "🎨", desc: "Design — client folders live here", url: "https://www.canva.com/" },
      { name: "Gmail", emoji: "✉️", desc: "alise@claudeandco.design", url: "https://mail.google.com/" },
      { name: "Google Calendar", emoji: "🗓", desc: "Shoots + client calls", url: "https://calendar.google.com/" },
      { name: "Google Analytics", emoji: "📈", desc: "Client site + web traffic", url: "https://analytics.google.com/" },
      { name: "Framer", emoji: "🖥", desc: "claudeandco.design website", url: "https://framer.com/" },
      { name: "GoDaddy", emoji: "🌐", desc: "Domains — claudeandco.design + client domains", url: "https://www.godaddy.com/" },
      { name: "Notta", emoji: "🎧", desc: "Meeting notes + transcripts", url: "https://www.notta.ai/" },
      { name: "Manychat", emoji: "💬", desc: "DM automation", url: "https://manychat.com/" },
      { name: "Venmo", emoji: "💵", desc: "Team payouts", url: "https://venmo.com/" }
    ]
  };
})();
