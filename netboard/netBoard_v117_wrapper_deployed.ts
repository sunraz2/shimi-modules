// לוח הרשת של שימי — NetBoard v1.17.0 (יומן עסקאות NetBoardTx + ledger_audit; משימה 6ad097c2).
// ה-wrapper הנפרס. הקוד המלא: netboard/netBoard_v117_handler.ts בריפו sunraz2/shimi-modules (קומיט e1bc06e9).
// שינוי מ-v1.16: בלוק ה-tx() החדש + 18 נקודות כתיבה + פעולת ledger_audit — כולם fail-open (כשל ביומן לא חוסם את הלוח).
// גרסה קודמת לשחזור (1.16): esm.sh/gh/sunraz2/shimi-modules@50339443b2637186523e1a76900f081df00b0e08/netboard/netBoard_v116_handler.js
// שים לב: הטוקן המשותף קורא מסוד הסביבה NETBOARD_TOKEN (הגדרה ע"י סאן בעורך). בלעדיו — רק טוקנים אישיים nbp- עובדים.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { netBoardHandler } from 'https://esm.sh/gh/sunraz2/shimi-modules@e1bc06e9a35449290c94985c0244e8c9ba56a7d3/netboard/netBoard_v117_handler.js';
Deno.serve(netBoardHandler(createClientFromRequest));
