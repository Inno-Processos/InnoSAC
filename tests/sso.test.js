'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

// A fake Authelia answers /api/authz/auth-request; backend and frontend run as real processes with AUTH_MODE=authelia.
const raiz = path.join(__dirname, '..');
const portaLivre = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

function autheliaFalso(porta) {
  const sessoes = new Map(); // cookie value -> { usuario, nome, email, grupos } | 'bloqueado'
  const consultas = [];
  const servidor = http.createServer((req, res) => {
    if (req.url !== '/api/authz/auth-request') { res.writeHead(404); return res.end(); }
    consultas.push(req.headers);
    const valor = (String(req.headers.cookie || '').match(/authelia_session=([^;]+)/) || [])[1];
    const s = sessoes.get(valor);
    if (s === 'bloqueado') { res.writeHead(403); return res.end(); }
    if (!s) { res.writeHead(401, { Location: `http://127.0.0.1:${porta}/?rd=x` }); return res.end(); }
    res.writeHead(200, { 'Remote-User': s.usuario, 'Remote-Name': s.nome || '', 'Remote-Email': s.email || '', 'Remote-Groups': (s.grupos || []).join(',') });
    res.end();
  }).listen(porta);
  return { servidor, sessoes, consultas, url: `http://127.0.0.1:${porta}` };
}

