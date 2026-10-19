'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Business hours, automatic replies (M01/M02/M03) and new-ticket e-mails to Admin + N1 only during business hours.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-auto-'));
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
  cache.put('sess:admin', JSON.stringify({ login: 'admin', trocar: false }), 600);
  run('salvarMembro', 'admin', { Nome: 'Nina N1', Email: 'n1@innomaker.com.br', Perfil: 'N1' });
  run('salvarMembro', 'admin', { Nome: 'Sofia Software', Email: 'software@innomaker.com.br', Perfil: 'Software' });
  const projeto = run('listarProjetos', 'admin')[0];
  run('salvarProjeto', 'admin', { ProjetoId: projeto.ProjetoId, Login: projeto.Login, Email: 'cliente@teste.com', Ativo: true, Modulos: [] });
  cache.put('sess:cliente', JSON.stringify({ login: projeto.Login, trocar: false }), 600);
  run('salvarMeuNome', 'cliente', 'Maria', '');
  const categoria = run('iniciar', 'admin').categorias[0];
  const abrir = () => run('abrirChamado', 'cliente', { categoria, titulo: 'Teste', descricao: 'Descrição', bloqueio: 'Não' });
  const automatica = id => run('detalheChamado', 'admin', id).historico.find(h => h.Autor === 'Atendimento automático');
  const avisosEquipe = () => enviados.filter(m => /Novo chamado|fora do horário/.test(m.subject));

  // Decision table: outside business hours wins; above the limit (10) → high volume
  assert.equal(run('regraAutomatica_', false, 0).codigo, 'M01');
  assert.equal(run('regraAutomatica_', false, 50).codigo, 'M01');
  assert.equal(run('regraAutomatica_', true, 10).codigo, 'M02');
  assert.equal(run('regraAutomatica_', true, 11).codigo, 'M03');
  // Business hours: Monday to Friday, 9h to 16h by default
  assert.equal(run('dentroDoExpediente_', new Date(2026, 9, 19, 10, 0)), true, 'Monday 10:00');
  assert.equal(run('dentroDoExpediente_', new Date(2026, 9, 19, 8, 59)), false, 'Monday 08:59');
  assert.equal(run('dentroDoExpediente_', new Date(2026, 9, 19, 16, 0)), false, 'Monday 16:00');
  assert.equal(run('dentroDoExpediente_', new Date(2026, 9, 24, 10, 0)), false, 'Saturday');
  assert.equal(run('dentroDoExpediente_', new Date(2026, 11, 25, 10, 0)), false, 'Christmas (holiday)');
  assert.match(run('mensagemAutomatica_', 'M02', new Date(2026, 9, 19, 9, 0)), /^Bom dia!\n\nRecebemos seu chamado com sucesso/);
  assert.match(run('mensagemAutomatica_', 'M01', new Date(2026, 9, 19, 20, 0)), /^Boa noite!/);

  const configurar = valores => run('salvarConfiguracoes', 'admin', valores);
  const hoje = new Date().getDay();
  const podeTestarAgora = new Date().getHours() < 23;
  if (podeTestarAgora) {
    // Inside business hours: reply M02 in the chat and e-mail; team e-mail right away, only to Admin and N1
    configurar({ DIAS_FUNCIONAMENTO: '0,1,2,3,4,5,6', HORA_INICIO: '0', HORA_FIM: '23' });
    enviados = [];
    const id1 = abrir();
    assert.match(automatica(id1).Texto, /Recebemos seu chamado com sucesso\.\n\nSua solicitação foi registrada/);
    assert.equal(automatica(id1).Perfil, 'Sistema');
    assert(enviados.some(m => m.subject.includes(id1) && /Recebemos seu chamado com sucesso/.test(m.htmlBody)), 'The opening e-mail carries the automatic reply.');
    const aviso = avisosEquipe()[0];
    assert(aviso, 'Team is notified during business hours.');
    assert(aviso.to.includes('n1@innomaker.com.br'));
    assert(!aviso.to.includes('software@innomaker.com.br'), 'Only Admin and N1.');

    // Outside business hours: reply M01; team e-mail waits in the queue
    configurar({ DIAS_FUNCIONAMENTO: String((hoje + 1) % 7) });
    enviados = [];
    const id2 = abrir();
    const id3 = abrir();
    assert.match(automatica(id2).Texto, /fora do nosso horário de funcionamento/);
    assert.equal(avisosEquipe().length, 0, 'No team e-mail outside business hours.');
    assert.equal(run('configuracoes', 'admin').automatico.avisosNaFila, 2);
    assert.equal(run('configuracoes', 'admin').automatico.codigo, 'M01');
    run('rotinaHoraria');
    assert.equal(avisosEquipe().length, 0, 'Still closed: the queue waits.');

    // Business opens: one summary with every queued ticket, then the queue is empty
    configurar({ DIAS_FUNCIONAMENTO: '0,1,2,3,4,5,6' });
    enviados = [];
    run('rotinaHoraria');
    const resumo = avisosEquipe();
    assert.equal(resumo.length, 1);
    assert.match(resumo[0].subject, /2 chamados recebidos fora do horário/);
    assert(resumo[0].htmlBody.includes(id2) && resumo[0].htmlBody.includes(id3));
    assert.equal(run('configuracoes', 'admin').automatico.avisosNaFila, 0);

    // High volume: more active tickets than the limit → M03
    configurar({ LIMITE_ALTO_VOLUME: '2' });
    assert.match(automatica(abrir()).Texto, /volume elevado de atendimentos/);
    // Turned off: no automatic reply
    configurar({ MENSAGEM_AUTOMATICA: 'NAO' });
    assert.equal(automatica(abrir()), undefined);
  }

  // Validation
  assert.throws(() => configurar({ DIAS_FUNCIONAMENTO: '' }), /pelo menos um dia/);
  assert.throws(() => configurar({ LIMITE_ALTO_VOLUME: '0' }), /entre 1 e 1000/);
  assert.throws(() => configurar({ MSG_M02: '   ' }), /não pode ficar vazia/);
  configurar({ MSG_M02: '{saudacao}, {SAUDACAO}! Linha 1\nLinha 2' });
  assert.equal(run('mensagemAutomatica_', 'M02', new Date(2026, 9, 19, 14, 0)), 'Boa tarde, Boa tarde! Linha 1\nLinha 2');
} finally { console.log = log; }
log('OK: tabela de decisão M01/M02/M03, saudação, horário e feriados, aviso a Admin e N1 só no expediente, fila e resumo, alto volume e validação.');
