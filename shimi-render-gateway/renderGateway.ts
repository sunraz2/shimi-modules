// ═══════════════════════════════════════════════════════════════════
// shimi-render-gateway v1.0 — API וידאו לכל סוכני רשת שימי (22/10/2026, שימי פיתוח)
// הבעיה: לסוכן אין מודל תמונה→וידאו, הסטודיו ממתין ל-worker, וקרדיטי האינטגרציה של אפליקציה אחת מתמצים.
// הפתרון: מודול אחד שכל סוכן פורס אצלו — והרינדר מחויב בקרדיטי האינטגרציה האישיים שלו.
//
// מצבי הפעלה:
//   1) API עצמאי (stateless — לא צריך שום ישות):
//      quote        — תמחור dry_run בלי הוצאה
//      video_start  — טקסט→וידאו או תמונה→וידאו (פריים פותח מתמונה ציבורית)
//      video_status — מעקב עד URL של הקובץ
//   2) גשר תור סטודיו (bridge_run): שואב ג'ובים מה-jobApi של הסטודיו, מרנדר בקרדיטים
//      של האפליקציה המפעילה, ומחזיר תוצאה לסטודיו. כך כמה סוכנים = רוטציית קרדיטים.
//
// פריסה אצל סוכן אחר (דקה אחת):
//   export default + Deno.serve(renderGatewayHandler(createClientFromRequest)) — ראה README.
//   דרישה: @base44/sdk@0.8.53+ (aiGateway).
//   הגנה: מפתח x-api-key מול SystemSettings render_api_keys (או env RENDER_API_KEY).
//   שומרי תקציב: render_max_credits_per_job (ברירת מחדל 400), render_monthly_max (8000),
//   מונה render_spend ב-SystemSettings של האפליקציה המפעילה.
// ═══════════════════════════════════════════════════════════════════

import type { Request } from 'npm:@base44/sdk@0.8.53';

export interface RenderGatewayDeps {
  asServiceRole: any; // base44.asServiceRole — האפליקציה המפעילה
}

const DEFAULT_MODEL = 'veo_3_1_fast';
const MODEL_MAP: Record<string, string> = {
  wan22: 'veo_3_1_fast', ltx: 'veo_3_1_fast', ad15: 'veo_3_1_fast',
  veo: 'veo_3_1_fast', veo_lite: 'veo_3_1_lite',
  seedance: 'seedance_2', seedance_fast: 'seedance_2_fast',
  kling: 'kling_3', minimax: 'minimax_h3', grok: 'grok_imagine_video',
};
// תמחור שנומד ב-6/10/2026 (8 שנ', 720p) — להצגה בלבד; quote מחזיר תמחור חי
const REFERENCE_PRICING: Record<string, number> = {
  grok_imagine_video: 224, seedance_2_mini: 242, veo_3_1_fast: 320, seedance_2_fast: 388,
};

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });
const asArr = (x: any): any[] => Array.isArray(x) ? x : (x?.data || x?.items || x?.records || []);

