'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

// A fake OpenID provider stands in for Authelia; the backend runs as a real process with AUTH_MODE=oidc.
const raiz = path.join(__dirname, '..');
const portaLivre = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function provedor(porta, clienteId, segredo) {
  const emissor = `http://127.0.0.1:${porta}`;
  const codigos = new Map(), acessos = new Map();
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, emissor);
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: emissor,
      authorization_endpoint: emissor + '/authorize', token_endpoint: emissor + '/token', userinfo_endpoint: emissor + '/userinfo' });
    if (url.pathname === '/token') {
      let corpo = '';
      req.on('data', c => { corpo += c; });
      return req.on('end', () => {
        const p = new URLSearchParams(corpo), c = codigos.get(p.get('code'));
        codigos.delete(p.get('code'));
        const basic = 'Basic ' + Buffer.from(clienteId + ':' + segredo).toString('base64');
        if (req.headers.authorization !== basic) return json(401, { error: 'invalid_client' });
        if (!c || c.redirect !== p.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
        if (crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.desafio) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
        const acesso = crypto.randomUUID();
        acessos.set(acesso, c.usuario);
        json(200, { access_token: acesso, token_type: 'Bearer',
          id_token: b64({ alg: 'none' }) + '.' + b64({ iss: emissor, aud: [clienteId], sub: c.usuario.sub, nonce: c.nonce, exp: Date.now() / 1000 + 300 }) + '.x' });
      });
    }
    if (url.pathname === '/userinfo') {
      const u = acessos.get(String(req.headers.authorization).replace('Bearer ', ''));
      return u ? json(200, u) : json(401, { error: 'invalid_token' });
    }
    json(404, {});
  });
  // What Authelia does after the user logs in: issue a code bound to the PKCE challenge and nonce
  function autorizar(urlLogin, usuario) {
    const u = new URL(urlLogin);
    assert.equal(u.origin + u.pathname, emissor + '/authorize');
    assert.equal(u.searchParams.get('client_id'), clienteId);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope'), /groups/);
    const codigo = crypto.randomUUID();
    codigos.set(codigo, { usuario: { sub: 'id-' + usuario.preferred_username, ...usuario }, desafio: u.searchParams.get('code_challenge'),
      nonce: u.searchParams.get('nonce'), redirect: u.searchParams.get('redirect_uri') });
    return new URL(`${u.searchParams.get('redirect_uri')}?code=${codigo}&state=${u.searchParams.get('state')}`);
  }
  return { servidor: servidor.listen(porta), emissor, autorizar };
}

