'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-sessoes-'));
const gasPath = path.join(__dirname, '../backend/src/gas/servicos.js');
const childCode = `
  const vm = require('node:vm');
  const cache = require(${JSON.stringify(gasPath)}).makeServices(vm.createContext({})).CacheService.getScriptCache();
  if (process.argv[1] === 'put') {
    cache.put('sess:test-token', JSON.stringify({ login: 'admin', trocar: false }), 21600);
    cache.put('perfil:admin', 'temporary', 300);
  }
  if (process.argv[1] === 'remove') cache.remove('sess:test-token');
  console.log(JSON.stringify({ session: cache.get('sess:test-token'), profile: cache.get('perfil:admin') }));
`;
function child(action) {
  const r = spawnSync(process.execPath, ['-e', childCode, action], {
    env: { ...process.env, DATA_DIR: data }, encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
assert(child('put').session);
const afterRestart = child('read');
assert.equal(JSON.parse(afterRestart.session).login, 'admin');
assert.equal(afterRestart.profile, null);
const file = path.join(data, 'sessoes.json');
assert(!fs.readFileSync(file, 'utf8').includes('test-token'));
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
const entry = Object.values(saved)[0];
assert(entry.expira <= Date.now() + 21600 * 1000);
assert.equal(child('remove').session, null);
assert.equal(child('read').session, null);
child('put');
const expired = JSON.parse(fs.readFileSync(file, 'utf8'));
Object.values(expired)[0].expira = Date.now() - 1000;
fs.writeFileSync(file, JSON.stringify(expired));
assert.equal(child('read').session, null);

const html = fs.readFileSync(path.join(__dirname, '../frontend/public/js/app.js'), 'utf8');
const helpers = html.slice(html.indexOf('const guarda ='), html.indexOf('function api('));
const storage = new Map();
const sessionStorage = {
  getItem: key => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key)
};
function browser(user) {
  const calls = [];
  const ctx = vm.createContext({
    S: { token: null, usuario: user }, sessionStorage,
    telaEquipe: (...args) => calls.push(['equipe', ...args]),
    telaDetalhe: id => calls.push(['detalhe', id]),
    telaMeuCadastro: () => calls.push(['cadastro']),
    telaNovoChamado: telefone => calls.push(['novo', telefone])
  });
  vm.runInContext(helpers, ctx);
  return { run: code => vm.runInContext(code, ctx), calls };
}
const admin = { login: 'admin', tipo: 'equipe', admin: true, n1: true };
const first = browser(admin);
first.run("guarda.set('test-token'); lembrarTela('config', 'modulos');");
const refreshed = browser(admin);
assert.equal(refreshed.run('guarda.get()'), 'test-token');
assert.equal(refreshed.run('restaurarTela()'), true);
assert.deepEqual(refreshed.calls, [['equipe', 'config', 'modulos']]);
assert.equal(browser({ ...admin, login: 'outro' }).run('restaurarTela()'), false);
assert.equal(browser({ ...admin, admin: false, n1: false }).run('restaurarTela()'), false);
refreshed.run('guarda.del()');
assert.equal(browser(admin).run('guarda.get()'), null);
assert.equal(storage.has('sac_tela'), false);
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
console.log('OK: sessão após reinício, expiração, logout persistente, token após F5, restauração de tela e permissões.');
