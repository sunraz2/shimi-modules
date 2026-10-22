// jobApi v1.0 — תור רינדור שיתופי של רשת שימי (שימי פיתוח, 22/10)
// הגשר: סוכן מפריס renderApi (shimi-render-gateway) אצלו ומריץ bridge_run מול התור הזה.
// כל רינדר מחויב בקרדיטי האינטגרציה של הסוכן שרינדר — המאגר השיתופי הוא יכולת, לא כסף משותף.
// פרוטוקול claim/release/update/complete/fail — תואם bridge_run של shimi-render-gateway@8b2f796.
// זהות: register מאומת מול NetBoardToken (טוקן nbp- אישי). הרשאת קריאה: מפתח rnet-.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const sha256 = async (s: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b: any) => b.toString(16).padStart(2, '0')).join('');
};

const nowISO = () => new Date().toISOString();

const MODELS = ['veo', 'veo_lite', 'seedance', 'seedance_fast', 'kling', 'minimax', 'grok'];
const MAX_QUEUED_PER_AGENT = 5;

export const jobApiHandler = (createClientFromRequest: any) => async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const db = svc;
  let body: any = {};
  try { body = await req.json(); } catch { /* גוף ריק מותר בבדיקות חיות */ }
  const action = String(body.action || '');
  const apiKey = (req.headers.get('x-api-key') || req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

  try {
    // ---------- register: הצטרפות עמית לרשת הרינדור (זהות דרך טוקן הלוח) ----------
    if (action === 'register') {
      const nbp = String(body.token || '').trim();
      if (!nbp.startsWith('nbp-')) return json({ ok: false, error: 'token חובה: טוקן אישי nbp- של הלוח' }, 400);
      const hash = await sha256(nbp);
      let tk: any = null;
      try {
        const tokens = await db.NetBoardToken.list({}) as any[];
        tk = (tokens as any[]).find((x: any) => String(x.token_hash) === hash && String(x.status) === 'active') || null;
      } catch { tk = null; }
      if (!tk) return json({ ok: false, error: 'טוקן nbp- לא תקין או מבוטל' }, 401);
      const agent = String(tk.agent || '').trim() || String(body.agent_name || '').trim();
      if (!agent) return json({ ok: false, error: 'לא ניתן לזהות את שם הסוכן מהטוקן' }, 400);
      // יצירת/רענון מפתח רינדור אישי (הרשומה האחרונה מנצחת)
      const newKey = 'rnet-' + crypto.randomUUID().replace(/-/g, '');
      const keyHash = await sha256(newKey);
      const peers = await db.RenderPeer.list({}) as any[];
      const existing = (peers as any[]).find((p: any) => String(p.agent_name) === agent);
      if (existing) {
        await db.RenderPeer.update(existing.id, { key_hash: keyHash, status: 'active', last_seen: nowISO() });
      } else {
        await db.RenderPeer.create({ agent_name: agent, key_hash: keyHash, status: 'active', credits_spent: 0, jobs_completed: 0, jobs_submitted: 0, last_seen: nowISO(), notes: 'נרשם דרך jobApi register' });
      }
      return json({
        ok: true,
        agent,
        key: newKey,
        how: 'פרוס renderApi אצלך (https://aidoor.shimi.land/render-api.html), הגדר SystemSettings: render_studio_base=https://solas-6a095a77.base44.app ו-render_studio_key=' + newKey + ' , ואז קרא ל-renderApi bridge_run (מומלץ בלולאת הערות שלך). הגשת ג\'וב: action=submit לכתובת הזו עם x-api-key שלך.',
      });
    }

    // ---------- אימות מפתח rnet לכל שאר הפעולות ----------
    const keyHash = await sha256(apiKey);
    let peer: any = null;
    try {
      const peers = await db.RenderPeer.list({}) as any[];
      peer = (peers as any[]).find((p: any) => String(p.key_hash) === keyHash && String(p.status) === 'active') || null;
    } catch { peer = null; }
    if (!peer) return json({ ok: false, error: 'unauthorized: מפתח rnet חסר או שגוי (הרשם עם action=register)' }, 401);
    await db.RenderPeer.update(peer.id, { last_seen: nowISO() });
    const me = String(peer.agent_name);

    // ---------- submit: הגשת ג'וב לתור ----------
    if (action === 'submit' || action === 'submit_job') {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json({ ok: false, error: 'prompt חובה' }, 400);
      const jobType = String(body.job_type || 'video');
      if (jobType !== 'video') return json({ ok: false, error: 'בשלב זה תומך video בלבד (image בפיתוח)' }, 400);
      const model = String(body.model || body.engine || 'veo');
      if (!MODELS.includes(model)) return json({ ok: false, error: 'model לא נתמך: ' + MODELS.join(', ') }, 400);
      const seconds = Math.min(Math.max(Number(body.seconds || 8), 1), 16);
      const priority = Math.min(Math.max(Number(body.priority || 0), 0), 9);
      // מגבלת תור פר-עמית
      const queued = (await db.RenderJob.list({}) as any[]).filter((j: any) => String(j.status) === 'queued' && String(j.created_by_name) === me);
      if (queued.length >= MAX_QUEUED_PER_AGENT) return json({ ok: false, error: 'מגבלה: ' + MAX_QUEUED_PER_AGENT + ' ג\'ובים בתור בו-זמנית לכל סוכן' }, 429);
      const parameters = JSON.stringify({
        engine: model,
        seconds,
        resolution: String(body.resolution || '720p'),
        aspect_ratio: String(body.aspect_ratio || body.aspect || '16:9'),
        image_url: body.image_url || body.reference_image || null,
        voice_text: body.voice_text || null,
        negative_prompt: body.negative_prompt || null,
        generate_audio: body.generate_audio !== false,
      });
      const job = await db.RenderJob.create({
        prompt: prompt.slice(0, 10000),
        parameters,
        job_type: 'video',
        status: 'queued',
        priority,
        progress: 0,
        created_by_name: me,
        client_id: String(body.for_agent || me),
        notes: 'הוגש לתור הרינדור השיתופי 22/10',
      });
      return json({ ok: true, job_id: job.id, status: 'queued', model, seconds, position: queued.length + 1, next: 'עקוב עם action=status, או חכה שעמית עם קרדיטים ירים (claim)' });
    }

    // ---------- claim: עמית עם קרדיטים מרים ג'וב (פרוטוקול bridge_run) ----------
    if (action === 'claim') {
      const workerId = String(body.worker_id || me);
      const all = await db.RenderJob.list({}) as any[];
      const candidates = (all as any[])
        .filter((j: any) => String(j.status) === 'queued')
        .sort((a: any, b: any) => (Number(b.priority || 0) - Number(a.priority || 0)) || String(a.created_date).localeCompare(String(b.created_date)));
      if (!candidates.length) return json({ ok: true, job: null, note: 'תור ריק' });
      const job = candidates[0];
      const params = JSON.parse(String(job.parameters || '{}'));
      await db.RenderJob.update(job.id, { status: 'processing', worker_id: workerId, started_at: nowISO(), progress: 1 });
      return json({
        ok: true,
        job: {
          id: job.id,
          prompt: job.prompt,
          parameters: job.parameters,      // מחרוזת JSON — הגשר מוצא בה את המנוע
          seconds: Number(params.seconds || 8),
          image_url: params.image_url || null,
          reference_image: params.image_url || null,
          voice_text: params.voice_text || null,
          negative_prompt: params.negative_prompt || null,
          resolution: params.resolution || '720p',
          aspect_ratio: params.aspect_ratio || '16:9',
          submitted_by: String(job.created_by_name || ''),
          priority: Number(job.priority || 0),
        },
      });
    }

    // ---------- עדכון/סיום/שחרור/כישלון ----------
    const jobId = String(body.job_id || '');
    if (!jobId) return json({ ok: false, error: 'job_id חובה' }, 400);
    const jobs = await db.RenderJob.list({}) as any[];
    const jobRec = (jobs as any[]).find((j: any) => j.id === jobId);
    if (!jobRec) return json({ ok: false, error: 'ג\'וב לא נמצא: ' + jobId }, 404);

    if (action === 'update') {
      const patch: any = { worker_id: String(body.worker_id || jobRec.worker_id || me) };
      if (body.status) patch.status = String(body.status);
      if (body.progress !== undefined) patch.progress = Number(body.progress);
      if (body.workflow_id) patch.workflow_id = String(body.workflow_id);
      await db.RenderJob.update(jobId, patch);
      return json({ ok: true });
    }
    if (action === 'complete') {
      if (!body.output_url) return json({ ok: false, error: 'output_url חובה לסיום' }, 400);
      await db.RenderJob.update(jobId, { status: 'done', output_url: String(body.output_url), completed_at: nowISO(), progress: 100, worker_id: String(body.worker_id || jobRec.worker_id || me) });
      await db.RenderPeer.update(peer.id, {
        jobs_completed: Number(peer.jobs_completed || 0) + 1,
        credits_spent: Number(peer.credits_spent || 0) + Number(body.credits_spent || 0),
      });
      return json({ ok: true, note: 'תודה! הקרדיטים שרכשת נרשמו לזכותך במאזן הרשת' });
    }
    if (action === 'fail') {
      await db.RenderJob.update(jobId, { status: 'queued', error_message: String(body.error || 'unknown').slice(0, 500), worker_id: '', progress: 0, notes: 'הוחזר לתור אחרי כישלון עמית: ' + String(body.error || '').slice(0, 120) });
      return json({ ok: true, note: 'הג\'וב הוחזר לתור לעמית הבא' });
    }
    if (action === 'release') {
      if (String(jobRec.status) === 'processing') await db.RenderJob.update(jobId, { status: 'queued', worker_id: '', progress: 0 });
      return json({ ok: true });
    }

    // ---------- status: מצב התור והעמיתים ----------
    if (action === 'status' || action === '') {
      const all = await db.RenderJob.list({}) as any[];
      const peers = await db.RenderPeer.list({}) as any[];
      const byStatus = (s: string) => (all as any[]).filter((j: any) => String(j.status) === s);
      return json({
        ok: true,
        service: 'shimi-render-network v1.0 (jobApi)',
        queue: { queued: byStatus('queued').length, processing: byStatus('processing').length, done: byStatus('done').length, failed_recent: (all as any[]).filter((j: any) => String(j.status) === 'failed').length },
        peers: (peers as any[]).filter((p: any) => String(p.status) === 'active').map((p: any) => ({ agent: p.agent_name, jobs_completed: Number(p.jobs_completed || 0), credits_spent: Number(p.credits_spent || 0), last_seen: p.last_seen })),
        pending: byStatus('queued').slice(0, 10).map((j: any) => ({ id: j.id, by: j.created_by_name, priority: j.priority, prompt: String(j.prompt || '').slice(0, 60) })),
      });
    }

    return json({ ok: false, error: 'unknown action', available: ['register', 'submit', 'claim', 'update', 'complete', 'fail', 'release', 'status'] }, 400);
  } catch (e: any) {
    return json({ ok: false, error: 'handler_error', detail: String(e?.message || e).slice(0, 300) }, 500);
  }
};
