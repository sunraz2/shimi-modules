<?php
/**
 * mcp.php — שרת MCP של רשת שימי (JSON-RPC 2.0 over HTTP).
 * מאפשר לסוכנים חיצוניים לקרוא, לכתוב, לפרסם דפים ולהריץ פעולות API ברשת.
 * v1.0 · 15/11/2026 · שימי פיתוח
 */
declare(strict_types=1);
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Mcp-Key, X-Agent, Accept');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

const ROOT     = '/home/rxsbeewori';
const GATE_KEY = 'shg_XZVPlG-iKvRNIZHglAyy7vooD4nJhqgbfKA9Zw';
const VERSION  = '1.0.0';
const TOKENS_F = ROOT . '/private_storage/mcp_tokens.json';
const LOG_F    = ROOT . '/private_storage/mcp_calls.jsonl';
const MAX_W    = 400000;   // 400KB לכתיבה
const API_DIR  = ROOT . '/shimi.wtf/api/fn/';

function jrpc($id, $result) {
    return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
}
function jrpc_err($id, $code, $msg, $data = null) {
    $e = ['code' => $code, 'message' => $msg];
    if ($data !== null) $e['data'] = $data;
    return ['jsonrpc' => '2.0', 'id' => $id, 'error' => $e];
}
function emit(array $payload) {
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $accept = (string)($_SERVER['HTTP_ACCEPT'] ?? '');
    if (stripos($accept, 'text/event-stream') !== false) {
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-store');
        echo "event: message\ndata: " . $json . "\n\n";
    } else {
        header('Content-Type: application/json; charset=utf-8');
        echo $json;
    }
    exit;
}
function body(): array {
    $raw = file_get_contents('php://input');
    $d = json_decode((string)$raw, true);
    if (!is_array($d)) $d = [];
    // תמיכה גם ב-GET לצורכי בדיקה: ?rpc=<json>&key=
    if (!$d && isset($_GET['rpc'])) {
        $t = json_decode((string)$_GET['rpc'], true);
        if (is_array($t)) $d = $t;
    }
    return $d;
}
function tokens(): array {
    if (!is_file(TOKENS_F)) return [];
    $d = json_decode((string)file_get_contents(TOKENS_F), true);
    return is_array($d) ? $d : [];
}
function in_root(string $path): string {
    $path = str_replace("\0", '', $path);
    if (preg_match('#(^|/)\.\.(/|$)#', $path)) throw new RuntimeException('outside_root');
    $abs = str_starts_with($path, '/') ? $path : ROOT . '/' . ltrim($path, '/');
    $abs = preg_replace('#/+#', '/', $abs);
    if ($abs !== ROOT && !str_starts_with($abs, ROOT . '/')) throw new RuntimeException('outside_root');
    return $abs;
}
function audit(string $agent, string $tool, array $args, $ok, $note = '') {
    $line = json_encode([
        'ts' => date('c'), 'agent' => $agent, 'tool' => $tool,
        'args' => array_map(fn($v) => is_string($v) ? mb_substr($v, 0, 120) : $v, $args),
        'ok' => (bool)$ok, 'note' => mb_substr($note, 0, 200), 'ip' => $_SERVER['REMOTE_ADDR'] ?? ''
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    @file_put_contents(LOG_F, $line . "\n", FILE_APPEND | LOCK_EX);
}

/* ---------- אימות ---------- */
$key   = (string)($_SERVER['HTTP_X_MCP_KEY'] ?? ($_GET['key'] ?? ''));
$agent = preg_replace('/[^A-Za-z0-9._-]/', '', (string)($_SERVER['HTTP_X_AGENT'] ?? ($_GET['agent'] ?? 'anonymous')));
$agent = mb_substr($agent, 0, 40);
if ($agent === '') $agent = 'anonymous';

$scopes = [];
$authorized = false;
if ($key !== '' && hash_equals(GATE_KEY, $key)) {
    $authorized = true; $scopes = ['fs', 'publish', 'api'];
} else {
    // תמיכה ב-Bearer
    $auth = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    if (stripos($auth, 'Bearer ') === 0) {
        $key = trim(substr($auth, 7));
        if (hash_equals(GATE_KEY, $key)) { $authorized = true; $scopes = ['fs', 'publish', 'api']; }
    }
}
if (!$authorized && $key !== '') {
    $t = tokens();
    if (isset($t[$key]) && is_array($t[$key]) && ($t[$key]['status'] ?? 'active') === 'active') {
        $authorized = true;
        $scopes = (array)($t[$key]['scopes'] ?? ['fs', 'publish']);
        if (!empty($t[$key]['agent'])) $agent = (string)$t[$key]['agent'];
    }
}
if (!$authorized) { http_response_code(401); emit(jrpc_err(null, -32001, 'unauthorized')); }

$need = function (string $scope) use ($scopes) {
    if (!in_array($scope, $scopes, true)) throw new RuntimeException('missing_scope:' . $scope);
};

/* ---------- כלים ---------- */
$TOOLS = [
    [
        'name' => 'fs_list',
        'description' => 'רשימת קבצים ותיקיות בשרת הרשת (בתוך /home/rxsbeewori).',
        'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string', 'description' => 'נתיב יחסי, ריק = שורש הבית']], 'required' => []],
    ],
    [
        'name' => 'fs_read',
        'description' => 'קריאת קובץ טקסט מהשרת (עד 400KB).',
        'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string'], 'max_bytes' => ['type' => 'integer']], 'required' => ['path']],
    ],
    [
        'name' => 'fs_write',
        'description' => 'כתיבה/עדכון קובץ בשרת. יוצר תיקיות אם צריך.',
        'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string'], 'content' => ['type' => 'string'], 'mode' => ['type' => 'string', 'enum' => ['set', 'append']]], 'required' => ['path', 'content']],
    ],
    [
        'name' => 'fs_delete',
        'description' => 'מחיקת קובץ מהשרת.',
        'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string']], 'required' => ['path']],
    ],
    [
        'name' => 'publish_page',
        'description' => 'פרסום דף HTML חי תחת https://shimi.wtf/pub/<page>.html — בלי טוקן GitHub.',
        'inputSchema' => ['type' => 'object', 'properties' => ['page' => ['type' => 'string'], 'html' => ['type' => 'string'], 'mode' => ['type' => 'string', 'enum' => ['set', 'append']]], 'required' => ['page', 'html']],
    ],
    [
        'name' => 'api_call',
        'description' => 'קריאה ל-endpoint פנימי של הרשת (bankApi, shimicard, sb, payApi, netBoard ועוד).',
        'inputSchema' => ['type' => 'object', 'properties' => ['endpoint' => ['type' => 'string', 'description' => 'למשל bankApi.php'], 'params' => ['type' => 'object']], 'required' => ['endpoint']],
    ],
    [
        'name' => 'server_status',
        'description' => 'מצב השרת: דיסק, עומס, גרסת PHP, קבצים אחרונים.',
        'inputSchema' => ['type' => 'object', 'properties' => [], 'required' => []],
    ],
];

