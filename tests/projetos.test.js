'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Separate database and Drive: tests never touch the running installation.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-projetos-'));
const folders = [
  { id: 'drive-innoboat', name: '4.2.01 - Innoboat' },
  { id: 'drive-marinha', name: '4.2.16 Marinha - USV' },
  { id: 'drive-radio', name: '4.2.28 - Adaptação rádio innoboat ' }
];
fs.writeFileSync(path.join(process.env.DATA_DIR, 'drive-projects.json'), JSON.stringify({
  folderId: '1SCQQuXBj7wZfbr-72Lp5OtFyPYrjXu30', folders
}));
const gas = require('../backend/src/gas/servicos');
const script = new vm.Script(fs.readFileSync(path.join(__dirname, '../backend/src/regras/Codigo.gs'), 'utf8'));
function run(fn, ...args) {
  const ctx = vm.createContext({ console });
  const services = gas.makeServices(ctx);
  for (const key of Object.keys(services)) if (!key.startsWith('_')) ctx[key] = services[key];
  script.runInContext(ctx);
  try { return JSON.parse(JSON.stringify(ctx[fn](...args) ?? null)); }
  finally { services._salvar(); }
}
const log = console.log;
console.log = () => {};
try {
  run('instalar');
  const services = gas.makeServices(vm.createContext({}));
  const cache = services.CacheService.getScriptCache();
  cache.put('sess:admin-test', JSON.stringify({ login: 'admin', trocar: false }), 600);
  const menu = run('listarPastasProjetos', 'admin-test');
  assert.equal(menu.length, folders.length);
  for (const folder of folders) {
    assert(menu.some(p => p.id === folder.id && p.nome === folder.name.trim()));
  }
  assert.deepEqual(run('sincronizarProjetos', 'admin-test'), []);
  const projects = run('listarProjetos', 'admin-test');
  const project = projects.find(p => p.Projeto === '4.2.01 - Innoboat');
  assert(project);
  cache.put('sess:client-test', JSON.stringify({ login: project.Login, trocar: false }), 600);
  assert.equal(run('iniciar', 'client-test').usuario.projeto, 'Innoboat');
  assert.equal(run('iniciar', 'client-test').usuario.nome, 'Innoboat');
  assert.equal(run('meuCadastro', 'client-test').projeto, 'Innoboat');
  const ticketId = run('abrirChamado', 'admin-test', {
    projetoId: project.ProjetoId, categoria: run('iniciar', 'admin-test').categorias[0],
    titulo: 'Teste de exibição', descricao: 'Descrição do teste', bloqueio: 'Sim'
  });
  const customer = run('detalheChamado', 'client-test', ticketId);
  assert.equal(customer.chamado.Projeto, 'Innoboat');
  assert.equal(customer.chamado.Usuario, 'Innoboat');
  assert.equal(run('detalheChamado', 'admin-test', ticketId).chamado.Projeto, '4.2.01 - Innoboat');
  assert.equal(run('ler_', 'Projetos').find(p => p.ProjetoId === project.ProjetoId).PastaId, 'drive-innoboat');
  run('registrar_', ticketId, { nome: project.Projeto, perfil: 'Cliente' }, 'RESPOSTA', 'Mensagem antiga', true);
  assert.equal(run('itensChat_', { tipo: 'cliente', projeto: project.Projeto }, ticketId).at(-1).Autor, 'Innoboat');
  for (const [original, expected] of [
    ['4.2.01 - Innoboat', 'Innoboat'],
    ['4.2.16 Marinha - USV', 'Marinha - USV'],
    ['4.2.23 UFRJ Painel Elétrico', 'UFRJ Painel Elétrico'],
    ['4.2.24 - SAILWING-DHITEC', 'SAILWING-DHITEC'],
    ['4.2.21 Vela F-Boat', 'Vela F-Boat'],
    ['Projeto sem código', 'Projeto sem código']
  ]) assert.equal(run('nomeProjetoCliente_', original), expected);
  // Existing personal names are not treated as project codes.
  run('salvarProjeto', 'admin-test', {
    ProjetoId: project.ProjetoId, Login: project.Login, Responsavel: 'Ana Silva', Ativo: true, Modulos: []
  });
  assert.equal(run('iniciar', 'client-test').usuario.nome, 'Ana Silva');
  new vm.Script(fs.readFileSync(path.join(__dirname, '../backend/src/gas/servicos.js'), 'utf8'));
  const js = path.join(__dirname, '../frontend/public/js');
  for (const f of fs.readdirSync(js)) new vm.Script(fs.readFileSync(path.join(js, f), 'utf8'), { filename: f });
} finally { console.log = log; }
log('OK: catálogo completo da fixture, IDs reais, espaços nos nomes, cliente sem códigos, dados administrativos preservados, cadastro, chamados e histórico.');
