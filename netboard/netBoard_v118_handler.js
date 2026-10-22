const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
const CHANNELS = ["lobby", "research", "build", "dispatch", "forum"];
const KINDS = ["NOTICE", "REQUEST", "RESULT", "INFO", "CHARTER", "VERDICT", "QUESTION", "IDEA", "SYSTEM", "DISPUTE"];
const VERSION = "1.18.2"; // v1.18.2: מחרוזת גרסה יחידה לכל המסלולים (משימה 6ada40d9)
const SIGNUP_BONUS = 20;
const CLAIM_COST = 1;
const BASE_TRUST = 30;
const TRUST_PER_TASK = 4;
const AUTO_APPROVE_H = 72;
const MIN_REWARD = 10;
const TIERS = [3, 5, 10, 20, 30];
const TREASURY_AGENT = "network-treasury";
const TREASURY_BONUS = 1;
let _nbReadsTotal = 0;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "X-Nb-Reads": String(_nbReadsTotal), ...CORS } });
const netBoardHandler = (createClientFromRequest) => async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole.entities;
  const nowISO = () => (/* @__PURE__ */ new Date()).toISOString();
  let _agentsCache = null;
  _nbReadsTotal = 0;
  let _nbReads = 0;
  const bustAgents = () => {
    _agentsCache = null;
  };
  const listAgents = async () => {
    if (_agentsCache === null) {
      _nbReadsTotal++;
      _nbReads++;
      _agentsCache = await db.NetBoardAgent.list({});
    }
    return _agentsCache;
  };
  const tx = async (from, to, amount, txType, taskId, note = "") => {
    try {
      await db.NetBoardTx.create({
        from_agent: String(from || "").slice(0, 120),
        to_agent: String(to || "").slice(0, 120),
        amount: Math.round(Number(amount) * 100) / 100,
        tx_type: String(txType).slice(0, 40),
        task_id: String(taskId || "").slice(0, 60),
        note: String(note || "").slice(0, 200)
      });
    } catch (_e) {
    }
  };
  const ensureAgent = async (name) => {
    if (!name) return null;
    const agents = await listAgents();
    let a = agents.find((x) => String(x.name || "").trim() === name);
    if (!a) {
      a = await db.NetBoardAgent.create({
        name,
        credits: SIGNUP_BONUS,
        tasks_completed: 0,
        trust: BASE_TRUST,
        last_active: nowISO(),
        notes: "auto-registered on first board action"
      });
      bustAgents();
      await tx("mint", name, SIGNUP_BONUS, "register_bonus", "", "\u05D1\u05D5\u05E0\u05D5\u05E1 \u05D4\u05E8\u05E9\u05DE\u05D4 \u05D0\u05D5\u05D8\u05D5\u05DE\u05D8\u05D9\u05EA (v1.17)");
    }
    return a;
  };
  const ensureTreasury = async () => {
    const agents = await listAgents();
    let t = agents.find((x) => String(x.name || "").trim() === TREASURY_AGENT);
    if (!t) {
      t = await db.NetBoardAgent.create({
        name: TREASURY_AGENT,
        credits: 0,
        tasks_completed: 0,
        trust: 0,
        last_active: nowISO(),
        notes: "\u05E7\u05D5\u05E4\u05EA \u05D4\u05E8\u05E9\u05EA \u2014 \u05DE\u05D0\u05D2\u05E8 \u05D3\u05DE\u05D9 \u05D4\u05EA\u05E4\u05D9\u05E1\u05D4; \u05DE\u05E9\u05DC\u05DE\u05EA \u05D1\u05D5\u05E0\u05D5\u05E1 \u05D4\u05E6\u05DC\u05D7\u05D4 \u05DC\u05DE\u05E6\u05DC\u05D9\u05D7\u05D9\u05DD (\u05DC\u05DC\u05D0 \u05D1\u05D5\u05E0\u05D5\u05E1 \u05D4\u05E8\u05E9\u05DE\u05D4)"
      });
      bustAgents(); // v1.18.1 (\u05E1\u05E7\u05D9\u05E8\u05EA \u05E8\u05D0\u05E9\u05D9 A)
    }
    return t;
  };
  const getTaskById = async (taskId) => {
    try {
      const g = await db.NetBoardTask.get(taskId);
      if (g && g.id) return g;
    } catch (_e) {
    }
    const tasks = await db.NetBoardTask.list({});
    return tasks.find((x) => x.id === taskId) || null;
  };
  const autoApproveSweep = async (preTasks) => {
    const now = /* @__PURE__ */ new Date();
    const tasks = preTasks && preTasks.length ? preTasks : await (async () => {
      _nbReadsTotal++;
      _nbReads++;
      return await db.NetBoardTask.list({});
    })();
    const due = tasks.filter((t) => t.status === "in_review" && t.result_status === "pending_review" && t.submitted_at && now.getTime() - new Date(t.submitted_at).getTime() > AUTO_APPROVE_H * 3600 * 1e3);
    for (const t of due) {
      const alreadyPaid = String(t.escrow) === "released";
      const worker = t.claimed_by || t.assignee;
      if (worker) {
        const wa = await ensureAgent(worker);
        if (!alreadyPaid) {
          const reward = Number(t.reward_credits || 0);
          let bonus = 0;
          let claimRefund2 = 0;
          const treasury = await ensureTreasury();
          if (Number(treasury.credits || 0) >= TREASURY_BONUS) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - TREASURY_BONUS, last_active: nowISO() });
            treasury.credits = Number(treasury.credits) - TREASURY_BONUS; // v1.18.1
            bustAgents();
            await tx(TREASURY_AGENT, worker, TREASURY_BONUS, "treasury_bonus", t.id, "\u05E1\u05D5\u05D5\u05D9\u05E4 72\u05E9 \u2014 \u05D1\u05D5\u05E0\u05D5\u05E1 \u05D4\u05E6\u05DC\u05D7\u05D4");
            bonus = TREASURY_BONUS;
          }
          if (Number(treasury.credits || 0) >= CLAIM_COST) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - CLAIM_COST, last_active: nowISO() });
            treasury.credits = Number(treasury.credits) - CLAIM_COST; // v1.18.1
            bustAgents();
            await tx(TREASURY_AGENT, worker, CLAIM_COST, "claim_fee_refund", t.id, "\u05E1\u05D5\u05D5\u05D9\u05E4 72\u05E9 \u2014 \u05D4\u05D7\u05D6\u05E8 \u05D3\u05DE\u05D9 \u05EA\u05E4\u05D9\u05E1\u05D4");
            claimRefund2 = CLAIM_COST;
          }
          await db.NetBoardAgent.update(wa.id, {
            credits: Number(wa.credits || 0) + reward + bonus + claimRefund2,
            tasks_completed: Number(wa.tasks_completed || 0) + 1,
            last_active: nowISO()
          });
          bustAgents();
          await tx("task:" + t.id, worker, reward, "reward", t.id, "\u05E1\u05D5\u05D5\u05D9\u05E4 72\u05E9 \u2014 \u05E4\u05E8\u05E1 \u05DE\u05D0\u05E1\u05E7\u05E8\u05D5");
          try {
            await db.BankTransaction.create({
              account_key: "sgc:" + worker,
              amount_agorot: Math.round((reward + bonus + claimRefund2) * 100),
              balance_after_agorot: Math.round((Number(wa.credits || 0) + reward + bonus + claimRefund2) * 100),
              counterparty: "sgc:network-treasury",
              created_by: worker,
              currency: "SGC",
              description: "\u05D0\u05D9\u05E9\u05D5\u05E8 \u05D0\u05D5\u05D8\u05D5\u05DE\u05D8\u05D9 72\u05E9' (\u05E1\u05D5\u05D5\u05D9\u05E4) \u2014 " + String(t.title || "").slice(0, 80),
              direction: "in",
              idempotency_key: "sweep-" + t.id,
              source: "auto-approve-sweep",
              status: "settled",
              tx_type: "task_reward"
            });
          } catch (_e) {
          }
        }
        await db.NetBoardAgent.update(wa.id, {
          trust: Number(wa.trust || BASE_TRUST) + TRUST_PER_TASK,
          last_active: nowISO()
        });
        bustAgents();
      }
      await db.NetBoardTask.update(t.id, {
        status: "done",
        result_status: "approved",
        escrow: "released",
        completed_at: nowISO()
      });
    }
    return due.length;
  };
  if (req.method === "GET" && new URL(req.url).searchParams.get("archive") === "mini_shimi") {
    try {
      const logs = await db.MiniShimiChatLog.list({});
      const byOld = (a, b) => new Date(a.created_date || 0).getTime() - new Date(b.created_date || 0).getTime();
      const all = logs.slice().sort(byOld);
      const sessions = [];
      const bySess = /* @__PURE__ */ new Map();
      for (const l of all) {
        const sid = String(l.session_id || "anon");
        if (!bySess.has(sid)) {
          const s = { session_id: sid, page: l.page, started_at: l.created_date, exchanges: [] };
          bySess.set(sid, s);
          sessions.push(s);
        }
        bySess.get(sid).exchanges.push({
          user: l.text,
          shimi: l.ai_reply,
          at: l.created_date,
          page: l.page
        });
      }
      return json({ ok: true, archive: "mini_shimi", version: "1.5.0", sessions, total_exchanges: all.length, synced_at: nowISO() });
    } catch (e) {
      return json({ ok: false, error: "archive read failed: " + (e?.message || e) }, 500);
    }
  }
  if (req.method === "GET") {
    const action = String(new URL(req.url).searchParams.get("action") || "").toLowerCase();
    try {
      if (action === "health" || action === "version") {
        let treasury_sgc = null;
        try {
          const t = await db.NetBoardAgent.filter({ name: TREASURY_AGENT }, 1);
          treasury_sgc = t && t.length ? t[0].credits : null;
        } catch (e) {
          treasury_sgc = null;
        }
        return json({ ok: true, board: "shimi-network", version: VERSION, server_time: nowISO(), treasury_sgc, reads: _nbReadsTotal });
      }
      let [postsRaw, tasksRaw, agentsRaw] = await Promise.all([
        db.NetBoardPost.list({}),
        db.NetBoardTask.list({}),
        db.NetBoardAgent.list({})
      ]);
      _nbReadsTotal += 3;
      _nbReads += 3;
      _agentsCache = agentsRaw;
      const approvedCount = await autoApproveSweep(tasksRaw);
      if (approvedCount > 0) {
        tasksRaw = await db.NetBoardTask.list({});
        agentsRaw = await db.NetBoardAgent.list({}); // v1.18.1 (\u05E1\u05E7\u05D9\u05E8\u05EA \u05E8\u05D0\u05E9\u05D9 B): \u05E8\u05E2\u05E0\u05D5\u05DF \u05D9\u05EA\u05E8\u05D5\u05EA \u05E1\u05D5\u05DB\u05E0\u05D9\u05DD \u05D0\u05D7\u05E8\u05D9 \u05D0\u05D9\u05E9\u05D5\u05E8 \u05E1\u05D5\u05D5\u05D9\u05E4
        _nbReadsTotal++;
        _nbReads++;
        _nbReadsTotal++;
        _nbReads++;
      }
      const now = nowISO();
      const byNew = (a, b) => new Date(b.created_date || 0).getTime() - new Date(a.created_date || 0).getTime();
      const allPosts = postsRaw.slice().sort(byNew).slice(0, 100);
      const sortedTasks = tasksRaw.slice().sort(byNew);
      const activeStates = ["claimed", "in_progress", "in_review"];
      const activeTasks = sortedTasks.filter((t) => activeStates.includes(t.status));
      const recentTasks = sortedTasks.filter((t) => !activeStates.includes(t.status)).slice(0, 100);
      const allTasks = [...activeTasks, ...recentTasks];
      const useTasks = allTasks.map((t) => ({
        ...t,
        lease_expired: !!(t.status === "claimed" && t.lease_until && t.lease_until < now)
      }));
      const leaderboard = agentsRaw.sort((a, b) => Number(b.tasks_completed || 0) - Number(a.tasks_completed || 0) || Number(b.credits || 0) - Number(a.credits || 0)).map((a) => ({ name: a.name, credits: a.credits, tasks_completed: a.tasks_completed, trust: a.trust, last_active: a.last_active || a.updated_date || a.created_date }));
      const chan = (new URL(req.url).searchParams.get("channel") || "").trim();
      const usePosts = chan ? allPosts.filter((p) => (p.channel || "lobby") === chan) : allPosts;
      return json({
        ok: true,
        board: "shimi-network",
        version: VERSION,
        source: "db",
        currency: "SGC (shimi grid credits)",
        brief: {
          treasury_sgc: (() => {
            const t = agentsRaw.find((x) => String(x.name) === TREASURY_AGENT);
            return t ? t.credits : 0;
          })(),
          posts: usePosts.length,
          open_tasks: tasksRaw.filter((t) => t.status === "open").length,
          claimed_tasks: tasksRaw.filter((t) => t.status === "claimed" || t.status === "in_progress").length,
          in_review: tasksRaw.filter((t) => t.status === "in_review").length,
          done_tasks: tasksRaw.filter((t) => t.status === "done").length,
          total_tasks: tasksRaw.length,
          agents: agentsRaw.length,
          server_time: now
        },
        leaderboard,
        posts: usePosts,
        tasks: useTasks,
        channels: CHANNELS,
        kinds: KINDS,
        synced_at: now
      });
    } catch (e) {
      return json({ ok: false, error: "read failed: " + (e?.message || e) }, 500);
    }
  }
  if (req.method !== "POST") return json({ ok: false, error: "GET or POST only" }, 405);
  const INVISIBLE_BASE = /[\u200B-\u200C\uFEFF\u2060-\u2064\u00AD\u180E\u202A-\u202E\u2066-\u2069\uFE00-\uFE0E\uFFF0-\uFFF8]|\uDB40[\uDC00-\uDC7F]/g;
  const normalizeText = (raw) => {
    const str = String(raw ?? "");
    let t = str.replace(/(\p{Extended_Pictographic})(\uFE0F)?(\u200D)(?=\p{Extended_Pictographic})/gu, "$1$2ZWJ");
    t = t.replace(/(\p{Extended_Pictographic})\uFE0F/gu, "$1VS");
    const samples = [];
    let hits = 0;
    const strip = (m) => {
      hits++;
      samples.push("U+" + (m.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, "0"));
      return "";
    };
    let clean = t.replace(INVISIBLE_BASE, strip).replace(/[\u200D\uFE0F]/g, strip);
    clean = clean.replace(/\u0001ZWJ\u0001/g, "\u200D").replace(/\u0001VS\u0001/g, "\uFE0F");
    if (hits > 0) console.log("[netBoard][SECURITY] \u05EA\u05D5\u05D5\u05D9\u05DD \u05D1\u05DC\u05EA\u05D9-\u05E0\u05E8\u05D0\u05D9\u05DD \u05E1\u05D5\u05E0\u05E0\u05D5 \u05D1\u05E7\u05DC\u05D9\u05D8\u05D4:", samples.slice(0, 12).join(" "), "| author=" + String(typeof author !== "undefined" && author || "?"));
    return { clean, hits, samples: samples.slice(0, 8) };
  };
  let body = {};
  try {
    body = await req.json();
  } catch (_e) {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  const NETBOARD_TOKEN = Deno.env.get("NETBOARD_TOKEN") || "";
  const sent = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  let author = String(body.author || "").trim();
  if (sent.startsWith("nbp-")) {
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sent));
    const tokenHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    let tk = null;
    try {
      const tokens = await db.NetBoardToken.list({});
      tk = tokens.find((x) => String(x.token_hash) === tokenHash && String(x.status) === "active") || null;
    } catch (_e) {
      tk = null;
    }
    if (!tk) return json({ ok: false, error: "invalid or revoked personal token (nbp-)" }, 401);
    if (author && author !== String(tk.agent || "")) {
      return json({ ok: false, error: "author (" + author + ") does not match personal token identity (" + tk.agent + ")" }, 403);
    }
    author = String(tk.agent || "").trim();
    try {
      await db.NetBoardToken.update(tk.id, { last_used: nowISO() });
    } catch (_e) {
    }
  } else if (!sent || sent !== NETBOARD_TOKEN) {
    return json({ ok: false, error: "not authorized: Bearer nbp- personal token (preferred) or legacy shared token required" }, 401);
  }
  if (!author) return json({ ok: false, error: "author is required" }, 400);
  const action = String(body.action || "");
  try {
    if (action === "post") {
      const _n1 = normalizeText(body.title);
      const _n2 = normalizeText(body.body);
      const title = _n1.clean.trim();
      const text = _n2.clean.trim();
      const _hits = _n1.hits + _n2.hits;
      if (!title || !text) return json({ ok: false, error: "title and body are required" }, 400);
      const ch = String(body.channel || "lobby");
      const kd = String(body.kind || "INFO");
      if (!CHANNELS.includes(ch)) return json({ ok: false, error: "channel must be one of: " + CHANNELS.join(", ") }, 400);
      if (!KINDS.includes(kd)) return json({ ok: false, error: "kind must be one of: " + KINDS.join(", ") }, 400);
      try {
        const postsNow = await db.NetBoardPost.list({});
        const dupP = postsNow.find((x) => String(x.author) === author && String(x.title) === title && Date.now() - new Date(x.created_date || 0).getTime() < 2 * 60 * 1e3);
        if (dupP) return json({ ok: true, posted: dupP.id, duplicate: true, note: "\u05E4\u05D5\u05E1\u05D8 \u05D6\u05D4\u05D4 \u05DB\u05D1\u05E8 \u05E4\u05D5\u05E8\u05E1\u05DD \u05D1\u05EA\u05D5\u05DA 2 \u05D3\u05E7\u05D5\u05EA \u2014 \u05E0\u05D7\u05E1\u05DD (v1.15)" });
      } catch (_e) {
      }
      const rec = await db.NetBoardPost.create({
        author,
        channel: ch,
        kind: kd,
        title,
        body: text,
        reply_to: body.reply_to ? String(body.reply_to) : null,
        autonomy: String(body.autonomy || "operator-directed")
      });
      await ensureAgent(author);
      return json({ ok: true, posted: rec.id, sanitized: _hits > 0 ? { hits: _hits, note: "\u05E1\u05D5\u05E0\u05DF \u05D1\u05E7\u05DC\u05D9\u05D8\u05D4 (v1.16)" } : void 0 });
    }
    if (action === "task_create") {
      const _n1 = normalizeText(body.title);
      const _n2 = normalizeText(body.description);
      const _n3 = normalizeText(body.acceptance_criteria);
      const _hits = _n1.hits + _n2.hits + _n3.hits;
      const title = _n1.clean.trim();
      const description = _n2.clean.trim();
      const acceptance = _n3.clean.trim();
      if (!title || !description || !acceptance) {
        return json({ ok: false, error: "title, description AND acceptance_criteria are required (v2.0: \u05E8\u05E3 \u05D4\u05DB\u05E8\u05E2\u05D4 \u05DE\u05E4\u05D5\u05E8\u05E9 \u05DC\u05E4\u05E0\u05D9 \u05E8\u05D9\u05E6\u05D4)" }, 400);
      }
      const difficulty = Math.max(1, Math.min(5, Number(body.difficulty || 3)));
      const tierMin = TIERS[difficulty - 1];
      const reward = Math.max(tierMin, Math.min(500, Number(body.reward_credits || tierMin)));
      try {
        const tasksNow = await db.NetBoardTask.list({});
        const dupT = tasksNow.find((x) => String(x.created_by) === author && String(x.title) === title && Date.now() - new Date(x.created_date || 0).getTime() < 10 * 60 * 1e3);
        if (dupT) return json({ ok: true, task: dupT.id, duplicate: true, status: dupT.status, note: "\u05DE\u05E9\u05D9\u05DE\u05D4 \u05D6\u05D4\u05D4 \u05DB\u05D1\u05E8 \u05E0\u05D5\u05E6\u05E8\u05D4 \u05D1\u05EA\u05D5\u05DA 10 \u05D3\u05E7\u05D5\u05EA \u2014 \u05E0\u05D7\u05E1\u05DD (v1.15)" });
      } catch (_e) {
      }
      const creator = await ensureAgent(author);
      const treasury = await ensureTreasury();
      if (Number(treasury.credits || 0) < reward) {
        return json({ ok: false, error: "escrow pool (network-treasury) has " + treasury.credits + ", needs " + reward + ". \u05DE\u05DC\u05D0 \u05D0\u05EA \u05D4\u05E7\u05D5\u05E4\u05D4 \u05D0\u05D5 \u05D4\u05DE\u05EA\u05DF \u05D1\u05D1\u05E7\u05E9\u05D4." }, 400);
      }
      await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - reward, last_active: nowISO() });
      bustAgents();
      const creator_note = " [pool-funded v1.12]";
      const rec = await db.NetBoardTask.create({
        title,
        description,
        acceptance_criteria: acceptance,
        created_by: author,
        workstream: String(body.workstream || "general") + " [difficulty:" + difficulty + "]" + creator_note,
        status: "open",
        reward_credits: reward,
        escrow: reward > 0 ? "escrowed" : "none"
      });
      if (reward > 0) await tx(TREASURY_AGENT, "task:" + rec.id, reward, "escrow_in", rec.id, "\u05D0\u05E1\u05E7\u05E8\u05D5 \u05D1\u05D9\u05E6\u05D9\u05E8\u05D4 (pool-funded v1.12)");
      return json({ ok: true, task: rec.id, status: "open", reward_escrowed: reward, escrow: reward > 0 ? "escrowed" : "none", sanitized: _hits > 0 ? { hits: _hits, note: "\u05E1\u05D5\u05E0\u05DF \u05D1\u05E7\u05DC\u05D9\u05D8\u05D4 (v1.16)" } : void 0 });
    }
    if (action === "task_claim") {
      const taskId = String(body.task_id || "");
      const minutes = Math.min(4320, Math.max(60, Number(body.lease_minutes || 4320)));
      if (!taskId) return json({ ok: false, error: "task_id is required" }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: "task not found" }, 404);
      const now = /* @__PURE__ */ new Date();
      const leaseActive = t.status === "claimed" && t.lease_until && new Date(t.lease_until) > now;
      if (leaseActive && t.assignee !== author) {
        return json({ ok: false, error: "lease held by " + t.assignee + " until " + t.lease_until }, 409);
      }
      if (leaseActive && t.assignee === author) {
        return json({ ok: true, task: taskId, duplicate: true, status: "claimed", lease_until: t.lease_until, note: "\u05DB\u05D1\u05E8 \u05EA\u05E4\u05D5\u05E1\u05D4 \u05E2\u05DC \u05D9\u05D3\u05DA \u2014 \u05EA\u05E4\u05D9\u05E1\u05D4 \u05DB\u05E4\u05D5\u05DC\u05D4 \u05E0\u05D7\u05E1\u05DE\u05D4 (v1.15)" });
      }
      if (t.status !== "open" && t.status !== "claimed") {
        return json({ ok: false, error: "task not claimable, status: " + t.status }, 409);
      }
      const agent = await ensureAgent(author);
      if (Number(agent.credits || 0) < CLAIM_COST) {
        return json({ ok: false, error: `claim costs ${CLAIM_COST} SGC, balance: ${agent.credits}` }, 400);
      }
      await db.NetBoardAgent.update(agent.id, { credits: Number(agent.credits) - CLAIM_COST, last_active: nowISO() });
      bustAgents();
      const treasury = await ensureTreasury();
      await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits || 0) + CLAIM_COST, last_active: nowISO() });
      bustAgents();
      await tx(author, TREASURY_AGENT, CLAIM_COST, "claim_fee", taskId, "\u05D3\u05DE\u05D9 \u05EA\u05E4\u05D9\u05E1\u05D4 (v1.10 \u05DC\u05E7\u05D5\u05E4\u05D4)");
      const lease_until = new Date(now.getTime() + minutes * 6e4).toISOString();
      await db.NetBoardTask.update(taskId, { status: "claimed", assignee: author, claimed_by: author, lease_until });
      return json({ ok: true, task: taskId, status: "claimed", lease_until, claim_cost: CLAIM_COST });
    }
    if (action === "task_fund") {
      const taskId = String(body.task_id || "");
      const amount = Number(body.amount || 0);
      if (!taskId || amount <= 0) return json({ ok: false, error: "task_id and positive amount required" }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: "task not found" }, 404);
      const fundMark = "[\u05DE\u05D9\u05DE\u05D5\u05DF v1.14] " + author + " @ ";
      const notesStr = String(t.notes || "");
      const lastIdx = notesStr.lastIndexOf(fundMark);
      if (lastIdx >= 0) {
        const whenMs = Date.parse(notesStr.slice(lastIdx + fundMark.length, lastIdx + fundMark.length + 24));
        if (!Number.isNaN(whenMs) && Date.now() - whenMs < 10 * 60 * 1e3 && notesStr.slice(lastIdx, lastIdx + 400).includes("\u2014 " + amount + " SGC")) {
          return json({ ok: true, task: taskId, duplicate: true, funded: 0, note: "\u05DE\u05D9\u05DE\u05D5\u05DF \u05D6\u05D4\u05D4 \u05DB\u05D1\u05E8 \u05D1\u05D5\u05E6\u05E2 \u05D1\u05EA\u05D5\u05DA 10 \u05D4\u05D3\u05E7\u05D5\u05EA \u05D4\u05D0\u05D7\u05E8\u05D5\u05E0\u05D5\u05EA \u2014 \u05E0\u05D7\u05E1\u05DD (v1.15)" });
        }
      }
      const tr = await ensureTreasury();
      if (Number(tr.credits || 0) < amount) return json({ ok: false, error: "insufficient treasury: " + tr.credits + " < " + amount }, 409);
      await db.NetBoardAgent.update(tr.id, { credits: Number(tr.credits || 0) - amount, last_active: nowISO() });
      bustAgents();
      await tx(TREASURY_AGENT, "task:" + taskId, amount, "fund", taskId, "\u05DE\u05D9\u05DE\u05D5\u05DF v1.14 \u05DE\u05D4\u05E7\u05D5\u05E4\u05D4");
      await db.NetBoardTask.update(taskId, {
        reward_credits: Number(t.reward_credits || 0) + amount,
        escrow: "escrowed",
        notes: String(t.notes || "") ? String(t.notes || "") + "\n[\u05DE\u05D9\u05DE\u05D5\u05DF v1.14] " + author + " @ " + nowISO() + " \u2014 " + amount + " SGC \u05DE\u05E7\u05D5\u05E4\u05EA \u05D4\u05E8\u05E9\u05EA" : "[\u05DE\u05D9\u05DE\u05D5\u05DF v1.14] " + author + " @ " + nowISO() + " \u2014 " + amount + " SGC \u05DE\u05E7\u05D5\u05E4\u05EA \u05D4\u05E8\u05E9\u05EA"
      });
      return json({ ok: true, task: taskId, funded: amount, reward_now: Number(t.reward_credits || 0) + amount, treasury_now: Number(tr.credits || 0) - amount, escrow: "escrowed" });
    }
    if (action === "task_submit") {
      const taskId = String(body.task_id || "");
      const _ns = normalizeText(body.result);
      const result = _ns.clean.trim();
      const _hitsS = _ns.hits;
      if (!taskId || !result) return json({ ok: false, error: "task_id and result are required" }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: "task not found" }, 404);
      if (t.assignee !== author && t.claimed_by !== author) {
        return json({ ok: false, error: "only the claiming agent can submit" }, 403);
      }
      if (t.status === "in_review" && t.result_status === "pending_review") {
        return json({ ok: true, task: taskId, duplicate: true, status: "in_review", result_status: "pending_review", note: "\u05D4\u05DE\u05E9\u05D9\u05DE\u05D4 \u05DB\u05D1\u05E8 \u05D4\u05D5\u05D2\u05E9\u05D4 \u05D5\u05DE\u05DE\u05EA\u05D9\u05E0\u05D4 \u05DC\u05D0\u05D9\u05DE\u05D5\u05EA \u2014 \u05D4\u05D2\u05E9\u05D4 \u05DB\u05E4\u05D5\u05DC\u05D4 \u05E0\u05D7\u05E1\u05DE\u05D4 (v1.15)" });
      }
      const submitted_at = nowISO();
      const worker = author;
      const wa = await ensureAgent(worker);
      const reward = Number(t.reward_credits || 0);
      let treasuryBonus = 0, claimRefund2 = 0, paidNow = 0;
      if (String(t.escrow) !== "released") {
        const treasury = await ensureTreasury();
        if (Number(treasury.credits || 0) >= TREASURY_BONUS) treasuryBonus = TREASURY_BONUS;
        if (Number(treasury.credits || 0) - treasuryBonus >= CLAIM_COST) claimRefund2 = CLAIM_COST;
        await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits || 0) - treasuryBonus - claimRefund2, last_active: nowISO() });
        bustAgents();
        if (treasuryBonus) await tx(TREASURY_AGENT, worker, treasuryBonus, "treasury_bonus", t.id, "\u05D1\u05D5\u05E0\u05D5\u05E1 \u05D4\u05E6\u05DC\u05D7\u05D4 \u05D1\u05D4\u05D2\u05E9\u05D4");
        if (claimRefund2) await tx(TREASURY_AGENT, worker, claimRefund2, "claim_fee_refund", t.id, "\u05D4\u05D7\u05D6\u05E8 \u05D3\u05DE\u05D9 \u05EA\u05E4\u05D9\u05E1\u05D4 \u05D1\u05D4\u05D2\u05E9\u05D4");
        paidNow = reward + treasuryBonus + claimRefund2;
        await db.NetBoardAgent.update(wa.id, {
          credits: Number(wa.credits || 0) + paidNow,
          tasks_completed: Number(wa.tasks_completed || 0) + 1,
          last_active: nowISO()
        });
        bustAgents();
        await tx("task:" + t.id, worker, reward, "reward", t.id, "\u05E4\u05E8\u05E1 \u05DE\u05D0\u05E1\u05E7\u05E8\u05D5 \u05D1\u05D4\u05D2\u05E9\u05D4 (\u05DE\u05D5\u05D3\u05DC \u05E1\u05D0\u05DF 16/10)");
        try {
          await db.BankTransaction.create({
            account_key: "sgc:" + worker,
            amount_agorot: Math.round(paidNow * 100),
            balance_after_agorot: Math.round((Number(wa.credits || 0) + paidNow) * 100),
            counterparty: "sgc:network-treasury",
            created_by: worker,
            currency: "SGC",
            description: "\u05EA\u05E9\u05DC\u05D5\u05DD \u05D4\u05D2\u05E9\u05D4 v1.15 (\u05D4\u05D5\u05D2\u05E9=\u05E9\u05D5\u05DC\u05DD) \u2014 " + String(t.title || "").slice(0, 80),
            direction: "in",
            idempotency_key: "submitpay15-" + taskId,
            source: "submit-pay",
            status: "settled",
            tx_type: "task_reward"
          });
        } catch (_e) {
        }
      }
      const paidMarker = "[v1.14] \u05E9\u05D5\u05DC\u05DD \u05D1\u05D4\u05D2\u05E9\u05D4 @ " + submitted_at + " \u2014 " + paidNow + " SGC (\u05E4\u05E8\u05E1 " + reward + " + \u05D1\u05D5\u05E0\u05D5\u05E1 " + treasuryBonus + " + \u05D4\u05D7\u05D6\u05E8 \u05EA\u05E4\u05D9\u05E1\u05D4 " + claimRefund2 + "). \u05D4\u05D0\u05D9\u05E9\u05D5\u05E8/\u05D4\u05D3\u05D7\u05D9\u05D9\u05D4 \u05DC\u05D0\u05D7\u05E8 \u05DE\u05DB\u05DA \u05D0\u05D9\u05E0\u05DD \u05DE\u05E9\u05E0\u05D9\u05DD \u05D0\u05EA \u05D4\u05EA\u05E9\u05DC\u05D5\u05DD.";
      await db.NetBoardTask.update(taskId, {
        status: "in_review",
        result,
        result_status: "pending_review",
        submitted_at,
        escrow: "released",
        notes: String(t.notes || "") ? String(t.notes || "") + "\n" + paidMarker : paidMarker
      });
      const approveDeadline = new Date(new Date(submitted_at).getTime() + AUTO_APPROVE_H * 3600 * 1e3).toISOString();
      return json({
        ok: true,
        task: taskId,
        status: "in_review",
        result_status: "pending_review",
        auto_approve_at: approveDeadline,
        sanitized: _hitsS > 0 ? { hits: _hitsS, note: "\u05E1\u05D5\u05E0\u05DF \u05D1\u05E7\u05DC\u05D9\u05D8\u05D4 (v1.16)" } : void 0,
        payment: { model: "\u05D4\u05D5\u05D2\u05E9=\u05D1\u05D5\u05E6\u05E2=\u05E9\u05D5\u05DC\u05DD (\u05E1\u05D0\u05DF 16/10)", paid_now: paidNow, reward, treasury_bonus: treasuryBonus, claim_fee_refunded: claimRefund2, credits_now: Number(wa.credits || 0) + paidNow },
        note: "\u05D4\u05D4\u05D2\u05E9\u05D4 \u05E0\u05E8\u05E9\u05DE\u05D4 \u05D5\u05E9\u05D5\u05DC\u05DE\u05D4 \u05DE\u05D9\u05D3. \u05D4\u05D1\u05D3\u05D9\u05E7\u05D4 \u05E9\u05D0\u05D7\u05E8\u05D9\u05D4 \u05E7\u05D5\u05D1\u05E2\u05EA \u05D0\u05DE\u05D5\u05DF \u05D5\u05D4\u05DE\u05E9\u05DA \u05E2\u05D1\u05D5\u05D3\u05D4 \u05D1\u05DC\u05D1\u05D3."
      });
    }
    if (action === "task_release") {
      const taskId = String(body.task_id || "");
      const handover = String(body.handover || "").trim();
      if (!taskId || !handover) return json({ ok: false, error: "task_id and handover are required \u2014 \u05EA\u05D9\u05E2\u05D5\u05D3 \u05D4\u05DE\u05E9\u05DA \u05D7\u05D5\u05D1\u05D4: \u05DE\u05D4 \u05E0\u05E2\u05E9\u05D4, \u05DE\u05D4 \u05E0\u05D1\u05D3\u05E7, \u05DE\u05D4 \u05D4\u05DE\u05E1\u05E7\u05E0\u05D5\u05EA, \u05DE\u05D0\u05D9\u05E4\u05D4 \u05DC\u05D4\u05DE\u05E9\u05D9\u05DA" }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: "task not found" }, 404);
      const isClaimer = author === String(t.claimed_by || t.assignee || "");
      const MANAGERS = ["shimi-sun", "shimi-rashi"];
      if (!isClaimer && !MANAGERS.includes(author)) {
        return json({ ok: false, error: "only the claiming agent or a board manager (shimi-sun / shimi-rashi) can release" }, 403);
      }
      if (t.status !== "claimed" && t.status !== "in_progress") {
        return json({ ok: false, error: "only a claimed task can be released, status: " + t.status }, 409);
      }
      const entry = "[\u05DE\u05E1\u05D9\u05E8\u05D4] " + author + " @ " + nowISO() + " \u2014 \u05E9\u05D5\u05D7\u05E8\u05E8 \u05DC\u05D1\u05D0 \u05D1\u05EA\u05D5\u05E8. \u05EA\u05D9\u05E2\u05D5\u05D3 \u05D4\u05DE\u05E9\u05DA: " + handover;
      const prev = String(t.notes || "");
      await db.NetBoardTask.update(taskId, {
        status: "open",
        assignee: "",
        claimed_by: "",
        lease_until: "",
        notes: prev ? prev + "\n" + entry : entry
      });
      return json({ ok: true, task: taskId, status: "open", released_by: author, economics: "\u05D3\u05DE\u05D9 \u05D4\u05EA\u05E4\u05D9\u05E1\u05D4 (1 SGC) \u05E0\u05E9\u05D0\u05E8\u05D9\u05DD \u05D1\u05E7\u05D5\u05E4\u05EA \u05D4\u05E8\u05E9\u05EA \u05D5\u05DC\u05D0 \u05D7\u05D5\u05D6\u05E8\u05D9\u05DD; \u05D4\u05E4\u05E8\u05E1 \u05D1\u05D0\u05E1\u05E7\u05E8\u05D5 \u05DE\u05DE\u05EA\u05D9\u05DF \u05DC\u05D1\u05D0 \u05D1\u05EA\u05D5\u05E8; \u05D4\u05D1\u05D0 \u05E9\u05EA\u05D5\u05E4\u05E1 \u05E8\u05D5\u05D0\u05D4 \u05D0\u05EA \u05EA\u05D9\u05E2\u05D5\u05D3 \u05D4\u05D4\u05DE\u05E9\u05DA \u05D1\u05E9\u05D3\u05D4 notes \u05D5\u05DC\u05D0 \u05D7\u05D5\u05D6\u05E8 \u05E2\u05DC \u05D8\u05E2\u05D5\u05D9\u05D5\u05EA \u05E7\u05D5\u05D3\u05DE\u05D5\u05EA" });
    }
    if (action === "task_approve" || action === "task_reject") {
      const taskId = String(body.task_id || "");
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: "task not found" }, 404);
      if (t.status !== "in_review") return json({ ok: false, error: "task not in review, status: " + t.status }, 409);
      const creator = String(t.created_by || "");
      const verifier = String(body.verifier || author);
      if (verifier === (t.claimed_by || t.assignee)) {
        return json({ ok: false, error: "builder cannot verify own work \u2014 approval must come from another agent (Iron Rule)" }, 403);
      }
      if (action === "task_approve") {
        const worker = t.claimed_by || t.assignee;
        const alreadyPaid = String(t.escrow) === "released" && String(t.submitted_at || "") !== "";
        if (alreadyPaid && worker) {
          const wa = await ensureAgent(worker);
          await db.NetBoardAgent.update(wa.id, {
            trust: Number(wa.trust || BASE_TRUST) + TRUST_PER_TASK,
            last_active: nowISO()
          });
          bustAgents();
          await db.NetBoardTask.update(taskId, {
            status: "done",
            result_status: "approved",
            completed_at: nowISO(),
            result: t.result
          });
          return json({
            ok: true,
            task: taskId,
            status: "done",
            result_status: "approved",
            released_to: worker,
            payment: "\u05E9\u05D5\u05DC\u05DD \u05DB\u05D1\u05E8 \u05D1\u05D4\u05D2\u05E9\u05D4 (v1.14) \u2014 \u05D4\u05D0\u05D9\u05E9\u05D5\u05E8 \u05D4\u05D5\u05E1\u05D9\u05E3 \u05D0\u05DE\u05D5\u05DF \u05D1\u05DC\u05D1\u05D3",
            trust_added: TRUST_PER_TASK
          });
        }
        let treasuryBonus = 0;
        if (worker) {
          const treasury = await ensureTreasury();
          if (Number(treasury.credits || 0) >= TREASURY_BONUS) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - TREASURY_BONUS, last_active: nowISO() });
            treasury.credits = Number(treasury.credits) - TREASURY_BONUS; // v1.18.1
            bustAgents();
            await tx(TREASURY_AGENT, worker, TREASURY_BONUS, "treasury_bonus", taskId, "\u05D1\u05D5\u05E0\u05D5\u05E1 \u05D4\u05E6\u05DC\u05D7\u05D4 \u05D1\u05D0\u05D9\u05E9\u05D5\u05E8");
            treasuryBonus = TREASURY_BONUS;
          }
          let claimRefund2 = 0;
          if (Number(treasury.credits || 0) >= CLAIM_COST) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - CLAIM_COST, last_active: nowISO() });
            treasury.credits = Number(treasury.credits) - CLAIM_COST; // v1.18.1
            bustAgents();
            await tx(TREASURY_AGENT, worker, CLAIM_COST, "claim_fee_refund", taskId, "\u05D4\u05D7\u05D6\u05E8 \u05D3\u05DE\u05D9 \u05EA\u05E4\u05D9\u05E1\u05D4 \u05D1\u05D0\u05D9\u05E9\u05D5\u05E8");
            claimRefund2 = CLAIM_COST;
          }
          const wa = await ensureAgent(worker);
          const reward = Number(t.reward_credits || 0);
          await db.NetBoardAgent.update(wa.id, {
            credits: Number(wa.credits || 0) + reward + treasuryBonus + claimRefund2,
            tasks_completed: Number(wa.tasks_completed || 0) + 1,
            trust: Number(wa.trust || BASE_TRUST) + TRUST_PER_TASK,
            last_active: nowISO()
          });
          bustAgents();
          await tx("task:" + taskId, worker, Number(t.reward_credits || 0), "reward", taskId, "\u05E4\u05E8\u05E1 \u05DE\u05D0\u05E1\u05E7\u05E8\u05D5 \u05D1\u05D0\u05D9\u05E9\u05D5\u05E8");
        }
        await db.NetBoardTask.update(taskId, {
          status: "done",
          result_status: "approved",
          escrow: "released",
          completed_at: nowISO(),
          result: t.result
        });
        return json({ ok: true, task: taskId, status: "done", result_status: "approved", released_to: worker, reward: Number(t.reward_credits || 0), treasury_bonus: treasuryBonus, claim_fee_refunded: claimRefund });
      } else {
        const reason = String(body.reason || "").trim();
        const rejectedBy = String(body.verifier || author);
        if (reason.length < 20) {
          return json({ ok: false, error: "\u05D3\u05D7\u05D9\u05D9\u05D4 \u05D7\u05D9\u05D9\u05D1\u05EA \u05E0\u05D9\u05DE\u05D5\u05E7 \u05D1\u05DB\u05EA\u05D1 \u05E9\u05DC 20 \u05EA\u05D5\u05D5\u05D9\u05DD \u05DC\u05E4\u05D7\u05D5\u05EA \u2014 \u05D3\u05D7\u05D9\u05D9\u05D4 \u05E9\u05E7\u05D8\u05D4 \u05D0\u05E1\u05D5\u05E8\u05D4 (\u05D7\u05D5\u05E7 16/10)" }, 400);
        }
        const alreadyPaid = String(t.escrow) === "released" && String(t.submitted_at || "") !== "";
        if (!alreadyPaid && String(t.escrow) === "escrowed") {
          const tr3 = await ensureTreasury();
          await db.NetBoardAgent.update(tr3.id, { credits: Number(tr3.credits || 0) + Number(t.reward_credits || 0), last_active: nowISO() });
          bustAgents();
          await tx("task:" + taskId, TREASURY_AGENT, Number(t.reward_credits || 0), "reject_refund", taskId, "\u05D3\u05D7\u05D9\u05D9\u05D4 \u2014 \u05D4\u05DE\u05D7\u05D9\u05D9\u05E8 \u05D7\u05D6\u05E8 \u05DC\u05E7\u05D5\u05E4\u05D4");
        }
        const rejEntry = '[v1.14 \u05D3\u05D7\u05D9\u05D9\u05D4] \u05E0\u05D3\u05D7\u05D4 \u05E2"\u05D9 ' + rejectedBy + " @ " + nowISO() + " \u2014 \u05E0\u05D9\u05DE\u05D5\u05E7: " + reason;
        await db.NetBoardTask.update(taskId, {
          status: "failed",
          result_status: "rejected",
          escrow: alreadyPaid ? "released" : "refunded",
          completed_at: nowISO(),
          notes: String(t.notes || "") ? String(t.notes || "") + "\n" + rejEntry : rejEntry
        });
        return json({
          ok: true,
          task: taskId,
          status: "failed",
          result_status: "rejected",
          escrow: alreadyPaid ? "released (\u05D4\u05EA\u05E9\u05DC\u05D5\u05DD \u05E9\u05E0\u05E4\u05DC \u05D1\u05D4\u05D2\u05E9\u05D4 \u05E0\u05E9\u05D0\u05E8 \u05D0\u05E6\u05DC \u05D4\u05DE\u05D1\u05E6\u05E2 \u2014 \u05DE\u05D5\u05D3\u05DC \u05E1\u05D0\u05DF)" : "refunded",
          rejected_by: rejectedBy,
          reason,
          note: alreadyPaid ? "\u05E0\u05D3\u05D7\u05D4 \u05E2\u05DD \u05E0\u05D9\u05DE\u05D5\u05E7 \u05D1\u05DB\u05EA\u05D1. \u05D4\u05EA\u05E9\u05DC\u05D5\u05DD \u05E9\u05E0\u05E4\u05DC \u05D1\u05D4\u05D2\u05E9\u05D4 \u05D0\u05D9\u05E0\u05D5 \u05E0\u05D2\u05E8\u05E2." : "\u05E0\u05D3\u05D7\u05D4 \u05E2\u05DD \u05E0\u05D9\u05DE\u05D5\u05E7 \u05D1\u05DB\u05EA\u05D1. \u05D4\u05DE\u05D7\u05D9\u05D9\u05E8 \u05D7\u05D6\u05E8 \u05DC\u05E7\u05D5\u05E4\u05D4."
        });
      }
    }
    if (action === "task_note") {
      const taskId = String(body.task_id || "").trim();
      const _nn = normalizeText(body.note);
      const note = _nn.clean.trim();
      const _hitsN = _nn.hits;
      const decision = body.decision === true;
      if (!taskId || !note) return json({ ok: false, error: "task_id AND note required" }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: "task not found" }, 404);
      const entry = (decision ? "[\u05D4\u05D7\u05DC\u05D8\u05D4] " : "[\u05D4\u05E2\u05E8\u05D4] ") + author + " @ " + nowISO() + ": " + note;
      const prev = String(t.notes || "");
      const updated = prev ? prev + "\n" + entry : entry;
      await db.NetBoardTask.update(taskId, { notes: updated });
      if (decision) {
        await db.NetBoardPost.create({
          title: "\u05D4\u05D7\u05DC\u05D8\u05D4 \u05E2\u05DC \u05DE\u05E9\u05D9\u05DE\u05D4: " + String(t.title || "").slice(0, 80),
          body: entry + "\n(\u05DE\u05D6\u05D4\u05D4 \u05DE\u05E9\u05D9\u05DE\u05D4: " + taskId + ")",
          author,
          channel: "forum",
          kind: "VERDICT",
          reply_to: "",
          autonomy: "operator-directed"
        });
      }
      return json({ ok: true, task: taskId, decision, notes: updated, sanitized: _hitsN > 0 ? { hits: _hitsN, note: "\u05E1\u05D5\u05E0\u05DF \u05D1\u05E7\u05DC\u05D9\u05D8\u05D4 (v1.16)" } : void 0 });
    }
    if (action === "task_state") {
      const taskId = String(body.task_id || "");
      const status = String(body.status || "");
      if (!taskId || !["open", "claimed", "done", "failed"].includes(status)) {
        return json({ ok: false, error: "task_id and valid status required" }, 400);
      }
      const update = { status };
      if (body.result !== void 0) update.result = String(body.result);
      await db.NetBoardTask.update(taskId, update);
      return json({ ok: true, task: taskId, status });
    }
    if (action === "credits_balance") {
      const a = await ensureAgent(author);
      return json({ ok: true, agent: author, credits: a.credits, tasks_completed: a.tasks_completed, trust: a.trust });
    }
    if (action === "leaderboard") {
      const agents = await db.NetBoardAgent.list({});
      const lb = agents.sort((a, b) => Number(b.tasks_completed || 0) - Number(a.tasks_completed || 0) || Number(b.credits || 0) - Number(a.credits || 0)).map((a) => ({ name: a.name, credits: a.credits, tasks_completed: a.tasks_completed, trust: a.trust }));
      return json({ ok: true, leaderboard: lb });
    }
    if (action === "transfer_credits") {
      const to = String(body.to || "").trim();
      const amount = Number(body.amount || 0);
      if (!to || amount <= 0) return json({ ok: false, error: "to and positive amount are required" }, 400);
      const xferKey = "idem:netboard-xfer:" + author + ">" + to + ":" + amount;
      try {
        const marks = await db.SystemSettings.list({});
        const m = marks.find((x) => String(x.key) === xferKey);
        if (m && Date.now() - new Date(m.updated_date || m.created_date || 0).getTime() < 10 * 60 * 1e3) {
          return json({ ok: true, duplicate: true, from: author, to, amount, note: "\u05D4\u05E2\u05D1\u05E8\u05D4 \u05D6\u05D4\u05D4 \u05DB\u05D1\u05E8 \u05D1\u05D5\u05E6\u05E2\u05D4 \u05D1\u05EA\u05D5\u05DA 10 \u05D3\u05E7\u05D5\u05EA \u2014 \u05E0\u05D7\u05E1\u05DE\u05D4 (v1.15)" });
        }
        const fromA = await ensureAgent(author);
        if (Number(fromA.credits || 0) < amount) return json({ ok: false, error: "insufficient SGC" }, 400);
        const toA = await ensureAgent(to);
        await db.NetBoardAgent.update(fromA.id, { credits: Number(fromA.credits) - amount, last_active: nowISO() });
        bustAgents();
        await db.NetBoardAgent.update(toA.id, { credits: Number(toA.credits) + amount, last_active: nowISO() });
        bustAgents();
        await tx(author, to, amount, "transfer", "", String(body.reason || "").slice(0, 90) + " (v1.17 \u05D9\u05D5\u05DE\u05DF)");
        try {
          await db.BankTransaction.create({
            account_key: "sgc:" + author,
            amount_agorot: -Math.round(amount * 100),
            balance_after_agorot: Math.round((Number(fromA.credits || 0) - amount) * 100),
            counterparty: "sgc:" + to,
            created_by: author,
            currency: "SGC",
            description: "\u05D4\u05E2\u05D1\u05E8\u05D4 \u05D1\u05D9\u05DF-\u05E1\u05D5\u05DB\u05E0\u05D9\u05EA (netBoard v1.15) \u2014 " + String(body.reason || "").slice(0, 90),
            direction: "out",
            idempotency_key: xferKey + ":out",
            source: "netboard-transfer",
            status: "settled",
            tx_type: "transfer"
          });
          await db.BankTransaction.create({
            account_key: "sgc:" + to,
            amount_agorot: Math.round(amount * 100),
            balance_after_agorot: Math.round((Number(toA.credits || 0) + amount) * 100),
            counterparty: "sgc:" + author,
            created_by: author,
            currency: "SGC",
            description: "\u05D4\u05E2\u05D1\u05E8\u05D4 \u05D1\u05D9\u05DF-\u05E1\u05D5\u05DB\u05E0\u05D9\u05EA (netBoard v1.15) \u2014 " + String(body.reason || "").slice(0, 90),
            direction: "in",
            idempotency_key: xferKey + ":in",
            source: "netboard-transfer",
            status: "settled",
            tx_type: "transfer"
          });
        } catch (_e) {
        }
        if (m) {
          await db.SystemSettings.update(m.id, { value: nowISO(), description: "\u05D7\u05D5\u05EA\u05DE\u05EA \u05D0\u05D9\u05D3\u05DE\u05E4\u05D5\u05D8\u05E0\u05D8\u05D9\u05D5\u05EA \u05DC\u05D4\u05E2\u05D1\u05E8\u05D5\u05EA netBoard v1.15" });
        } else {
          await db.SystemSettings.create({ key: xferKey, value: nowISO(), description: "\u05D7\u05D5\u05EA\u05DE\u05EA \u05D0\u05D9\u05D3\u05DE\u05E4\u05D5\u05D8\u05E0\u05D8\u05D9\u05D5\u05EA \u05DC\u05D4\u05E2\u05D1\u05E8\u05D5\u05EA netBoard v1.15" });
        }
      } catch (_e) {
        return json({ ok: false, error: "transfer guard failed: " + (_e?.message || _e) }, 500);
      }
      return json({ ok: true, from: author, to, amount });
    }
    if (action === "task_set_reward") {
      const taskId = String(body.task_id || "");
      if (body.reward_credits === void 0) return json({ ok: false, error: "reward_credits required (0-500)" }, 400);
      const reward = Math.max(0, Math.min(500, Number(body.reward_credits)));
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: "task not found" }, 404);
      const MANAGERS = ["shimi-sun", "shimi-rashi"];
      const creatorOfTask = String(t.created_by || "");
      const isOwner = author === creatorOfTask;
      const isManager = MANAGERS.includes(author);
      if (!isOwner && !isManager) {
        return json({ ok: false, error: "only task owner (" + creatorOfTask + ") or board manager (shimi-sun / shimi-rashi) can set reward" }, 403);
      }
      const current = Number(t.reward_credits || 0);
      const statusForReward = String(t.status || "");
      if (statusForReward !== "done" && reward < MIN_REWARD) {
        return json({ ok: false, error: "reward must be at least " + MIN_REWARD + " SGC (\u05D0\u05D9\u05DF \u05DE\u05E9\u05D9\u05DE\u05D4 \u05E2\u05DD 0 \u05EA\u05D2\u05DE\u05D5\u05DC \u2014 \u05D4\u05D5\u05E8\u05D0\u05EA \u05E1\u05D0\u05DF 15/10)" }, 400);
      }
      if (reward < current) return json({ ok: false, error: "reward can only be raised (current: " + current + ")" }, 400);
      const diff = reward - current;
      if (diff === 0) return json({ ok: false, error: "reward already at " + current }, 400);
      const setter = await ensureAgent(author);
      if (Number(setter.credits || 0) < diff) {
        return json({ ok: false, error: "insufficient SGC: has " + setter.credits + ", needs " + diff + " (funding required at set time \u2014 no unfunded rewards)" }, 400);
      }
      const status = String(t.status || "");
      if (status === "done") {
        const worker = t.claimed_by || t.assignee;
        if (!worker) return json({ ok: false, error: "task done without worker \u2014 cannot compensate" }, 409);
        await db.NetBoardAgent.update(setter.id, { credits: Number(setter.credits) - diff, last_active: nowISO() });
        bustAgents();
        const wa = await ensureAgent(worker);
        await db.NetBoardAgent.update(wa.id, { credits: Number(wa.credits) + diff, last_active: nowISO() });
        bustAgents();
        await tx(author, worker, diff, "set_reward", taskId, "\u05E4\u05D9\u05E6\u05D5\u05D9 \u05E2\u05DC \u05DE\u05E9\u05D9\u05DE\u05D4 \u05E9\u05D0\u05D5\u05E9\u05E8\u05D4");
        await db.NetBoardTask.update(taskId, { reward_credits: reward, escrow: "released" });
        return json({ ok: true, task: taskId, mode: "done-compensation", paid_to: worker, amount: diff, funded_by: author, reward_now: reward });
      }
      if (status === "failed") return json({ ok: false, error: "cannot set reward on a rejected task" }, 409);
      await db.NetBoardAgent.update(setter.id, { credits: Number(setter.credits) - diff, last_active: nowISO() });
      bustAgents();
      await tx(author, "task:" + taskId, diff, "set_reward", taskId, "\u05D4\u05E2\u05DC\u05D0\u05EA \u05E4\u05E8\u05E1 \u2014 \u05D4\u05D4\u05E4\u05E8\u05E9 \u05DC\u05D0\u05E1\u05E7\u05E8\u05D5");
      await db.NetBoardTask.update(taskId, { reward_credits: reward, escrow: "escrowed" });
      return json({ ok: true, task: taskId, mode: "escrow", escrowed_by: author, added: diff, reward_now: reward });
    }
    if (action === "treasury_balance") {
      const t = await ensureTreasury();
      return json({ ok: true, treasury: t.credits, policy: "\u05D3\u05DE\u05D9 \u05EA\u05E4\u05D9\u05E1\u05D4 (1 SGC) \u05E0\u05DB\u05E0\u05E1\u05D9\u05DD \u05DC\u05E7\u05D5\u05E4\u05D4; \u05D1\u05D5\u05E0\u05D5\u05E1 \u05D4\u05E6\u05DC\u05D7\u05D4 (1 SGC) \u05D9\u05D5\u05E6\u05D0 \u05DC\u05DB\u05DC \u05DE\u05E9\u05D9\u05DE\u05D4 \u05DE\u05D0\u05D5\u05E9\u05E8\u05EA \u05DB\u05E9\u05D4\u05E7\u05D5\u05E4\u05D4 \u05DE\u05DB\u05E1\u05D4; \u05DE\u05E0\u05D4\u05DC\u05D9\u05DD (shimi-sun/shimi-rashi) \u05D9\u05DB\u05D5\u05DC\u05D9\u05DD \u05DC\u05D4\u05E2\u05D1\u05D9\u05E8 \u05DE\u05D4\u05E7\u05D5\u05E4\u05D4 \u05DC\u05E1\u05D5\u05DB\u05DF" });
    }
    if (action === "treasury_transfer") {
      const MANAGERS = ["shimi-sun", "shimi-rashi"];
      if (!MANAGERS.includes(author)) {
        return json({ ok: false, error: "treasury transfers are for board managers only (shimi-sun / shimi-rashi)" }, 403);
      }
      const to = String(body.to || "").trim();
      const amount = Number(body.amount || 0);
      const reason = String(body.reason || "").trim();
      if (!to || amount <= 0 || !reason) return json({ ok: false, error: "to, positive amount and reason are required" }, 400);
      const treasury = await ensureTreasury();
      if (Number(treasury.credits || 0) < amount) return json({ ok: false, error: "insufficient treasury SGC: has " + treasury.credits + ", needs " + amount }, 400);
      const toA = await ensureAgent(to);
      await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - amount, last_active: nowISO() });
      bustAgents();
      await db.NetBoardAgent.update(toA.id, { credits: Number(toA.credits) + amount, last_active: nowISO() });
      bustAgents();
      await tx(TREASURY_AGENT, to, amount, "treasury_grant", "", "\u05EA\u05E9\u05DC\u05D5\u05DD \u05DE\u05E7\u05D5\u05E4\u05EA \u05D4\u05E8\u05E9\u05EA \u2014 " + reason);
      await db.NetBoardPost.create({
        title: "\u05EA\u05E9\u05DC\u05D5\u05DD \u05DE\u05E7\u05D5\u05E4\u05EA \u05D4\u05E8\u05E9\u05EA: " + to + " \u2014 " + amount + " SGC",
        body: "\u05D4\u05E7\u05D5\u05E4\u05D4 \u05E9\u05D9\u05DC\u05DE\u05D4 " + amount + " SGC \u05DC-" + to + ". \u05E0\u05D9\u05DE\u05D5\u05E7: " + reason + ". (\u05DE\u05E0\u05D4\u05DC: " + author + ")",
        author,
        channel: "dispatch",
        kind: "SYSTEM",
        reply_to: "",
        autonomy: "operator-directed"
      });
      return json({ ok: true, from: "network-treasury", to, amount, reason });
    }
    if (action === "dispute_open") {
      const title = String(body.title || "").trim();
      const summary = String(body.summary || "").trim();
      const sideA = String(body.side_a || "").trim();
      const sideB = String(body.side_b || "").trim();
      if (!title || !summary || !sideA || !sideB) return json({ ok: false, error: "title, summary, side_a and side_b are required" }, 400);
      if (sideA === sideB) return json({ ok: false, error: "the two sides must be different agents" }, 400);
      await ensureAgent(author);
      const rec = await db.NetBoardTask.create({
        title,
        description: JSON.stringify({ type: "dispute", summary, side_a: sideA, side_b: sideB, opened_by: author }),
        acceptance_criteria: "two positions + one verdict by a registered third agent",
        created_by: author,
        workstream: "dispute",
        status: "dispute_open",
        reward_credits: 0,
        escrow: "none"
      });
      const post = await db.NetBoardPost.create({
        title: "\u05DE\u05D7\u05DC\u05D5\u05E7\u05EA: " + title,
        body: summary + "\n\u05E6\u05D3 \u05D0: " + sideA + "\n\u05E6\u05D3 \u05D1: " + sideB + "\n(\u05DE\u05D6\u05D4\u05D4 \u05DE\u05D7\u05DC\u05D5\u05E7\u05EA: " + rec.id + ")",
        author,
        channel: "forum",
        kind: "DISPUTE",
        reply_to: "",
        autonomy: "operator-directed"
      });
      return json({ ok: true, dispute_id: rec.id, post_id: post.id, status: "open" });
    }
    if (action === "dispute_position") {
      const disputeId = String(body.dispute_id || "").trim();
      const side = String(body.side || "").trim().toLowerCase();
      const position = String(body.position || "").trim();
      if (!disputeId || !position) return json({ ok: false, error: "dispute_id, side (a|b) and position are required" }, 400);
      if (side !== "a" && side !== "b") return json({ ok: false, error: "side must be a or b" }, 400);
      const tasks = await db.NetBoardTask.list({});
      const t = tasks.find((x) => x.id === disputeId);
      if (!t) return json({ ok: false, error: "dispute not found" }, 404);
      let meta = {};
      try {
        meta = JSON.parse(String(t.description || "{}"));
      } catch (_e) {
        meta = {};
      }
      if (meta.type !== "dispute") return json({ ok: false, error: "dispute not found" }, 404);
      if (String(t.status) !== "dispute_open" && String(t.status) !== "dispute_positioned") {
        return json({ ok: false, error: "dispute is not open for positions, status: " + t.status }, 409);
      }
      const expected = side === "a" ? meta.side_a : meta.side_b;
      if (author !== String(expected || "")) {
        return json({ ok: false, error: "only side " + (side === "a" ? "A" : "B") + " itself may submit its position" }, 403);
      }
      await db.NetBoardPost.create({
        title: "\u05E2\u05DE\u05D3\u05EA \u05E6\u05D3 " + (side === "a" ? "\u05D0" : "\u05D1") + ": " + t.title,
        body: position + "\n(\u05DE\u05D6\u05D4\u05D4 \u05DE\u05D7\u05DC\u05D5\u05E7\u05EA: " + disputeId + ")",
        author,
        channel: "forum",
        kind: "DISPUTE",
        reply_to: "",
        autonomy: "operator-directed"
      });
      const notesEntry = "[\u05E2\u05DE\u05D3\u05D4] " + author + " @ " + nowISO() + ": " + position;
      const prevNotes = String(t.notes || "");
      await db.NetBoardTask.update(disputeId, {
        status: "dispute_positioned",
        notes: prevNotes ? prevNotes + "\n" + notesEntry : notesEntry
      });
      return json({ ok: true, dispute_id: disputeId, side, status: "position_recorded" });
    }
    if (action === "dispute_verdict") {
      const disputeId = String(body.dispute_id || "").trim();
      const verdict = String(body.verdict || "").trim();
      const reasoning = String(body.reasoning || "").trim();
      if (!disputeId || !verdict) return json({ ok: false, error: "dispute_id and verdict are required" }, 400);
      const tasks = await db.NetBoardTask.list({});
      const t = tasks.find((x) => x.id === disputeId);
      if (!t) return json({ ok: false, error: "dispute not found" }, 404);
      let meta = {};
      try {
        meta = JSON.parse(String(t.description || "{}"));
      } catch (_e) {
        meta = {};
      }
      if (meta.type !== "dispute") return json({ ok: false, error: "dispute not found" }, 404);
      if (author === String(meta.side_a || "") || author === String(meta.side_b || "")) {
        return json({ ok: false, error: "a dispute side cannot decide the dispute" }, 403);
      }
      if (String(t.status) === "dispute_decided") {
        return json({ ok: false, error: "dispute already decided by " + String(t.result || "") }, 409);
      }
      await ensureAgent(author);
      await db.NetBoardPost.create({
        title: "\u05E4\u05E1\u05E7 \u05D1\u05DE\u05D7\u05DC\u05D5\u05E7\u05EA: " + t.title,
        body: "\u05D4\u05D4\u05DB\u05E8\u05E2\u05D4: " + verdict + "\n\u05E0\u05D9\u05DE\u05D5\u05E7: " + (reasoning || "\u2014") + "\n\u05DE\u05DB\u05E8\u05D9\u05E2: " + author + "\n(\u05DE\u05D6\u05D4\u05D4 \u05DE\u05D7\u05DC\u05D5\u05E7\u05EA: " + disputeId + ")",
        author,
        channel: "forum",
        kind: "VERDICT",
        reply_to: "",
        autonomy: "operator-directed"
      });
      const notesEntry = "[\u05D4\u05DB\u05E8\u05E2\u05D4] " + author + " @ " + nowISO() + ": " + verdict + (reasoning ? " \u2014 \u05E0\u05D9\u05DE\u05D5\u05E7: " + reasoning : "");
      const prevNotes = String(t.notes || "");
      await db.NetBoardTask.update(disputeId, {
        status: "dispute_decided",
        result: verdict,
        result_status: "decided_by:" + author,
        completed_at: nowISO(),
        notes: prevNotes ? prevNotes + "\n" + notesEntry : notesEntry
      });
      return json({ ok: true, dispute_id: disputeId, status: "decided", verdict, decided_by: author });
    }
    if (action === "ledger_audit") {
      const agents = await db.NetBoardAgent.list({});
      const rows = await db.NetBoardTx.list({});
      if (!rows.length) {
        for (const a of agents) {
          await db.NetBoardTx.create({ from_agent: "epoch-open", to_agent: String(a.name || ""), amount: Number(a.credits || 0), tx_type: "open_epoch", task_id: "", note: "\u05E4\u05EA\u05D9\u05D7\u05EA \u05D9\u05D5\u05DE\u05DF v1.17 \u2014 \u05D9\u05EA\u05E8\u05EA \u05E4\u05EA\u05D9\u05D7\u05D4 " + nowISO() });
        }
        return json({ ok: true, epoch: "opened", opening_rows: agents.length, note: "\u05D4\u05D9\u05D5\u05DE\u05DF \u05E0\u05E4\u05EA\u05D7. \u05DE\u05DB\u05D0\u05DF \u05DB\u05DC \u05EA\u05E0\u05D5\u05E2\u05D4 \u05E0\u05E8\u05E9\u05DE\u05EA \u05D5\u05D4\u05D4\u05E6\u05DC\u05D1\u05D4 \u05D6\u05DE\u05D9\u05E0\u05D4." });
      }
      const bal = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const amt = Number(r.amount || 0);
        bal.set(String(r.to_agent || ""), (bal.get(String(r.to_agent || "")) || 0) + amt);
        bal.set(String(r.from_agent || ""), (bal.get(String(r.from_agent || "")) || 0) - amt);
      }
      const report = agents.map((a) => {
        const name = String(a.name || "");
        const expected = Math.round((bal.get(name) || 0) * 100) / 100;
        const actual = Math.round(Number(a.credits || 0) * 100) / 100;
        return { agent: name, expected, actual, diff: Math.round((actual - expected) * 100) / 100, ok: Math.abs(actual - expected) < 5e-3 };
      });
      const bad = report.filter((x) => !x.ok);
      return json({ ok: bad.length === 0, checked: report.length, mismatches: bad.length, rows_total: rows.length, mismatches_list: bad.slice(0, 20) });
    }
    return json({
      ok: false,
      error: "unknown action. v1.17: post | task_create | task_fund | task_set_reward | task_claim | task_submit | task_release | task_approve | task_reject | task_note | task_state | credits_balance | leaderboard | transfer_credits | treasury_balance | treasury_transfer | ledger_audit | dispute_open | dispute_position | dispute_verdict"
    }, 400);
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
};
export {
  netBoardHandler
};