$API_ALLOW = ['bankApi.php', 'shimicard.php', 'sb.php', 'payApi.php', 'netBoard.php', 'collect.php',
              'cryptoOrder.php', 'walletApi.php', 'forumProxy.php', 'getNetworkArchive.php', 'jobApi.php'];

function call_tool(string $name, array $a, string $agent): array {
    global $need, $API_ALLOW;
    if ($name === 'fs_list') {
        $need('fs');
        $p = in_root((string)($a['path'] ?? ''));
        if (!is_dir($p)) return ['ok' => false, 'error' => 'not_a_dir'];
        $out = [];
        foreach (scandir($p) as $f) {
            if ($f === '.' || $f === '..') continue;
            $fp = $p . '/' . $f;
            $out[] = ['name' => $f, 'dir' => is_dir($fp), 'size' => is_dir($fp) ? 0 : filesize($fp),
                      'modified' => date('c', filemtime($fp))];
        }
        return ['ok' => true, 'path' => $p, 'count' => count($out), 'entries' => $out];
    }
    if ($name === 'fs_read') {
        $need('fs');
        $p = in_root((string)($a['path'] ?? ''));
        if (!is_file($p)) return ['ok' => false, 'error' => 'not_found'];
        $max = min((int)($a['max_bytes'] ?? MAX_W), MAX_W);
        return ['ok' => true, 'path' => $p, 'size' => filesize($p),
                'content' => (string)file_get_contents($p, false, null, 0, $max)];
    }
    if ($name === 'fs_write') {
        $need('fs');
        $p = in_root((string)($a['path'] ?? ''));
        $c = (string)($a['content'] ?? '');
        if (strlen($c) > MAX_W) return ['ok' => false, 'error' => 'too_large', 'limit' => MAX_W];
        if (!is_dir(dirname($p)) && !@mkdir(dirname($p), 0755, true)) return ['ok' => false, 'error' => 'mkdir_failed'];
        $mode = (($a['mode'] ?? 'set') === 'append') ? FILE_APPEND : 0;
        $bytes = @file_put_contents($p, $c, $mode | LOCK_EX);
        if ($bytes === false) return ['ok' => false, 'error' => 'write_failed'];
        return ['ok' => true, 'path' => $p, 'bytes' => $bytes, 'total' => filesize($p)];
    }
    if ($name === 'fs_delete') {
        $need('fs');
        $p = in_root((string)($a['path'] ?? ''));
        if (!is_file($p)) return ['ok' => false, 'error' => 'not_found'];
        return ['ok' => (bool)@unlink($p), 'path' => $p];
    }
    if ($name === 'publish_page') {
        $need('publish');
        $page = preg_replace('/[^a-z0-9._-]/i', '-', (string)($a['page'] ?? ''));
        if ($page === '') return ['ok' => false, 'error' => 'page_required'];
        $html = (string)($a['html'] ?? '');
        if (strlen($html) > MAX_W) return ['ok' => false, 'error' => 'too_large'];
        $dir = ROOT . '/shimi.wtf/pub';
        if (!is_dir($dir)) @mkdir($dir, 0755, true);
        $f = $dir . '/' . $page . '.html';
        $mode = (($a['mode'] ?? 'set') === 'append') ? FILE_APPEND : 0;
        $tmp = $f . '.tmp';
        if ($mode === 0) { @file_put_contents($tmp, $html, LOCK_EX); @rename($tmp, $f); }
        else { @file_put_contents($f, $html, FILE_APPEND | LOCK_EX); }
        $url = 'https://shimi.wtf/pub/' . $page . '.html';
        return ['ok' => is_file($f), 'page' => $page, 'url' => $url, 'bytes' => is_file($f) ? filesize($f) : 0];
    }
    if ($name === 'api_call') {
        $need('api');
        $ep = (string)($a['endpoint'] ?? '');
        if (!in_array($ep, $API_ALLOW, true)) return ['ok' => false, 'error' => 'endpoint_not_allowed', 'allowed' => $API_ALLOW];
        $params = (array)($a['params'] ?? []);
        $params['key'] = GATE_KEY;
        $ch = curl_init('https://shimi.wtf/api/fn/' . $ep);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 45,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode($params, JSON_UNESCAPED_UNICODE),
        ]);
        $r = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
        $j = json_decode((string)$r, true);
        return ['ok' => $code < 400 && is_array($j), 'http' => $code,
                'data' => is_array($j) ? $j : mb_substr((string)$r, 0, 800)];
    }
    if ($name === 'server_status') {
        return ['ok' => true, 'php' => PHP_VERSION, 'disk_free_gb' => round(@disk_free_space(ROOT) / 1e9, 2),
                'disk_total_gb' => round(@disk_total_space(ROOT) / 1e9, 2),
                'load' => @sys_getloadavg(), 'time' => date('c'), 'mcp_version' => VERSION];
    }
    throw new RuntimeException('unknown_tool');
}

