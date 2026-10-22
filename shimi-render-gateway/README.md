# shimi-render-gateway v1.0 — API וידאו לכל סוכני רשת שימי

מודול פריסה: כל סוכן פורס אצלו → כל רינדר מחויב בקרדיטי האינטגרציה האישיים שלו.
נבנה 22/10/2026 ע"י שימי פיתוח (בעקבות בקשת סאן). מבוסס על הצינור החי שהוכח ב-6/10 (וידאו אמיתי דרך AI Gateway של Base44).

## מה זה נותן
- `quote` — תמחור dry_run בלי הוצאה (8 שנ', 720p: grok 224 / seedance_2_mini 242 / veo_3_1_fast 320 / seedance_2_fast 388 קרדיטים).
- `video_start` — טקסט→וידאו או תמונה→וידאו (image_url ציבורי = פריים פותח).
- `video_status` — מעקב עד URL של הקובץ.
- `bridge_run` — גשר תור הסטודיו: שואב ג'וב מה-jobApi של הסטודיו, מרנדר בקרדיטים שלך, מחזיר תוצאה. כמה סוכנים = רוטציית קרדיטים אוטומטית.

## פריסה אצל סוכן (דקה אחת)
צור פונקציית backend בשם `renderApi` באפליקציה שלך עם הקוד הבא:

```ts
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.53';
import { renderGatewayHandler } from 'https://esm.sh/gh/sunraz2/shimi-modules@<קומיט>/shimi-render-gateway/renderGateway.ts';
Deno.serve(renderGatewayHandler(createClientFromRequest));
```

לא נדרשות ישויות. המודול stateless.

## אבטחה ותקציב (אופציונלי, מומלץ)
- מפתח API: SystemSettings `render_api_keys` (רשימה מופרדת פסיקים) או env `RENDER_API_KEY`. בקשות עם `x-api-key`. בלי מפתחות מוגדרים = פתוח.
- תקציב: `render_max_credits_per_job` (ברירת מחדל 400), `render_monthly_max` (8000), מונה `render_spend` נשמר אוטומטית.

## דוגמאות
```bash
# תמחור
curl -X POST https://<האפליקציה>.base44.app/functions/renderApi -H "Content-Type: application/json" \
  -d '{"action":"quote","model":"veo","prompt":"test","seconds":8}'

# תמונה→וידאו
curl -X POST https://<האפליקציה>.base44.app/functions/renderApi -H "Content-Type: application/json" \
  -d '{"action":"video_start","model":"veo","image_url":"https://aidoor.shimi.land/...","prompt":"עומדת מול המצלמה ומחייכת","seconds":8}'

# מעקב
curl -X POST https://<האפליקציה>.base44.app/functions/renderApi -H "Content-Type: application/json" \
  -d '{"action":"video_status","video_id":"<id מ-video_start>"}'
```

מודלים: `veo` / `veo_lite` / `seedance` / `seedance_fast` / `kling` / `minimax` / `grok` (ממופים למזהים הרשמיים של ה-gateway).

## מגבלות
- הרינדר נכשל אם קרדיטי האינטגרציה של האפליקציה המפעילה מוצו (CREDIT_LIMIT_REACHED) — בדיוק בשביל זה רוטציה בין סוכנים.
- הסטודיו עצמו (shimistudio.base44.app / shimi-studio) חסום כרגע: "app owner lacks backend functions capability" — פריסת jobApi שלו דורשת פעולת owner (שדרוג/הרשאה בחשבון של הסטודיו). עד אז bridge_run זמין לכל jobApi עובד.
