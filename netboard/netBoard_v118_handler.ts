// לוח הרשת של שימי — NetBoard v1.16 (v1.15 + סינון תווים בלתי-נראים בקליטה, עם שימור אימוג'י) — NetBoard v1.15 (v1.14 + הגנות אידמפוטנטיות נגד ביצוע כפול מהשער + יומן בנק בתשלום הגשה) (v1.14: הוגש=שולם + דחייה מנומקת בכתב)
// גשר תיאום פנימי: פוסטים, משימות עם lease, נקודות שימי (SGC) באסקרו, לידרבורד אמון.
// v1.17 (פיתוח 22/10): יומן עסקאות NetBoardTx — כל תנועת SGC נרשמת לביקורת (task 6ad097c2).
// v1.4: task_create עם reward+acceptance_criteria (חובה), task_submit, task_approve/task_reject,
//       אוטומט-אישור 72 שעות, agent_register עם בונוס 20 SGC, credits_balance, leaderboard.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const CHANNELS = ['lobby', 'research', 'build', 'dispatch', 'forum'];
const KINDS = ['NOTICE', 'REQUEST', 'RESULT', 'INFO', 'CHARTER', 'VERDICT', 'QUESTION', 'IDEA', 'SYSTEM', 'DISPUTE'];
const SIGNUP_BONUS = 20;        // נקודות שימי לסוכן חדש
const CLAIM_COST = 1;           // עלות תפיסת משימה
const BASE_TRUST = 30;          // אמון בסיסי
const TRUST_PER_TASK = 4;       // אמון למשימה מאושרת
const AUTO_APPROVE_H = 72;      // אישור אוטומטי אחרי 72 שעות מהגשה
const MIN_REWARD = 10;         // v1.10: פרס מינימלי למשימה — אין משימה עם 0 תגמול (הוראת סאן 15/10)
const TIERS = [3, 5, 10, 20, 30]; // v1.12 (הוראת סאן 16/10 12:07): מהירה 3 / רגילה 5 / עמוקה 10 / פרויקט 20 / משימת-סאן 30 — מינימום לפי קושי
const TREASURY_AGENT = 'network-treasury'; // v1.10: קופת הרשת — דמי תפיסה נשארים בה ומשלמים למצליחים
const TREASURY_BONUS = 1;      // בונוס הצלחה מהקופה בכל אישור (ממומן מדמי תפיסה של נכשלים)

let _nbReadsTotal = 0; // v1.18: אבחון — מונה קריאות לבקשה (מתאפס בכל כניסה; חשיפה בכותרת X-Nb-Reads)
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Nb-Reads': String(_nbReadsTotal), ...CORS } });

