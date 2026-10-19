// SAC Innomaker — servidor do frontend.
// Entrega os arquivos de public/ e repassa /api e /drive ao backend (assim o navegador usa uma só origem).
// Com AUTH_MODE=authelia no backend, a página do SAC só sai para quem tem sessão válida no Authelia;
// os demais recebem a landing page (public/landing.html) com o botão de login.
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

// Pergunta ao backend se o cookie do Authelia deste pedido dá acesso ao SAC
function consultarSessao(req) {
  return new Promise((ok, falha) => {
    const alvo = new URL('/api/auth/sessao', API_URL);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const pedido = (alvo.protocol === 'https:' ? https : http).get(alvo, { headers: { cookie: req.headers.cookie || '', 'x-forwarded-for': ip } }, resp => {
      let corpo = '';
      resp.on('data', c => { corpo += c; });
      resp.on('end', () => { try { ok({ status: resp.statusCode, dados: JSON.parse(corpo) }); } catch (e) { falha(e); } });
    });
    pedido.setTimeout(15000, () => pedido.destroy(new Error('tempo esgotado')));
    pedido.on('error', falha);
  });
}

async function paginaInicial(req, res, busca) {
  // O link da pesquisa de satisfação abre sem login (é validado pela chave do próprio link)
  if (busca.has('pesquisa') && busca.has('k')) return arquivo(req, res, 'index.html');
  let estado;
  try {
    const { status, dados } = await consultarSessao(req);
    if (status === 200) return arquivo(req, res, 'index.html');
    estado = { estado: status === 403 ? 'sem-acesso' : status === 401 ? 'anonimo' : 'indisponivel', erro: dados.erro, entrar: dados.entrar || '', sair: dados.sair || '' };
  } catch (e) {
    console.error('[web] sessão:', e.message);
    estado = { estado: 'indisponivel', erro: 'O servidor do SAC está fora do ar. Tente de novo em instantes.' };
  }
  if (estado.estado === 'anonimo') estado.erro = '';
  const attr = v => String(v || '#').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const pagina = fs.readFileSync(path.join(PUBLICO, 'landing.html'), 'utf8')
    .replace('{{ENTRAR}}', attr(estado.entrar)).replace('{{SAIR}}', attr(estado.sair))
    .replace('<!--ESTADO-->', '<script>window.SAC_LANDING = ' + JSON.stringify(estado).replace(/</g, '\\u003c') + ';</script>');
  res.writeHead(200, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : pagina);
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
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/') || pathname.startsWith('/drive/')) return repassar(req, res);
  if (pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(CONFIG_JS);
  }
  // /exec mantém funcionando os links antigos do Apps Script enviados por e-mail
  if (pathname === '/' || pathname === '/exec' || pathname === '/index.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return paginaInicial(req, res, searchParams).catch(e => { console.error(e); res.writeHead(500); res.end(); });
  }
  if (pathname === '/landing.html') { res.writeHead(302, { Location: '/' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  arquivo(req, res, rel);
}).listen(PORTA, () => console.log(`Frontend em http://localhost:${PORTA} (API: ${API_URL.origin})`));
