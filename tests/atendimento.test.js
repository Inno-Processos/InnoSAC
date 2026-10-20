'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Who sees a ticket: the N1 who takes it (atendente), transfer to another N1, passing to a sector, Admin oversight.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-atendimento-'));
fs.mkdirSync(path.join(process.env.DATA_DIR, 'drive', 'Projetos', '4.2.01 - Teste'), { recursive: true });
const gas = require('../backend/src/gas/servicos');
const { criarExecutor } = require('../backend/src/nucleo/executor');
let enviados = [];
const regras = criarExecutor(fs.readFileSync(path.join(__dirname, '../backend/src/regras/Codigo.gs'), 'utf8'),
  { ativo: true, despachar(msgs) { enviados = enviados.concat(msgs); } });
const run = (fn, ...args) => regras.executar(fn, args);
const log = console.log;
console.log = () => {};
try {
  run('instalar');
  const cache = gas.makeServices(require('node:vm').createContext({})).CacheService.getScriptCache();
  const sessao = (token, login) => cache.put('sess:' + token, JSON.stringify({ login, trocar: false }), 600);
  sessao('admin', 'admin');
  const ana = run('salvarMembro', 'admin', { Nome: 'Ana', Email: 'ana@innomaker.com.br', Perfil: 'N1' }).login;
  const bruno = run('salvarMembro', 'admin', { Nome: 'Bruno', Email: 'bruno@innomaker.com.br', Perfil: 'N1' }).login;
  const sofia = run('salvarMembro', 'admin', { Nome: 'Sofia', Email: 'sofia@innomaker.com.br', Perfil: 'Software' }).login;
  sessao('ana', ana); sessao('bruno', bruno); sessao('sofia', sofia);
  const projeto = run('listarProjetos', 'admin')[0];
  run('salvarProjeto', 'admin', { ProjetoId: projeto.ProjetoId, Login: projeto.Login, Email: 'cliente@teste.com', Ativo: true, Modulos: [] });
  sessao('cliente', projeto.Login);
  run('salvarMeuNome', 'cliente', 'Maria', '');
  const categoria = run('iniciar', 'admin').categorias[0];
  const id = run('abrirChamado', 'cliente', { categoria, titulo: 'Teste', descricao: 'Descrição', bloqueio: 'Não' });
  const fila = token => run('filaEquipe', token).map(c => c.Id);
  const ve = (token, chamado) => { try { run('detalheChamado', token, chamado); return true; } catch (e) { return false; } };

  // Without an atendente, every N1 sees it (someone has to take it)
  assert.deepEqual([fila('ana'), fila('bruno')], [[id], [id]]);
  assert.equal(run('filaEquipe', 'ana')[0].Atendente, '');

  // Ana acts on it → she becomes the atendente; Bruno no longer sees it; Admin always does
  run('enviarChat', 'ana', id, 'cliente', 'Olá, vou verificar.');
  assert.equal(run('detalheChamado', 'admin', id).chamado.atendenteNome, 'Ana');
  assert.deepEqual(fila('bruno'), []);
  assert.equal(ve('bruno', id), false);
  assert.throws(() => run('alterarStatus', 'bruno', id, 'Em atendimento', ''), /não tem acesso/);
  assert.deepEqual(fila('admin'), [id]);
  const resumoAna = run('filaEquipe', 'ana')[0];
  assert.deepEqual([resumoAna.Atendente, resumoAna.meuAtendimento], ['Ana', true]);
  let acoes = run('detalheChamado', 'ana', id).acoes;
  assert.deepEqual([acoes.assumir, acoes.transferir], [false, true]);
  assert(run('detalheChamado', 'admin', id).historico.some(h => h.Tipo === 'AVISO' && /Ana assumiu o atendimento/.test(h.Texto)));
  assert(!run('detalheChamado', 'cliente', id).historico.some(h => h.Tipo === 'AVISO'), 'The client does not see internal notices.');
  assert.equal(run('detalheChamado', 'cliente', id).chamado.Atendente, undefined);

  // Client messages now notify only the atendente
  enviados = [];
  run('enviarChat', 'cliente', id, 'cliente', 'O pedido é o 4521.');
  const aviso = enviados.find(m => /Nova mensagem do cliente/.test(m.subject));
  assert(aviso && aviso.to === 'ana@innomaker.com.br', 'Only the atendente is notified: ' + (aviso && aviso.to));

  // Passing to a sector: the status changes, Ana keeps the ticket and the sector can take it too
  run('encaminhar', 'ana', id, 'Software', 'Verificar a emissão da nota.');
  assert.equal(run('detalheChamado', 'ana', id).chamado.Status, 'Encaminhado ao setor');
  assert.equal(ve('ana', id), true);
  assert.equal(ve('sofia', id), true);
  assert.equal(run('detalheChamado', 'admin', id).chamado.atendenteNome, 'Ana');

  // While forwarded, the sector talks to the client directly (messages and visible attachments)
  const dSofia = run('detalheChamado', 'sofia', id);
  assert.deepEqual([dSofia.chat.podeEscreverCliente, dSofia.acoes.responder], [true, true]);
  // Every team reply e-mails the client right away: no "online" check, no 10-minute window
  enviados = [];
  run('enviarChat', 'sofia', id, 'cliente', 'Qual CFOP aparece na nota?');
  run('enviarChat', 'sofia', id, 'cliente', 'Pode mandar um print?');
  assert(run('detalheChamado', 'cliente', id).historico.some(h => h.Tipo === 'MENSAGEM' && h.Texto === 'Qual CFOP aparece na nota?'), 'The client sees the sector message.');
  assert.equal(enviados.filter(m => m.to === 'cliente@teste.com' && /Nova mensagem no chat/.test(m.subject)).length, 2, 'One e-mail per reply.');
  enviados = [];
  run('enviarChat', 'sofia', id, 'equipe', 'Nota só da equipe');
  assert(!enviados.some(m => m.to === 'cliente@teste.com'), 'Internal notes never e-mail the client.');
  assert.equal(run('detalheChamado', 'admin', id).chamado.atendenteNome, 'Ana', 'The sector does not become the atendente.');
  enviados = [];
  run('anexar', 'sofia', id, { nome: 'print.png', tipo: 'image/png', b64: Buffer.from('x').toString('base64') }, false);
  assert(run('detalheChamado', 'cliente', id).anexos.some(a => a.Nome === 'print.png'), 'Sector attachments in the client chat are visible.');
  assert(enviados.some(m => m.to === 'cliente@teste.com' && /print\.png/.test(m.html || m.htmlBody || JSON.stringify(m))), 'A visible attachment e-mails the client too.');
  enviados = [];
  run('anexar', 'sofia', id, { nome: 'log.txt', tipo: 'text/plain', b64: Buffer.from('x').toString('base64') }, true);
  assert(!enviados.some(m => m.to === 'cliente@teste.com'), 'Internal attachments do not.');
  enviados = [];
  run('enviarChat', 'cliente', id, 'cliente', 'É o 5102.');
  assert(enviados.some(m => m.to === 'sofia@innomaker.com.br' && /Nova mensagem do cliente/.test(m.subject)), 'The sector hears the client reply.');

  run('devolverAoN1', 'sofia', id, 'Corrigido o CFOP.');
  assert.equal(ve('sofia', id), false, 'Back with the N1, the sector no longer sees it.');
  assert.throws(() => run('enviarChat', 'sofia', id, 'cliente', 'Mais uma coisa'), /não tem acesso/, 'Back with the N1, the sector can no longer write.');
  // The client reply goes to whoever is answering and still has the ticket (Sofia lost it, so Ana), every time
  enviados = [];
  run('enviarChat', 'cliente', id, 'cliente', 'Obrigada!');
  run('anexar', 'cliente', id, { nome: 'nota.png', tipo: 'image/png', b64: Buffer.from('x').toString('base64') }, false);
  const paraEquipe = enviados.filter(m => /Nova mensagem do cliente/.test(m.subject)).map(m => m.to);
  assert.deepEqual(paraEquipe, ['ana@innomaker.com.br', 'ana@innomaker.com.br'], 'Not the admin, not the whole N1: ' + paraEquipe);
  assert.equal(ve('ana', id), true);

  // Transferring to another N1: Ana loses it, Bruno gets it and an e-mail
  assert.throws(() => run('transferirChamado', 'ana', id, sofia, ''), /pessoa do N1/);
  assert.throws(() => run('transferirChamado', 'ana', id, ana, ''), /outra pessoa/);
  const possiveis = run('atendentesN1', 'ana').map(a => a.login);
  assert(possiveis.includes(ana) && possiveis.includes(bruno) && !possiveis.includes(sofia), 'Only N1 and Admin can receive a transfer.');
  enviados = [];
  const r = run('transferirChamado', 'ana', id, bruno, 'Cliente prefere falar à tarde.');
  assert.deepEqual(r, { saiu: true, para: 'Bruno' });
  assert.equal(ve('ana', id), false);
  assert.deepEqual(fila('ana'), []);
  assert.equal(ve('bruno', id), true);
  assert(enviados.some(m => m.to === 'bruno@innomaker.com.br' && /transferido para você/.test(m.subject)));
  assert(run('detalheChamado', 'bruno', id).historico.some(h => /Ana transferiu o atendimento para Bruno\. Nota: Cliente prefere falar à tarde\./.test(h.Texto)));
  assert.throws(() => run('enviarChat', 'ana', id, 'cliente', 'Oi'), /não tem acesso/);
  run('alterarStatus', 'bruno', id, 'Aguardando cliente', 'Pode testar de novo?');

  // Admin can take over; then Bruno no longer sees it
  assert.equal(run('assumirChamado', 'admin', id), 'Você assumiu o atendimento.');
  assert.equal(ve('bruno', id), false);
  assert(run('detalheChamado', 'admin', id).historico.some(h => /assumiu o atendimento no lugar de Bruno/.test(h.Texto)));

  // A phone ticket registered by an N1 is already theirs
  const tel = run('abrirChamado', 'bruno', { projetoId: projeto.ProjetoId, categoria, titulo: 'Por telefone', descricao: 'Ligou', bloqueio: 'Não' });
  assert.equal(run('detalheChamado', 'admin', tel).chamado.atendenteNome, 'Bruno');
  assert.equal(ve('ana', tel), false);
} finally { console.log = log; }
log('OK: atendente ao agir, só o atendente e o Admin veem, encaminhar mantém o atendente, transferir tira o acesso, avisos ao atendente e chamado por telefone.');
