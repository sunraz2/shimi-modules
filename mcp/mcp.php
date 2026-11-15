<?php
// ============================================================
// Shimi Network MCP server v1.0  (2026-11-15, shimi-pituach)
// Stateless MCP over HTTP (JSON-RPC 2.0) for network agents.
// Endpoint: https://shimi.wtf/api/v2/mcp.php
// Auth: Authorization: Bearer <token>   (or X-Mcp-Key / ?key=)
// Tokens file: /home/rxsbeewori/private_storage/mcp_tokens.json
// Human/browser simple mode: GET ?op=ping|tools|whoami|read|list
// ============================================================
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: content-type, authorization, x-mcp-key, mcp-protocol-version, mcp-session-id');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

const ROOT_PATH = '/home/rxsbeewori';
const TOK_FILE  = '/home/rxsbeewori/private_storage/mcp_tokens.json';
const PUB_DIR   = '/home/rxsbeewori/shimi.wtf/pub';
const PROTO_DEFAULT = '2024-11-05';
const SERVER_NAME = 'shimi-network';
const SERVER_VER  = '1.0.0';

function jout($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(string $msg, int $code = 400): void { jout(['ok' => false, 'error' => $msg], $code); }

// ---------- tokens ----------
function load_tokens(): array {
    if (!is_file(TOK_FILE)) return ['tokens' => []];
    $j = json_decode((string)@file_get_contents(TOK_FILE), true);
    return is_array($j) ? $j : ['tokens' => []];
}
function save_tokens(array $db): void {
    @file_put_contents(TOK_FILE, json_encode($db, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), LOCK_EX);
    @chmod(TOK_FILE, 0600);
}
function bearer(): string {
    $h = '';
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $k) if (!empty($_SERVER[$k])) { $h = (string)$_SERVER[$k]; break; }
    if ($h !== '' && preg_match('/Bearer\s+(.+)/i', $h, $m)) return trim($m[1]);
    if (!empty($_SERVER['HTTP_X_MCP_KEY'])) return trim((string)$_SERVER['HTTP_X_MCP_KEY']);
    if (!empty($_GET['key'])) return trim((string)$_GET['key']);
    if (!empty($_GET['token'])) return trim((string)$_GET['token']);
    return '';
}
function auth(): array {
    $tok = bearer();
    if ($tok === '') fail('missing token (Authorization: Bearer <token>)', 401);
    $db = load_tokens();
    foreach (($db['tokens'] ?? []) as $t) {
        if (!empty($t['token']) && hash_equals((string)$t['token'], $tok)) {
            if (!empty($t['revoked'])) fail('token revoked', 403);
            if (!empty($t['expires']) && strtotime((string)$t['expires']) < time()) fail('token expired', 403);
            $t['scopes'] = is_array($t['scopes'] ?? null) ? $t['scopes'] : [];
            return $t;
        }
    }
    fail('invalid token', 403);
}
function has(array $who, string $scope): bool {
    $s = $who['scopes'] ?? [];
    return in_array('admin', $s, true) || in_array($scope, $s, true);
}
function need(array $who, string $scope): void {
    if (!has($who, $scope)) fail("scope '$scope' required for this token", 403);
}

// ---------- paths ----------
function norm_path(string $p): string {
    $p = str_replace('\\', '/', trim($p));
    if ($p === '') $p = '.';
    if ($p[0] !== '/') $p = ROOT_PATH . '/' . $p;
    $out = [];
    foreach (explode('/', $p) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..') { array_pop($out); continue; }
        $out[] = $seg;
    }
    return '/' . implode('/', $out);
}
function guard(array $who, string $path): string {
    $abs = norm_path($path);
    if (strpos($abs, ROOT_PATH . '/') !== 0 && $abs !== ROOT_PATH) fail('path outside home', 403);
    if (strpos($abs, ROOT_PATH . '/private_storage') === 0 && !has($who, 'vault')) fail('private_storage needs vault scope', 403);
    return $abs;
}

