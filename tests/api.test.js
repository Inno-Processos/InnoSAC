'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Backend and frontend run as real processes on free ports, with a throwaway data folder.
const raiz = path.join(__dirname, '..');
const portaLivre = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

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
  const [apiPorta, webPorta] = [await portaLivre(), await portaLivre()];
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sac-api-')), SMTP_HOST: '', CORS_ORIGIN: 'https://site.example',
    API_PORT: String(apiPorta), WEB_PORT: String(webPorta), API_URL: `http://127.0.0.1:${apiPorta}`, PUBLIC_API_URL: '' };
  const inst = spawnSync(process.execPath, ['src/cli.js', 'instalar'], { cwd: path.join(raiz, 'backend'), env, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  const filhos = [];
  try {
    filhos.push(await subir('src/index.js', path.join(raiz, 'backend'), env, 'API do SAC'));
    filhos.push(await subir('server.js', path.join(raiz, 'frontend'), env, 'Frontend em'));
    const api = `http://127.0.0.1:${apiPorta}`, web = `http://127.0.0.1:${webPorta}`;
    const post = (base, fn, args, headers) => fetch(`${base}/api/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ args }) });

    assert.deepEqual(await (await fetch(api + '/api/saude')).json(), { ok: true });
    const publicos = await post(api, 'dadosPublicos', []);
    assert.equal(publicos.status, 200);
    assert.equal((await publicos.json()).ok, true);
    for (const proibida of ['instalar', 'rotinaHoraria', 'backupDiario', 'ler_', 'SpreadsheetApp']) {
      assert.equal((await post(api, proibida, [])).status, 404, proibida + ' must not be callable over HTTP');
    }
    const login = await post(api, 'entrar', ['admin', 'senha-errada']);
    assert.equal(login.status, 400);
    assert.match((await login.json()).erro, /incorretos/);
    assert.equal((await post(api, 'iniciar', ['token-invalido'])).status, 401);
    assert.equal((await fetch(api + '/api/entrar', { method: 'POST', body: '{quebrado' })).status, 400);

    // CORS only for configured origins
    assert.equal((await post(api, 'dadosPublicos', [], { Origin: 'https://site.example' })).headers.get('access-control-allow-origin'), 'https://site.example');
    assert.equal((await post(api, 'dadosPublicos', [], { Origin: 'https://outro.example' })).headers.get('access-control-allow-origin'), null);

    const pagina = await (await fetch(web + '/')).text();
    for (const ref of ['config.js', 'js/api.js', 'js/app.js', 'js/inicio.js', 'css/estilo.css', 'css/interno.css']) {
      assert(pagina.includes(ref), ref);
      assert.equal((await fetch(`${web}/${ref}`)).status, 200, ref);
    }
    assert.equal(await (await fetch(web + '/config.js')).text(), 'window.SAC_CONFIG = {"apiUrl":""};\n');
    assert.equal((await fetch(web + '/exec')).status, 200);
    assert.notEqual((await fetch(web + '/..%2fserver.js')).status, 200);
    assert.notEqual((await fetch(web + '/..%2f..%2fbackend%2f.env')).status, 200);
    const viaWeb = await post(web, 'dadosPublicos', []);
    assert.equal(viaWeb.status, 200, 'The frontend must forward /api to the backend.');
    assert.equal((await post(web, 'iniciar', ['token-invalido'])).status, 401);
    assert.equal((await fetch(web + '/drive/d_inexistente')).status, 404);
  } finally { filhos.forEach(f => { f.removeAllListeners('exit'); f.kill(); }); }
  console.log('OK: API JSON, funções privadas bloqueadas, códigos HTTP de erro, CORS, arquivos do frontend e repasse /api e /drive.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