async function main() {
  const [apiPorta, idpPorta] = [await portaLivre(), await portaLivre()];
  const fake = provedor(idpPorta, 'sac', 'segredo-de-teste');
  const publico = 'https://sac.example';
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sac-sso-')), SMTP_HOST: '', API_PORT: String(apiPorta),
    PUBLIC_URL: publico, AUTH_MODE: 'oidc', OIDC_ISSUER: fake.emissor, OIDC_CLIENT_ID: 'sac', OIDC_CLIENT_SECRET: 'segredo-de-teste' };
  const inst = spawnSync(process.execPath, ['src/cli.js', 'instalar'], { cwd: path.join(raiz, 'backend'), env, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  // Project with a dotted login, to check the LLDAP group name
  fs.mkdirSync(path.join(env.DATA_DIR, 'drive', 'Projetos', '4.2.16 Marinha - USV'), { recursive: true });

  const backend = spawn(process.execPath, ['src/index.js'], { cwd: path.join(raiz, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  backend.stdout.on('data', d => { log += d; });
  backend.stderr.on('data', d => { log += d; });
  try {
    await new Promise((ok, falha) => {
      const t = setInterval(() => { if (log.includes('API do SAC')) { clearInterval(t); ok(); } }, 50);
      backend.on('exit', c => { clearInterval(t); falha(new Error('backend saiu: ' + c + '\n' + log)); });
    });
    assert.match(log, /login: Authelia/);
    const api = `http://127.0.0.1:${apiPorta}`;
    const post = async (fn, ...args) => {
      const r = await fetch(`${api}/api/${fn}`, { method: 'POST', body: JSON.stringify({ args }) });
      return { status: r.status, corpo: await r.json() };
    };

    // Full login: SAC -> "Authelia" -> SAC, returning to the requested page with the session in the fragment
    async function entrar(usuario, volta) {
      const ida = await fetch(`${api}/api/auth/entrar?volta=${encodeURIComponent(volta || '/')}`, { redirect: 'manual' });
      assert.equal(ida.status, 302);
      const cookie = ida.headers.get('set-cookie');
      assert.match(cookie, /^sac_oidc=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
      const volta2 = fake.autorizar(ida.headers.get('location'), usuario);
      assert.equal(volta2.origin + volta2.pathname, publico + '/api/auth/retorno');
      const r = await fetch(api + volta2.pathname + volta2.search, { redirect: 'manual', headers: { Cookie: cookie.split(';')[0] } });
      assert.equal(r.status, 302);
      const destino = new URL(r.headers.get('location'));
      const h = new URLSearchParams(destino.hash.slice(1));
      return { destino, token: h.get('sso'), erro: h.get('sso-erro') };
    }

    assert.deepEqual(await (await fetch(api + '/api/auth/info')).json(), { modo: 'oidc', sair: fake.emissor + '/logout?rd=' + encodeURIComponent(publico + '/') });
    for (const fn of ['entrar', 'trocarSenha', 'esqueciSenha', 'redefinirSenhaAcesso', 'salvarMembro']) {
      assert.equal((await post(fn, 'admin', 'x')).status, 403, fn + ' must be disabled with Authelia');
    }

    // Team: the LLDAP group defines the profile; the person is created on first login
    const ana = await entrar({ preferred_username: 'Ana', name: 'Ana Souza', email: 'Ana@Innomaker.com.br', groups: ['sac_n1', 'outros'] }, '/?chamado=CH-1');
    assert.equal(ana.erro, null);
    assert.equal(ana.destino.origin + ana.destino.pathname + ana.destino.search, publico + '/?chamado=CH-1');
    let eu = (await post('iniciar', ana.token)).corpo.resultado.usuario;
    assert.deepEqual([eu.tipo, eu.login, eu.nome, eu.email, eu.perfil, eu.n1, eu.admin], ['equipe', 'ana', 'Ana Souza', 'ana@innomaker.com.br', 'N1', true, false]);

    const chefe = await entrar({ preferred_username: 'chefe', name: 'Chefe', email: 'chefe@innomaker.com.br', groups: ['sac_n1', 'SAC_ADMIN'] });
    assert.equal((await post('iniciar', chefe.token)).corpo.resultado.usuario.perfil, 'Admin', 'The highest profile wins.');
    const equipe = (await post('listarEquipe', chefe.token)).corpo.resultado;
    assert(equipe.some(m => m.Login === 'ana' && m.Perfil === 'N1' && m.Ativo));

    // Clients: sac_projeto_<project login>, several LLDAP users share the project
    assert.deepEqual((await post('sincronizarProjetos', chefe.token)).corpo.resultado.map(p => p.login), ['4.2.16.marinha.usv']);
    const cliente = await entrar({ preferred_username: 'joao', name: 'João', email: 'joao@cliente.com', groups: ['sac_projeto_4_2_16_marinha_usv'] });
    eu = (await post('iniciar', cliente.token)).corpo.resultado.usuario;
    assert.deepEqual([eu.tipo, eu.login, eu.projeto, eu.email, eu.cadastroIncompleto], ['cliente', '4.2.16.marinha.usv', 'Marinha - USV', 'joao@cliente.com', false]);
    const maria = await entrar({ preferred_username: 'maria', name: 'Maria', email: 'maria@cliente.com', groups: ['sac_projeto_4_2_16_marinha_usv'] });
    assert.equal((await post('iniciar', maria.token)).corpo.resultado.usuario.login, '4.2.16.marinha.usv');
    assert.equal((await post('listarProjetos', cliente.token)).status, 400, 'Clients are not admins.');

    // Without a sac_ group: refused, and a former team member is deactivated
    const sem = await entrar({ preferred_username: 'ana', name: 'Ana Souza', email: 'ana@innomaker.com.br', groups: ['outros'] });
    assert.equal(sem.token, null);
    assert.match(sem.erro, /ainda não tem acesso ao SAC/);
    assert.equal((await post('iniciar', ana.token)).status, 401, 'The open session ends once the person leaves the groups.');
    assert((await post('listarEquipe', chefe.token)).corpo.resultado.some(m => m.Login === 'ana' && !m.Ativo));
    assert.match((await entrar({ preferred_username: '4.2.16.marinha.usv', groups: ['sac_n1'] })).erro, /mesmo nome do login de um projeto/);

    // Security: state bound to the cookie, single use, and no open redirect
    const ida = await fetch(`${api}/api/auth/entrar?volta=${encodeURIComponent('//evil.example/x')}`, { redirect: 'manual' });
    const retorno = fake.autorizar(ida.headers.get('location'), { preferred_username: 'chefe', groups: ['sac_admin'] });
    const semCookie = await fetch(api + retorno.pathname + retorno.search, { redirect: 'manual' });
    assert.match(new URL(semCookie.headers.get('location')).hash, /^#sso-erro=/);
    const comCookie = await fetch(api + retorno.pathname + retorno.search, { redirect: 'manual', headers: { Cookie: ida.headers.get('set-cookie').split(';')[0] } });
    assert.match(new URL(comCookie.headers.get('location')).hash, /^#sso-erro=/, 'A state can only be used once.');
    const desvio = await entrar({ preferred_username: 'chefe', groups: ['sac_admin'] }, 'https://evil.example/');
    assert.equal(desvio.destino.origin + desvio.destino.pathname, publico + '/');

    // Frontend and backend compute the same LLDAP group names
    const ctx = vm.createContext({ S: {} });
    const js = fs.readFileSync(path.join(raiz, 'frontend/public/js/app.js'), 'utf8');
    vm.runInContext(js.slice(js.indexOf('const sso ='), js.indexOf('const guarda =')), ctx);
    const { criarExecutor } = require('../backend/src/nucleo/executor');
    process.env.DATA_DIR = env.DATA_DIR;
    const regras = criarExecutor(fs.readFileSync(path.join(raiz, 'backend/src/regras/Codigo.gs'), 'utf8'), { ativo: false, despachar() {} });
    for (const nome of ['Admin', 'N1', 'Suporte de Campo', 'Pós-venda', 'projeto marinha.usv', 'projeto 4-2_01']) {
      assert.equal(vm.runInContext(`grupoLldap(${JSON.stringify(nome)})`, ctx), regras.executar('grupoLldap_', [nome]), nome);
    }
  } finally { backend.removeAllListeners('exit'); backend.kill(); fake.servidor.close(); }
  console.log('OK: login pelo Authelia (OIDC + PKCE), perfis pelos grupos do LLDAP, clientes por projeto, recusa, senhas desligadas, state de uso único e sem redirecionamento aberto.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