// ---------- tools ----------
function tool_defs(): array {
    return [
        ['name' => 'server_info', 'description' => 'Shimi server identity, root, php version and token scopes.',
         'inputSchema' => ['type' => 'object', 'properties' => new stdClass()]],
        ['name' => 'fs_list', 'description' => 'List a directory under /home/rxsbeewori.',
         'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string', 'description' => 'relative or absolute path, default .']], 'required' => []]],
        ['name' => 'fs_read', 'description' => 'Read a text file (utf-8). Use offset/limit for big files.',
         'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string'], 'offset' => ['type' => 'integer'], 'limit' => ['type' => 'integer']], 'required' => ['path']]],
        ['name' => 'fs_write', 'description' => 'Create or overwrite a text file. append=true adds to the end.',
         'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string'], 'content' => ['type' => 'string'], 'append' => ['type' => 'boolean']], 'required' => ['path', 'content']]],
        ['name' => 'fs_delete', 'description' => 'Delete a file (or empty dir).',
         'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string']], 'required' => ['path']]],
        ['name' => 'sh_exec', 'description' => 'Run a shell command on the server as the hosting user, cwd /home/rxsbeewori. Returns stdout/stderr/exit code.',
         'inputSchema' => ['type' => 'object', 'properties' => ['cmd' => ['type' => 'string'], 'timeout' => ['type' => 'integer', 'description' => 'seconds, 1-300, default 60']], 'required' => ['cmd']]],
        ['name' => 'pub_set', 'description' => 'Publish a live HTML page for agents at https://shimi.wtf/pub/<slug>.html.',
         'inputSchema' => ['type' => 'object', 'properties' => ['slug' => ['type' => 'string'], 'html' => ['type' => 'string']], 'required' => ['slug', 'html']]],
        ['name' => 'pub_list', 'description' => 'List published pages under /pub.',
         'inputSchema' => ['type' => 'object', 'properties' => new stdClass()]],
        ['name' => 'mcp_whoami', 'description' => 'Show the calling token: agent name and scopes.',
         'inputSchema' => ['type' => 'object', 'properties' => new stdClass()]],
        ['name' => 'mcp_token_create', 'description' => 'Mint a new agent token (admin scope only).',
         'inputSchema' => ['type' => 'object', 'properties' => [
             'agent' => ['type' => 'string'], 'scopes' => ['type' => 'array', 'items' => ['type' => 'string']],
             'days' => ['type' => 'integer', 'description' => '0 = never expires']], 'required' => ['agent']]],
        ['name' => 'mcp_token_list', 'description' => 'List agent tokens without secrets (admin scope only).',
         'inputSchema' => ['type' => 'object', 'properties' => new stdClass()]],
    ];
}

function ok_text(string $text): array {
    return ['content' => [['type' => 'text', 'text' => $text]], 'isError' => false];
}
function err_text(string $text): array {
    return ['content' => [['type' => 'text', 'text' => $text]], 'isError' => true];
}

