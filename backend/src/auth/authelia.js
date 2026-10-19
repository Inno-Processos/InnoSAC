// Login pelo Authelia: o navegador já traz o cookie de sessão do Authelia (domínio innomaker.com.br).
// O backend pergunta ao Authelia se a sessão vale (endpoint /api/authz/auth-request, o mesmo do Nginx)
// e recebe usuário, nome, e-mail e grupos do LLDAP. Os grupos sac_* viram o perfil no SAC (entrarExterno_).
'use strict';
const crypto = require('crypto');

const VERIFICACAO_MS = 30 * 1000;  // reconsulta o Authelia a cada 30 s: sair do Authelia corta o SAC em até 30 s
const RENOVACAO_MS = 15 * 60 * 1000; // reaplica os grupos do LLDAP a cada 15 min

function lerCookie(req, nome) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]*)'));
  return m ? m[1] : '';
}

function criarAuthelia({ url, cookie, urlPublica, entrarExterno, sair }) {
  const verificados = new Map(); // sha256(cookie) -> { identidade, expira }
  const sessoes = new Map();     // sha256(cookie) -> { token, erro, expira }

  function limpar(mapa) { const agora = Date.now(); for (const [k, v] of mapa) if (v.expira <= agora) mapa.delete(k); }

  // { estado: 'anonimo' } | { estado: 'ok', identidade }; erro se o Authelia não responder
  async function verificar(req) {
    const valor = lerCookie(req, cookie);
    if (!valor) return { chave: null, estado: 'anonimo' };
    const chave = crypto.createHash('sha256').update(valor).digest('hex');
    const guardado = verificados.get(chave);
    if (guardado && guardado.expira > Date.now()) return { chave, estado: 'ok', identidade: guardado.identidade };
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    const r = await fetch(url + '/api/authz/auth-request', {
      redirect: 'manual',
      headers: { 'X-Original-URL': urlPublica + '/', 'X-Original-Method': 'GET', 'X-Forwarded-For': ip, Cookie: `${cookie}=${valor}` }
    });
    if (r.status === 401) return { chave, estado: 'anonimo' };
    if (r.status === 403) return { chave, estado: 'sem-acesso', erro: 'As regras do Authelia não liberam o SAC para a sua conta Innomaker.' };
    if (r.status !== 200) throw new Error('O Authelia respondeu HTTP ' + r.status);
    const identidade = {
      usuario: r.headers.get('remote-user') || '', nome: r.headers.get('remote-name') || '', email: r.headers.get('remote-email') || '',
      grupos: String(r.headers.get('remote-groups') || '').split(',').map(g => g.trim()).filter(Boolean)
    };
    limpar(verificados);
    verificados.set(chave, { identidade, expira: Date.now() + VERIFICACAO_MS });
    return { chave, estado: 'ok', identidade };
  }

  // Sessão do SAC ligada à sessão do Authelia: { estado: 'anonimo' | 'sem-acesso' | 'ok', token, erro }
  async function sessao(req) {
    const v = await verificar(req);
    if (v.estado !== 'ok') return v;
    const atual = sessoes.get(v.chave);
    if (atual && atual.expira > Date.now()) return atual.erro ? { estado: 'sem-acesso', erro: atual.erro } : { estado: 'ok', token: atual.token, identidade: v.identidade };
    if (atual && atual.token) { try { sair(atual.token); } catch (e) { } }
    limpar(sessoes);
    try {
      const { token } = entrarExterno(v.identidade);
      sessoes.set(v.chave, { token, expira: Date.now() + RENOVACAO_MS });
      return { estado: 'ok', token, identidade: v.identidade };
    } catch (e) {
      // Quem não tem grupo sac_ tenta de novo em 1 minuto (tempo para o admin ajustar o LLDAP)
      sessoes.set(v.chave, { erro: e.message, expira: Date.now() + 60 * 1000 });
      return { estado: 'sem-acesso', erro: e.message };
    }
  }

  // "Sair" no SAC: esquece a ligação deste cookie com a sessão (o frontend segue para o logout do Authelia)
  function encerrar(req) {
    const valor = lerCookie(req, cookie);
    if (!valor) return;
    const chave = crypto.createHash('sha256').update(valor).digest('hex');
    verificados.delete(chave);
    sessoes.delete(chave);
  }

  return {
    sessao,
    encerrar,
    urlEntrar: volta => url + '/?rd=' + encodeURIComponent(urlPublica + (volta || '/')),
    urlSair: url + '/logout?rd=' + encodeURIComponent(urlPublica + '/')
  };
}

module.exports = { criarAuthelia };
