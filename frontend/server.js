// SAC Innomaker — servidor do frontend.
// Entrega os arquivos de public/ e repassa /api e /drive ao backend (assim o navegador usa uma só origem).
// Uso: node server.js   (porta WEB_PORT, padrão 3000; backend em API_URL, padrão http://localhost:3001)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}); } catch (e) { }

const PORTA = Number(process.env.WEB_PORT || 3000);
const API_URL = new URL(process.env.API_URL || 'http://localhost:3001');
// Endereço da API visto pelo navegador. Vazio = mesma origem, pelo repasse abaixo.
const API_PUBLICA = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
const PUBLICO = path.join(__dirname, 'public');

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const CONFIG_JS = `window.SAC_CONFIG = ${JSON.stringify({ apiUrl: API_PUBLICA })};\n`;

function repassar(req, res) {
  const alvo = new URL(req.url, API_URL);
  const cliente = alvo.protocol === 'https:' ? https : http;
  const pedido = cliente.request(alvo, { method: req.method, headers: { ...req.headers, host: alvo.host } }, resp => {
    res.writeHead(resp.statusCode, resp.headers);
    resp.pipe(res);
  });
  pedido.on('error', e => {
    console.error('[api] backend indisponível:', e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'O servidor do SAC está fora do ar. Tente de novo em instantes.' }));
  });
  req.pipe(pedido);
}

function arquivo(req, res, caminho) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const abs = path.join(PUBLICO, path.normalize(caminho).replace(/^([\\/]|\.\.[\\/])+/, ''));
  if (!abs.startsWith(PUBLICO + path.sep)) { res.writeHead(403); return res.end('Acesso negado'); }
  fs.stat(abs, (erro, info) => {
    if (erro || !info.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/') || pathname.startsWith('/drive/')) return repassar(req, res);
  if (pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(CONFIG_JS);
  }
  // /exec mantém funcionando os links antigos do Apps Script enviados por e-mail
  if (pathname === '/' || pathname === '/exec') return arquivo(req, res, 'index.html');
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  arquivo(req, res, rel);
}).listen(PORTA, () => console.log(`Frontend em http://localhost:${PORTA} (API: ${API_URL.origin})`));