function subir(arquivo, cwd, env, pronto) {
  return new Promise((ok, falha) => {
    const filho = spawn(process.execPath, [arquivo], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    const tempo = setTimeout(() => falha(new Error('Timeout: ' + arquivo + '\n' + saida)), 10000);
    filho.stdout.on('data', d => { saida += d; if (saida.includes(pronto)) { clearTimeout(tempo); ok(filho); } });
    filho.stderr.on('data', d => { saida += d; });
    filho.on('exit', c => { clearTimeout(tempo); falha(new Error(arquivo + ' saiu com código ' + c + '\n' + saida)); });
  });
}

async function main() {
  const [apiPorta, webPorta, autPorta] = [await portaLivre(), await portaLivre(), await portaLivre()];
  const aut = autheliaFalso(autPorta);
  const web = `http://127.0.0.1:${webPorta}`;
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sac-authelia-')), SMTP_HOST: '',
    API_PORT: String(apiPorta), WEB_PORT: String(webPorta), API_URL: `http://127.0.0.1:${apiPorta}`, PUBLIC_API_URL: '',
    PUBLIC_URL: web, AUTH_MODE: 'authelia', AUTHELIA_URL: aut.url };
  const inst = spawnSync(process.execPath, ['src/cli.js', 'instalar'], { cwd: path.join(raiz, 'backend'), env, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  fs.mkdirSync(path.join(env.DATA_DIR, 'drive', 'Projetos', '4.2.16 Marinha - USV'), { recursive: true });

  const filhos = [];
  try {
    filhos.push(await subir('src/index.js', path.join(raiz, 'backend'), env, 'login: Authelia'));
    filhos.push(await subir('server.js', path.join(raiz, 'frontend'), env, 'Frontend em'));
    const pagina = async cookie => (await fetch(web + '/', { headers: cookie ? { Cookie: 'authelia_session=' + cookie } : {} })).text();
    const post = async (cookie, fn, ...args) => {
      const r = await fetch(`${web}/api/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: web, ...(cookie ? { Cookie: 'outro=1; authelia_session=' + cookie } : {}) },
        body: JSON.stringify({ args }) });
      return { status: r.status, corpo: await r.json() };
    };
    const estadoLanding = html => JSON.parse(html.match(/window\.SAC_LANDING = (.*?);<\/script>/)[1]);

    const info = await (await fetch(web + '/api/auth/info')).json();
    assert.deepEqual(info, { modo: 'authelia', entrar: aut.url + '/?rd=' + encodeURIComponent(web + '/'), sair: aut.url + '/logout?rd=' + encodeURIComponent(web + '/') });

    // Without an Authelia session: only the landing page, with the login button
    const landing = await pagina();
    assert.match(landing, /id="lp-entrar" href="http:\/\/127\.0\.0\.1:\d+\/\?rd=/);
    assert.doesNotMatch(landing, /js\/app\.js/, 'The SAC page must not be served without login.');
    assert.equal(estadoLanding(landing).estado, 'anonimo');
    assert.equal(estadoLanding(await pagina('cookie-desconhecido')).estado, 'anonimo');
    assert.equal((await post(null, 'iniciar', 'x')).status, 401);
    assert.equal((await post(null, 'dadosPublicos')).status, 200, 'The landing page reads public data without login.');
    for (const ref of ['css/landing.css', 'js/landing.js', 'css/estilo.css']) assert.equal((await fetch(`${web}/${ref}`)).status, 200, ref);
    assert.match(await (await fetch(web + '/?pesquisa=CH-1&k=abc')).text(), /js\/app\.js/, 'Survey links open without login.');

    // Team: the Authelia session opens the SAC; the LLDAP group defines the profile
    aut.sessoes.set('sessao-ana', { usuario: 'Ana', nome: 'Ana Souza', email: 'Ana@Innomaker.com.br', grupos: ['sac_n1', 'outros'] });
    assert.match(await pagina('sessao-ana'), /js\/app\.js/);
    const consulta = aut.consultas.at(-1);
    assert.equal(consulta['x-original-url'], web + '/');
    assert.equal(consulta['x-original-method'], 'GET');
    assert.equal(consulta.cookie, 'authelia_session=sessao-ana', 'Only the Authelia cookie is forwarded.');
    let eu = (await post('sessao-ana', 'iniciar', 'token-qualquer')).corpo.resultado.usuario;
    assert.deepEqual([eu.tipo, eu.login, eu.nome, eu.email, eu.perfil, eu.n1, eu.admin], ['equipe', 'ana', 'Ana Souza', 'ana@innomaker.com.br', 'N1', true, false]);
    const antes = aut.consultas.length;
    await post('sessao-ana', 'filaEquipe', 'x');
    assert.equal(aut.consultas.length, antes, 'Authelia answers are cached for a few seconds.');

    aut.sessoes.set('sessao-chefe', { usuario: 'chefe', nome: 'Chefe', email: 'chefe@innomaker.com.br', grupos: ['sac_n1', 'SAC_ADMIN'] });
    assert.equal((await post('sessao-chefe', 'iniciar')).corpo.resultado.usuario.perfil, 'Admin', 'The highest profile wins.');
    for (const fn of ['entrar', 'trocarSenha', 'esqueciSenha', 'redefinirSenhaAcesso', 'salvarMembro']) {
      assert.equal((await post('sessao-chefe', fn, 'admin', 'x')).status, 403, fn + ' must be disabled with Authelia');
    }
    const evil = await fetch(`${web}/api/iniciar`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.innomaker.com.br', Cookie: 'authelia_session=sessao-chefe' }, body: '{"args":[]}' });
    assert.equal(evil.status, 403, 'Calls from another origin are refused.');

    // Clients: sac_projeto_<project login>; several LLDAP users share the project
    assert.deepEqual((await post('sessao-chefe', 'sincronizarProjetos')).corpo.resultado.map(p => p.login), ['4.2.16.marinha.usv']);
    aut.sessoes.set('sessao-joao', { usuario: 'joao', nome: 'João', email: 'joao@cliente.com', grupos: ['sac_projeto_4_2_16_marinha_usv'] });
    aut.sessoes.set('sessao-maria', { usuario: 'maria', nome: 'Maria', email: 'maria@cliente.com', grupos: ['sac_projeto_4_2_16_marinha_usv'] });
    eu = (await post('sessao-joao', 'iniciar')).corpo.resultado.usuario;
    assert.deepEqual([eu.tipo, eu.login, eu.projeto, eu.email, eu.cadastroIncompleto], ['cliente', '4.2.16.marinha.usv', 'Marinha - USV', 'joao@cliente.com', false]);
    assert.equal((await post('sessao-maria', 'iniciar')).corpo.resultado.usuario.login, '4.2.16.marinha.usv');
    assert.equal((await post('sessao-joao', 'listarProjetos')).status, 400, 'Clients are not admins.');

    // Logged in, but without a sac_ group (or blocked by Authelia rules): landing page with the reason
    aut.sessoes.set('sessao-ana-sem-grupo', { usuario: 'ana', nome: 'Ana Souza', email: 'ana@innomaker.com.br', grupos: ['outros'] });
    const semGrupo = estadoLanding(await pagina('sessao-ana-sem-grupo'));
    assert.equal(semGrupo.estado, 'sem-acesso');
    assert.match(semGrupo.erro, /ainda não tem acesso ao SAC/);
    assert.equal(semGrupo.sair, info.sair);
    assert.equal((await post('sessao-ana-sem-grupo', 'iniciar')).status, 403);
    assert.equal((await post('sessao-ana', 'iniciar')).status, 401, 'An open session ends once the person leaves the groups.');
    aut.sessoes.set('sessao-bloqueada', 'bloqueado');
    assert.equal(estadoLanding(await pagina('sessao-bloqueada')).estado, 'sem-acesso');
    aut.sessoes.set('sessao-xss', { usuario: 'x</script><img src=x onerror=alert(1)>', grupos: [] });
    const xss = await pagina('sessao-xss');
    assert.doesNotMatch(xss, /<\/script><img/, 'Messages are escaped inside the landing page.');
    assert.equal(estadoLanding(xss).estado, 'sem-acesso');

    // Logout: the SAC session ends and, once Authelia drops its session, only the landing page is left
    assert.equal((await post('sessao-chefe', 'sair', 'x')).status, 200);
    aut.sessoes.delete('sessao-chefe');
    assert.equal((await post('sessao-chefe', 'iniciar')).status, 401);
    assert.equal(estadoLanding(await pagina('sessao-chefe')).estado, 'anonimo');

    // Authelia down: a clear message, not an error page
    aut.servidor.close();
    aut.servidor.closeAllConnections();
    assert.equal(estadoLanding(await pagina('sessao-nova')).estado, 'indisponivel');

    // Frontend and backend compute the same LLDAP group names
    const ctx = vm.createContext({ S: {} });
    const js = fs.readFileSync(path.join(raiz, 'frontend/public/js/app.js'), 'utf8');
    vm.runInContext(js.slice(js.indexOf('const sso ='), js.indexOf('const guarda =')), ctx);
    process.env.DATA_DIR = env.DATA_DIR;
    const { criarExecutor } = require('../backend/src/nucleo/executor');
    const regras = criarExecutor(fs.readFileSync(path.join(raiz, 'backend/src/regras/Codigo.gs'), 'utf8'), { ativo: false, despachar() {} });
    for (const nome of ['Admin', 'N1', 'Suporte de Campo', 'Pós-venda', 'projeto 4.2.16.marinha.usv', 'projeto 4-2_01']) {
      assert.equal(vm.runInContext(`grupoLldap(${JSON.stringify(nome)})`, ctx), regras.executar('grupoLldap_', [nome]), nome);
    }
  } finally { filhos.forEach(f => { f.removeAllListeners('exit'); f.kill(); }); aut.servidor.close(); }
  console.log('OK: landing page sem sessão, SAC com a sessão do Authelia, perfis pelos grupos do LLDAP, clientes por projeto, sem acesso, senhas desligadas, origem, saída e Authelia fora do ar.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