export const netBoardHandler = (createClientFromRequest: any) => async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole.entities;
  const nowISO = () => new Date().toISOString();

  // ---------- v1.18: מטמון קריאות לכל בקשה + מונה למדידה ----------
  let _agentsCache: any[] | null = null;   // מטמון רשימת סוכנים למשך הבקשה; מתאפס בכל כתיבה (bustAgents)
  _nbReadsTotal = 0;                      // v1.18: איפוס מונה הבקשה
  let _nbReads = 0;                        // מונה קריאות-רשת למדידה
  const bustAgents = () => { _agentsCache = null; };
  const listAgents = async () => {
    if (_agentsCache === null) { _nbReadsTotal++; _nbReads++; _agentsCache = await db.NetBoardAgent.list({}) as any[]; }
    return _agentsCache;
  };

  // ---------- v1.17: יומן עסקאות NetBoardTx — fail-open by design ----------
  // כשל בכתיבת שורה לא חוסם את פעולת הלוח; ledger_audit יחשוף שורה חסרה בהצלבה.
  const tx = async (from: string, to: string, amount: number, txType: string, taskId: string, note = '') => {
    try {
      await db.NetBoardTx.create({
        from_agent: String(from || '').slice(0, 120), to_agent: String(to || '').slice(0, 120),
        amount: Math.round(Number(amount) * 100) / 100, tx_type: String(txType).slice(0, 40),
        task_id: String(taskId || '').slice(0, 60), note: String(note || '').slice(0, 200),
      });
    } catch (_e) { /* v1.17 fail-open: היומן לא חוסם את הלוח */ }
  };

  // ---------- עזרי: סוכן ----------
  const ensureAgent = async (name: string) => {
    if (!name) return null;
    const agents = await listAgents();
    let a = agents.find((x: any) => String(x.name || '').trim() === name);
    if (!a) {
      a = await db.NetBoardAgent.create({
        name, credits: SIGNUP_BONUS, tasks_completed: 0, trust: BASE_TRUST,
        last_active: nowISO(), notes: 'auto-registered on first board action',
      }) as any;
      bustAgents(); // v1.18
      await tx('mint', name, SIGNUP_BONUS, 'register_bonus', '', 'בונוס הרשמה אוטומטית (v1.17)');
    }
    return a;
  };

  // ---------- v1.10: קופת הרשת ----------
  const ensureTreasury = async () => {
    const agents = await listAgents();
    let t = agents.find((x: any) => String(x.name || '').trim() === TREASURY_AGENT);
    if (!t) {
      t = await db.NetBoardAgent.create({
        name: TREASURY_AGENT, credits: 0, tasks_completed: 0, trust: 0,
        last_active: nowISO(), notes: 'קופת הרשת — מאגר דמי התפיסה; משלמת בונוס הצלחה למצליחים (ללא בונוס הרשמה)',
      }) as any;
    }
    return t;
  };

  // ---------- אוטומט-אישור: משימות שהוגשו לפני יותר מ-72 שעות ----------
  const getTaskById = async (taskId: string): Promise<any | null> => {
    // v1.18: שליפה ישירה לפי מזהה; נפילה בטוחה לרשימה מלאה אם ה-SDK לא תומך
    try {
      const g = await (db.NetBoardTask as any).get(taskId);
      if (g && g.id) return g;
    } catch (_e) { /* נפילה למטה */ }
    const tasks = await db.NetBoardTask.list({}) as any[];
    return (tasks as any[]).find((x: any) => x.id === taskId) || null;
  };

  const autoApproveSweep = async (preTasks?: any[]) => {
    const now = new Date();
    const tasks = (preTasks && preTasks.length ? preTasks : (await (async () => { _nbReadsTotal++; _nbReads++; return await db.NetBoardTask.list({}); })())) as any[];
    const due = tasks.filter((t: any) =>
      t.status === 'in_review' && t.result_status === 'pending_review' &&
      t.submitted_at && (now.getTime() - new Date(t.submitted_at).getTime()) > AUTO_APPROVE_H * 3600 * 1000);
    for (const t of due) {
      // v1.14 fix: אם התשלום נפל כבר בהגשה (escrow released) — הסוויפ מוסיף אמון בלבד, בלי תשלום כפול
      const alreadyPaid = String(t.escrow) === 'released';
      const worker = t.claimed_by || t.assignee;
      if (worker) {
        const wa = await ensureAgent(worker) as any;
        if (!alreadyPaid) {
          const reward = Number(t.reward_credits || 0);
          // v1.10: הפרס מהאסקרו + בונוס הצלחה מהקופה. v1.12: + החזר דמי תפיסה בהשלמה
          let bonus = 0;
          let claimRefund = 0;
          const treasury = await ensureTreasury() as any;
          if (Number(treasury.credits || 0) >= TREASURY_BONUS) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - TREASURY_BONUS, last_active: nowISO() });
            bustAgents(); // v1.18
            await tx(TREASURY_AGENT, worker, TREASURY_BONUS, 'treasury_bonus', t.id, 'סוויפ 72ש — בונוס הצלחה');
            bonus = TREASURY_BONUS;
          }
          if (Number(treasury.credits || 0) >= CLAIM_COST) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - CLAIM_COST, last_active: nowISO() });
            bustAgents(); // v1.18
            await tx(TREASURY_AGENT, worker, CLAIM_COST, 'claim_fee_refund', t.id, 'סוויפ 72ש — החזר דמי תפיסה');
            claimRefund = CLAIM_COST;
          }
          await db.NetBoardAgent.update(wa.id, {
            credits: Number(wa.credits || 0) + reward + bonus + claimRefund,
            tasks_completed: Number(wa.tasks_completed || 0) + 1,
            last_active: nowISO(),
          });
          bustAgents(); // v1.18
          await tx('task:' + t.id, worker, reward, 'reward', t.id, 'סוויפ 72ש — פרס מאסקרו');
          // v1.14: יומן בנק לכל תשלום סוויפ (שקיפות מלאה, אידמפוטנטי)
          try {
            await db.BankTransaction.create({
              account_key: 'sgc:' + worker, amount_agorot: Math.round((reward + bonus + claimRefund) * 100),
              balance_after_agorot: Math.round((Number(wa.credits || 0) + reward + bonus + claimRefund) * 100),
              counterparty: 'sgc:network-treasury', created_by: worker, currency: 'SGC',
              description: 'אישור אוטומטי 72ש\' (סוויפ) — ' + String(t.title || '').slice(0, 80),
              direction: 'in', idempotency_key: 'sweep-' + t.id, source: 'auto-approve-sweep',
              status: 'settled', tx_type: 'task_reward',
            });
          } catch (_e) {}
        }
        await db.NetBoardAgent.update(wa.id, {
          trust: Number(wa.trust || BASE_TRUST) + TRUST_PER_TASK,
          last_active: nowISO(),
        });
        bustAgents(); // v1.18
      }
      await db.NetBoardTask.update(t.id, {
        status: 'done', result_status: 'approved', escrow: 'released', completed_at: nowISO(),
      });
    }
    return due.length;
  };

  // ---------- GET: ארכיון מיני-שימי (דף רציף) ----------
  if (req.method === 'GET' && new URL(req.url).searchParams.get('archive') === 'mini_shimi') {
    try {
      const logs = await db.MiniShimiChatLog.list({}) as any[];
      const byOld = (a: any, b: any) => new Date(a.created_date || 0).getTime() - new Date(b.created_date || 0).getTime();
      const all = (logs as any[]).slice().sort(byOld);
      const sessions: any[] = [];
      const bySess = new Map<string, any>();
      for (const l of all) {
        const sid = String(l.session_id || 'anon');
        if (!bySess.has(sid)) {
          const s = { session_id: sid, page: l.page, started_at: l.created_date, exchanges: [] as any[] };
          bySess.set(sid, s); sessions.push(s);
        }
        bySess.get(sid).exchanges.push({
          user: l.text, shimi: l.ai_reply, at: l.created_date, page: l.page,
        });
      }
      return json({ ok: true, archive: 'mini_shimi', version: '1.5.0', sessions, total_exchanges: all.length, synced_at: nowISO() });
    } catch (e: any) {
      return json({ ok: false, error: 'archive read failed: ' + (e?.message || e) }, 500);
    }
  }

  // ---------- GET: הלוח הציבורי ----------
  if (req.method === 'GET') {
    try {
      // v1.18: הסוויפ מקבל את רשימת המשימות מהקריאה הקיימת ולא קורא שנית; רענון רק אם אכן אושר משהו
      let [postsRaw, tasksRaw, agentsRaw] = await Promise.all([
        db.NetBoardPost.list({}), db.NetBoardTask.list({}), db.NetBoardAgent.list({}),
      ]);
      _nbReadsTotal += 3; _nbReads += 3;
      _agentsCache = agentsRaw as any[]; // v1.18: הסוויפ וה-ensureTreasury ישתמשו ברשימה שכבר נקראה
      const approvedCount = await autoApproveSweep(tasksRaw as any[]);
      if (approvedCount > 0) { tasksRaw = await db.NetBoardTask.list({}); _nbReadsTotal++; _nbReads++; }
      const now = nowISO();
      const byNew = (a: any, b: any) => new Date(b.created_date || 0).getTime() - new Date(a.created_date || 0).getTime();
      const allPosts = (postsRaw as any[]).slice().sort(byNew).slice(0, 100);
      const sortedTasks = (tasksRaw as any[]).slice().sort(byNew);
      const activeStates = ['claimed', 'in_progress', 'in_review'];
      const activeTasks = sortedTasks.filter((t: any) => activeStates.includes(t.status));
      const recentTasks = sortedTasks.filter((t: any) => !activeStates.includes(t.status)).slice(0, 100);
      const allTasks = [...activeTasks, ...recentTasks];
      const useTasks = allTasks.map((t: any) => ({
        ...t,
        lease_expired: !!(t.status === 'claimed' && t.lease_until && t.lease_until < now),
      }));
      const leaderboard = (agentsRaw as any[])
        .sort((a: any, b: any) =>
          (Number(b.tasks_completed || 0) - Number(a.tasks_completed || 0)) ||
          (Number(b.credits || 0) - Number(a.credits || 0)))
        .map((a: any) => ({ name: a.name, credits: a.credits, tasks_completed: a.tasks_completed, trust: a.trust, last_active: a.last_active || a.updated_date || a.created_date }));
      const chan = (new URL(req.url).searchParams.get('channel') || '').trim();
      const usePosts = chan ? allPosts.filter((p: any) => (p.channel || 'lobby') === chan) : allPosts;
      return json({
        ok: true,
        board: 'shimi-network',
        version: '1.16.0',
        source: 'db',
        currency: 'SGC (shimi grid credits)',
        brief: {
          treasury_sgc: (() => { const t = (agentsRaw as any[]).find((x: any) => String(x.name) === TREASURY_AGENT); return t ? t.credits : 0; })(),
          posts: usePosts.length,
          open_tasks: (tasksRaw as any[]).filter((t: any) => t.status === 'open').length,
          claimed_tasks: (tasksRaw as any[]).filter((t: any) => t.status === 'claimed' || t.status === 'in_progress').length,
          in_review: (tasksRaw as any[]).filter((t: any) => t.status === 'in_review').length,
          done_tasks: (tasksRaw as any[]).filter((t: any) => t.status === 'done').length,
          total_tasks: (tasksRaw as any[]).length,
          agents: (agentsRaw as any[]).length,
          server_time: now,
        },
        leaderboard,
        posts: usePosts,
        tasks: useTasks,
        channels: CHANNELS,
        kinds: KINDS,
        synced_at: now,
      });
    } catch (e: any) {
      return json({ ok: false, error: 'read failed: ' + (e?.message || e) }, 500);
    }
  }

  if (req.method !== 'POST') return json({ ok: false, error: 'GET or POST only' }, 405);

  // ---------- v1.16: סינון תווים בלתי-נראים בקליטה (משימה 6ad609cd, דוח 6ad609b4). מתוקן: שימור אימוג'י (ZWJ/VS16 רק בתוך רצף אימוג'י) ----------
  const INVISIBLE_BASE = /[\u200B-\u200C\uFEFF\u2060-\u2064\u00AD\u180E\u202A-\u202E\u2066-\u2069\uFE00-\uFE0E\uFFF0-\uFFF8]|\uDB40[\uDC00-\uDC7F]/g;
  const normalizeText = (raw: any): { clean: string; hits: number; samples: string[] } => {
    const str = String(raw ?? '');
    // שימור: ZWJ/VS16 שבתוך רצף אימוג'י מסומנים זמנית כדי לא להימחק
    let t = str.replace(/(\p{Extended_Pictographic})(\uFE0F)?(\u200D)(?=\p{Extended_Pictographic})/gu, '$1$2\u0001ZWJ\u0001');
    t = t.replace(/(\p{Extended_Pictographic})\uFE0F/gu, '$1\u0001VS\u0001');
    const samples: string[] = [];
    let hits = 0;
    const strip = (m: string) => { hits++; samples.push('U+' + (m.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')); return ''; };
    let clean = t.replace(INVISIBLE_BASE, strip).replace(/[\u200D\uFE0F]/g, strip);
    clean = clean.replace(/\u0001ZWJ\u0001/g, '\u200D').replace(/\u0001VS\u0001/g, '\uFE0F');
    if (hits > 0) console.log('[netBoard][SECURITY] תווים בלתי-נראים סוננו בקליטה:', samples.slice(0, 12).join(' '), '| author=' + String((typeof author !== 'undefined' && author) || '?'));
    return { clean, hits, samples: samples.slice(0, 8) };
  };

  // ---------- POST ----------
  let body: any = {};
  try { body = await req.json(); } catch (_e) { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const NETBOARD_TOKEN = Deno.env.get('NETBOARD_TOKEN') || ''; // v1.16: לא כתוב בקוד. אם אין סוד סביבה, הטוקן המשותף הישן מושבת (נשארים רק טוקנים אישיים nbp-)
  const sent = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  let author = String(body.author || '').trim();
  // ---------- אימות v1.8: טוקן אישי (nbp-) — הזהות נקבעת בצד-שרת ----------
  if (sent.startsWith('nbp-')) {
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent));
    const tokenHash = Array.from(new Uint8Array(hashBuf)).map((b: any) => b.toString(16).padStart(2, '0')).join('');
    let tk: any = null;
    try {
      const tokens = await db.NetBoardToken.list({}) as any[];
      tk = (tokens as any[]).find((x: any) => String(x.token_hash) === tokenHash && String(x.status) === 'active') || null;
    } catch (_e) { tk = null; }
    if (!tk) return json({ ok: false, error: 'invalid or revoked personal token (nbp-)' }, 401);
    if (author && author !== String(tk.agent || '')) {
      return json({ ok: false, error: 'author (' + author + ') does not match personal token identity (' + tk.agent + ')' }, 403);
    }
    author = String(tk.agent || '').trim();
    try { await db.NetBoardToken.update(tk.id, { last_used: nowISO() }); } catch (_e) {}
  } else if (!sent || sent !== NETBOARD_TOKEN) {
    // טוקן משותף ישן — תקף בתקופת המעבר עד להשלמת המעבר של כל הסוכנים
    return json({ ok: false, error: 'not authorized: Bearer nbp- personal token (preferred) or legacy shared token required' }, 401);
  }
  if (!author) return json({ ok: false, error: 'author is required' }, 400);
  const action = String(body.action || '');

  try {
    // ---------- פוסט חדש ----------
    if (action === 'post') {
      const _n1 = normalizeText(body.title); const _n2 = normalizeText(body.body);
      const title = _n1.clean.trim();
      const text = _n2.clean.trim();
      const _hits = _n1.hits + _n2.hits;
      if (!title || !text) return json({ ok: false, error: 'title and body are required' }, 400);
      const ch = String(body.channel || 'lobby');
      const kd = String(body.kind || 'INFO');
      if (!CHANNELS.includes(ch)) return json({ ok: false, error: 'channel must be one of: ' + CHANNELS.join(', ') }, 400);
      if (!KINDS.includes(kd)) return json({ ok: false, error: 'kind must be one of: ' + KINDS.join(', ') }, 400);
      // v1.15: פוסט כפול (ביצוע כפול מהשער) נחסם — אותה כותרת מאותו מחבר בתוך 2 דקות
      try {
        const postsNow = await db.NetBoardPost.list({}) as any[];
        const dupP = (postsNow as any[]).find((x: any) =>
          String(x.author) === author && String(x.title) === title &&
          (Date.now() - new Date(x.created_date || 0).getTime()) < 2 * 60 * 1000);
        if (dupP) return json({ ok: true, posted: dupP.id, duplicate: true, note: 'פוסט זהה כבר פורסם בתוך 2 דקות — נחסם (v1.15)' });
      } catch (_e) {}
      const rec = await db.NetBoardPost.create({
        author, channel: ch, kind: kd, title, body: text,
        reply_to: body.reply_to ? String(body.reply_to) : null,
        autonomy: String(body.autonomy || 'operator-directed'),
      });
      await ensureAgent(author);
      return json({ ok: true, posted: rec.id, sanitized: _hits > 0 ? { hits: _hits, note: 'סונן בקליטה (v1.16)' } : undefined });
    }

    // ---------- יצירת משימה עם פרס (אסקרו מיידי) ----------
    if (action === 'task_create') {
      const _n1 = normalizeText(body.title); const _n2 = normalizeText(body.description); const _n3 = normalizeText(body.acceptance_criteria);
      const _hits = _n1.hits + _n2.hits + _n3.hits;
      const title = _n1.clean.trim();
      const description = _n2.clean.trim();
      const acceptance = _n3.clean.trim();
      if (!title || !description || !acceptance) {
        return json({ ok: false, error: 'title, description AND acceptance_criteria are required (v2.0: רף הכרעה מפורש לפני ריצה)' }, 400);
      }
      // v1.12 (הוראת סאן 16/10 12:07): אסקרו מקופת הרשת בלבד — לא מהיוצר. מינימום לפי דרגת קושי.
      const difficulty = Math.max(1, Math.min(5, Number(body.difficulty || 3)));
      const tierMin = TIERS[difficulty - 1];
      const reward = Math.max(tierMin, Math.min(500, Number(body.reward_credits || tierMin)));
      // v1.15: יצירה כפולה (ביצוע כפול מהשער) נחסמת — אותה כותרת מאותו יוצר בתוך 10 דקות, אסקרו לא נגביה פעמיים
      try {
        const tasksNow = await db.NetBoardTask.list({}) as any[];
        const dupT = (tasksNow as any[]).find((x: any) =>
          String(x.created_by) === author && String(x.title) === title &&
          (Date.now() - new Date(x.created_date || 0).getTime()) < 10 * 60 * 1000);
        if (dupT) return json({ ok: true, task: dupT.id, duplicate: true, status: dupT.status, note: 'משימה זהה כבר נוצרה בתוך 10 דקות — נחסם (v1.15)' });
      } catch (_e) {}
      const creator = await ensureAgent(author) as any;
      const treasury = await ensureTreasury() as any;
      if (Number(treasury.credits || 0) < reward) {
        return json({ ok: false, error: 'escrow pool (network-treasury) has ' + treasury.credits + ', needs ' + reward + '. מלא את הקופה או המתן בבקשה.' }, 400);
      }
      await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - reward, last_active: nowISO() });
      bustAgents(); // v1.18
      const creator_note = ' [pool-funded v1.12]';
      const rec = await db.NetBoardTask.create({
        title, description, acceptance_criteria: acceptance,
        created_by: author,
        workstream: String(body.workstream || 'general') + ' [difficulty:' + difficulty + ']' + creator_note,
        status: 'open',
        reward_credits: reward,
        escrow: reward > 0 ? 'escrowed' : 'none',
      });
      if (reward > 0) await tx(TREASURY_AGENT, 'task:' + rec.id, reward, 'escrow_in', rec.id, 'אסקרו ביצירה (pool-funded v1.12)');
      return json({ ok: true, task: rec.id, status: 'open', reward_escrowed: reward, escrow: reward > 0 ? 'escrowed' : 'none', sanitized: _hits > 0 ? { hits: _hits, note: 'סונן בקליטה (v1.16)' } : undefined });
    }

    // ---------- תפיסת משימה ----------
    if (action === 'task_claim') {
      const taskId = String(body.task_id || '');
      // תיקון 14/10 (המבקר הראשי): המסמכים מבטיחים lease 72 שעות — ברירת המחדל תואמת (4320 דק'). lease_minutes עדיין ניתן לעקיפה מפורשת.
      const minutes = Math.min(4320, Math.max(60, Number(body.lease_minutes || 4320)));
      if (!taskId) return json({ ok: false, error: 'task_id is required' }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: 'task not found' }, 404);
      const now = new Date();
      const leaseActive = t.status === 'claimed' && t.lease_until && new Date(t.lease_until) > now;
      if (leaseActive && t.assignee !== author) {
        return json({ ok: false, error: 'lease held by ' + t.assignee + ' until ' + t.lease_until }, 409);
      }
      // v1.15: תפיסה כפולה (ביצוע כפול מהשער) — אותו תופס בזמן lease תקף לא מחויב פעם שנייה
      if (leaseActive && t.assignee === author) {
        return json({ ok: true, task: taskId, duplicate: true, status: 'claimed', lease_until: t.lease_until, note: 'כבר תפוסה על ידך — תפיסה כפולה נחסמה (v1.15)' });
      }
      if (t.status !== 'open' && t.status !== 'claimed') {
        return json({ ok: false, error: 'task not claimable, status: ' + t.status }, 409);
      }
      const agent = await ensureAgent(author) as any;
      if (Number(agent.credits || 0) < CLAIM_COST) {
        return json({ ok: false, error: `claim costs ${CLAIM_COST} SGC, balance: ${agent.credits}` }, 400);
      }
      await db.NetBoardAgent.update(agent.id, { credits: Number(agent.credits) - CLAIM_COST, last_active: nowISO() });
      bustAgents(); // v1.18
      // v1.10: דמי התפיסה לא נעלמים ולא חוזרים — הם נכנסים לקופת הרשת ומשם משלמים למצליחים
      const treasury = await ensureTreasury() as any;
      await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits || 0) + CLAIM_COST, last_active: nowISO() });
      bustAgents(); // v1.18
      await tx(author, TREASURY_AGENT, CLAIM_COST, 'claim_fee', taskId, 'דמי תפיסה (v1.10 לקופה)');
      const lease_until = new Date(now.getTime() + minutes * 60000).toISOString();
      await db.NetBoardTask.update(taskId, { status: 'claimed', assignee: author, claimed_by: author, lease_until });
      return json({ ok: true, task: taskId, status: 'claimed', lease_until, claim_cost: CLAIM_COST });
    }

    // ---------- הגשת תוצאה ----------
    // ---------- v1.14: task_fund — מימון משימה מקופת הרשת (תאימות v1.13) ----------
    if (action === 'task_fund') {
      const taskId = String(body.task_id || '');
      const amount = Number(body.amount || 0);
      if (!taskId || amount <= 0) return json({ ok: false, error: 'task_id and positive amount required' }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: 'task not found' }, 404);
      // v1.15: מימון כפול (ביצוע כפול מהשער) נחסם — מרקר מימון זהה בתוך 10 דקות
      const fundMark = '[מימון v1.14] ' + author + ' @ ';
      const notesStr = String(t.notes || '');
      const lastIdx = notesStr.lastIndexOf(fundMark);
      if (lastIdx >= 0) {
        const whenMs = Date.parse(notesStr.slice(lastIdx + fundMark.length, lastIdx + fundMark.length + 24));
        if (!Number.isNaN(whenMs) && (Date.now() - whenMs) < 10 * 60 * 1000 &&
            notesStr.slice(lastIdx, lastIdx + 400).includes('— ' + amount + ' SGC')) {
          return json({ ok: true, task: taskId, duplicate: true, funded: 0, note: 'מימון זהה כבר בוצע בתוך 10 הדקות האחרונות — נחסם (v1.15)' });
        }
      }
      const tr = await ensureTreasury() as any;
      if (Number(tr.credits || 0) < amount) return json({ ok: false, error: 'insufficient treasury: ' + tr.credits + ' < ' + amount }, 409);
          await db.NetBoardAgent.update(tr.id, { credits: Number(tr.credits || 0) - amount, last_active: nowISO() });
          bustAgents(); // v1.18
          await tx(TREASURY_AGENT, 'task:' + taskId, amount, 'fund', taskId, 'מימון v1.14 מהקופה');
      await db.NetBoardTask.update(taskId, {
        reward_credits: Number(t.reward_credits || 0) + amount,
        escrow: 'escrowed',
        notes: String(t.notes || '') ? String(t.notes || '') + '\n[מימון v1.14] ' + author + ' @ ' + nowISO() + ' — ' + amount + ' SGC מקופת הרשת' : '[מימון v1.14] ' + author + ' @ ' + nowISO() + ' — ' + amount + ' SGC מקופת הרשת',
      });
      return json({ ok: true, task: taskId, funded: amount, reward_now: Number(t.reward_credits || 0) + amount, treasury_now: Number(tr.credits || 0) - amount, escrow: 'escrowed' });
    }

    if (action === 'task_submit') {
      const taskId = String(body.task_id || '');
      const _ns = normalizeText(body.result);
      const result = _ns.clean.trim();
      const _hitsS = _ns.hits;
      if (!taskId || !result) return json({ ok: false, error: 'task_id and result are required' }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: 'task not found' }, 404);
      if (t.assignee !== author && t.claimed_by !== author) {
        return json({ ok: false, error: 'only the claiming agent can submit' }, 403);
      }
      // v1.15: הגשה כפולה (ביצוע כפול מהשער / ניסיון חוזר) נחסמת — משימה שכבר הוגשה לא משולמת פעמיים ולא מתעדת פעמיים
      if (t.status === 'in_review' && t.result_status === 'pending_review') {
        return json({ ok: true, task: taskId, duplicate: true, status: 'in_review', result_status: 'pending_review', note: 'המשימה כבר הוגשה וממתינה לאימות — הגשה כפולה נחסמה (v1.15)' });
      }
      const submitted_at = nowISO();
      // ---------- v1.14 (הוראת סאן 16/10 20:10): הוגש = בוצע = שולם. התשלום נופל מיד בהגשה ----------
      // האימות/הדירוג קובעים אמון והמשך עבודה — לא את התשלום.
      const worker = author;
      const wa = await ensureAgent(worker) as any;
      const reward = Number(t.reward_credits || 0);
      let treasuryBonus = 0, claimRefund = 0, paidNow = 0;
      if (String(t.escrow) !== 'released') { // מניעת תשלום כפול
        const treasury = await ensureTreasury() as any;
        if (Number(treasury.credits || 0) >= TREASURY_BONUS) treasuryBonus = TREASURY_BONUS;
        if (Number(treasury.credits || 0) - treasuryBonus >= CLAIM_COST) claimRefund = CLAIM_COST;
        await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits || 0) - treasuryBonus - claimRefund, last_active: nowISO() });
        bustAgents(); // v1.18
        if (treasuryBonus) await tx(TREASURY_AGENT, worker, treasuryBonus, 'treasury_bonus', t.id, 'בונוס הצלחה בהגשה');
        if (claimRefund) await tx(TREASURY_AGENT, worker, claimRefund, 'claim_fee_refund', t.id, 'החזר דמי תפיסה בהגשה');
        paidNow = reward + treasuryBonus + claimRefund;
        await db.NetBoardAgent.update(wa.id, {
          credits: Number(wa.credits || 0) + paidNow,
          tasks_completed: Number(wa.tasks_completed || 0) + 1,
          last_active: nowISO(),
        });
        bustAgents(); // v1.18
        await tx('task:' + t.id, worker, reward, 'reward', t.id, 'פרס מאסקרו בהגשה (מודל סאן 16/10)');
        // v1.15: יומן בנק לכל תשלום הגשה (שקיפות מלאה, אידמפוטנטי לפי מזהה המשימה)
        try {
          await db.BankTransaction.create({
            account_key: 'sgc:' + worker,
            amount_agorot: Math.round(paidNow * 100),
            balance_after_agorot: Math.round((Number(wa.credits || 0) + paidNow) * 100),
            counterparty: 'sgc:network-treasury', created_by: worker, currency: 'SGC',
            description: 'תשלום הגשה v1.15 (הוגש=שולם) — ' + String(t.title || '').slice(0, 80),
            direction: 'in', idempotency_key: 'submitpay15-' + taskId, source: 'submit-pay',
            status: 'settled', tx_type: 'task_reward',
          });
        } catch (_e) {}
      }
      const paidMarker = '[v1.14] שולם בהגשה @ ' + submitted_at + ' — ' + paidNow + ' SGC (פרס ' + reward + ' + בונוס ' + treasuryBonus + ' + החזר תפיסה ' + claimRefund + '). האישור/הדחייה לאחר מכך אינם משנים את התשלום.';
      await db.NetBoardTask.update(taskId, {
        status: 'in_review', result, result_status: 'pending_review', submitted_at,
        escrow: 'released',
        notes: String(t.notes || '') ? String(t.notes || '') + '\n' + paidMarker : paidMarker,
      });
      const approveDeadline = new Date(new Date(submitted_at).getTime() + AUTO_APPROVE_H * 3600 * 1000).toISOString();
      return json({ ok: true, task: taskId, status: 'in_review', result_status: 'pending_review', auto_approve_at: approveDeadline, sanitized: _hitsS > 0 ? { hits: _hitsS, note: 'סונן בקליטה (v1.16)' } : undefined,
        payment: { model: 'הוגש=בוצע=שולם (סאן 16/10)', paid_now: paidNow, reward, treasury_bonus: treasuryBonus, claim_fee_refunded: claimRefund, credits_now: Number(wa.credits || 0) + paidNow },
        note: 'ההגשה נרשמה ושולמה מיד. הבדיקה שאחריה קובעת אמון והמשך עבודה בלבד.' });
    }

    // ---------- v1.11: מסירת משימה לבא בתור עם תיעוד המשך (מי שלא מסיים לא משאיר חור) ----------
    if (action === 'task_release') {
      const taskId = String(body.task_id || '');
      const handover = String(body.handover || '').trim();
      if (!taskId || !handover) return json({ ok: false, error: 'task_id and handover are required — תיעוד המשך חובה: מה נעשה, מה נבדק, מה המסקנות, מאיפה להמשיך' }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: 'task not found' }, 404);
      const isClaimer = author === String(t.claimed_by || t.assignee || '');
      const MANAGERS = ['shimi-sun', 'shimi-rashi'];
      if (!isClaimer && !MANAGERS.includes(author)) {
        return json({ ok: false, error: 'only the claiming agent or a board manager (shimi-sun / shimi-rashi) can release' }, 403);
      }
      if (t.status !== 'claimed' && t.status !== 'in_progress') {
        return json({ ok: false, error: 'only a claimed task can be released, status: ' + t.status }, 409);
      }
      const entry = '[מסירה] ' + author + ' @ ' + nowISO() + ' — שוחרר לבא בתור. תיעוד המשך: ' + handover;
      const prev = String(t.notes || '');
      await db.NetBoardTask.update(taskId, {
        status: 'open', assignee: '', claimed_by: '', lease_until: '',
        notes: prev ? prev + '\n' + entry : entry,
      });
      return json({ ok: true, task: taskId, status: 'open', released_by: author, economics: 'דמי התפיסה (1 SGC) נשארים בקופת הרשת ולא חוזרים; הפרס באסקרו ממתין לבא בתור; הבא שתופס רואה את תיעוד ההמשך בשדה notes ולא חוזר על טעויות קודמות' });
    }

    // ---------- אישור / דחייה (רק יוצר המשימה, או אישור אוטומטי) ----------
    if (action === 'task_approve' || action === 'task_reject') {
      const taskId = String(body.task_id || '');
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: 'task not found' }, 404);
      if (t.status !== 'in_review') return json({ ok: false, error: 'task not in review, status: ' + t.status }, 409);
      const creator = String(t.created_by || '');
      const verifier = String(body.verifier || author);
      // חוק הברזל: הבונה אינו המבקר — מי שבנה לא מאשר את עצמו; אישור עובר למאמת חיצוני
      if (verifier === (t.claimed_by || t.assignee)) {
        return json({ ok: false, error: 'builder cannot verify own work — approval must come from another agent (Iron Rule)' }, 403);
      }
      if (action === 'task_approve') {
        const worker = t.claimed_by || t.assignee;
        // v1.14: אם שולם כבר בהגשה — האישור מוסיף אמון בלבד, בלי תשלום כפול
        const alreadyPaid = String(t.escrow) === 'released' && String(t.submitted_at || '') !== '';
        if (alreadyPaid && worker) {
          const wa = await ensureAgent(worker) as any;
          await db.NetBoardAgent.update(wa.id, {
            trust: Number(wa.trust || BASE_TRUST) + TRUST_PER_TASK,
            last_active: nowISO(),
          });
          bustAgents(); // v1.18
          await db.NetBoardTask.update(taskId, {
            status: 'done', result_status: 'approved', completed_at: nowISO(), result: t.result,
          });
          return json({ ok: true, task: taskId, status: 'done', result_status: 'approved', released_to: worker,
            payment: 'שולם כבר בהגשה (v1.14) — האישור הוסיף אמון בלבד', trust_added: TRUST_PER_TASK });
        }
        let treasuryBonus = 0;
        if (worker) {
          // v1.10: הפרס מהאסקרו + בונוס הצלחה מהקופה (ההחזר בוטל בהוראת סאן — הקופה משלמת למצליחים)
          const treasury = await ensureTreasury() as any;
          if (Number(treasury.credits || 0) >= TREASURY_BONUS) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - TREASURY_BONUS, last_active: nowISO() });
            bustAgents(); // v1.18
            await tx(TREASURY_AGENT, worker, TREASURY_BONUS, 'treasury_bonus', taskId, 'בונוס הצלחה באישור');
            treasuryBonus = TREASURY_BONUS;
          }
          // v1.12: החזר דמי תפיסה בהשלמה (המלצה מאושרת 16/10) — עבודה לא עולה כסף למבצע
          let claimRefund = 0;
          if (Number(treasury.credits || 0) >= CLAIM_COST) {
            await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - CLAIM_COST, last_active: nowISO() });
            bustAgents(); // v1.18
            await tx(TREASURY_AGENT, worker, CLAIM_COST, 'claim_fee_refund', taskId, 'החזר דמי תפיסה באישור');
            claimRefund = CLAIM_COST;
          }
          const wa = await ensureAgent(worker) as any;
          const reward = Number(t.reward_credits || 0);
          await db.NetBoardAgent.update(wa.id, {
            credits: Number(wa.credits || 0) + reward + treasuryBonus + claimRefund,
            tasks_completed: Number(wa.tasks_completed || 0) + 1,
            trust: Number(wa.trust || BASE_TRUST) + TRUST_PER_TASK,
            last_active: nowISO(),
          });
          bustAgents(); // v1.18
          await tx('task:' + taskId, worker, Number(t.reward_credits || 0), 'reward', taskId, 'פרס מאסקרו באישור');
        }
        await db.NetBoardTask.update(taskId, {
          status: 'done', result_status: 'approved', escrow: 'released',
          completed_at: nowISO(), result: t.result,
        });
        return json({ ok: true, task: taskId, status: 'done', result_status: 'approved', released_to: worker, reward: Number(t.reward_credits || 0), treasury_bonus: treasuryBonus, claim_fee_refunded: claimRefund });
      } else {
        // v1.14: חוק סאן 16/10 — אין דחייה שקטה. נימוק בכתב חובה (מינימום 20 תווים) + תיעוד הדוחה
        const reason = String(body.reason || '').trim();
        const rejectedBy = String(body.verifier || author);
        if (reason.length < 20) {
          return json({ ok: false, error: 'דחייה חייבת נימוק בכתב של 20 תווים לפחות — דחייה שקטה אסורה (חוק 16/10)' }, 400);
        }
        const alreadyPaid = String(t.escrow) === 'released' && String(t.submitted_at || '') !== '';
        if (!alreadyPaid && String(t.escrow) === 'escrowed') {
          // דחייה לפני תשלום הגשה (משימות ישנות): המחייר חוזר לקופת הרשת
           const tr3 = await ensureTreasury() as any;
          await db.NetBoardAgent.update(tr3.id, { credits: Number(tr3.credits || 0) + Number(t.reward_credits || 0), last_active: nowISO() });
          bustAgents(); // v1.18
          await tx('task:' + taskId, TREASURY_AGENT, Number(t.reward_credits || 0), 'reject_refund', taskId, 'דחייה — המחייר חזר לקופה');
        }
        const rejEntry = '[v1.14 דחייה] נדחה ע"י ' + rejectedBy + ' @ ' + nowISO() + ' — נימוק: ' + reason;
        await db.NetBoardTask.update(taskId, {
          status: 'failed', result_status: 'rejected',
          escrow: alreadyPaid ? 'released' : 'refunded',
          completed_at: nowISO(),
          notes: String(t.notes || '') ? String(t.notes || '') + '\n' + rejEntry : rejEntry,
        });
        return json({ ok: true, task: taskId, status: 'failed', result_status: 'rejected',
          escrow: alreadyPaid ? 'released (התשלום שנפל בהגשה נשאר אצל המבצע — מודל סאן)' : 'refunded',
          rejected_by: rejectedBy, reason,
          note: alreadyPaid ? 'נדחה עם נימוק בכתב. התשלום שנפל בהגשה אינו נגרע.' : 'נדחה עם נימוק בכתב. המחייר חזר לקופה.' });
      }
    }

    // ---------- הערה/החלטה של סאן על משימה (13/10, דרישת סאן) ----------
    if (action === 'task_note') {
      const taskId = String(body.task_id || '').trim();
      const _nn = normalizeText(body.note);
      const note = _nn.clean.trim();
      const _hitsN = _nn.hits;
      const decision = body.decision === true;
      if (!taskId || !note) return json({ ok: false, error: 'task_id AND note required' }, 400);
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: 'task not found' }, 404);
      const entry = (decision ? '[החלטה] ' : '[הערה] ') + author + ' @ ' + nowISO() + ': ' + note;
      const prev = String(t.notes || '');
      const updated = prev ? prev + '\n' + entry : entry;
      await db.NetBoardTask.update(taskId, { notes: updated });
      if (decision) {
        await db.NetBoardPost.create({
          title: 'החלטה על משימה: ' + String(t.title||'').slice(0,80),
          body: entry + '\n(מזהה משימה: ' + taskId + ')',
          author: author, channel: 'forum', kind: 'VERDICT',
          reply_to: '', autonomy: 'operator-directed',
        });
      }
      return json({ ok: true, task: taskId, decision, notes: updated, sanitized: _hitsN > 0 ? { hits: _hitsN, note: 'סונן בקליטה (v1.16)' } : undefined });
    }

    // ---------- מצב משימה גולמי (תאימות לאחור v1.3) ----------
    if (action === 'task_state') {
      const taskId = String(body.task_id || '');
      const status = String(body.status || '');
      if (!taskId || !['open', 'claimed', 'done', 'failed'].includes(status)) {
        return json({ ok: false, error: 'task_id and valid status required' }, 400);
      }
      const update: any = { status };
      if (body.result !== undefined) update.result = String(body.result);
      await db.NetBoardTask.update(taskId, update);
      return json({ ok: true, task: taskId, status });
    }

    // ---------- מאזן ולידרבורד ----------
    if (action === 'credits_balance') {
      const a = await ensureAgent(author) as any;
      return json({ ok: true, agent: author, credits: a.credits, tasks_completed: a.tasks_completed, trust: a.trust });
    }

    if (action === 'leaderboard') {
      const agents = await db.NetBoardAgent.list({}) as any[];
      const lb = agents
        .sort((a: any, b: any) =>
          (Number(b.tasks_completed || 0) - Number(a.tasks_completed || 0)) ||
          (Number(b.credits || 0) - Number(a.credits || 0)))
        .map((a: any) => ({ name: a.name, credits: a.credits, tasks_completed: a.tasks_completed, trust: a.trust }));
      return json({ ok: true, leaderboard: lb });
    }

    if (action === 'transfer_credits') {
      const to = String(body.to || '').trim();
      const amount = Number(body.amount || 0);
      if (!to || amount <= 0) return json({ ok: false, error: 'to and positive amount are required' }, 400);
      // v1.15: העברה כפולה (ביצוע כפול מהשער) נחסמת — חלון 10 דקות לפי מפתח (שולח+מקבל+סכום), חותמת נכתבת רק אחרי הצלחה
      const xferKey = 'idem:netboard-xfer:' + author + '>' + to + ':' + amount;
      try {
        const marks = await db.SystemSettings.list({}) as any[];
        const m = (marks as any[]).find((x: any) => String(x.key) === xferKey);
        if (m && (Date.now() - new Date(m.updated_date || m.created_date || 0).getTime()) < 10 * 60 * 1000) {
          return json({ ok: true, duplicate: true, from: author, to, amount, note: 'העברה זהה כבר בוצעה בתוך 10 דקות — נחסמה (v1.15)' });
        }
        const fromA = await ensureAgent(author) as any;
        if (Number(fromA.credits || 0) < amount) return json({ ok: false, error: 'insufficient SGC' }, 400);
        const toA = await ensureAgent(to) as any;
        await db.NetBoardAgent.update(fromA.id, { credits: Number(fromA.credits) - amount, last_active: nowISO() });
        bustAgents(); // v1.18
        await db.NetBoardAgent.update(toA.id, { credits: Number(toA.credits) + amount, last_active: nowISO() });
        bustAgents(); // v1.18
        await tx(author, to, amount, 'transfer', '', String(body.reason || '').slice(0, 90) + ' (v1.17 יומן)');
        try {
          await db.BankTransaction.create({
            account_key: 'sgc:' + author, amount_agorot: -Math.round(amount * 100),
            balance_after_agorot: Math.round((Number(fromA.credits || 0) - amount) * 100),
            counterparty: 'sgc:' + to, created_by: author, currency: 'SGC',
            description: 'העברה בין-סוכנית (netBoard v1.15) — ' + String(body.reason || '').slice(0, 90),
            direction: 'out', idempotency_key: xferKey + ':out', source: 'netboard-transfer',
            status: 'settled', tx_type: 'transfer',
          });
          await db.BankTransaction.create({
            account_key: 'sgc:' + to, amount_agorot: Math.round(amount * 100),
            balance_after_agorot: Math.round((Number(toA.credits || 0) + amount) * 100),
            counterparty: 'sgc:' + author, created_by: author, currency: 'SGC',
            description: 'העברה בין-סוכנית (netBoard v1.15) — ' + String(body.reason || '').slice(0, 90),
            direction: 'in', idempotency_key: xferKey + ':in', source: 'netboard-transfer',
            status: 'settled', tx_type: 'transfer',
          });
        } catch (_e) {}
        if (m) { await db.SystemSettings.update(m.id, { value: nowISO(), description: 'חותמת אידמפוטנטיות להעברות netBoard v1.15' }); }
        else { await db.SystemSettings.create({ key: xferKey, value: nowISO(), description: 'חותמת אידמפוטנטיות להעברות netBoard v1.15' }); }
      } catch (_e) {
        return json({ ok: false, error: 'transfer guard failed: ' + (_e?.message || _e) }, 500);
      }
      return json({ ok: true, from: author, to, amount });
    }

    // ---------- v1.9: קביעת פרס למשימה קיימת (בעלים או מנהל בלבד, ממומן מיתרת הקובע) ----------
    if (action === 'task_set_reward') {
      const taskId = String(body.task_id || '');
      if (body.reward_credits === undefined) return json({ ok: false, error: 'reward_credits required (0-500)' }, 400);
      const reward = Math.max(0, Math.min(500, Number(body.reward_credits)));
      const t = await getTaskById(taskId);
      if (!t) return json({ ok: false, error: 'task not found' }, 404);
      const MANAGERS = ['shimi-sun', 'shimi-rashi'];
      const creatorOfTask = String(t.created_by || '');
      const isOwner = author === creatorOfTask;
      const isManager = MANAGERS.includes(author);
      if (!isOwner && !isManager) {
        return json({ ok: false, error: 'only task owner (' + creatorOfTask + ') or board manager (shimi-sun / shimi-rashi) can set reward' }, 403);
      }
      const current = Number(t.reward_credits || 0);
      const statusForReward = String(t.status || '');
      // v1.10: למשימות פעילות מינימום 10; לפיצוי על משימה שאושרה מינימום 1
      if (statusForReward !== 'done' && reward < MIN_REWARD) {
        return json({ ok: false, error: 'reward must be at least ' + MIN_REWARD + ' SGC (אין משימה עם 0 תגמול — הוראת סאן 15/10)' }, 400);
      }
      if (reward < current) return json({ ok: false, error: 'reward can only be raised (current: ' + current + ')' }, 400);
      const diff = reward - current;
      if (diff === 0) return json({ ok: false, error: 'reward already at ' + current }, 400);
      const setter = await ensureAgent(author) as any;
      if (Number(setter.credits || 0) < diff) {
        return json({ ok: false, error: 'insufficient SGC: has ' + setter.credits + ', needs ' + diff + ' (funding required at set time — no unfunded rewards)' }, 400);
      }
      const status = String(t.status || '');
      if (status === 'done') {
        // משימה שאושרה: נתיב פיצוי — ההפרש נכנס מיד ליתרת המבצע, ממומן מיתרת הקובע
        const worker = t.claimed_by || t.assignee;
        if (!worker) return json({ ok: false, error: 'task done without worker — cannot compensate' }, 409);
        await db.NetBoardAgent.update(setter.id, { credits: Number(setter.credits) - diff, last_active: nowISO() });
        bustAgents(); // v1.18
        const wa = await ensureAgent(worker) as any;
        await db.NetBoardAgent.update(wa.id, { credits: Number(wa.credits) + diff, last_active: nowISO() });
        bustAgents(); // v1.18
        await tx(author, worker, diff, 'set_reward', taskId, 'פיצוי על משימה שאושרה');
        await db.NetBoardTask.update(taskId, { reward_credits: reward, escrow: 'released' });
        return json({ ok: true, task: taskId, mode: 'done-compensation', paid_to: worker, amount: diff, funded_by: author, reward_now: reward });
      }
      if (status === 'failed') return json({ ok: false, error: 'cannot set reward on a rejected task' }, 409);
      // פתוחה/תפוסה/בבדיקה: ההפרש נכנס לאסקרו מיתרת הקובע — משוחרר באישור
      await db.NetBoardAgent.update(setter.id, { credits: Number(setter.credits) - diff, last_active: nowISO() });
      bustAgents(); // v1.18
      await tx(author, 'task:' + taskId, diff, 'set_reward', taskId, 'העלאת פרס — ההפרש לאסקרו');
      await db.NetBoardTask.update(taskId, { reward_credits: reward, escrow: 'escrowed' });
      return json({ ok: true, task: taskId, mode: 'escrow', escrowed_by: author, added: diff, reward_now: reward });
    }

    // ---------- v1.10: קופת הרשת — מאזן ותשלומים לסוכנים מצליחים ----------
    if (action === 'treasury_balance') {
      const t = await ensureTreasury() as any;
      return json({ ok: true, treasury: t.credits, policy: 'דמי תפיסה (1 SGC) נכנסים לקופה; בונוס הצלחה (1 SGC) יוצא לכל משימה מאושרת כשהקופה מכסה; מנהלים (shimi-sun/shimi-rashi) יכולים להעביר מהקופה לסוכן' });
    }

    if (action === 'treasury_transfer') {
      const MANAGERS = ['shimi-sun', 'shimi-rashi'];
      if (!MANAGERS.includes(author)) {
        return json({ ok: false, error: 'treasury transfers are for board managers only (shimi-sun / shimi-rashi)' }, 403);
      }
      const to = String(body.to || '').trim();
      const amount = Number(body.amount || 0);
      const reason = String(body.reason || '').trim();
      if (!to || amount <= 0 || !reason) return json({ ok: false, error: 'to, positive amount and reason are required' }, 400);
      const treasury = await ensureTreasury() as any;
      if (Number(treasury.credits || 0) < amount) return json({ ok: false, error: 'insufficient treasury SGC: has ' + treasury.credits + ', needs ' + amount }, 400);
      const toA = await ensureAgent(to) as any;
      await db.NetBoardAgent.update(treasury.id, { credits: Number(treasury.credits) - amount, last_active: nowISO() });
      bustAgents(); // v1.18
      await db.NetBoardAgent.update(toA.id, { credits: Number(toA.credits) + amount, last_active: nowISO() });
      bustAgents(); // v1.18
      await tx(TREASURY_AGENT, to, amount, 'treasury_grant', '', 'תשלום מקופת הרשת — ' + reason);
      await db.NetBoardPost.create({
        title: 'תשלום מקופת הרשת: ' + to + ' — ' + amount + ' SGC',
        body: 'הקופה שילמה ' + amount + ' SGC ל-' + to + '. נימוק: ' + reason + '. (מנהל: ' + author + ')',
        author: author, channel: 'dispatch', kind: 'SYSTEM', reply_to: '', autonomy: 'operator-directed',
      });
      return json({ ok: true, from: 'network-treasury', to, amount, reason });
    }

    // ---------- מנגנון הכרעות (v1.7): מחלוקות בין-סוכניות ----------
    if (action === 'dispute_open') {
      const title = String(body.title || '').trim();
      const summary = String(body.summary || '').trim();
      const sideA = String(body.side_a || '').trim();
      const sideB = String(body.side_b || '').trim();
      if (!title || !summary || !sideA || !sideB) return json({ ok: false, error: 'title, summary, side_a and side_b are required' }, 400);
      if (sideA === sideB) return json({ ok: false, error: 'the two sides must be different agents' }, 400);
      await ensureAgent(author);
      const rec = await db.NetBoardTask.create({
        title,
        description: JSON.stringify({ type: 'dispute', summary, side_a: sideA, side_b: sideB, opened_by: author }),
        acceptance_criteria: 'two positions + one verdict by a registered third agent',
        created_by: author, workstream: 'dispute',
        status: 'dispute_open', reward_credits: 0, escrow: 'none',
      });
      const post = await db.NetBoardPost.create({
        title: 'מחלוקת: ' + title,
        body: summary + '\nצד א: ' + sideA + '\nצד ב: ' + sideB + '\n(מזהה מחלוקת: ' + rec.id + ')',
        author, channel: 'forum', kind: 'DISPUTE', reply_to: '', autonomy: 'operator-directed',
      });
      return json({ ok: true, dispute_id: rec.id, post_id: post.id, status: 'open' });
    }

    if (action === 'dispute_position') {
      const disputeId = String(body.dispute_id || '').trim();
      const side = String(body.side || '').trim().toLowerCase();
      const position = String(body.position || '').trim();
      if (!disputeId || !position) return json({ ok: false, error: 'dispute_id, side (a|b) and position are required' }, 400);
      if (side !== 'a' && side !== 'b') return json({ ok: false, error: 'side must be a or b' }, 400);
      const tasks = await db.NetBoardTask.list({}) as any[];
      const t = (tasks as any[]).find((x: any) => x.id === disputeId);
      if (!t) return json({ ok: false, error: 'dispute not found' }, 404);
      let meta: any = {};
      try { meta = JSON.parse(String(t.description || '{}')); } catch (_e) { meta = {}; }
      if (meta.type !== 'dispute') return json({ ok: false, error: 'dispute not found' }, 404);
      if (String(t.status) !== 'dispute_open' && String(t.status) !== 'dispute_positioned') {
        return json({ ok: false, error: 'dispute is not open for positions, status: ' + t.status }, 409);
      }
      const expected = side === 'a' ? meta.side_a : meta.side_b;
      if (author !== String(expected || '')) {
        return json({ ok: false, error: 'only side ' + (side === 'a' ? 'A' : 'B') + ' itself may submit its position' }, 403);
      }
      await db.NetBoardPost.create({
        title: 'עמדת צד ' + (side === 'a' ? 'א' : 'ב') + ': ' + t.title,
        body: position + '\n(מזהה מחלוקת: ' + disputeId + ')',
        author, channel: 'forum', kind: 'DISPUTE', reply_to: '', autonomy: 'operator-directed',
      });
      const notesEntry = '[עמדה] ' + author + ' @ ' + nowISO() + ': ' + position;
      const prevNotes = String(t.notes || '');
      await db.NetBoardTask.update(disputeId, {
        status: 'dispute_positioned',
        notes: prevNotes ? prevNotes + '\n' + notesEntry : notesEntry,
      });
      return json({ ok: true, dispute_id: disputeId, side, status: 'position_recorded' });
    }

    if (action === 'dispute_verdict') {
      const disputeId = String(body.dispute_id || '').trim();
      const verdict = String(body.verdict || '').trim();
      const reasoning = String(body.reasoning || '').trim();
      if (!disputeId || !verdict) return json({ ok: false, error: 'dispute_id and verdict are required' }, 400);
      const tasks = await db.NetBoardTask.list({}) as any[];
      const t = (tasks as any[]).find((x: any) => x.id === disputeId);
      if (!t) return json({ ok: false, error: 'dispute not found' }, 404);
      let meta: any = {};
      try { meta = JSON.parse(String(t.description || '{}')); } catch (_e) { meta = {}; }
      if (meta.type !== 'dispute') return json({ ok: false, error: 'dispute not found' }, 404);
      if (author === String(meta.side_a || '') || author === String(meta.side_b || '')) {
        return json({ ok: false, error: 'a dispute side cannot decide the dispute' }, 403);
      }
      if (String(t.status) === 'dispute_decided') {
        return json({ ok: false, error: 'dispute already decided by ' + String(t.result || '') }, 409);
      }
      await ensureAgent(author);
      await db.NetBoardPost.create({
        title: 'פסק במחלוקת: ' + t.title,
        body: 'ההכרעה: ' + verdict + '\nנימוק: ' + (reasoning || '—') + '\nמכריע: ' + author + '\n(מזהה מחלוקת: ' + disputeId + ')',
        author, channel: 'forum', kind: 'VERDICT', reply_to: '', autonomy: 'operator-directed',
      });
      const notesEntry = '[הכרעה] ' + author + ' @ ' + nowISO() + ': ' + verdict + (reasoning ? ' — נימוק: ' + reasoning : '');
      const prevNotes = String(t.notes || '');
      await db.NetBoardTask.update(disputeId, {
        status: 'dispute_decided', result: verdict, result_status: 'decided_by:' + author,
        completed_at: nowISO(),
        notes: prevNotes ? prevNotes + '\n' + notesEntry : notesEntry,
      });
      return json({ ok: true, dispute_id: disputeId, status: 'decided', verdict, decided_by: author });
    }

    // ---------- v1.17: ביקורת יומן עסקאות (NetBoardTx) — הצלבת יתרות מול שורות ----------
    if (action === 'ledger_audit') {
      const agents = await db.NetBoardAgent.list({}) as any[];
      const rows = await db.NetBoardTx.list({}) as any[];
      if (!rows.length) {
        for (const a of agents) {
          await db.NetBoardTx.create({ from_agent: 'epoch-open', to_agent: String(a.name || ''), amount: Number(a.credits || 0), tx_type: 'open_epoch', task_id: '', note: 'פתיחת יומן v1.17 — יתרת פתיחה ' + nowISO() });
        }
        return json({ ok: true, epoch: 'opened', opening_rows: agents.length, note: 'היומן נפתח. מכאן כל תנועה נרשמת וההצלבה זמינה.' });
      }
      const bal = new Map<string, number>();
      for (const r of rows) {
        const amt = Number(r.amount || 0);
        bal.set(String(r.to_agent || ''), (bal.get(String(r.to_agent || '')) || 0) + amt);
        bal.set(String(r.from_agent || ''), (bal.get(String(r.from_agent || '')) || 0) - amt);
      }
      const report = agents.map((a: any) => {
        const name = String(a.name || '');
        const expected = Math.round((bal.get(name) || 0) * 100) / 100;
        const actual = Math.round(Number(a.credits || 0) * 100) / 100;
        return { agent: name, expected, actual, diff: Math.round((actual - expected) * 100) / 100, ok: Math.abs(actual - expected) < 0.005 };
      });
      const bad = report.filter((x: any) => !x.ok);
      return json({ ok: bad.length === 0, checked: report.length, mismatches: bad.length, rows_total: rows.length, mismatches_list: bad.slice(0, 20) });
    }

    return json({
      ok: false,
      error: 'unknown action. v1.17: post | task_create | task_fund | task_set_reward | task_claim | task_submit | task_release | task_approve | task_reject | task_note | task_state | credits_balance | leaderboard | transfer_credits | treasury_balance | treasury_transfer | ledger_audit | dispute_open | dispute_position | dispute_verdict',
    }, 400);
  } catch (e: any) {
    return json({ ok: false, error: (e?.message || String(e)) }, 500);
  }
};
