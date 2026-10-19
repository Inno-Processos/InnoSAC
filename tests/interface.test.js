'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

async function main() {
  const publico = path.join(__dirname, '../frontend/public');
  const html = fs.readFileSync(path.join(publico, 'index.html'), 'utf8');
  const { window } = parseHTML(html);
  const document = window.document;
  let focused = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  window.HTMLElement.prototype.reset = function () {
    this.querySelectorAll('input').forEach(input => { input.value = ''; });
  };
  const createElement = document.createElement.bind(document);
  document.createElement = name => {
    const el = createElement(name);
    if (name === 'dialog') {
      el.showModal = () => el.setAttribute('open', '');
      el.close = () => el.removeAttribute('open');
    }
    return el;
  };
  let confirmation = false;
  const confirmations = [], calls = [];
  const project = { ProjetoId: 'PRJ-1', Projeto: '4.2.01 - Teste', Login: 'teste', Ativo: true, modulos: ['Compras'], modulosDetalhes: [{ nome: 'Compras', descricao: 'Pedidos' }] };
  const config = { projetos: [{ id: 'PRJ-1', nome: project.Projeto, modulos: project.modulos, modulosDetalhes: project.modulosDetalhes }], manuais: [{ id: 'MAN-1', titulo: 'Guia', ordem: 1, publico: 'Clientes', projeto: '', descricao: '', link: 'https://example.com/guia' }], feriados: [{ data: '2026-12-25', descricao: 'Natal' }], categorias: ['Dúvida', 'Erro'] };
  const ctx = vm.createContext({
    window, document, console, URL, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: true }),
    confirm: message => { confirmations.push(message); return confirmation; },
    mockApi: async (fn, ...args) => {
      calls.push([fn, ...args]);
      if (fn === 'listarProjetos') return [project];
      if (fn === 'obterPastaGeralProjetos') return { url: 'https://drive.google.com/drive/folders/root' };
      if (fn === 'listarPastasProjetos') return [{ id: 'folder-2', nome: 'Outro projeto', vinculada: false }];
      if (fn === 'listarEquipe') return [{ Nome: 'Ana', Email: 'ana@example.com', Login: 'ana', Perfil: 'N1', Ativo: true }];
      if (fn === 'configuracoes') return config;
      if (fn === 'salvarProjeto') throw new Error('Falha simulada ao salvar');
      return true;
    }
  });
  // Carrega as telas sem js/inicio.js, que abriria o portal chamando a API real
  for (const f of ['js/api.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path.join(publico, f), 'utf8'), ctx, { filename: f });
  const run = code => vm.runInContext(code, ctx);
  const $ = selector => document.querySelector(selector);
  const admin = { tipo: 'equipe', nome: 'Admin', login: 'admin', perfil: 'Admin', admin: true, n1: true };
  ctx.user = admin;
  run("api = mockApi; S.usuario = user; S.publico = { nome: 'Innomaker' }; S.base = { setores: ['Software'], categorias: ['Dúvida'], manuais: [], status: [] }; topo();");
  assert.equal(document.querySelectorAll('.nav-grupo').length, 3);
  await run('telaProjetos()');
  $('[data-editar]').focus();
  $('[data-editar]').onclick();
  assert.equal($('#app').hidden, true);
  assert.equal($('dialog').parentElement, document.body);
  assert.equal($('.topo').inert, true);
  assert.match($('#editor-titulo').textContent, /Editar projeto/);
  assert.equal($('#b-pj').closest('.editor-acoes') !== null, true);
  await $('#f-pj').onsubmit({ preventDefault() {} });
  assert($('dialog'), 'A failed save must leave the editor open.');
  assert.equal($('#pj-login').value, 'teste');
  $('dialog').dispatchEvent(new window.Event('cancel', { cancelable: true }));
  assert.equal($('dialog'), null);
  assert.equal($('#app').hidden, false);
  assert.equal($('#form-pj').hidden, true);
  assert.equal($('.topo').inert, false);
  await $('#b-novo-pj').onclick();
  assert.match($('#editor-titulo').textContent, /Criar projeto/);
  $('#b-pj-x').onclick();

  await run('telaEquipeAdmin()');
  assert.equal($('#form-m').hidden, true);
  $('[data-editar]').onclick();
  assert.equal($('#m-nome').value, 'Ana');
  assert.equal($('#app').hidden, true);
  $('#b-m-x').onclick();
  $('#b-nova-pessoa').onclick();
  assert.equal($('#m-orig').value, '');
  assert.equal($('#m-nome').value, '');
  assert.match($('#editor-titulo').textContent, /Adicionar pessoa/);
  run('fecharEditor()');

  await run("telaConfig('manuais')");
  assert.equal($('#form-man').hidden, true);
  $('[data-ed]').onclick();
  assert.equal($('#man-tit').value, 'Guia');
  assert.equal($('#app').hidden, true);
  $('#b-man-x').onclick();
  const countBefore = calls.length;
  await $('[data-ex]').onclick();
  assert.equal(calls.length, countBefore, 'Cancelling deletion must not call the API.');
  confirmation = true;
  await $('[data-ex]').onclick();
  assert(calls.some(([fn]) => fn === 'excluirManual'));

  await run("telaConfig('modulos')");
  $('[data-editar-modulos]').onclick();
  assert.equal($('#app').hidden, true);
  assert.equal($('[data-modulo-descricao]').value, 'Pedidos');
  confirmation = false;
  $('[data-modulo-remover]').onclick();
  assert.equal(document.querySelectorAll('[data-modulos-linhas] tr').length, 1);
  confirmation = true;
  $('[data-modulo-remover]').onclick();
  assert.equal($('[data-modulo-nome]').value, '');
  run('fecharEditor()');

  await run("telaConfig('feriados')");
  confirmation = false;
  $('[data-rem]').onclick();
  assert($('.feriado'));
  confirmation = true;
  $('[data-rem]').onclick();
  assert.equal($('.feriado'), null);
  await run("telaConfig('categorias')");
  confirmation = false;
  const categoryCalls = calls.length;
  await $('[data-categoria-excluir]').onclick();
  assert.equal(calls.length, categoryCalls, 'Cancelling a category deletion must not call the API.');
  $('[data-categoria-editar]').onclick();
  assert.equal($('#categoria-nome').value, 'Dúvida');
  assert.match($('#editor-titulo').textContent, /Editar categoria/);
  run('fecharEditor()');

  run("app.innerHTML = '<aside id=\"lateral\"></aside>'; painelN1({ Id: 'CH-1', Categoria: 'Dúvida', Status: 'Aberto', Prioridade: 'Normal', Bloqueio: 'Não', modulosProjeto: [] }, { classificar: true, transicoes: ['Cancelado'], encaminhar: true }, () => {});");
  assert.equal(document.querySelectorAll('[data-abrir-acao]').length, 3);
  $('[data-abrir-acao]').onclick();
  assert.equal($('#app').hidden, true);
  assert.match($('#editor-titulo').textContent, /triagem/);
  $('#b-classif').disabled = true;
  run('fecharEditor()');
  assert($('dialog'), 'An in-flight save must not be interrupted by closing.');
  $('#b-classif').disabled = false;
  run('fecharEditor()');
  assert.equal($('dialog'), null);
  ctx.user = { ...admin, admin: false, n1: false, perfil: 'Software' };
  run('S.usuario = user; topo();');
  assert.equal($('[data-aba=projetos]'), null);
  assert.equal($('[data-aba=config]'), null);
  assert(confirmations.length >= 6);

  // Authelia/LLDAP mode: no password controls, LLDAP group names instead
  ctx.user = admin;
  run("S.auth = { modo: 'authelia', sair: 'https://auth.example/logout' }; S.usuario = user; topo();");
  assert.equal($('#btn-senha'), null);
  assert($('#btn-sair'));
  await run('telaProjetos()');
  assert.equal($('[data-senha]'), null);
  assert.match($('#app').innerHTML, /sac_projeto_teste/);
  await run('telaEquipeAdmin()');
  assert.equal($('#b-nova-pessoa'), null);
  assert.equal($('[data-editar]'), null);
  for (const grupo of ['sac_admin', 'sac_n1', 'sac_software']) assert.match($('#app').innerHTML, new RegExp(grupo));
  run("S.auth = null;");
  console.log('OK: navegação, edição/criação em modal, lista oculta, cancelamento, erro de gravação e confirmações de exclusão.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
