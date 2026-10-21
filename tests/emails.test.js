'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-emails-'));
const gas = require('../backend/src/gas/servicos');
const script = new vm.Script(fs.readFileSync(path.join(__dirname, '../backend/src/regras/Codigo.gs'), 'utf8'));
let outbox = [];
function run(fn, ...args) {
  const ctx = vm.createContext({ console }), svc = gas.makeServices(ctx);
  for (const k of Object.keys(svc)) if (!k.startsWith('_')) ctx[k] = svc[k];
  script.runInContext(ctx);
  try { return JSON.parse(JSON.stringify(ctx[fn](...args) ?? null)); }
  finally { svc._salvar(); outbox = svc._enviados.slice(); }
}
const log = console.log;
console.log = () => {};
try {
  run('instalar');
  const cache = gas.makeServices(vm.createContext({})).CacheService.getScriptCache();
  cache.put('sess:admin-test', JSON.stringify({ login: 'admin', trocar: false }), 600);
  const member = run('salvarMembro', 'admin-test', { Nome: 'Pessoa teste', Email: 'equipe@example.com', Perfil: 'N1', enviarEmail: false });
  assert.equal(member.emailEnviado, true);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'equipe@example.com');
  assert(outbox[0].htmlBody.includes(member.senha));
  assert.equal(run('entrar', member.login, member.senha).trocarSenha, true);
  run('salvarMembro', 'admin-test', { loginOriginal: member.login, Login: member.login, Nome: 'Pessoa editada', Email: 'equipe@example.com', Perfil: 'N1', Ativo: true });
  assert.equal(outbox.length, 0, 'Editing a member must not generate or send a password.');
  const reset = run('redefinirSenhaAcesso', 'admin-test', 'equipe', member.login, false);
  assert.equal(reset.emailEnviado, true);
  assert.equal(outbox[0].to, 'equipe@example.com');
  assert(outbox[0].htmlBody.includes(reset.senha));
  assert.throws(() => run('entrar', member.login, member.senha), /incorretos/);
  assert.equal(run('entrar', member.login, reset.senha).trocarSenha, true);

  fs.mkdirSync(path.join(gas.DRIVE, 'Projetos', '4.2.01 - Cliente teste'));
  const folder = run('listarPastasProjetos', 'admin-test')[0];
  const client = run('criarProjeto', 'admin-test', { pastaId: folder.id, email: 'cliente@example.com', enviarEmail: true });
  assert.equal(client.emailEnviado, false);
  assert.equal(outbox.length, 0);
  const project = run('listarProjetos', 'admin-test')[0];
  const clientReset = run('redefinirSenhaAcesso', 'admin-test', 'projeto', project.ProjetoId, true);
  assert.equal(clientReset.emailEnviado, false);
  assert.equal(outbox.length, 0);
  const login = run('entrar', clientReset.login, clientReset.senha);
  assert.equal(login.trocarSenha, true);
  run('trocarSenha', login.token, clientReset.senha, 'SenhaCliente123');
  run('esqueciSenha', 'cliente@example.com');
  assert.equal(outbox.filter(m => m.to === 'cliente@example.com').length, 1);
  const recovered = run('ler_', 'Projetos')[0];
  assert(recovered.SenhaTempHash);
  assert(new Date(recovered.SenhaTempExpira) > new Date());

  const { criarExecutor } = require('../backend/src/nucleo/executor');
  const executor = criarExecutor('function envio() { return {emailEnviado: true}; }', { ativo: false, despachar() {} });
  assert(executor.publicas.has('envio'));
  const delivery = executor.executar('envio');
  assert.equal(delivery.emailEnviado, false);
  assert.equal(delivery.emailSalvoLocal, true);
  // Two messages to the same recipient in the same millisecond must both survive.
  const { criarCorreio } = require('../backend/src/nucleo/correio');
  const pastaEmails = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-outbox-'));
  const smtpHost = process.env.SMTP_HOST;
  const agora = Date.now;
  try {
    process.env.SMTP_HOST = '';
    Date.now = () => 1234567890;
    criarCorreio(pastaEmails).despachar([
      { to: 'teste@example.com', subject: 'Primeiro', htmlBody: '<p>Primeiro</p>' },
      { to: 'teste@example.com', subject: 'Segundo', htmlBody: '<p>Segundo</p>' }
    ]);
    assert.equal(fs.readdirSync(pastaEmails).length, 2);
  } finally {
    Date.now = agora;
    if (smtpHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = smtpHost;
  }
} finally { console.log = log; }
log('OK: equipe recebe senha ao criar/redefinir, edição preserva acesso, projetos sem envio automático, troca inicial, recuperação e aviso sem SMTP.');
