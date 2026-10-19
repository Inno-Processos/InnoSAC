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
  // Projects from before the LLDAP: created at install time from the Drive folders
  for (const pasta of ['4.2.16 Marinha - USV', '4.2.01 - Innoboat']) fs.mkdirSync(path.join(env.DATA_DIR, 'drive', 'Projetos', pasta), { recursive: true });
  const inst = spawnSync(process.execPath, ['src/cli.js', 'instalar'], { cwd: path.join(raiz, 'backend'), env, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);

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
    assert.equal(consulta['x-original-url'], web + '/_sac/verificar');
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

    // Projects come from the LLDAP Projeto_... groups; Drive folders and "Criar projeto" are off
    assert.match((await post('sessao-chefe', 'sincronizarProjetos')).corpo.erro, /grupos Projeto_/);
    assert.match((await post('sessao-chefe', 'criarProjeto', 'x', { pastaId: 'x' })).corpo.erro, /grupos Projeto_/);
    assert.match((await post('sessao-chefe', 'criarPerfilEquipe', 'x', 'Novo')).corpo.erro, /grupos sac_/);
    const antigos = (await post('sessao-chefe', 'listarProjetos')).corpo.resultado;
    const marinha = antigos.find(p => p.Projeto === '4.2.16 Marinha - USV'), innoboat = antigos.find(p => p.Projeto === '4.2.01 - Innoboat');
    assert(marinha && innoboat, 'Projects created at install time from the Drive folders.');

    // A staff login brings its project groups: existing projects are reused by name or code, others are created
    aut.sessoes.set('sessao-func', { usuario: 'func', nome: 'Func', grupos: ['sac_software', 'Projeto_Marinha_USV', 'Projeto_4.2.01', 'Projeto_Novo_Cliente'] });
    assert.equal((await post('sessao-func', 'iniciar')).corpo.resultado.usuario.perfil, 'Software', 'Project groups change nothing for staff.');
    let projetos = (await post('sessao-chefe', 'listarProjetos')).corpo.resultado;
    const grupoDe = nome => (projetos.find(p => p.Projeto === nome) || {}).GrupoLldap;
    assert.equal(projetos.length, 3);
    assert.equal(grupoDe('4.2.16 Marinha - USV'), 'Projeto_Marinha_USV', 'Reused by name.');
    assert.equal(grupoDe('4.2.01 - Innoboat'), 'Projeto_4.2.01', 'Reused by code.');
    assert.equal(grupoDe('Novo Cliente'), 'Projeto_Novo_Cliente', 'New group, new project.');
    const ligar = (pj, grupo) => post('sessao-chefe', 'salvarProjeto', 'x', { ProjetoId: pj.ProjetoId, Login: pj.Login, Ativo: true, Modulos: [], GrupoLldap: grupo });
    assert.match((await ligar(innoboat, 'projeto_marinha_usv')).corpo.erro, /já está ligado/, 'A group points to a single project.');

    // Clients: global "Clientes" group + one Projeto_... group per project
    aut.sessoes.set('sessao-joao', { usuario: 'joao', nome: 'João', email: 'joao@cliente.com', grupos: ['Clientes', 'Projeto_Marinha_USV'] });
    aut.sessoes.set('sessao-maria', { usuario: 'maria', nome: 'Maria', email: 'maria@cliente.com', grupos: ['clientes', 'projeto_marinha_usv', 'Projeto_4.2.01'] });
    let base = (await post('sessao-joao', 'iniciar')).corpo.resultado;
    eu = base.usuario;
    assert.deepEqual([eu.tipo, eu.login, eu.nome, eu.projeto, eu.email, eu.cadastroIncompleto, eu.contaLldap], ['cliente', 'joao', 'João', 'Marinha - USV', 'joao@cliente.com', false, true]);
    assert.deepEqual(base.projetos.map(p => p.id), [marinha.ProjetoId], 'The existing project (and its tickets) is kept.');
    base = (await post('sessao-maria', 'iniciar')).corpo.resultado;
    assert.deepEqual(base.projetos.map(p => p.nome).sort(), ['Innoboat', 'Marinha - USV'], 'A client sees every project of their groups.');
    assert.equal((await post('sessao-joao', 'listarProjetos')).status, 400, 'Clients are not admins.');
    assert.equal((await post('sessao-joao', 'meuCadastro')).status, 400, 'Name and e-mail come from the LLDAP account.');

    // Opening tickets: a single-project client needs no choice; a multi-project client must pick one of theirs
    const novo = projetoId => ({ projetoId, categoria: base.categorias[0], titulo: 'Teste', descricao: 'Descrição', bloqueio: 'Não' });
    const chJoao = (await post('sessao-joao', 'abrirChamado', 'x', novo(''))).corpo.resultado;
    assert.match((await post('sessao-maria', 'abrirChamado', 'x', novo(''))).corpo.erro, /Escolha o projeto/);
    assert.match((await post('sessao-joao', 'abrirChamado', 'x', novo(innoboat.ProjetoId))).corpo.erro, /não participa/);
    const chMaria = (await post('sessao-maria', 'abrirChamado', 'x', novo(innoboat.ProjetoId))).corpo.resultado;
    assert.deepEqual((await post('sessao-maria', 'meusChamados')).corpo.resultado.map(c => c.Id).sort(), [chJoao, chMaria].sort());
    assert.deepEqual((await post('sessao-joao', 'meusChamados')).corpo.resultado.map(c => c.Id), [chJoao]);
    assert.equal((await post('sessao-joao', 'detalheChamado', 'x', chMaria)).status, 400, 'Clients only see their projects.');
    const detalhe = (await post('sessao-chefe', 'detalheChamado', 'x', chMaria)).corpo.resultado.chamado;
    assert.deepEqual([detalhe.Projeto, detalhe.Usuario, detalhe.Email], ['4.2.01 - Innoboat', 'Maria', 'maria@cliente.com']);
    assert(fs.readdirSync(path.join(env.DATA_DIR, 'emails')).some(f => f.includes('maria@cliente.com')), 'The client who opened the ticket gets the notice.');

    // The admin sees the Projeto_ groups seen at login and the clients who came in
    const vistos = (await post('sessao-chefe', 'gruposProjetoLldap')).corpo.resultado;
    assert.deepEqual(vistos.map(g => g.grupo + '=' + g.projeto).sort(), ['Projeto_4.2.01=4.2.01 - Innoboat', 'Projeto_Marinha_USV=4.2.16 Marinha - USV', 'Projeto_Novo_Cliente=Novo Cliente']);
    const clientes = (await post('sessao-chefe', 'listarClientesLldap')).corpo.resultado;
    assert.deepEqual(clientes.find(c => c.Login === 'maria').projetos.sort(), ['4.2.01 - Innoboat', '4.2.16 Marinha - USV']);

    // "Clientes" wins over sac_ groups; a client without any project group is refused with a clear reason
    aut.sessoes.set('sessao-externo', { usuario: 'externo', nome: 'Externo', email: 'e@cliente.com', grupos: ['Clientes', 'sac_admin', 'Projeto_Marinha_USV'] });
    assert.equal((await post('sessao-externo', 'iniciar')).corpo.resultado.usuario.tipo, 'cliente');
    aut.sessoes.set('sessao-solto', { usuario: 'solto', grupos: ['Clientes'] });
    assert.match(estadoLanding(await pagina('sessao-solto')).erro, /não está ligada a nenhum projeto/);

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
    for (const nome of ['Admin', 'N1', 'Suporte de Campo', 'Pós-venda', 'Suporte de campo 2']) {
      assert.equal(vm.runInContext(`grupoLldap(${JSON.stringify(nome)})`, ctx), regras.executar('grupoLldap_', [nome]), nome);
    }
  } finally { filhos.forEach(f => { f.removeAllListeners('exit'); f.kill(); }); aut.servidor.close(); }
  console.log('OK: landing page sem sessão, SAC com a sessão do Authelia, perfis pelos grupos do LLDAP, clientes por projeto, sem acesso, senhas desligadas, origem, saída e Authelia fora do ar.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