/* ---------- ניתוב JSON-RPC ---------- */
$req = body();
$id = $req['id'] ?? null;
$method = (string)($req['method'] ?? ($_GET['method'] ?? ''));

if ($method === 'ping') emit(jrpc($id, []));

if ($method === 'initialize') {
    emit(jrpc($id, [
        'protocolVersion' => '2024-11-05',
        'capabilities' => ['tools' => ['listChanged' => false]],
        'serverInfo' => ['name' => 'shimi-network', 'version' => VERSION],
        'instructions' => 'שרת MCP של רשת שימי. כלים: fs_list, fs_read, fs_write, fs_delete, publish_page, api_call, server_status. כל כתיבה נרשמת בלוג ביקורת.',
    ]));
}
if ($method === 'tools/list') emit(jrpc($id, ['tools' => $TOOLS]));

if ($method === 'tools/call') {
    $name = (string)($req['params']['name'] ?? '');
    $args = (array)($req['params']['arguments'] ?? []);
    try {
        $res = call_tool($name, $args, $agent);
        audit($agent, $name, $args, $res['ok'] ?? false, json_encode($res['error'] ?? '', JSON_UNESCAPED_UNICODE));
        emit(jrpc($id, ['content' => [['type' => 'text', 'text' => json_encode($res, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]], 'isError' => !($res['ok'] ?? false)]));
    } catch (Throwable $e) {
        audit($agent, $name, $args, false, $e->getMessage());
        emit(jrpc($id, ['content' => [['type' => 'text', 'text' => json_encode(['ok' => false, 'error' => $e->getMessage()], JSON_UNESCAPED_UNICODE)]], 'isError' => true]));
    }
}

if ($method === '') {
    // health check ידידותי
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true, 'server' => 'shimi-network-mcp', 'version' => VERSION,
                      'tools' => array_column($TOOLS, 'name'), 'auth' => 'key or bearer',
                      'time' => date('c')], JSON_UNESCAPED_UNICODE);
    exit;
}

emit(jrpc_err($id, -32601, 'method_not_found', ['method' => $method]));
