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
      if (fn === 'gruposProjetoLldap') return [{ grupo: 'Projeto_Livre', projeto: '' }, { grupo: 'Projeto_Usado', projeto: 'Outro' }];
      if (fn === 'listarClientesLldap') return [{ Nome: 'Maria', Login: 'maria', Email: 'maria@cliente.com', Ativo: true, projetoIds: ['PRJ-1'], projetos: ['4.2.01 - Teste'] }];
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
  assert.match($('#app').innerHTML, /não definido/);
  for (const id of ['#b-sinc', '#b-novo-pj']) assert.equal($(id), null, id + ': projects come from LLDAP groups.');
  assert.match($('#app').innerHTML, /Clientes que já entraram[\s\S]*maria@cliente\.com/);
  $('[data-editar]').onclick();
  assert($('#pj-grupo'), 'The project form asks for the LLDAP group.');
  assert.deepEqual([...document.querySelectorAll('#pj-grupos option')].map(o => o.getAttribute('value')), ['Projeto_Livre'], 'Only unlinked groups are suggested.');
  run('fecharEditor()');
  assert.doesNotMatch($('#app table').innerHTML, /Responsável|E-mail/, 'No contact columns in LLDAP mode.');
  $('[data-ver-clientes]').onclick();
  assert.match($('#editor-titulo').textContent, /Clientes de 4.2.01 - Teste/);
  assert.match($('dialog').innerHTML, /maria@cliente.com/);
  run('fecharEditor()');
  await run('telaEquipeAdmin()');
  assert.equal($('#b-nova-pessoa'), null);
  assert.equal($('#b-adicionar-perfil'), null, 'Profiles come from LLDAP groups.');
  assert.equal($('[data-editar]'), null);
  for (const grupo of ['sac_admin', 'sac_n1', 'sac_software']) assert.match($('#app').innerHTML, new RegExp(grupo));
  // Client in two projects (Authelia): picks the project when opening a ticket and filters the list by project
  ctx.cliente = { tipo: 'cliente', nome: 'Maria', login: 'maria', perfil: 'Cliente', projeto: 'A · B', contaLldap: true };
  run(`S.usuario = cliente; S.base = { categorias: ['Dúvida'], status: ['Aberto'], manuais: [], modulos: [], diasAutoFechamento: 5, diasReabertura: 5, prazoNormal: 3,
    projetos: [{ id: 'PRJ-A', nome: 'A', modulos: ['Compras'] }, { id: 'PRJ-B', nome: 'B', modulos: [] }] };
    S.publico.horaInicio = 9; S.publico.horaFim = 16; topo();`);
  assert.equal($('#btn-cadastro'), null, 'LLDAP clients have no "Meu cadastro".');
  await run('telaNovoChamado(false)');
  assert.deepEqual([...document.querySelectorAll('#n-cliente option')].map(o => o.getAttribute('value')), ['', 'PRJ-A', 'PRJ-B']);
  $('#n-cliente option[value="PRJ-A"]').setAttribute('selected', ''); $('#n-cliente').onchange();
  assert.equal($('#campo-modulo').hidden, false, 'Modules follow the chosen project.');
  // Attachments: choosing again adds to the list; each file can be removed before sending
  const escolher = arquivos => { Object.defineProperty($('#n-arquivos'), 'files', { value: arquivos, configurable: true, writable: true }); $('#n-arquivos').onchange(); };
  const arq = (name, size) => ({ name, size, lastModified: 1 });
  escolher([arq('print.png', 2048), arq('nota.xml', 4096)]);
  escolher([arq('planilha.xlsx', 8192), arq('print.png', 2048)]);
  assert.deepEqual(Array.from(run("arquivosDe('n-arquivos').map(f => f.name)")), ['print.png', 'nota.xml', 'planilha.xlsx']);
  assert.equal(document.querySelectorAll('#n-arquivos-lista [data-arquivo-ver]').length, 3);
  $('#n-arquivos-lista [data-arquivo-tirar="1"]').onclick();
  assert.deepEqual(Array.from(run("arquivosDe('n-arquivos').map(f => f.name)")), ['print.png', 'planilha.xlsx']);
  assert.doesNotMatch($('#n-arquivos-lista').innerHTML, /nota.xml/);
  const meus = [{ Id: 'CH-A', ProjetoId: 'PRJ-A', Projeto: 'A', Titulo: 'Tem A', Status: 'Aberto', Categoria: 'Dúvida' }, { Id: 'CH-B', ProjetoId: 'PRJ-B', Projeto: 'B', Titulo: 'Tem B', Status: 'Aberto', Categoria: 'Dúvida' }];
  ctx.mockApi = async fn => fn === 'meusChamados' ? meus : true;
  await run('api = mockApi; telaCliente()');
  assert($('#f-projeto'));
  $('#f-projeto option[value="PRJ-B"]').setAttribute('selected', ''); $('#f-projeto').oninput();
  assert.match($('#lista').innerHTML, /Tem B/);
  assert.doesNotMatch($('#lista').innerHTML, /Tem A/);

  // Client side menu: Meus chamados, Abrir chamado, Como funciona
  assert.deepEqual([...document.querySelectorAll('#abas [data-aba]')].map(b => b.dataset.aba), ['cliente', 'novo', 'como']);
  assert.equal($('#abas [data-aba=cliente]').getAttribute('aria-current'), 'page');
  run('telaComoFunciona()');
  assert.match($('#app').innerHTML, /Aguardando cliente/);
  assert.equal($('#abas [data-aba=como]').getAttribute('aria-current'), 'page');

  // Closing a ticket: the client confirms, with an optional reason
  const chamadas = [];
  ctx.mockApi = async (fn, ...args) => { chamadas.push([fn, ...args]); return true; };
  run(`api = mockApi; app.innerHTML = '<div id="painel"></div>'; painelCliente({ Id: 'CH-1', Status: 'Em atendimento' }, {}, { fechar: true }, () => {});`);
  assert.equal($('#fechar-form').hidden, true);
  $('#b-fechar').onclick();
  assert.equal($('#fechar-form').hidden, false);
  $('#t-fechar').value = 'Resolvi';
  await $('#b-confirmar-fechar').onclick({ target: $('#b-confirmar-fechar') });
  assert.deepEqual(chamadas.at(-1).slice(0, 1).concat(chamadas.at(-1).slice(2)), ['fecharChamado', 'CH-1', 'Resolvi']);

  // Chat: reactions under the message, emoji picker, quoted reply and "Respondendo a..." bar
  run(`app.innerHTML = '<div id="chat"></div>'; montarChat({ Id: 'CH-1', Abertura: '2026-10-19T12:00:00Z', Descricao: 'Abertura', Status: 'Em atendimento' }, {
    acoes: { responder: true, anexar: true }, chat: { canais: ['cliente'], ver: '1', ladoOnline: {}, podeEscreverCliente: true },
    historico: [
      { Id: 'm1', Tipo: 'MENSAGEM', Texto: 'Qual nota?', Autor: 'Ana', Perfil: 'N1', DataHora: '2026-10-19T12:01:00Z', reacoes: [{ emoji: '👍', total: 2, meu: true, nomes: ['Ana', 'Maria'] }] },
      { Id: 'm2', Tipo: 'MENSAGEM', Texto: 'A 123', Autor: 'Maria', Perfil: 'Cliente', meu: true, RespostaA: 'm1', DataHora: '2026-10-19T12:02:00Z', reacoes: [] },
      { Id: 's1', Tipo: 'STATUS', Texto: 'Aberto → Em atendimento', DataHora: '2026-10-19T12:03:00Z' }] });`);
  assert.match($('[data-msg=m1] .reacao.minha').textContent, /👍\s*2/);
  assert.match($('[data-msg=m2] .citacao').textContent, /Ana, atendimento[\s\S]*Qual nota\?/);
  assert.equal(document.querySelectorAll('[data-abrir-reacoes]').length, 2, 'Status events have no reactions.');
  $('[data-abrir-reacoes=m1]').onclick();
  assert.equal(document.querySelectorAll('.seletor-reacao button').length, 6);
  await $('.seletor-reacao button[data-emoji="❤️"]').onclick();
  assert.deepEqual(chamadas.at(-1).slice(2), ['CH-1', 'm1', '❤️']);
  $('[data-responder=m1]').onclick();
  assert.match($('.respondendo').textContent, /Respondendo a Ana, atendimento/);
  $('#chat-txt').value = 'É a 123';
  await run('enviarMensagemChat()');
  assert.deepEqual(chamadas.at(-1).slice(2), ['CH-1', 'cliente', 'É a 123', 'm1']);
  assert.equal($('.respondendo'), null, 'The reply bar closes after sending.');
  run('pararChat()');

  // Settings > business hours and automatic replies: simulator follows the decision table
  ctx.cfgAuto = { geral: [['DIAS_FUNCIONAMENTO', '1,2,3,4,5'], ['HORA_INICIO', '9'], ['HORA_FIM', '16'], ['NOTIFICAR_EQUIPE', 'SIM'], ['MENSAGEM_AUTOMATICA', 'SIM'], ['LIMITE_ALTO_VOLUME', '10'],
    ['MSG_M01', '{saudacao}! Fora'], ['MSG_M02', '{saudacao}! Normal'], ['MSG_M03', '{saudacao}! Volume'], ['NOME_SISTEMA', 'Innomaker']].map(([chave, valor]) => ({ chave, valor, descricao: '', tipo: 'texto' })),
    automatico: { dentro: true, ativos: 4, codigo: 'M02', situacao: 'Atendimento normal', saudacao: 'Boa tarde', avisosNaFila: 2 } };
  run('app.innerHTML = "<div id=cfg></div>"; cfgAutomaticas(cfgAuto);');
  assert.match($('.auto-agora').textContent, /dentro do horário[\s\S]*M02[\s\S]*2 avisos/);
  assert.deepEqual([...document.querySelectorAll('[data-dia]')].filter(c => c.hasAttribute('checked')).map(c => c.dataset.dia), ['1', '2', '3', '4', '5']);
  assert.match($('.tabela-decisao tr.atual').textContent, /Sim[\s\S]*Não[\s\S]*M02/);
  assert.equal($('#sim-previa').textContent, 'Boa tarde! Normal');
  $('#sim-ativos').value = '15'; $('#sim-ativos').oninput();
  assert.equal($('#sim-codigo').textContent, 'M03');
  $('input[name=sim-dentro][value="1"]').removeAttribute('checked'); $('input[name=sim-dentro][value="0"]').setAttribute('checked', ''); $('#sim-ativos').oninput();
  assert.equal($('#sim-codigo').textContent, 'M01', 'Outside business hours wins.');
  assert.equal($('#sim-previa').textContent, 'Boa tarde! Fora');
  run("S.auth = null;");
  console.log('OK: navegação, edição/criação em modal, lista oculta, cancelamento, erro de gravação e confirmações de exclusão.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
