// API HTTP do SAC. Só JSON (e os PDFs públicos dos manuais); a interface fica no frontend.
//   GET  /api/saude          -> { ok: true }
//   POST /api/<funcao>       corpo { args: [...] } -> { ok: true, resultado } | { erro }
//   GET  /drive/<id>         -> manual publicado (equivalente a "qualquer pessoa com o link" no Drive)
//   GET  /api/auth/info      -> { modo: "senha" | "oidc", sair } (como a tela de login deve se comportar)
//   GET  /api/auth/entrar    -> leva ao login do Authelia (AUTH_MODE=oidc)
//   GET  /api/auth/retorno   -> volta do Authelia; abre a sessão e devolve o navegador ao portal
'use strict';
const fs = require('fs');
const path = require('path');
const gas = require('../gas/servicos');

function lerCorpo(req, limite) {
  return new Promise((ok, falha) => {
    const partes = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limite) { falha(Object.assign(new Error('Arquivo grande demais'), { status: 413 })); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

function json(res, status, dados) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(dados));
}

// Erros de sessão viram 401/403 para clientes HTTP; a mensagem continua a mesma para o frontend
function statusDoErro(msg) {
  if (msg.includes('SESSAO_EXPIRADA')) return 401;
  if (msg.includes('TROCAR_SENHA')) return 403;
  return 400;
}

// Com o Authelia, as senhas do SAC deixam de existir: estas funções ficam bloqueadas
const SO_COM_SENHA = new Set(['entrar', 'trocarSenha', 'esqueciSenha', 'redefinirSenhaAcesso', 'salvarMembro']);

function lerCookie(req, nome) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function redirecionar(res, url, cookie) {
  const cab = { Location: url, 'Cache-Control': 'no-store' };
  if (cookie) cab['Set-Cookie'] = cookie;
  res.writeHead(302, cab);
  res.end();
}

function criarApp({ executor, limiteCorpo, origensCors, auth }) {
  const oidc = auth.modo === 'oidc' ? auth.oidc : null;
  const cookieState = valor => `sac_oidc=${valor}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${valor ? 600 : 0}` +
    (auth.urlPublica.startsWith('https:') ? '; Secure' : '');

  // Só caminhos do próprio portal ("/..." sem "//" nem "#"), para o login não virar um redirecionador aberto
  const voltaSegura = v => (typeof v === 'string' && /^\/(?![/\\])[^\s\\#]*$/.test(v) ? v : '/');

  async function entrarSso(res, params) {
    try {
      const { url, state } = await oidc.iniciar(voltaSegura(params.get('volta')));
      redirecionar(res, url, cookieState(state));
    } catch (e) {
      console.error('[oidc]', e.message);
      redirecionar(res, auth.urlPublica + '/#sso-erro=' + encodeURIComponent(e.message));
    }
  }

  async function retornoSso(req, res, params) {
    let destino;
    try {
      const { identidade, volta } = await oidc.concluir(params, lerCookie(req, 'sac_oidc'));
      const { token } = executor.executar('entrarExterno_', [identidade]);
      destino = auth.urlPublica + volta + '#sso=' + encodeURIComponent(token);
    } catch (e) {
      console.error('[oidc]', e.message);
      destino = auth.urlPublica + '/#sso-erro=' + encodeURIComponent(String(e && e.message || e));
    }
    redirecionar(res, destino, cookieState(''));
  }

  function cors(req, res) {
    const origem = req.headers.origin;
    if (!origem || !(origensCors.includes('*') || origensCors.includes(origem))) return;
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  async function chamarFuncao(req, res, fn) {
    if (!executor.publicas.has(fn)) return json(res, 404, { erro: 'Função não permitida: ' + fn });
    if (oidc && SO_COM_SENHA.has(fn)) return json(res, 403, { erro: 'O acesso ao SAC é gerenciado pelo Authelia/LLDAP: não há senhas no SAC.' });
    let args;
    try {
      const corpo = await lerCorpo(req, limiteCorpo);
      args = corpo ? JSON.parse(corpo).args : [];
    } catch (e) { return json(res, e.status || 400, { erro: e.status ? e.message : 'Corpo da requisição inválido' }); }
    try { return json(res, 200, { ok: true, resultado: executor.executar(fn, Array.isArray(args) ? args : []) }); }
    catch (e) { const msg = String(e && e.message || e); return json(res, statusDoErro(msg), { erro: msg }); }
  }

  function manual(res, id) {
    let abs;
    try {
      const rel = gas.relDe(id);
      if (!/^Projetos[\\/]SC - Manuais/.test(rel) && !/[\\/]SC - Manuais[\\/]/.test(rel)) { res.writeHead(403); return res.end('Acesso negado'); }
      abs = path.join(gas.DRIVE, rel);
      if (!fs.statSync(abs).isFile()) throw new Error('não é arquivo');
    } catch (e) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': gas.mimeDe(abs), 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(abs)) });
    fs.createReadStream(abs).pipe(res);
  }

  return async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://x');
    try {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (pathname === '/api/saude' && req.method === 'GET') return json(res, 200, { ok: true });
      if (pathname === '/api/auth/info' && req.method === 'GET') return json(res, 200, { modo: auth.modo, sair: oidc ? oidc.urlSair : '' });
      if (oidc && pathname === '/api/auth/entrar' && req.method === 'GET') return await entrarSso(res, searchParams);
      if (oidc && pathname === '/api/auth/retorno' && req.method === 'GET') return await retornoSso(req, res, searchParams);
      const m = pathname.match(/^\/api\/([A-Za-z][A-Za-z0-9]*)$/);
      if (m && req.method === 'POST') return await chamarFuncao(req, res, m[1]);
      if (pathname.startsWith('/drive/') && req.method === 'GET') return manual(res, decodeURIComponent(pathname.slice(7)));
      json(res, 404, { erro: 'Não encontrado' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { erro: 'Erro interno do servidor' }); else res.end();
    }
  };
}

module.exports = { criarApp };
