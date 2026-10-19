// API HTTP do SAC. Só JSON (e os PDFs públicos dos manuais); a interface fica no frontend.
//   GET  /api/saude          -> { ok: true }
//   POST /api/<funcao>       corpo { args: [...] } -> { ok: true, resultado } | { erro }
//   GET  /drive/<id>         -> manual publicado (equivalente a "qualquer pessoa com o link" no Drive)
//   GET  /api/auth/info      -> { modo: "senha" | "authelia", entrar, sair } (links do login e da saída)
//   GET  /api/auth/sessao    -> 200 se o cookie do Authelia vale e dá acesso ao SAC; 401 sem login; 403 sem grupo sac_
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
// Abertas sem login: dados da tela inicial e a pesquisa de satisfação (validada pela chave do link)
const SEM_LOGIN = new Set(['dadosPublicos', 'dadosPesquisa', 'responderPesquisa']);
const FALHA_AUTHELIA = 'Não foi possível falar com o login da Innomaker. Tente de novo em instantes.';

function criarApp({ executor, limiteCorpo, origensCors, auth }) {
  const authelia = auth.modo === 'authelia' ? auth.authelia : null;
  const origemPublica = new URL(auth.urlPublica).origin;

  function cors(req, res) {
    const origem = req.headers.origin;
    if (!origem || !(origensCors.includes('*') || origensCors.includes(origem))) return;
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  // A sessão vem de um cookie: só o próprio portal (ou origens liberadas no CORS) pode chamar a API
  const origemPermitida = req => { const o = req.headers.origin; return !o || o === origemPublica || origensCors.includes('*') || origensCors.includes(o); };

  async function sessaoAuthelia(res, req) {
    let s;
    try { s = await authelia.sessao(req); } catch (e) { console.error('[authelia]', e.message); return json(res, 502, { erro: FALHA_AUTHELIA }); }
    if (s.estado === 'ok') return json(res, 200, { ok: true, usuario: s.identidade.usuario });
    if (s.estado === 'sem-acesso') return json(res, 403, { erro: s.erro, sair: authelia.urlSair });
    json(res, 401, { erro: 'SESSAO_EXPIRADA', entrar: authelia.urlEntrar('/') });
  }

  async function chamarFuncao(req, res, fn) {
    if (!executor.publicas.has(fn)) return json(res, 404, { erro: 'Função não permitida: ' + fn });
    if (authelia && SO_COM_SENHA.has(fn)) return json(res, 403, { erro: 'O acesso ao SAC é gerenciado pelo Authelia/LLDAP: não há senhas no SAC.' });
    if (authelia && !origemPermitida(req)) return json(res, 403, { erro: 'Origem não permitida.' });
    let args;
    try {
      const corpo = await lerCorpo(req, limiteCorpo);
      args = corpo ? JSON.parse(corpo).args : [];
    } catch (e) { return json(res, e.status || 400, { erro: e.status ? e.message : 'Corpo da requisição inválido' }); }
    args = Array.isArray(args) ? args : [];
    if (authelia && (!SEM_LOGIN.has(fn) || (fn === 'responderPesquisa' && args[0] && args[0].token))) {
      let s;
      try { s = await authelia.sessao(req); } catch (e) { console.error('[authelia]', e.message); return json(res, 502, { erro: FALHA_AUTHELIA }); }
      if (s.estado === 'sem-acesso') return json(res, 403, { erro: s.erro });
      if (s.estado !== 'ok') return json(res, 401, { erro: 'SESSAO_EXPIRADA' });
      // Quem decide a sessão é o cookie do Authelia: o token enviado pelo navegador é substituído
      if (fn === 'responderPesquisa') args[0] = { ...args[0], token: s.token }; else args[0] = s.token;
      if (fn === 'sair') authelia.encerrar(req);
    }
    try { return json(res, 200, { ok: true, resultado: executor.executar(fn, args) }); }
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
    const { pathname } = new URL(req.url, 'http://x');
    try {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (pathname === '/api/saude' && req.method === 'GET') return json(res, 200, { ok: true });
      if (pathname === '/api/auth/info' && req.method === 'GET') {
        return json(res, 200, { modo: auth.modo, entrar: authelia ? authelia.urlEntrar('/') : '', sair: authelia ? authelia.urlSair : '' });
      }
      if (pathname === '/api/auth/sessao' && req.method === 'GET') return authelia ? await sessaoAuthelia(res, req) : json(res, 200, { ok: true, modo: auth.modo });
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