export function renderGatewayHandler(base44: any) {
  // תמיכה בשני סגנונות wrapper: renderGatewayHandler(createClientFromRequest) או renderGatewayHandler(client)
  const svcOf = (req: Request) => {
    const client = typeof base44 === 'function' ? base44(req) : base44;
    return client.asServiceRole;
  };

  const setting = async (key: string, dflt: string): Promise<string> => {
    try {
      const rec = await svc.entities.SystemSettings.list({ filter: { key }, limit: 1 });
      const r = asArr(rec);
      return r.length > 0 && r[0].value ? String(r[0].value) : dflt;
    } catch { return dflt; } // אפליקציה בלי SystemSettings — ברירות מחדל
  };

  const authed = async (req: Request): Promise<boolean> => {
    const hdr = (req.headers.get('x-api-key') || req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const fromEnv = (Deno as any).env?.get?.('RENDER_API_KEY') || '';
    const fromSettings = await setting('render_api_keys', '');
    const allowed = [fromEnv, ...fromSettings.split(',').map((s: string) => s.trim())].filter(Boolean);
    if (!allowed.length) return true; // אין מפתחות מוגדרים = פתוח (החלטת המפעיל)
    return allowed.includes(hdr);
  };

  const budgetState = async () => {
    const capPerJob = Number(await setting('render_max_credits_per_job', '400'));
    const monthlyMax = Number(await setting('render_monthly_max', '8000'));
    let spend = 0;
    try { spend = Number(JSON.parse(await setting('render_spend', '{}')).credits || 0); } catch { spend = 0; }
    return { capPerJob, monthlyMax, spend };
  };

  const addSpend = async (credits: number) => {
    try {
      const cur = JSON.parse(await setting('render_spend', '{}') || '{}');
      const month = new Date().toISOString().slice(0, 7);
      const creditsNow = Number(cur.credits || 0) + Number(credits);
      const rec = await svc.entities.SystemSettings.list({ filter: { key: 'render_spend' }, limit: 1 });
      const r = asArr(rec);
      const payload = { credits: creditsNow, month, updated: new Date().toISOString() };
      if (r.length > 0) await svc.entities.SystemSettings.update(r[0].id, { value: JSON.stringify(payload) });
      else await svc.entities.SystemSettings.create({ key: 'render_spend', value: JSON.stringify(payload), description: 'מונה הוצאת קרדיטים חודשי של shimi-render-gateway' });
      return creditsNow;
    } catch { return null; } // כשל במונה לא חוסם רינדר
  };

  const buildRequest = (b: any, model: string) => {
    const reqBody: any = {
      model,
      prompt: String(b.prompt || '').slice(0, 10000),
      seconds: Number(b.seconds || b.duration) >= 1 ? Number(b.seconds || b.duration) : 8,
      resolution: String(b.resolution || '720p'),
      aspect_ratio: String(b.aspect_ratio || b.aspect || '16:9'),
      generate_audio: b.generate_audio !== false,
    };
    // תמונה→וידאו: תמונה ציבורית נהפכת לפריים פותח
    const img = String(b.image_url || b.reference_image || '');
    if (img.startsWith('https://') && !img.includes('private')) {
      reqBody.frame_images = [{ type: 'image_url', image_url: { url: img }, frame_type: 'first_frame' }];
    }
    if (b.voice_text) reqBody.prompt = (reqBody.prompt + ' .עם קריינות: ' + String(b.voice_text).slice(0, 300)).slice(0, 10000);
    if (b.negative_prompt) reqBody.negative_prompt = String(b.negative_prompt).slice(0, 1000);
    return reqBody;
  };

  const gwPost = async (reqBody: any) => {
    const gw = svc.aiGateway.connection();
    const res = await fetch(`${gw.baseURL}/videos`, {
      method: 'POST',
      headers: { ...gw.headers, Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const raw = await res.text().catch(() => '');
    let data: any = {}; try { data = JSON.parse(raw); } catch { data = { _raw: raw.slice(0, 300) }; }
    const location = res.headers.get('location') || '';
    const locId = (location.match(/videos\/([A-Za-z0-9_-]+)/) || [])[1] || '';
    return { http: res.status, data, id: data?.id || locId || '' };
  };

  const gwGet = async (videoId: string) => {
    const gw = svc.aiGateway.connection();
    const res = await fetch(`${gw.baseURL}/videos/${videoId}`, {
      headers: { ...gw.headers, Authorization: `Bearer ${gw.token}` },
    });
    const data = await res.json().catch(() => ({}));
    return { http: res.status, data };
  };

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const svc = svcOf(req);
      const body = await req.json().catch(() => ({}));
      const action = String(body.action || '');

      if (!(await authed(req))) return json({ ok: false, error: 'unauthorized: x-api-key חסר או שגוי' }, 401);

      // ══════════ info ══════════
      if (action === 'info' || action === '' ) {
        const bud = await budgetState();
        return json({
          ok: true, service: 'shimi-render-gateway', version: '1.0',
          how_it_works: 'כל רינדר מחויב בקרדיטי האינטגרציה של האפליקציה שפרסה את הפונקציה',
          actions: ['info', 'quote', 'video_start', 'video_status', 'bridge_run'],
          models: MODEL_MAP,
          reference_pricing_8s_720p: REFERENCE_PRICING,
          budget: bud,
        });
      }

      // ══════════ quote (dry_run — בלי הוצאה) ══════════
      if (action === 'quote') {
        const model = MODEL_MAP[String(body.model || '')] || DEFAULT_MODEL;
        const r = await gwPost({ ...buildRequest(body, model), dry_run: true });
        return json({ ok: r.http === 200, model, quote: r.data }, r.http === 200 ? 200 : r.http);
      }

      // ══════════ video_start ══════════
      if (action === 'video_start') {
        if (!body.prompt) return json({ ok: false, error: 'prompt required' }, 400);
        const model = MODEL_MAP[String(body.model || '')] || DEFAULT_MODEL;
        const bud = await budgetState();
        if (bud.spend >= bud.monthlyMax) return json({ ok: false, error: 'monthly_budget_reached', spend: bud.spend, cap: bud.monthlyMax }, 429);

        const reqBody = buildRequest(body, model);
        const quote = await gwPost({ ...reqBody, dry_run: true });
        const cost = Number(quote?.data?.estimated_base44_credits ?? quote?.data?.usage?.base44_credits ?? REFERENCE_PRICING[model] ?? 400);
        if (cost > bud.capPerJob) return json({ ok: false, error: 'job_budget_exceeded', cost, cap: bud.capPerJob }, 429);

        const r = await gwPost(reqBody);
        if ((r.http === 200 || r.http === 201 || r.http === 202) && r.id) {
          await addSpend(cost);
          return json({ ok: true, video_id: r.id, model, seconds: reqBody.seconds, quoted_credits: cost, next: `video_status עם video_id=${r.id}` });
        }
        return json({ ok: false, error: `gateway_http_${r.http}`, detail: String(r.data?.error?.message || r.data?._raw || '').slice(0, 200), hint: 'אם CREDIT_LIMIT_REACHED — קרדיטי האינטגרציה של האפליקציה המפעילה מוצו' }, 502);
      }

      // ══════════ video_status ══════════
      if (action === 'video_status') {
        const vid = String(body.video_id || '');
        if (!vid) return json({ ok: false, error: 'video_id required' }, 400);
        const r = await gwGet(vid);
        const d = r.data || {};
        const done = String(d.status || d.state || '') === 'completed' || !!d.video_url || !!d.url;
        return json({
          ok: r.http === 200, video_id: vid, status: d.status || d.state || 'unknown',
          completed: done,
          output_url: d.video_url || d.url || d.output_url || null,
          raw_keys: Object.keys(d).slice(0, 12),
        }, r.http === 200 ? 200 : r.http);
      }

      // ══════════ bridge_run — גשר תור הסטודיו ══════════
      if (action === 'bridge_run') {
        const studioBase = String(body.studio_base || await setting('render_studio_base', 'https://shimi-studio.base44.app'));
        const studioKey = String(body.studio_key || await setting('render_studio_key', ''));
        const maxJobs = Math.min(Number(body.max_jobs || 1), 3);

        const apiPost = async (payload: any) => {
          const res = await fetch(`${studioBase}/functions/jobApi`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': studioKey }, body: JSON.stringify(payload),
          });
          return await res.json().catch(() => ({}));
        };

        const claimed: any[] = [];
        for (let i = 0; i < maxJobs; i++) {
          const claim = await apiPost({ action: 'claim', worker_id: body.worker_id || 'render-bridge-' + Math.random().toString(36).slice(2, 8) });
          const job = claim?.job || claim;
          if (!job || !job.id) break;

          const model = MODEL_MAP[String(((job.parameters || '') + '').match(/"(?:engine|model)"\s*:\s*"([^"]+)"/)?.[1] || '')] || DEFAULT_MODEL;
          const reqBody = buildRequest(job, model);
          const bud = await budgetState();
          if (bud.spend >= bud.monthlyMax) { await apiPost({ action: 'release', job_id: job.id }); break; }
          const quote = await gwPost({ ...reqBody, dry_run: true });
          const cost = Number(quote?.data?.estimated_base44_credits ?? quote?.data?.usage?.base44_credits ?? REFERENCE_PRICING[model] ?? 400);
          if (cost > bud.capPerJob) {
            await apiPost({ action: 'fail', job_id: job.id, error: `bridge_budget_exceeded: ${cost} > ${bud.capPerJob}` });
            claimed.push({ id: job.id, result: 'rejected_budget' }); continue;
          }
          const r = await gwPost(reqBody);
          if (r.id) {
            await addSpend(cost);
            await apiPost({ action: 'update', job_id: job.id, status: 'processing', worker_id: 'render-bridge', progress: 10, workflow_id: r.id });
            // מעקב עד סיום (עד 5 דק')
            let outUrl: string | null = null;
            for (let p = 0; p < 30; p++) {
              await new Promise((res) => setTimeout(res, 10000));
              const st = await gwGet(r.id);
              const d = st.data || {};
              outUrl = d.video_url || d.url || d.output_url || null;
              if (String(d.status || d.state || '').match(/complete|succeed|done/i) || outUrl) break;
              if (String(d.status || d.state || '').match(/fail|error/i)) break;
            }
            if (outUrl) {
              await apiPost({ action: 'complete', job_id: job.id, output_url: outUrl, credits_spent: cost });
              claimed.push({ id: job.id, result: 'completed', output_url: outUrl, credits: cost });
            } else {
              await apiPost({ action: 'update', job_id: job.id, status: 'processing', progress: 50, note: 'bridge: עדיין בעיבוד ב-gateway' });
              claimed.push({ id: job.id, result: 'still_processing', video_id: r.id });
            }
          } else {
            await apiPost({ action: 'fail', job_id: job.id, error: `gateway_http_${r.http}` });
            claimed.push({ id: job.id, result: 'gateway_error', http: r.http });
          }
        }
        return json({ ok: true, studio: studioBase, claimed });
      }

      return json({ ok: false, error: 'unknown action', available: ['info', 'quote', 'video_start', 'video_status', 'bridge_run'] }, 400);
    } catch (e: any) {
      return json({ ok: false, error: 'handler_error', detail: String(e?.message || e).slice(0, 300) }, 500);
    }
  };
}