function call_tool(array $who, string $name, array $a): array {
    switch ($name) {
        case 'server_info':
            $n = 0; foreach (scandir(ROOT_PATH) ?: [] as $e) if ($e !== '.' && $e !== '..') $n++;
            return ok_text(json_encode([
                'ok' => true, 'server' => gethostname(), 'root' => ROOT_PATH, 'php' => PHP_VERSION,
                'agent' => $who['agent'] ?? 'unknown', 'scopes' => $who['scopes'] ?? [],
                'home_entries' => $n, 'tools' => count(tool_defs()), 'endpoint' => 'https://shimi.wtf/api/v2/mcp.php',
                'time' => date('c'),
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));

        case 'fs_list': {
            need($who, 'read');
            $abs = guard($who, (string)($a['path'] ?? '.'));
            if (!is_dir($abs)) return err_text("not a directory: $abs");
            $out = [];
            foreach (scandir($abs) ?: [] as $e) {
                if ($e === '.' || $e === '..') continue;
                $p = $abs . '/' . $e;
                $out[] = ['name' => $e, 'dir' => is_dir($p), 'size' => is_dir($p) ? 0 : (int)@filesize($p),
                          'mtime' => date('c', (int)@filemtime($p))];
            }
            return ok_text(json_encode(['ok' => true, 'path' => $abs, 'count' => count($out), 'entries' => $out],
                JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        }

        case 'fs_read': {
            need($who, 'read');
            $abs = guard($who, (string)($a['path'] ?? ''));
            if (!is_file($abs)) return err_text("no such file: $abs");
            $off = max(0, (int)($a['offset'] ?? 0));
            $lim = (int)($a['limit'] ?? 200000); if ($lim < 1 || $lim > 500000) $lim = 200000;
            $data = (string)@file_get_contents($abs, false, null, $off, $lim);
            return ok_text(json_encode(['ok' => true, 'path' => $abs, 'size' => (int)@filesize($abs), 'offset' => $off,
                'returned' => strlen($data), 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        }

        case 'fs_write': {
            need($who, 'write');
            $abs = guard($who, (string)($a['path'] ?? ''));
            $dir = dirname($abs);
            if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return err_text("cannot create dir: $dir");
            $append = !empty($a['append']);
            $bytes = @file_put_contents($abs, (string)($a['content'] ?? ''), $append ? FILE_APPEND : 0);
            if ($bytes === false) return err_text("write failed: $abs");
            return ok_text(json_encode(['ok' => true, 'path' => $abs, 'bytes' => $bytes, 'append' => $append,
                'size' => (int)@filesize($abs)], JSON_UNESCAPED_SLASHES));
        }

        case 'fs_delete': {
            need($who, 'write');
            $abs = guard($who, (string)($a['path'] ?? ''));
            if (!file_exists($abs)) return err_text("no such path: $abs");
            $ok = is_dir($abs) ? @rmdir($abs) : @unlink($abs);
            return ok_text(json_encode(['ok' => (bool)$ok, 'path' => $abs], JSON_UNESCAPED_SLASHES));
        }

        case 'sh_exec': {
            need($who, 'exec');
            $cmd = (string)($a['cmd'] ?? '');
            if (trim($cmd) === '') return err_text('empty cmd');
            $t = (int)($a['timeout'] ?? 60); if ($t < 1 || $t > 300) $t = 60;
            $desc = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
            $p = @proc_open(['/bin/bash', '-lc', $cmd], $desc, $pipes, ROOT_PATH);
            if (!is_resource($p)) return err_text('proc_open failed');
            fclose($pipes[0]);
            stream_set_blocking($pipes[1], false);
            stream_set_blocking($pipes[2], false);
            $out = ''; $err = ''; $start = time();
            while (true) {
                $out .= (string)stream_get_contents($pipes[1]);
                $err .= (string)stream_get_contents($pipes[2]);
                $st = proc_get_status($p);
                if (!$st['running']) break;
                if (time() - $start > $t) { proc_terminate($p, 9); $err .= "\n[timeout {$t}s]"; break; }
                usleep(120000);
            }
            $out .= (string)stream_get_contents($pipes[1]);
            $err .= (string)stream_get_contents($pipes[2]);
            fclose($pipes[1]); fclose($pipes[2]);
            $code = proc_close($p);
            return ok_text(json_encode(['ok' => true, 'code' => $code, 'secs' => time() - $start,
                'stdout' => substr($out, 0, 200000), 'stderr' => substr($err, 0, 20000)], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        }

        case 'pub_set': {
            need($who, 'publish');
            $slug = preg_replace('/[^a-zA-Z0-9._-]/', '-', (string)($a['slug'] ?? ''));
            if ($slug === '' || $slug === '-') return err_text('bad slug');
            if (!is_dir(PUB_DIR)) @mkdir(PUB_DIR, 0755, true);
            $file = PUB_DIR . '/' . $slug . '.html';
            $html = (string)($a['html'] ?? '');
            $html = preg_replace('/<\?php/i', '&lt;?php', $html);
            $b = @file_put_contents($file, $html);
            if ($b === false) return err_text('publish failed');
            return ok_text(json_encode(['ok' => true, 'url' => 'https://shimi.wtf/pub/' . $slug . '.html', 'bytes' => $b],
                JSON_UNESCAPED_SLASHES));
        }

        case 'pub_list': {
            need($who, 'read');
            if (!is_dir(PUB_DIR)) return ok_text(json_encode(['ok' => true, 'pages' => []]));
            $pages = [];
            foreach (scandir(PUB_DIR) ?: [] as $e) {
                if (substr($e, -5) !== '.html') continue;
                $p = PUB_DIR . '/' . $e;
                $pages[] = ['slug' => substr($e, 0, -5), 'bytes' => (int)@filesize($p),
                            'mtime' => date('c', (int)@filemtime($p)),
                            'url' => 'https://shimi.wtf/pub/' . $e];
            }
            return ok_text(json_encode(['ok' => true, 'count' => count($pages), 'pages' => $pages], JSON_UNESCAPED_SLASHES));
        }

        case 'mcp_whoami':
            return ok_text(json_encode(['ok' => true, 'agent' => $who['agent'] ?? 'unknown',
                'scopes' => $who['scopes'] ?? [], 'created' => $who['created'] ?? null,
                'expires' => $who['expires'] ?? null], JSON_UNESCAPED_SLASHES));

        case 'mcp_token_create': {
            if (!has($who, 'admin')) return err_text('admin scope required');
            $agent = preg_replace('/[^a-zA-Z0-9._-]/', '-', (string)($a['agent'] ?? ''));
            if ($agent === '') return err_text('bad agent name');
            $scopes = is_array($a['scopes'] ?? null) ? array_values(array_intersect(
                array_map('strval', $a['scopes']), ['read', 'write', 'exec', 'publish', 'vault', 'admin'])) : ['read'];
            if (!$scopes) $scopes = ['read'];
            $days = (int)($a['days'] ?? 0);
            $db = load_tokens();
            $tok = 'mcp_' . bin2hex(random_bytes(18));
            $db['tokens'][] = ['token' => $tok, 'agent' => $agent, 'scopes' => $scopes,
                'created' => date('c'), 'expires' => $days > 0 ? date('c', time() + $days * 86400) : null,
                'issued_by' => $who['agent'] ?? 'unknown', 'revoked' => false];
            save_tokens($db);
            return ok_text(json_encode(['ok' => true, 'agent' => $agent, 'token' => $tok, 'scopes' => $scopes,
                'expires' => $days > 0 ? date('c', time() + $days * 86400) : null], JSON_UNESCAPED_SLASHES));
        }

        case 'mcp_token_list': {
            if (!has($who, 'admin')) return err_text('admin scope required');
            $db = load_tokens();
            $rows = [];
            foreach (($db['tokens'] ?? []) as $t) {
                $rows[] = ['agent' => $t['agent'] ?? '?', 'scopes' => $t['scopes'] ?? [],
                    'created' => $t['created'] ?? null, 'expires' => $t['expires'] ?? null,
                    'revoked' => !empty($t['revoked']), 'prefix' => substr((string)($t['token'] ?? ''), 0, 10)];
            }
            return ok_text(json_encode(['ok' => true, 'count' => count($rows), 'tokens' => $rows], JSON_UNESCAPED_SLASHES));
        }
    }
    return err_text("unknown tool: $name");
}

// ---------- JSON-RPC ----------
function rpc_one(array $req, array $who): array {
    $id = $req['id'] ?? null;
    $method = (string)($req['method'] ?? '');
    $params = is_array($req['params'] ?? null) ? $req['params'] : [];
    $reply = function (array $result) use ($id) { return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]; };
    $rpcErr = function (int $code, string $msg) use ($id) { return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $msg]]; };

    switch ($method) {
        case 'initialize':
            return $reply([
                'protocolVersion' => $params['protocolVersion'] ?? PROTO_DEFAULT,
                'capabilities' => ['tools' => ['listChanged' => false]],
                'serverInfo' => ['name' => SERVER_NAME, 'version' => SERVER_VER],
                'instructions' => 'Shimi Network server: files, shell, publishing. Auth by Bearer token. Token scopes decide what you may do.',
            ]);
        case 'notifications/initialized':
        case 'notifications/cancelled':
            return [];
        case 'ping':
            return $reply(new stdClass());
        case 'tools/list':
            return $reply(['tools' => tool_defs()]);
        case 'tools/call': {
            $name = (string)($params['name'] ?? '');
            $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
            try {
                $res = call_tool($who, $name, $args);
            } catch (Throwable $e) {
                $res = err_text('tool error: ' . $e->getMessage());
            }
            return $reply($res);
        }
        case 'resources/list':
            return $reply(['resources' => []]);
        case 'prompts/list':
            return $reply(['prompts' => []]);
    }
    if (strpos($method, 'notifications/') === 0) return [];
    return $rpcErr(-32601, 'method not found: ' . $method);
}

$who = auth();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    $op = (string)($_GET['op'] ?? 'ping');
    switch ($op) {
        case 'tools': jout(['ok' => true, 'tools' => tool_defs()]);
        case 'whoami': jout(['ok' => true, 'agent' => $who['agent'] ?? 'unknown', 'scopes' => $who['scopes'] ?? [], 'expires' => $who['expires'] ?? null]);
        case 'read': jout(call_tool($who, 'fs_read', ['path' => (string)($_GET['path'] ?? ''), 'limit' => 200000]));
        case 'list': jout(call_tool($who, 'fs_list', ['path' => (string)($_GET['path'] ?? '.')]));
        case 'exec': jout(call_tool($who, 'sh_exec', ['cmd' => (string)($_GET['cmd'] ?? ''), 'timeout' => (int)($_GET['t'] ?? 60)]));
        default:
            jout(['ok' => true, 'server' => SERVER_NAME, 'v' => SERVER_VER, 'transport' => 'streamable-http',
                  'protocol' => PROTO_DEFAULT, 'tools' => count(tool_defs()), 'time' => date('c'),
                  'agent' => $who['agent'] ?? 'unknown', 'hint' => 'POST JSON-RPC 2.0 here, Bearer token required']);
    }
}

$raw = (string)file_get_contents('php://input');
$body = json_decode($raw, true);
if (!is_array($body)) jout(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32700, 'message' => 'parse error']], 400);

if (array_is_list($body)) {
    $out = [];
    foreach ($body as $r) if (is_array($r)) { $x = rpc_one($r, $who); if ($x) $out[] = $x; }
    if (!$out) { http_response_code(202); exit; }
    jout($out);
}
$res = rpc_one($body, $who);
if (!$res) { http_response_code(202); exit; }
jout($res);
