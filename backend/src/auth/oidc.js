// Login pelo Authelia (OpenID Connect, fluxo "authorization code" com PKCE).
// O navegador vai ao Authelia e volta com um código; o backend troca o código pela identidade
// falando direto com o Authelia (servidor a servidor, por HTTPS). O navegador nunca vê o segredo.
'use strict';
const crypto = require('crypto');

const aleatorio = () => crypto.randomBytes(32).toString('base64url');

function criarOidc({ emissor, clienteId, segredo, urlPublica }) {
  const retorno = urlPublica + '/api/auth/retorno';
  const pendentes = new Map(); // state -> { verificador, nonce, volta, expira }
  let descoberta = null;

  async function metadados() {
    if (descoberta) return descoberta;
    const r = await fetch(emissor + '/.well-known/openid-configuration');
    if (!r.ok) throw new Error('O Authelia não respondeu (HTTP ' + r.status + '). Tente de novo em instantes.');
    const d = await r.json();
    if (d.issuer !== emissor) throw new Error('OIDC_ISSUER não confere com o Authelia: ' + d.issuer);
    return (descoberta = d);
  }

  // Monta o endereço do login no Authelia. "state" volta num cookie para provar que o login começou neste navegador.
  async function iniciar(volta) {
    const m = await metadados();
    for (const [k, p] of pendentes) if (p.expira < Date.now()) pendentes.delete(k);
    const state = aleatorio(), verificador = aleatorio(), nonce = aleatorio();
    pendentes.set(state, { verificador, nonce, volta, expira: Date.now() + 10 * 60000 });
    const url = new URL(m.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clienteId, redirect_uri: retorno, scope: 'openid profile email groups', state, nonce,
      code_challenge: crypto.createHash('sha256').update(verificador).digest('base64url'), code_challenge_method: 'S256'
    });
    return { url: url.toString(), state };
  }

  // Recebe a volta do Authelia (?code=...&state=...) e devolve { identidade, volta }
  async function concluir(params, stateDoCookie) {
    const state = params.get('state');
    const p = state ? pendentes.get(state) : null;
    if (state) pendentes.delete(state); // uso único, mesmo numa tentativa inválida
    if (!p || state !== stateDoCookie || p.expira < Date.now()) throw new Error('O login expirou ou começou em outra janela. Tente de novo.');
    if (params.get('error')) throw new Error('O Authelia recusou o login: ' + (params.get('error_description') || params.get('error')));
    const m = await metadados();
    const r = await fetch(m.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(encodeURIComponent(clienteId) + ':' + encodeURIComponent(segredo)).toString('base64') },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code') || '', redirect_uri: retorno, code_verifier: p.verificador })
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token || !t.id_token) throw new Error('O Authelia não confirmou o login: ' + (t.error_description || t.error || 'HTTP ' + r.status));
    // O id_token chegou direto do Authelia por HTTPS; conferimos emissor, destinatário, validade e nonce
    let c;
    try { c = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString('utf8')); } catch (e) { c = {}; }
    if (c.iss !== m.issuer || ![].concat(c.aud).includes(clienteId) || c.nonce !== p.nonce || !(c.exp * 1000 > Date.now())) {
      throw new Error('Resposta de login inválida. Tente de novo.');
    }
    const u = await fetch(m.userinfo_endpoint, { headers: { Authorization: 'Bearer ' + t.access_token } });
    const info = await u.json().catch(() => ({}));
    if (!u.ok || info.sub !== c.sub) throw new Error('Não foi possível ler os dados do usuário no Authelia.');
    return {
      identidade: { usuario: info.preferred_username || '', nome: info.name || '', email: info.email || '', grupos: Array.isArray(info.groups) ? info.groups : [] },
      volta: p.volta
    };
  }

  return { iniciar, concluir, urlSair: emissor + '/logout?rd=' + encodeURIComponent(urlPublica + '/') };
}

module.exports = { criarOidc };
