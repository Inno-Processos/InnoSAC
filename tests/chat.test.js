'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Chat reactions, replies to a specific message and closing a ticket by the client, on a throwaway install.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-chat-'));
fs.mkdirSync(path.join(process.env.DATA_DIR, 'drive', 'Projetos', '4.2.01 - Teste'), { recursive: true });
const gas = require('../backend/src/gas/servicos');
const { criarExecutor } = require('../backend/src/nucleo/executor');
const regras = criarExecutor(fs.readFileSync(path.join(__dirname, '../backend/src/regras/Codigo.gs'), 'utf8'), { ativo: false, despachar() {} });
const run = (fn, ...args) => regras.executar(fn, args);
const log = console.log;
console.log = () => {};
try {
  run('instalar');
  const cache = gas.makeServices(require('node:vm').createContext({})).CacheService.getScriptCache();
  cache.put('sess:admin', JSON.stringify({ login: 'admin', trocar: false }), 600);
  const projeto = run('listarProjetos', 'admin')[0];
  cache.put('sess:cliente', JSON.stringify({ login: projeto.Login, trocar: false }), 600);
  run('salvarMeuNome', 'cliente', 'Maria', '');
  const id = run('abrirChamado', 'admin', { projetoId: projeto.ProjetoId, categoria: run('iniciar', 'admin').categorias[0], titulo: 'Teste', descricao: 'Descrição', bloqueio: 'Não' });

  // Replies point to a specific message
  run('enviarChat', 'cliente', id, 'cliente', 'A nota não sai');
  let msgs = run('detalheChamado', 'cliente', id).historico.filter(h => h.Tipo === 'MENSAGEM');
  const original = msgs[0];
  assert(original.Id, 'Every message has an Id.');
  run('enviarChat', 'admin', id, 'cliente', 'Qual nota?', original.Id);
  msgs = run('detalheChamado', 'cliente', id).historico.filter(h => h.Tipo === 'MENSAGEM');
  assert.equal(msgs.at(-1).RespostaA, original.Id);
  run('enviarChat', 'admin', id, 'equipe', 'Nota interna', original.Id);
  assert.equal(run('detalheChamado', 'admin', id).historico.find(h => h.Tipo === 'NOTA_INTERNA').RespostaA, original.Id);

  // Reactions: one per person per message; same emoji again removes it; a new emoji replaces it
  run('reagirChat', 'admin', id, original.Id, '👍');
  run('reagirChat', 'cliente', id, original.Id, '👍');
  const reacoes = () => run('detalheChamado', 'cliente', id).historico.find(h => h.Id === original.Id).reacoes;
  assert.deepEqual(reacoes().map(r => [r.emoji, r.total, r.meu]), [['👍', 2, true]]);
  run('reagirChat', 'cliente', id, original.Id, '❤️');
  assert.deepEqual(reacoes().map(r => [r.emoji, r.total, r.meu]).sort(), [['❤️', 1, true], ['👍', 1, false]]);
  run('reagirChat', 'cliente', id, original.Id, '❤️');
  assert.deepEqual(reacoes().map(r => [r.emoji, r.total, r.meu]), [['👍', 1, false]]);
  assert.throws(() => run('reagirChat', 'cliente', id, original.Id, '💩'), /Reação inválida/);
  const interna = run('detalheChamado', 'admin', id).historico.find(h => h.Tipo === 'NOTA_INTERNA');
  assert.throws(() => run('reagirChat', 'cliente', id, interna.Id, '👍'), /não encontrada/, 'Clients cannot react to internal notes.');
  const status = run('detalheChamado', 'admin', id).historico.find(h => h.Tipo === 'STATUS');
  assert.throws(() => run('reagirChat', 'admin', id, status.Id, '👍'), /não encontrada/, 'Status events are not reactable.');
  const atualizacao = run('chatAtualizar', 'admin', id, 0, 'versao-antiga', '');
  assert.equal(atualizacao.reacoes[original.Id][0].emoji, '👍', 'Polling carries reactions of older messages.');

  // The client closes the ticket at any time, with an optional reason
  assert.equal(run('detalheChamado', 'cliente', id).acoes.fechar, true);
  assert.throws(() => run('fecharChamado', 'admin', id), /encerrado/, 'Only the client uses this action.');
  run('fecharChamado', 'cliente', id, 'Resolvi sozinho');
  const fechado = run('detalheChamado', 'cliente', id);
  assert.equal(fechado.chamado.Status, 'Fechado');
  assert.equal(fechado.chamado.FechadoPor, 'Cliente');
  assert.equal(fechado.acoes.fechar, false);
  assert.equal(fechado.acoes.reabrir, true, 'It can still be reopened.');
  assert(fechado.historico.some(h => /Cliente fechou o chamado\. Motivo: Resolvi sozinho/.test(h.Texto)));
  assert.throws(() => run('fecharChamado', 'cliente', id), /encerrado/);
} finally { console.log = log; }
log('OK: respostas a mensagens, reações (uma por pessoa, trocar e tirar), notas internas protegidas e fechamento pelo cliente.');
