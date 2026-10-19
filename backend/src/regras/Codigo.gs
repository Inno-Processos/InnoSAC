/**
 * SAC Innomaker — portal de chamados para todos os projetos
 * Google Planilhas (banco de dados) + Apps Script (app web) + Gmail (avisos) + Drive (anexos)
 *
 * Instalação resumida:
 *  1. Crie uma planilha nova no Google Planilhas e abra Extensões > Apps Script.
 *  2. Cole este arquivo em "Codigo.gs" e crie um arquivo HTML chamado "Index" com o conteúdo de Index.html.
 *  3. Em Configurações do projeto, defina o fuso horário "(GMT-03:00) São Paulo".
 *  4. Selecione a função instalar() e clique em Executar. Autorize as permissões pedidas.
 *  5. Implantar > Nova implantação > App da Web. Executar como: Eu. Quem pode acessar: Qualquer pessoa.
 *  6. Copie a URL que termina em /exec e cole na aba Config, chave URL_APP.
 *  7. Abra a aba de execução (Ver > Registros) ou seu e-mail: estão lá o login "admin", a senha
 *     temporária e os logins criados para cada pasta de projeto encontrada na pasta geral.
 */

// ───────────────────────── Constantes ─────────────────────────

const STATUS = {
  ABERTO: 'Aberto',
  TRIAGEM: 'Em triagem',
  ATENDIMENTO: 'Em atendimento',
  AGUARDANDO: 'Aguardando cliente',
  ENCAMINHADO: 'Encaminhado ao setor',
  RESOLVIDO: 'Resolvido',
  FECHADO: 'Fechado',
  CANCELADO: 'Cancelado'
};
const LISTA_STATUS = Object.keys(STATUS).map(function (k) { return STATUS[k]; });
const FINAIS = [STATUS.FECHADO, STATUS.CANCELADO];
const SETORES = ['Software', 'Comercial', 'Financeiro'];

function setores_() {
  let extras = [];
  try { extras = JSON.parse(PropertiesService.getScriptProperties().getProperty('PERFIS_PERSONALIZADOS') || '[]'); } catch (e) { }
  return SETORES.concat(Array.isArray(extras) ? extras : []);
}

function perfisEquipe_() { return ['Admin', 'N1'].concat(setores_()); }

function listarPerfisEquipe(token) {
  exigirAdmin_(sessao_(token));
  return perfisEquipe_().map(function (nome) {
    return { nome: nome, fixo: ['Admin', 'N1'].concat(SETORES).indexOf(nome) >= 0 };
  });
}

function criarPerfilEquipe(token, nome) {
  const eu = exigirAdmin_(sessao_(token));
  nome = limpa_(nome, 60);
  if (!nome || /[\r\n]/.test(nome)) throw new Error('Informe um nome para o perfil.');
  return comTrava_(function () {
    if (perfisEquipe_().concat(['Cliente', 'Sistema', 'Equipe', 'Todos']).some(function (p) { return p.toLowerCase() === nome.toLowerCase(); })) throw new Error('Esse nome de perfil já existe ou é reservado.');
    const extras = setores_().filter(function (p) { return SETORES.indexOf(p) < 0; });
    extras.push(nome);
    PropertiesService.getScriptProperties().setProperty('PERFIS_PERSONALIZADOS', JSON.stringify(extras));
    auditar_(eu, 'Perfil criado', nome);
    return { nome: nome, setores: setores_() };
  });
}

function excluirPerfilEquipe(token, nome) {
  const eu = exigirAdmin_(sessao_(token));
  return comTrava_(function () {
    if (['Admin', 'N1'].concat(SETORES).indexOf(nome) >= 0) throw new Error('Os perfis padrão não podem ser excluídos.');
    if (setores_().indexOf(nome) < 0) throw new Error('Perfil não encontrado.');
    if (ler_('Equipe').some(function (m) { return String(m.Perfil) === nome; })) throw new Error('Há pessoas usando esse perfil. Altere o perfil dessas pessoas antes de excluir.');
    if (ler_('Chamados').some(function (c) { return String(c.Setor) === nome && FINAIS.indexOf(c.Status) < 0; })) throw new Error('Há chamados em andamento nesse setor. Encaminhe-os a outro setor antes de excluir.');
    const extras = setores_().filter(function (p) { return SETORES.indexOf(p) < 0 && p !== nome; });
    PropertiesService.getScriptProperties().setProperty('PERFIS_PERSONALIZADOS', JSON.stringify(extras));
    auditar_(eu, 'Perfil excluído', nome);
    return 'Perfil excluído.';
  });
}

// O que o N1 pode fazer a partir de cada status (encaminhar tem função própria)
const TRANSICOES_N1 = {
  'Aberto': ['Em triagem', 'Em atendimento', 'Cancelado'],
  'Em triagem': ['Em atendimento', 'Aguardando cliente', 'Resolvido', 'Cancelado'],
  'Em atendimento': ['Aguardando cliente', 'Resolvido', 'Cancelado'],
  'Aguardando cliente': ['Em atendimento', 'Resolvido', 'Cancelado'],
  'Encaminhado ao setor': ['Em atendimento', 'Cancelado'],
  'Resolvido': ['Em atendimento'],
  'Fechado': [],
  'Cancelado': []
};
const PODE_ENCAMINHAR = ['Aberto', 'Em triagem', 'Em atendimento', 'Aguardando cliente', 'Encaminhado ao setor'];

const ABAS = {
  Config: ['Chave', 'Valor', 'Descricao'],
  Equipe: ['Email', 'Nome', 'Perfil', 'Login', 'SenhaHash', 'Sal', 'TrocarSenha', 'Ativo', 'UltimoAcesso',
    'SenhaTempHash', 'SenhaTempSal', 'SenhaTempExpira'],
  Projetos: ['ProjetoId', 'Projeto', 'PastaId', 'Responsavel', 'Email', 'Telefone', 'Login', 'SenhaHash', 'Sal',
    'TrocarSenha', 'Ativo', 'CriadoEm', 'UltimoAcesso', 'NomePreferido', 'Modulos', 'SenhaTempHash', 'SenhaTempSal', 'SenhaTempExpira'],
  Chamados: ['Id', 'ProjetoId', 'Projeto', 'Usuario', 'Email', 'Abertura', 'Canal', 'Categoria', 'Modulo',
    'Titulo', 'Descricao', 'Bloqueio', 'Prioridade', 'Setor', 'Status', 'UltimaAtualizacao',
    'UltimaMudancaStatus', 'Prazo', 'AvisoAtrasoEnviado', 'ResolvidoEm', 'FechadoEm', 'FechadoPor',
    'PastaId', 'Reaberturas', 'MotivoCancelamento'],
  Historico: ['Chamado', 'DataHora', 'Autor', 'Perfil', 'Tipo', 'Texto', 'Visivel', 'Ref'],
  Leituras: ['Chave', 'Chamado', 'Email', 'Canal', 'LidoEm'], // Email guarda o login de quem leu
  Anexos: ['Chamado', 'DataHora', 'Autor', 'Nome', 'ArquivoId', 'Tamanho', 'Visivel'],
  Pesquisa: ['Chamado', 'DataHora', 'Nota', 'Resolvido', 'Comentario'],
  Feriados: ['Data', 'Descricao'],
  Manuais: ['Titulo', 'Descricao', 'Link', 'Ordem', 'Projeto', 'Publico', 'ArquivoId', 'Id'], // Projeto vazio = todos; Publico: Clientes, Equipe ou Todos
  Categorias: ['Categoria'],
  Auditoria: ['DataHora', 'Login', 'Perfil', 'Acao', 'Detalhe']
};

const CONFIG_PADRAO = [
  ['NOME_SISTEMA', 'Innomaker', 'Nome do SAC no portal e nos e-mails (vale para todos os projetos)'],
  ['PASTA_GERAL_ID', '1SCQQuXBj7wZfbr-72Lp5OtFyPYrjXu30', 'ID da pasta geral do Drive com uma pasta para cada projeto'],
  ['TELEFONE', '(21) 97317-6148', 'Telefone do rodapé "Prefere ligar?" e dos e-mails'],
  ['EMAIL_ADMIN', 'tecnico.innomaker@gmail.com', 'E-mail que recebe os pedidos de "Esqueci minha senha" e os avisos de projetos novos'],
  ['RODAPE_TEXTO', 'Segunda a sexta, das 9h às 16h, exceto feriados.', 'Texto que aparece no rodapé, abaixo do telefone (pode deixar vazio)'],
  ['URL_APP', '', 'Endereço onde o SAC está acessível. Ex.: http://localhost:3000 ou https://sac.suaempresa.com.br. Usado nos links dos e-mails.'],
  ['URL_PORTAL', '', 'Opcional: outro endereço de entrada para o SAC. Deixe vazio para usar o endereço principal.'],
  ['HORA_INICIO', 9, 'Início do atendimento (hora cheia)'],
  ['HORA_FIM', 16, 'Fim do atendimento (hora cheia)'],
  ['PRAZO_NORMAL_DIAS_UTEIS', 3, 'Prazo de solução da prioridade Normal'],
  ['PRAZO_BLOQUEIO_DIAS_UTEIS', 1, 'Prazo de solução da prioridade Bloqueio (A DEFINIR pela equipe; aceita 0,5)'],
  ['DIAS_UTEIS_AUTOFECHAMENTO', 5, 'Dias úteis sem resposta do cliente até o sistema fechar'],
  ['DIAS_UTEIS_REABERTURA', 5, 'Dias úteis que o cliente tem para reabrir depois de fechado'],
  ['NOTIFICAR_EQUIPE', 'SIM', 'SIM = o N1 recebe e-mail a cada chamado novo e resposta do cliente'],
  ['BUSCAR_PROJETOS_NOVOS', 'SIM', 'SIM = a cada hora, toda pasta nova na pasta geral vira um projeto com login']
];
const NUMERICOS = ['HORA_INICIO', 'HORA_FIM', 'PRAZO_NORMAL_DIAS_UTEIS', 'PRAZO_BLOQUEIO_DIAS_UTEIS',
  'DIAS_UTEIS_AUTOFECHAMENTO', 'DIAS_UTEIS_REABERTURA'];

const CATEGORIAS_PADRAO = ['Dúvida', 'Erro (bug)', 'Melhoria', 'Treinamento', 'Configuração', 'Financeiro/Contrato'];
// Só o projeto 4.2.22 (Software ERP Linave & Servinave) tem módulos; os demais projetos não pedem módulo
const MODULOS_LINAVE = ['Financeiro', 'Suprimentos', 'Compras', 'Comercial', 'Cadastros', 'Relatórios', 'Outro'];
function ehProjetoLinave_(nome) { return /4\.2\.22|linave|servinave/i.test(String(nome || '')); }

function nomeProjetoCliente_(nome) {
  const original = String(nome || '').trim();
  return original.replace(/^\d+(?:\.\d+)*(?:\s*[-–—]\s*|\s+)/, '').trim() || original;
}

function modulosDoProjeto_(pj) {
  return detalhesModulos_(pj && pj.Modulos).map(function (m) { return m.nome; });
}

function detalhesModulos_(valor) {
  let lista = valor;
  if (!Array.isArray(lista)) {
    const texto = String(valor || '');
    try { lista = JSON.parse(texto); } catch (e) { lista = texto.split(/[\n;,]+/); }
    if (!Array.isArray(lista)) lista = texto.split(/[\n;,]+/);
  }
  const vistos = Object.create(null);
  return lista.map(function (m) {
    const item = { nome: limpa_(typeof m === 'string' ? m : m && m.nome, 60), descricao: limpa_(m && m.descricao, 1000) };
    if (item.descricao && !item.nome) throw new Error('Informe o nome de cada módulo que tem descrição.');
    return item;
  }).filter(function (m) {
    if (!m.nome || vistos[m.nome.toLowerCase()]) return false;
    vistos[m.nome.toLowerCase()] = true;
    return true;
  });
}

// ───────────────────────── Instalação ─────────────────────────

function instalar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Abra o Apps Script pela planilha (Extensões > Apps Script) e rode de novo.');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('SEGREDO')) props.setProperty('SEGREDO', Utilities.getUuid() + Utilities.getUuid());

  Object.keys(ABAS).forEach(function (nome) {
    let sh = ss.getSheetByName(nome);
    if (!sh) sh = ss.insertSheet(nome);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, ABAS[nome].length).setValues([ABAS[nome]])
        .setFontWeight('bold').setBackground('#41a639').setFontColor('#0f2a0d');
      sh.setFrozenRows(1);
    } else {
      garantirCabecalho_(sh, ABAS[nome]);
    }
  });

  semear_('Config', CONFIG_PADRAO);
  comTrava_(function () {
    const atuais = ler_('Config');
    const antigos = { TELEFONE: ['(00) 0000-0000', ''], NOME_SISTEMA: ['ERP-Linave', ''] };
    CONFIG_PADRAO.forEach(function (l) {
      const linha = atuais.filter(function (x) { return String(x.Chave).trim() === l[0]; })[0];
      if (!linha) { inserir_('Config', { Chave: l[0], Valor: l[1], Descricao: l[2] }); return; }
      if (antigos[l[0]] && antigos[l[0]].indexOf(String(linha.Valor).trim()) >= 0) atualizar_('Config', linha._linha, { Valor: l[1] });
    });
  });
  semear_('Categorias', CATEGORIAS_PADRAO.map(function (c) { return [c]; }));
  semear_('Manuais', [['Manual do usuário', 'Visão geral do sistema (troque pelo link real em Configurações > Manuais)', 'https://cole-aqui-o-link-do-manual', 1, '', 'Clientes', '', Utilities.getUuid().slice(0, 8)]]);
  semear_('Feriados', feriadosPadrao_());

  ['Página1', 'Planilha1', 'Sheet1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  _cfg = null;
  const relatorioAcessos = [];
  const temAdmin = ler_('Equipe').some(function (m) { return String(m.Perfil).trim().toLowerCase() === 'admin'; });
  if (!temAdmin) {
    const eu = Session.getEffectiveUser().getEmail();
    const conta = comTrava_(function () { return criarMembro_({ nome: 'Administrador', email: eu, perfil: 'Admin', login: 'admin' }); });
    relatorioAcessos.push(['Admin', conta.login, conta.senha]);
  }
  pastaGeral_();
  comTrava_(sincronizarProjetos_).forEach(function (n) { relatorioAcessos.push([n.projeto, n.login, n.senha]); });
  comTrava_(function () {
    ler_('Manuais').forEach(function (m) { if (!m.Id) atualizar_('Manuais', m._linha, { Id: Utilities.getUuid().slice(0, 8) }); });
    ler_('Projetos').forEach(function (pj) {
      if (ehProjetoLinave_(pj.Projeto) && !String(pj.Modulos || '').trim()) atualizar_('Projetos', pj._linha, { Modulos: MODULOS_LINAVE.join('\n') });
    });
  });

  criarGatilhos_();

  if (relatorioAcessos.length) {
    relatorioAcessos.forEach(function (l) { Logger.log(l[0] + ' → login: ' + l[1] + ' | senha temporária: ' + l[2]); });
    enviarEmail_(Session.getEffectiveUser().getEmail(), 'Logins criados no SAC', tabelaAcessos_(relatorioAcessos));
  }
  Logger.log('Instalado. Confira o endereço do SAC em Configurações > Geral.');
}

/**
 * Esqueceu a senha do admin? Rode esta função no editor do Apps Script (só o dono do projeto consegue).
 * A nova senha temporária aparece no Registro de execução e chega no seu e-mail.
 */
function redefinirSenhaAdmin() {
  const r = comTrava_(function () {
    const m = ler_('Equipe').filter(function (x) { return String(x.Perfil).trim().toLowerCase() === 'admin'; })[0];
    if (!m) return criarMembro_({ nome: 'Administrador', email: Session.getEffectiveUser().getEmail(), perfil: 'Admin', login: 'admin' });
    const senha = novaSenha_();
    atualizar_('Equipe', m._linha, Object.assign(camposSenha_(senha, true), { Ativo: 'SIM' }));
    return { login: normLogin_(m.Login), senha: senha };
  });
  CacheService.getScriptCache().remove('falhas:' + r.login);
  esquecerPerfil_(r.login);
  Logger.log('Login do admin: ' + r.login + ' | senha temporária: ' + r.senha + ' (troque no primeiro acesso)');
  enviarEmail_(Session.getEffectiveUser().getEmail(), 'Nova senha do admin do SAC', tabelaAcessos_([['Admin', r.login, r.senha]]));
}

function tabelaAcessos_(linhas) {
  return '<p>Estes são os acessos criados. Cada pessoa troca a senha temporária no primeiro login.</p>' +
    '<table style="border-collapse:collapse;font-size:14px">' +
    '<tr><th style="text-align:left;padding:4px 10px">Acesso</th><th style="text-align:left;padding:4px 10px">Login</th><th style="text-align:left;padding:4px 10px">Senha temporária</th></tr>' +
    linhas.map(function (l) {
      return '<tr><td style="padding:4px 10px;border-top:1px solid #d6e1d4">' + esc_(l[0]) + '</td><td style="padding:4px 10px;border-top:1px solid #d6e1d4"><b>' +
        esc_(l[1]) + '</b></td><td style="padding:4px 10px;border-top:1px solid #d6e1d4;font-family:monospace">' + esc_(l[2]) + '</td></tr>';
    }).join('') + '</table>' + botao_('Acessar o SAC', linkEntrada_());
}

function criarGatilhos_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return ['rotinaHoraria', 'backupDiario'].indexOf(t.getHandlerFunction()) >= 0; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('rotinaHoraria').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('backupDiario').timeBased().everyDays(1).atHour(2).create();
}

// ───────────────────────── Backup diário (cópia da planilha no Meu Drive do dono, guarda 15) ─────────────────────────

function pastaBackups_() {
  const nome = 'SC - Backups do SAC';
  const raiz = DriveApp.getRootFolder();
  const it = raiz.getFoldersByName(nome);
  return it.hasNext() ? it.next() : raiz.createFolder(nome);
}

function backupDiario() {
  const pasta = pastaBackups_();
  const nome = 'Backup SAC ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm');
  DriveApp.getFileById(ss_().getId()).makeCopy(nome, pasta);
  const arquivos = [];
  const it = pasta.getFiles();
  while (it.hasNext()) arquivos.push(it.next());
  arquivos.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); })
    .slice(15).forEach(function (f) { f.setTrashed(true); });
  PropertiesService.getScriptProperties().setProperty('ULTIMO_BACKUP', new Date().toISOString());
  return nome;
}

// ───────────────────────── Auditoria ─────────────────────────

function auditar_(p, acao, detalhe) {
  try {
    inserir_('Auditoria', { DataHora: new Date(), Login: p ? p.login || '' : '', Perfil: p ? p.perfil || '' : '', Acao: acao, Detalhe: limpa_(detalhe, 500) });
  } catch (e) { console.error('Auditoria: ' + e.message); }
}

function resumoArgs_(args) {
  const lista = Array.prototype.slice.call(args, 1);
  return JSON.stringify(lista, function (k, v) {
    if (k === 'b64') return '[arquivo]';
    if (/senha/i.test(k)) return '***';
    return v;
  }).slice(0, 500);
}

function garantirCabecalho_(sh, cab) {
  const atual = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  let ultima = atual.filter(String).length;
  cab.forEach(function (c) {
    if (atual.indexOf(c) >= 0) return;
    ultima++;
    sh.getRange(1, ultima).setValue(c).setFontWeight('bold').setBackground('#41a639').setFontColor('#0f2a0d');
    atual[ultima - 1] = c;
  });
}

function semear_(nome, linhas) {
  const sh = aba_(nome);
  if (sh.getLastRow() > 1 || !linhas.length) return;
  sh.getRange(2, 1, linhas.length, linhas[0].length).setValues(linhas);
}

function feriadosPadrao_() {
  const d = function (a, m, dia) { return new Date(a, m - 1, dia); };
  return [
    [d(2026, 11, 2), 'Finados'], [d(2026, 11, 20), 'Consciência Negra'], [d(2026, 12, 25), 'Natal'],
    [d(2027, 1, 1), 'Confraternização Universal'], [d(2027, 2, 8), 'Carnaval (ponto facultativo: apague se houver expediente)'],
    [d(2027, 2, 9), 'Carnaval (ponto facultativo: apague se houver expediente)'], [d(2027, 3, 26), 'Sexta-feira Santa'],
    [d(2027, 4, 21), 'Tiradentes'], [d(2027, 5, 1), 'Dia do Trabalho'], [d(2027, 5, 27), 'Corpus Christi'],
    [d(2027, 9, 7), 'Independência'], [d(2027, 10, 12), 'Nossa Senhora Aparecida'], [d(2027, 11, 2), 'Finados'],
    [d(2027, 11, 15), 'Proclamação da República'], [d(2027, 11, 20), 'Consciência Negra'], [d(2027, 12, 25), 'Natal']
  ];
}

// ───────────────────────── App web ─────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('SAC')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // permite incorporar no Google Sites ou no site da empresa
}

// ───────────────────────── Planilha ─────────────────────────

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function aba_(nome) {
  const sh = ss_().getSheetByName(nome);
  if (!sh) throw new Error('Aba "' + nome + '" não encontrada. Rode a função instalar().');
  return sh;
}

function ler_(nome) {
  const valores = aba_(nome).getDataRange().getValues();
  const cab = valores.shift() || [];
  return valores.map(function (linha, i) {
    const o = { _linha: i + 2 };
    cab.forEach(function (c, j) { o[c] = linha[j]; });
    return o;
  });
}

// Força texto em toda string gravada: evita fórmulas injetadas e conversões automáticas (datas, números)
function seguro_(v) {
  return (typeof v === 'string' && v !== '') ? "'" + v : v;
}

// Grava pela ordem real das colunas da aba (funciona mesmo se colunas novas foram acrescentadas no fim)
const _cab = {};
function cabecalho_(nome) {
  if (_cab[nome]) return _cab[nome];
  const sh = aba_(nome);
  _cab[nome] = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  return _cab[nome];
}

function inserir_(nome, obj) {
  aba_(nome).appendRow(cabecalho_(nome).map(function (c) { return seguro_(obj[c] === undefined ? '' : obj[c]); }));
}

function atualizar_(nome, linha, campos) {
  const cab = cabecalho_(nome);
  const rg = aba_(nome).getRange(linha, 1, 1, cab.length);
  const row = rg.getValues()[0];
  Object.keys(campos).forEach(function (k) {
    const j = cab.indexOf(k);
    if (j >= 0) row[j] = campos[k];
  });
  rg.setValues([row.map(seguro_)]);
}

function comTrava_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function pub_(o) {
  return JSON.parse(JSON.stringify(o, function (k, v) { return k === '_linha' ? undefined : v; }));
}

// ───────────────────────── Configuração ─────────────────────────

let _cfg = null;
let _feriados = null;

function cfg_() {
  if (_cfg) return _cfg;
  const o = {};
  const padrao = {};
  CONFIG_PADRAO.forEach(function (l) { o[l[0]] = l[1]; padrao[l[0]] = l[1]; });
  try {
    ler_('Config').forEach(function (l) { if (l.Chave) o[String(l.Chave).trim()] = l.Valor; });
  } catch (e) { /* planilha ainda não instalada */ }
  NUMERICOS.forEach(function (k) {
    const n = Number(String(o[k]).replace(',', '.'));
    o[k] = (o[k] === '' || isNaN(n)) ? Number(padrao[k]) : n;
  });
  o.NOME_SISTEMA = String(o.NOME_SISTEMA || 'Innomaker');
  if (/^erp[\s-]*linave$/i.test(o.NOME_SISTEMA.trim())) o.NOME_SISTEMA = 'Innomaker';
  o.TELEFONE = String(o.TELEFONE || '');
  _cfg = o;
  return o;
}

function horasDia_() { return cfg_().HORA_FIM - cfg_().HORA_INICIO; }

function urlApp_() {
  return String(cfg_().URL_APP || '') || ScriptApp.getService().getUrl() || '';
}

function urlHttpValida_(valor) {
  return /^https?:\/\/[^\s\/?#@]+(?:[\/?#][^\s]*)?$/i.test(String(valor || ''));
}

function lista_(aba, campo, padrao) {
  try {
    const v = ler_(aba).map(function (l) { return String(l[campo] || '').trim(); }).filter(String);
    return v.length ? v : padrao;
  } catch (e) { return padrao; }
}

// ───────────────────────── Dias úteis (9h–16h, sem fim de semana e feriados) ─────────────────────────

function fmtDia_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

function feriados_() {
  if (_feriados) return _feriados;
  const s = {};
  try {
    ler_('Feriados').forEach(function (l) {
      let d = l.Data;
      if (!(d instanceof Date)) {
        const m = String(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        d = m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
      }
      if (d) s[fmtDia_(d)] = true;
    });
  } catch (e) { }
  _feriados = s;
  return s;
}

function ehDiaUtil_(d) {
  const w = d.getDay();
  return w !== 0 && w !== 6 && !feriados_()[fmtDia_(d)];
}

function proximoInicioUtil_(d) {
  const x = new Date(d);
  x.setHours(cfg_().HORA_INICIO, 0, 0, 0);
  do { x.setDate(x.getDate() + 1); } while (!ehDiaUtil_(x));
  return x;
}

function normalizarInicio_(d) {
  const c = cfg_();
  const x = new Date(d);
  if (!ehDiaUtil_(x) || x.getHours() >= c.HORA_FIM) return proximoInicioUtil_(x);
  if (x.getHours() < c.HORA_INICIO) x.setHours(c.HORA_INICIO, 0, 0, 0);
  return x;
}

function somarHorasUteis_(inicio, horas) {
  let d = normalizarInicio_(inicio);
  let restante = horas * 60;
  for (let guarda = 0; guarda < 400; guarda++) {
    const fim = new Date(d);
    fim.setHours(cfg_().HORA_FIM, 0, 0, 0);
    const disponivel = (fim.getTime() - d.getTime()) / 60000;
    if (restante <= disponivel) return new Date(d.getTime() + restante * 60000);
    restante -= disponivel;
    d = proximoInicioUtil_(d);
  }
  return d;
}

function somarDiasUteis_(inicio, dias) { return somarHorasUteis_(inicio, dias * horasDia_()); }

function horasUteisEntre_(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date) || b <= a) return 0;
  const c = cfg_();
  let total = 0;
  const dia = new Date(a);
  dia.setHours(0, 0, 0, 0);
  while (dia <= b) {
    if (ehDiaUtil_(dia)) {
      const ini = new Date(dia); ini.setHours(c.HORA_INICIO, 0, 0, 0);
      const fim = new Date(dia); fim.setHours(c.HORA_FIM, 0, 0, 0);
      const s = Math.max(ini.getTime(), a.getTime());
      const e = Math.min(fim.getTime(), b.getTime());
      if (e > s) total += e - s;
    }
    dia.setDate(dia.getDate() + 1);
  }
  return total / 3600000;
}

function calcularPrazo_(inicio, prioridade) {
  const c = cfg_();
  return somarDiasUteis_(inicio, prioridade === 'Bloqueio' ? c.PRAZO_BLOQUEIO_DIAS_UTEIS : c.PRAZO_NORMAL_DIAS_UTEIS);
}

// ───────────────────────── Acesso (código por e-mail) ─────────────────────────

function normEmail_(e) { return String(e || '').trim().toLowerCase(); }

function ativo_(v) {
  const s = String(v).trim().toUpperCase();
  return s === '' || s === 'SIM' || s === 'S' || s === 'TRUE';
}

function normLogin_(l) { return String(l || '').trim().toLowerCase(); }

function slugLogin_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 40);
}

function hashSenha_(senha, sal) {
  const D = Utilities.DigestAlgorithm.SHA_256;
  const salBytes = Utilities.newBlob(String(sal)).getBytes();
  let b = Utilities.computeDigest(D, String(sal) + ':' + String(senha), Utilities.Charset.UTF_8);
  for (let i = 0; i < 300; i++) b = Utilities.computeDigest(D, b.concat(salBytes));
  return Utilities.base64Encode(b);
}

function novaSenha_() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const u = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 10; i++) s += a[parseInt(u.substr(i * 2, 2), 16) % a.length];
  return s;
}

function validarNovaSenha_(s) {
  s = String(s || '');
  if (s.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) throw new Error('Use letras e números na senha.');
}

function camposSenha_(senha, trocar) {
  const sal = Utilities.getUuid();
  return { SenhaHash: hashSenha_(senha, sal), Sal: sal, TrocarSenha: trocar ? 'SIM' : 'NAO' };
}

function loginsUsados_() {
  const u = {};
  ler_('Equipe').concat(ler_('Projetos')).forEach(function (l) { if (l.Login) u[normLogin_(l.Login)] = true; });
  return u;
}

function loginLivre_(base, desejado, atual) {
  const usados = loginsUsados_();
  if (atual) delete usados[normLogin_(atual)];
  if (desejado) {
    const l = normLogin_(desejado);
    if (!/^[a-z0-9._-]{3,40}$/.test(l)) throw new Error('O login deve ter de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.');
    if (usados[l]) throw new Error('O login "' + l + '" já está em uso.');
    return l;
  }
  const b = slugLogin_(base) || 'projeto';
  let l = b, n = 2;
  while (usados[l]) l = b + n++;
  return l;
}

function contaPorLogin_(login) {
  login = normLogin_(login);
  if (!login) return null;
  const m = ler_('Equipe').filter(function (l) { return normLogin_(l.Login) === login; })[0];
  if (m) return { aba: 'Equipe', linha: m };
  const pj = ler_('Projetos').filter(function (l) { return normLogin_(l.Login) === login; })[0];
  return pj ? { aba: 'Projetos', linha: pj } : null;
}

function perfilDaConta_(conta) {
  const l = conta.linha;
  if (!ativo_(l.Ativo)) return null;
  const login = normLogin_(l.Login);
  if (conta.aba === 'Equipe') {
    const perfil = perfisEquipe_().filter(function (p) { return p.toLowerCase() === String(l.Perfil).trim().toLowerCase(); })[0];
    if (!perfil) return null;
    return { tipo: 'equipe', login: login, email: normEmail_(l.Email), nome: String(l.Nome || login), perfil: perfil };
  }
  return {
    tipo: 'cliente', login: login, email: normEmail_(l.Email), nome: String(l.NomePreferido || l.Responsavel || nomeProjetoCliente_(l.Projeto)), perfil: 'Cliente',
    nomePreferido: String(l.NomePreferido || ''),
    projetoId: String(l.ProjetoId), projeto: String(l.Projeto)
  };
}

function identificar_(login) {
  const c = contaPorLogin_(login);
  return c ? perfilDaConta_(c) : null;
}

function esquecerPerfil_(login) { CacheService.getScriptCache().remove('perfil:' + normLogin_(login)); }

function entrar(login, senha) {
  login = normLogin_(login);
  const cache = CacheService.getScriptCache();
  const kf = 'falhas:' + login;
  const falhas = Number(cache.get(kf) || 0);
  if (falhas >= 5) throw new Error('Muitas tentativas erradas. Espere 15 minutos ou use "Esqueci minha senha".');
  const conta = contaPorLogin_(login);
  const ok = conta && conta.linha.SenhaHash &&
    hashSenha_(String(senha || ''), String(conta.linha.Sal)) === String(conta.linha.SenhaHash);
  const temp = !ok && conta && conta.linha.SenhaTempHash && conta.linha.SenhaTempExpira instanceof Date &&
    conta.linha.SenhaTempExpira > new Date() &&
    hashSenha_(String(senha || ''), String(conta.linha.SenhaTempSal)) === String(conta.linha.SenhaTempHash);
  if (temp) {
    comTrava_(function () {
      atualizar_(conta.aba, conta.linha._linha, {
        SenhaHash: conta.linha.SenhaTempHash, Sal: conta.linha.SenhaTempSal, TrocarSenha: 'SIM',
        SenhaTempHash: '', SenhaTempSal: '', SenhaTempExpira: ''
      });
    });
    conta.linha.TrocarSenha = 'SIM';
  }
  if (!ok && !temp) {
    cache.put(kf, String(falhas + 1), 900);
    auditar_({ login: login, perfil: conta ? (conta.aba === 'Equipe' ? 'Equipe' : 'Cliente') : '?' }, 'Login recusado', 'Tentativa ' + (falhas + 1));
    throw new Error('Login ou senha incorretos.');
  }
  const p = perfilDaConta_(conta);
  if (!p) throw new Error('Este acesso está desativado. Fale com o atendimento.');
  cache.remove(kf);
  esquecerPerfil_(login);
  auditar_(p, 'Login', '');
  atualizar_(conta.aba, conta.linha._linha, { UltimoAcesso: new Date() });
  const trocar = String(conta.linha.TrocarSenha).toUpperCase() === 'SIM';
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('sess:' + token, JSON.stringify({ login: login, trocar: trocar }), 21600);
  return { token: token, trocarSenha: trocar };
}

function sair(token) {
  if (token) CacheService.getScriptCache().remove('sess:' + token);
  return true;
}

function sessaoBruta_(token) {
  const bruto = token ? CacheService.getScriptCache().get('sess:' + token) : null;
  if (!bruto) throw new Error('SESSAO_EXPIRADA');
  try { return JSON.parse(bruto); } catch (e) { throw new Error('SESSAO_EXPIRADA'); }
}

function sessao_(token) {
  const s = sessaoBruta_(token);
  if (s.trocar) throw new Error('TROCAR_SENHA');
  const cache = CacheService.getScriptCache();
  const guardado = cache.get('perfil:' + s.login);
  if (guardado) return JSON.parse(guardado);
  const p = identificar_(s.login);
  if (!p) throw new Error('SESSAO_EXPIRADA');
  cache.put('perfil:' + s.login, JSON.stringify(p), 300);
  return p;
}

function trocarSenha(token, atual, nova) {
  const s = sessaoBruta_(token);
  const conta = contaPorLogin_(s.login);
  if (!conta || hashSenha_(String(atual || ''), String(conta.linha.Sal)) !== String(conta.linha.SenhaHash)) {
    throw new Error('A senha atual não confere.');
  }
  validarNovaSenha_(nova);
  if (nova === atual) throw new Error('A nova senha precisa ser diferente da atual.');
  comTrava_(function () { atualizar_(conta.aba, conta.linha._linha, camposSenha_(nova, false)); });
  s.trocar = false;
  CacheService.getScriptCache().put('sess:' + token, JSON.stringify(s), 21600);
  return true;
}

// ───────────────────────── Login pelo Authelia/LLDAP ─────────────────────────
// O backend confirma a sessão com o Authelia (cookie authelia_session) e chama entrarExterno_; o navegador não chega aqui.
// Os grupos do LLDAP definem o acesso: sac_admin, sac_n1 e sac_<setor> para a equipe,
// sac_projeto_<login do projeto> para os clientes. Quem não está em nenhum grupo sac_ não entra.

function grupoLldap_(nome) { return 'sac_' + slugLogin_(nome).replace(/\./g, '_'); }

function entrarExterno_(id) {
  id = id || {};
  const usuario = normLogin_(id.usuario);
  if (!usuario) throw new Error('O Authelia não informou o usuário.');
  const grupos = (Array.isArray(id.grupos) ? id.grupos : []).map(function (g) { return String(g).trim().toLowerCase(); });
  const email = normEmail_(id.email);
  const nome = limpa_(id.nome, 120) || usuario;
  // Na ordem de perfisEquipe_: quem está em sac_admin e sac_n1 fica Admin
  const perfil = perfisEquipe_().filter(function (p) { return grupos.indexOf(grupoLldap_(p)) >= 0; })[0];
  const login = comTrava_(function () {
    const membro = ler_('Equipe').filter(function (m) { return normLogin_(m.Login) === usuario; })[0];
    if (perfil) {
      const campos = { Nome: nome, Email: email, Perfil: perfil, Ativo: 'SIM', UltimoAcesso: new Date() };
      if (membro) atualizar_('Equipe', membro._linha, campos);
      else {
        if (loginsUsados_()[usuario]) throw new Error('O usuário "' + usuario + '" do LLDAP tem o mesmo nome do login de um projeto. Renomeie um dos dois.');
        inserir_('Equipe', Object.assign({ Login: usuario }, campos));
      }
      return usuario;
    }
    if (membro && ativo_(membro.Ativo)) { // saiu dos grupos da equipe: as sessões abertas param de valer
      atualizar_('Equipe', membro._linha, { Ativo: 'NAO' });
      esquecerPerfil_(usuario);
    }
    const projetos = ler_('Projetos').filter(function (pj) { return pj.Login && grupos.indexOf(grupoLldap_('projeto ' + pj.Login)) >= 0; });
    if (projetos.length > 1) throw new Error('Seu usuário está em mais de um grupo de projeto (sac_projeto_...). Fale com o atendimento.');
    if (!projetos.length) return null;
    const pj = projetos[0];
    // O primeiro acesso preenche o cadastro do projeto com os dados do LLDAP
    const campos = { UltimoAcesso: new Date() };
    if (!pj.Email && email) campos.Email = email;
    if (!pj.NomePreferido && id.nome) campos.NomePreferido = limpa_(id.nome, 60);
    atualizar_('Projetos', pj._linha, campos);
    return normLogin_(pj.Login);
  });
  if (!login) {
    auditar_({ login: usuario, perfil: '?' }, 'Login recusado', 'Authelia: nenhum grupo sac_ (' + grupos.join(', ') + ')');
    throw new Error('Seu usuário "' + usuario + '" ainda não tem acesso ao SAC. Peça ao administrador para incluí-lo num grupo sac_ no LLDAP.');
  }
  esquecerPerfil_(login);
  const p = identificar_(login);
  if (!p) throw new Error('Este acesso está desativado. Fale com o atendimento.');
  auditar_(p, 'Login', 'Authelia: ' + usuario);
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('sess:' + token, JSON.stringify({ login: login, trocar: false, sso: usuario }), 21600);
  return { token: token };
}

function emailAdmin_() {
  const e = normEmail_(cfg_().EMAIL_ADMIN);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : 'tecnico.innomaker@gmail.com';
}

function garantirColunas_(nome) {
  garantirCabecalho_(aba_(nome), ABAS[nome]);
  delete _cab[nome];
}

/**
 * "Esqueci minha senha": a pessoa informa só o e-mail.
 * Se o e-mail estiver salvo num acesso que já foi ativado (a pessoa já entrou, criou a própria senha
 * e cadastrou o e-mail), o sistema envia para ele uma senha temporária que vale 24 horas.
 * No primeiro acesso não há recuperação: quem envia a primeira senha é o administrador.
 * A senha atual continua valendo até a pessoa entrar com a temporária, então pedir em nome
 * de outra pessoa não tranca o acesso dela. Um mesmo e-mail pode estar em mais de um projeto:
 * nesse caso o e-mail traz uma senha para cada login.
 */
function esqueciSenha(email) {
  email = normEmail_(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Digite o e-mail que você cadastrou no seu acesso.');
  const resposta = 'Se este e-mail estiver cadastrado em um acesso já ativado, enviamos para ele uma senha temporária que vale por 24 horas. ' +
    'Confira também o spam. Primeiro acesso? Use a senha que o administrador enviou para você.';
  const cache = CacheService.getScriptCache();
  if (cache.get('pedido-senha:' + email)) return resposta;
  const globais = Number(cache.get('pedido-senha:total') || 0);
  if (globais >= 30) throw new Error('Muitos pedidos agora. Tente de novo em alguns minutos ou ligue para o atendimento.');
  cache.put('pedido-senha:' + email, '1', 900);
  cache.put('pedido-senha:total', String(globais + 1), 600);

  const contas = [];
  ['Equipe', 'Projetos'].forEach(function (nome) {
    ler_(nome).forEach(function (l) {
      if (normEmail_(l.Email) !== email || !l.Login) return;
      contas.push({ aba: nome, linha: l, ativa: ativo_(l.Ativo), primeiroAcesso: String(l.TrocarSenha).toUpperCase() === 'SIM' });
    });
  });
  const elegiveis = contas.filter(function (c) { return c.ativa && !c.primeiroAcesso; });

  const enviados = [];
  if (elegiveis.length) {
    ['Equipe', 'Projetos'].forEach(garantirColunas_);
    comTrava_(function () {
      elegiveis.forEach(function (c) {
        const senha = novaSenha_();
        const sal = Utilities.getUuid();
        atualizar_(c.aba, c.linha._linha, { SenhaTempHash: hashSenha_(senha, sal), SenhaTempSal: sal, SenhaTempExpira: new Date(Date.now() + 24 * 3600000) });
        enviados.push({
          login: normLogin_(c.linha.Login), senha: senha,
          acesso: c.aba === 'Projetos' ? nomeProjetoCliente_(c.linha.Projeto) : 'Equipe (' + c.linha.Perfil + ')',
          nome: c.aba === 'Projetos' ? String(c.linha.NomePreferido || c.linha.Responsavel || nomeProjetoCliente_(c.linha.Projeto)) : String(c.linha.Nome)
        });
        CacheService.getScriptCache().remove('falhas:' + normLogin_(c.linha.Login));
      });
    });
    const linhas = enviados.map(function (e) {
      return '<tr><td style="padding:6px 12px 6px 0">' + esc_(e.acesso) + '</td><td style="padding:6px 12px 6px 0"><b>' + esc_(e.login) +
        '</b></td><td style="padding:6px 0;font-family:monospace;font-size:17px;letter-spacing:1px"><b>' + esc_(e.senha) + '</b></td></tr>';
    }).join('');
    enviarEmail_(email, 'Sua senha temporária do SAC',
      '<p>Olá, ' + esc_(enviados[0].nome) + '.</p><p>Recebemos um pedido de nova senha para ' + (enviados.length > 1 ? 'os acessos ligados a este e-mail' : 'o seu acesso') + ':</p>' +
      '<table style="border-collapse:collapse;font-size:14px"><tr><th style="text-align:left;padding:4px 12px 4px 0;color:#5b6b5a">Acesso</th>' +
      '<th style="text-align:left;padding:4px 12px 4px 0;color:#5b6b5a">Login</th><th style="text-align:left;padding:4px 0;color:#5b6b5a">Senha temporária</th></tr>' + linhas + '</table>' +
      '<p style="color:#5b6b5a">Vale por 24 horas. Entre com o login e a senha temporária: o sistema pede para você criar uma senha nova.</p>' +
      '<p>Se não foi você, ignore este e-mail: a sua senha atual continua funcionando.</p>' + botao_('Entrar no SAC', linkEntrada_()));
  }

  const semAtivar = contas.filter(function (c) { return c.ativa && c.primeiroAcesso; });
  const desativadas = contas.filter(function (c) { return !c.ativa; });
  auditar_({ login: email, perfil: 'Recuperação' }, 'Pedido de nova senha',
    enviados.length ? 'Enviada para: ' + enviados.map(function (e) { return e.login; }).join(', ')
      : (contas.length ? 'Sem envio (primeiro acesso pendente ou acesso desativado)' : 'E-mail não cadastrado'));
  enviarEmail_(emailAdmin_(), (enviados.length ? 'Senha temporária enviada — ' : 'Pedido de nova senha sem envio — ') + email,
    '<p>Alguém pediu uma nova senha informando o e-mail <b>' + esc_(email) + '</b>.</p>' +
    (enviados.length ? '<p>Senha temporária enviada automaticamente para os logins: <b>' + esc_(enviados.map(function (e) { return e.login; }).join(', ')) + '</b>. Nada a fazer.</p>' : '') +
    (semAtivar.length ? '<p>Logins que ainda não fizeram o primeiro acesso (sem recuperação; envie a primeira senha em Projetos ou Equipe &gt; Nova senha): <b>' +
      esc_(semAtivar.map(function (c) { return c.linha.Login; }).join(', ')) + '</b>.</p>' : '') +
    (desativadas.length ? '<p>Acessos desativados com este e-mail: <b>' + esc_(desativadas.map(function (c) { return c.linha.Login; }).join(', ')) + '</b>.</p>' : '') +
    (!contas.length ? '<p>Este e-mail não está cadastrado em nenhum acesso. Nenhuma senha foi enviada.</p>' : '') +
    botao_('Abrir o SAC', linkEntrada_()));
  return resposta;
}

function ehN1_(p) { return p.tipo === 'equipe' && (p.perfil === 'N1' || p.perfil === 'Admin'); }

function exigirN1_(p) {
  if (!ehN1_(p)) throw new Error('Somente o atendimento N1 ou o administrador pode fazer isso.');
  return p;
}

function exigirAdmin_(p) {
  if (p.tipo !== 'equipe' || p.perfil !== 'Admin') throw new Error('Somente o administrador pode fazer isso.');
  return p;
}

// ───────────────────────── Dados de início ─────────────────────────

function publicoDe_(m) {
  const v = String(m.Publico || '').trim().toLowerCase();
  return v === 'equipe' ? 'Equipe' : (v === 'todos' ? 'Todos' : 'Clientes');
}

// publico: 'cliente' (portal do projeto ou tela de login, com pj nulo) ou 'equipe'
function manualVisivel_(m, pj, publico) {
  const pub = publicoDe_(m);
  if (publico === 'equipe') return pub !== 'Clientes';
  if (pub === 'Equipe') return false;
  const alvo = String(m.Projeto || '').trim().toLowerCase();
  if (!alvo) return true;
  return !!pj && (alvo === String(pj.ProjetoId).toLowerCase() || alvo === String(pj.Projeto).toLowerCase());
}

function manuais_(pj, publico) {
  try {
    return ler_('Manuais').filter(function (m) {
      return m.Titulo && m.Link && manualVisivel_(m, pj, publico || 'cliente');
    })
      .sort(function (a, b) { return Number(a.Ordem || 99) - Number(b.Ordem || 99); })
      .map(function (m) { return { titulo: String(m.Titulo), descricao: String(m.Descricao || ''), link: String(m.Link), projeto: String(m.Projeto || '') }; });
  } catch (e) { return []; }
}

function dadosPublicos() {
  const c = cfg_();
  return {
    nome: c.NOME_SISTEMA, telefone: c.TELEFONE, rodape: String(c.RODAPE_TEXTO || ''), horaInicio: c.HORA_INICIO, horaFim: c.HORA_FIM
  };
}

function iniciar(token) {
  const p = sessao_(token);
  const c = cfg_();
  return {
    usuario: { tipo: p.tipo, nome: p.tipo === 'cliente' && p.nome === p.projeto ? nomeProjetoCliente_(p.nome) : p.nome, login: p.login, email: p.email, perfil: p.perfil, projeto: p.tipo === 'cliente' ? nomeProjetoCliente_(p.projeto) : (p.projeto || ''), admin: p.perfil === 'Admin', n1: ehN1_(p),
      cadastroIncompleto: p.tipo === 'cliente' && (!p.email || !p.nomePreferido) },
    categorias: lista_('Categorias', 'Categoria', CATEGORIAS_PADRAO),
    modulos: p.tipo === 'cliente' ? modulosDoProjeto_(projetoPorId_(p.projetoId)) : [],
    manuais: p.tipo === 'cliente' ? manuais_(projetoPorId_(p.projetoId), 'cliente') : manuais_(null, 'equipe'),
    status: LISTA_STATUS, setores: setores_(),
    prazoNormal: c.PRAZO_NORMAL_DIAS_UTEIS, diasAutoFechamento: c.DIAS_UTEIS_AUTOFECHAMENTO,
    diasReabertura: c.DIAS_UTEIS_REABERTURA
  };
}

// ───────────────────────── Chamados: utilitários ─────────────────────────

function limpa_(s, max) { return String(s === undefined || s === null ? '' : s).trim().slice(0, max || 5000); }

function obterChamado_(id) {
  const ch = ler_('Chamados').filter(function (c) { return String(c.Id) === String(id); })[0];
  if (!ch) throw new Error('Chamado ' + id + ' não encontrado.');
  return ch;
}

function podeVer_(p, ch) {
  if (p.tipo === 'cliente') return String(ch.ProjetoId) === String(p.projetoId);
  if (ehN1_(p)) return true;
  return ch.Setor === p.perfil && ch.Status === STATUS.ENCAMINHADO;
}

function exigirAcesso_(p, ch) {
  if (!podeVer_(p, ch)) throw new Error('Você não tem acesso a este chamado.');
}

function registrar_(chamado, p, tipo, texto, visivel, ref) {
  inserir_('Historico', {
    Chamado: chamado, DataHora: new Date(), Autor: p.nome, Perfil: p.perfil,
    Tipo: tipo, Texto: texto, Visivel: visivel ? 'SIM' : 'NAO', Ref: ref || ''
  });
  marcarVersaoChat_(chamado);
}

const SISTEMA = { nome: 'Sistema', perfil: 'Sistema' };

function mudarStatus_(ch, novo, p, extra) {
  const agora = new Date();
  const anterior = ch.Status;
  const campos = { Status: novo, UltimaMudancaStatus: agora, UltimaAtualizacao: agora };
  if (novo === STATUS.RESOLVIDO) campos.ResolvidoEm = agora;
  if (novo === STATUS.FECHADO) campos.FechadoEm = agora;
  Object.keys(extra || {}).forEach(function (k) { campos[k] = extra[k]; });
  atualizar_('Chamados', ch._linha, campos);
  Object.keys(campos).forEach(function (k) { ch[k] = campos[k]; });
  const destino = novo === STATUS.ENCAMINHADO ? novo + ' (' + ch.Setor + ')' : novo;
  registrar_(ch.Id, p, 'STATUS', anterior + ' → ' + destino, true);
  return ch;
}

function tocar_(ch) {
  const agora = new Date();
  atualizar_('Chamados', ch._linha, { UltimaAtualizacao: agora });
  ch.UltimaAtualizacao = agora;
}

function limiteReabertura_(ch) {
  return ch.FechadoEm instanceof Date ? somarDiasUteis_(ch.FechadoEm, cfg_().DIAS_UTEIS_REABERTURA) : null;
}

function limiteResposta_(ch) {
  return ch.UltimaMudancaStatus instanceof Date ? somarDiasUteis_(ch.UltimaMudancaStatus, cfg_().DIAS_UTEIS_AUTOFECHAMENTO) : null;
}

function pesquisaPendente_(ch, pesquisas) {
  if (ch.Status !== STATUS.FECHADO || !(ch.FechadoEm instanceof Date)) return false;
  const lista = pesquisas || ler_('Pesquisa');
  return !lista.some(function (r) {
    return String(r.Chamado) === String(ch.Id) && r.DataHora instanceof Date && r.DataHora.getTime() >= ch.FechadoEm.getTime();
  });
}

function chavePesquisa_(id) {
  const segredo = PropertiesService.getScriptProperties().getProperty('SEGREDO') || 'sem-segredo';
  const sig = Utilities.computeHmacSha256Signature(String(id), segredo);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '').slice(0, 24);
}

function resumo_(ch, p, pesquisas) {
  const agora = new Date();
  const r = {
    Id: ch.Id, Titulo: ch.Titulo, Status: ch.Status, Categoria: ch.Categoria, Modulo: ch.Modulo,
    Prioridade: ch.Prioridade, Abertura: ch.Abertura, UltimaAtualizacao: ch.UltimaAtualizacao, Prazo: ch.Prazo,
    atrasado: ch.Prazo instanceof Date && agora > ch.Prazo && FINAIS.indexOf(ch.Status) < 0 && ch.Status !== STATUS.RESOLVIDO
  };
  if (p.tipo === 'cliente') r.pesquisaPendente = pesquisaPendente_(ch, pesquisas);
  else { r.Projeto = ch.Projeto; r.Setor = ch.Setor; r.Canal = ch.Canal; }
  return pub_(r);
}

function acoes_(p, ch) {
  const ativo = FINAIS.indexOf(ch.Status) < 0;
  if (p.tipo === 'cliente') {
    return {
      responder: ativo,
      anexar: ativo,
      confirmar: ch.Status === STATUS.RESOLVIDO,
      reajuste: ch.Status === STATUS.RESOLVIDO,
      reabrir: ch.Status === STATUS.FECHADO && limiteReabertura_(ch) > new Date(),
      pesquisa: pesquisaPendente_(ch)
    };
  }
  if (ehN1_(p)) {
    return {
      transicoes: TRANSICOES_N1[ch.Status] || [], encaminhar: PODE_ENCAMINHAR.indexOf(ch.Status) >= 0,
      responder: ativo, nota: true, anexar: ativo, classificar: ativo
    };
  }
  return { devolver: ch.Status === STATUS.ENCAMINHADO, nota: true, anexar: true };
}

// ───────────────────────── Chamados: leitura ─────────────────────────

function meusChamados(token) {
  const p = sessao_(token);
  if (p.tipo !== 'cliente') throw new Error('Tela exclusiva do cliente.');
  const pesquisas = ler_('Pesquisa');
  const novas = naoLidas_(p);
  return ler_('Chamados')
    .filter(function (c) { return String(c.ProjetoId) === String(p.projetoId); })
    .sort(function (a, b) { return b.Abertura - a.Abertura; })
    .map(function (c) { const r = resumo_(c, p, pesquisas); r.naoLidas = novas[c.Id] || 0; return r; });
}

function filaEquipe(token) {
  const p = sessao_(token);
  if (p.tipo !== 'equipe') throw new Error('Tela exclusiva da equipe.');
  const novas = naoLidas_(p);
  const peso = function (c) { return FINAIS.indexOf(c.Status) >= 0 ? 2 : (c.Prioridade === 'Bloqueio' ? 0 : 1); };
  return ler_('Chamados')
    .filter(function (c) { return podeVer_(p, c); })
    .sort(function (a, b) {
      const d = peso(a) - peso(b);
      if (d) return d;
      return peso(a) === 2 ? b.Abertura - a.Abertura : a.Abertura - b.Abertura; // ativos: FIFO
    })
    .map(function (c) { const r = resumo_(c, p); r.naoLidas = novas[c.Id] || 0; return r; });
}

function detalheChamado(token, id) {
  const p = sessao_(token);
  const ch = obterChamado_(id);
  exigirAcesso_(p, ch);
  const equipe = p.tipo === 'equipe';
  const historico = itensChat_(p, id);
  const canais = canaisDe_(p);
  marcarLido_(p, id, canais[0]);
  const anexos = ler_('Anexos')
    .filter(function (a) { return String(a.Chamado) === String(id) && (equipe || String(a.Visivel).toUpperCase() === 'SIM'); })
    .map(function (a) { return pub_({ DataHora: a.DataHora, Autor: !equipe && a.Autor === p.projeto ? nomeProjetoCliente_(a.Autor) : a.Autor, Nome: a.Nome, ArquivoId: a.ArquivoId, Tamanho: a.Tamanho, interno: String(a.Visivel).toUpperCase() !== 'SIM' }); });

  const c = pub_(ch);
  delete c.PastaId; delete c.AvisoAtrasoEnviado;
  if (p.tipo === 'cliente') {
    delete c.ProjetoId;
    c.Projeto = nomeProjetoCliente_(ch.Projeto);
    if (c.Usuario === ch.Projeto) c.Usuario = c.Projeto;
  }
  if (p.tipo === 'equipe' && !ehN1_(p)) { delete c.Email; delete c.Usuario; }
  if (ehN1_(p)) {
    const pj = projetoPorId_(ch.ProjetoId);
    c.modulosProjeto = modulosDoProjeto_(pj);
    c.contato = pj ? { email: String(pj.Email || ''), telefone: String(pj.Telefone || ''), usuario: String(pj.Responsavel || ''), login: String(pj.Login) } : null;
  }
  return pub_({
    chamado: c, historico: historico, anexos: anexos, acoes: acoes_(p, ch),
    chat: { ver: versaoChat_(id), canais: canais, ladoOnline: ladoOnline_(id, p), podeEscreverCliente: p.tipo === 'cliente' || ehN1_(p) },
    limiteReabertura: ch.Status === STATUS.FECHADO ? limiteReabertura_(ch) : null,
    limiteResposta: [STATUS.AGUARDANDO, STATUS.RESOLVIDO].indexOf(ch.Status) >= 0 ? limiteResposta_(ch) : null
  });
}

// ───────────────────────── Chamados: abertura ─────────────────────────

function abrirChamado(token, d) {
  const p = sessao_(token);
  d = d || {};
  let cli, mods;
  if (p.tipo === 'cliente') {
    if (!p.email) throw new Error('Cadastre e confirme o seu e-mail em Meu cadastro antes de abrir um chamado: é por ele que você recebe os avisos.');
    cli = { ProjetoId: p.projetoId, Projeto: p.projeto, Usuario: p.nome, Email: p.email };
    mods = modulosDoProjeto_(projetoPorId_(p.projetoId));
  } else {
    exigirN1_(p);
    const pj = projetoPorId_(d.projetoId);
    if (!pj || !ativo_(pj.Ativo)) throw new Error('Escolha o projeto de quem ligou.');
    cli = { ProjetoId: pj.ProjetoId, Projeto: pj.Projeto, Usuario: pj.Responsavel || pj.Projeto, Email: pj.Email };
    mods = modulosDoProjeto_(pj);
  }
  const categoria = limpa_(d.categoria, 80);
  const modulo = mods.length ? limpa_(d.modulo, 80) : '';
  const titulo = limpa_(d.titulo, 150);
  const descricao = limpa_(d.descricao, 20000);
  const bloqueio = d.bloqueio === 'Sim' ? 'Sim' : (d.bloqueio === 'Não' ? 'Não' : '');
  if (lista_('Categorias', 'Categoria', CATEGORIAS_PADRAO).indexOf(categoria) < 0) throw new Error('Escolha a categoria.');
  if (mods.length && mods.indexOf(modulo) < 0) throw new Error('Escolha o módulo do sistema.');
  if (!titulo) throw new Error('Escreva um título.');
  if (!descricao) throw new Error('Descreva o que aconteceu.');
  if (!bloqueio) throw new Error('Responda se o sistema está bloqueado.');

  const ch = comTrava_(function () {
    const agora = new Date();
    const prioridade = bloqueio === 'Sim' ? 'Bloqueio' : 'Normal';
    const novo = {
      Id: novoId_(), ProjetoId: String(cli.ProjetoId), Projeto: String(cli.Projeto), Usuario: String(cli.Usuario),
      Email: normEmail_(cli.Email), Abertura: agora, Canal: p.tipo === 'cliente' ? 'Site' : 'Telefone',
      Categoria: categoria, Modulo: modulo, Titulo: titulo, Descricao: descricao, Bloqueio: bloqueio,
      Prioridade: prioridade, Setor: '', Status: STATUS.ABERTO, UltimaAtualizacao: agora,
      UltimaMudancaStatus: agora, Prazo: calcularPrazo_(agora, prioridade), Reaberturas: 0
    };
    inserir_('Chamados', novo);
    registrar_(novo.Id, p, 'STATUS', 'Chamado aberto (' + novo.Canal + ')', true);
    return novo;
  });

  emailStatus_(ch);
  notificarN1_((ch.Prioridade === 'Bloqueio' ? '[BLOQUEIO] ' : '') + 'Novo chamado ' + ch.Id + ' — ' + ch.Projeto,
    '<p><b>' + esc_(ch.Projeto) + '</b> abriu o chamado <b>' + ch.Id + '</b>: ' + esc_(ch.Titulo) + '.</p>' +
    '<p>Categoria: ' + esc_(ch.Categoria) + (ch.Modulo ? ' · Módulo: ' + esc_(ch.Modulo) : '') + ' · Sistema bloqueado: ' + ch.Bloqueio + '</p>', ch.Id);
  return ch.Id;
}

function novoId_() {
  const ano = new Date().getFullYear();
  const props = PropertiesService.getScriptProperties();
  const chave = 'SEQ_' + ano;
  const n = Number(props.getProperty(chave) || 0) + 1;
  props.setProperty(chave, String(n));
  return 'SAC-' + ano + '-' + String(n).padStart(6, '0');
}

// ───────────────────────── Chamados: ações do cliente ─────────────────────────

function responder(token, id, texto) {
  const p = sessao_(token);
  texto = limpa_(texto, 20000);
  if (!texto) throw new Error('Escreva a mensagem.');
  if (p.tipo === 'equipe' && !ehN1_(p)) throw new Error('Os setores falam com o cliente pelo N1. Use uma nota interna.');

  const r = comTrava_(function () {
    const ch = obterChamado_(id);
    exigirAcesso_(p, ch);
    if (!acoes_(p, ch).responder) throw new Error('Este chamado não aceita mensagens no status "' + ch.Status + '".');
    registrar_(ch.Id, p, 'MENSAGEM', texto, true);
    let mudou = false;
    if (p.tipo === 'cliente' && ch.Status === STATUS.AGUARDANDO) { mudarStatus_(ch, STATUS.ATENDIMENTO, p); mudou = true; }
    else tocar_(ch);
    return { ch: ch, mudou: mudou };
  });

  if (p.tipo === 'cliente') {
    if (r.mudou) emailStatus_(r.ch);
    if (!online_(r.ch.Id, 'n1') && podeAvisar_(r.ch.Id, 'n1')) {
      notificarN1_('Nova mensagem do cliente — ' + r.ch.Id, '<p>' + esc_(r.ch.Projeto) + ' escreveu no chat:</p>' + citacao_(texto), r.ch.Id);
    }
  } else if (!online_(r.ch.Id, 'cliente') && podeAvisar_(r.ch.Id, 'cliente')) {
    enviarEmail_(emailCliente_(r.ch), '[' + r.ch.Id + '] Nova mensagem no chat do chamado',
      '<p>Olá, ' + esc_(nomeCliente_(r.ch)) + '.</p><p>O atendimento escreveu no chat do chamado <b>' + r.ch.Id + '</b> — ' + esc_(r.ch.Titulo) + ':</p>' +
      citacao_(texto) + botao_('Abrir o chat', linkChamado_(r.ch.Id)));
  }
  return true;
}

function confirmarCorrecao(token, id) {
  const p = sessao_(token);
  const ch = comTrava_(function () {
    const ch = obterChamado_(id);
    exigirAcesso_(p, ch);
    if (p.tipo !== 'cliente' || ch.Status !== STATUS.RESOLVIDO) throw new Error('Só é possível confirmar chamados resolvidos.');
    registrar_(ch.Id, p, 'MENSAGEM', 'Cliente confirmou que a correção funcionou.', true);
    return mudarStatus_(ch, STATUS.FECHADO, p, { FechadoPor: 'Cliente' });
  });
  emailStatus_(ch);
  return true;
}

function solicitarReajuste(token, id, texto) {
  const p = sessao_(token);
  texto = limpa_(texto, 20000);
  if (!texto) throw new Error('Explique o que ainda não está certo.');
  const ch = comTrava_(function () {
    const ch = obterChamado_(id);
    exigirAcesso_(p, ch);
    if (p.tipo !== 'cliente' || ch.Status !== STATUS.RESOLVIDO) throw new Error('Só é possível pedir reajuste de chamados resolvidos.');
    registrar_(ch.Id, p, 'MENSAGEM', 'Reajuste solicitado: ' + texto, true);
    return mudarStatus_(ch, STATUS.ATENDIMENTO, p);
  });
  emailStatus_(ch);
  notificarN1_('Reajuste solicitado — ' + ch.Id, '<p>' + esc_(ch.Projeto) + ' pediu reajuste:</p>' + citacao_(texto), ch.Id);
  return true;
}

function reabrir(token, id, texto) {
  const p = sessao_(token);
  texto = limpa_(texto, 20000);
  if (!texto) throw new Error('Explique por que precisa reabrir.');
  const ch = comTrava_(function () {
    const ch = obterChamado_(id);
    exigirAcesso_(p, ch);
    if (p.tipo !== 'cliente' || ch.Status !== STATUS.FECHADO) throw new Error('Só é possível reabrir chamados fechados.');
    if (!(limiteReabertura_(ch) > new Date())) throw new Error('O prazo para reabrir terminou. Abra um novo chamado.');
    registrar_(ch.Id, p, 'MENSAGEM', 'Reaberto: ' + texto, true);
    const agora = new Date();
    return mudarStatus_(ch, STATUS.ATENDIMENTO, p, {
      Reaberturas: Number(ch.Reaberturas || 0) + 1, Prazo: calcularPrazo_(agora, ch.Prioridade), AvisoAtrasoEnviado: ''
    });
  });
  emailStatus_(ch);
  notificarN1_('Chamado reaberto — ' + ch.Id, '<p>' + esc_(ch.Projeto) + ' reabriu o chamado:</p>' + citacao_(texto), ch.Id);
  return true;
}

// ───────────────────────── Chamados: ações da equipe ─────────────────────────

function alterarStatus(token, id, novo, mensagem) {
  const p = exigirN1_(sessao_(token));
  mensagem = limpa_(mensagem, 20000);
  const ch = comTrava_(function () {
    const ch = obterChamado_(id);
    if ((TRANSICOES_N1[ch.Status] || []).indexOf(novo) < 0) throw new Error('Não é possível ir de "' + ch.Status + '" para "' + novo + '".');
    if ([STATUS.AGUARDANDO, STATUS.RESOLVIDO, STATUS.CANCELADO].indexOf(novo) >= 0 && !mensagem) {
      throw new Error('Escreva a mensagem ao cliente: o que falta, o que foi feito ou o motivo do cancelamento.');
    }
    const extra = {};
    if (novo === STATUS.CANCELADO) extra.MotivoCancelamento = mensagem;
    if (mensagem) registrar_(ch.Id, p, 'MENSAGEM', mensagem, true);
    return mudarStatus_(ch, novo, p, extra);
  });
  emailStatus_(ch, mensagem);
  return true;
}

function salvarClassificacao(token, id, d) {
  const p = exigirN1_(sessao_(token));
  d = d || {};
  const r = comTrava_(function () {
    const ch = obterChamado_(id);
    if (FINAIS.indexOf(ch.Status) >= 0) throw new Error('Chamado encerrado não pode ser reclassificado.');
    const campos = {};
    const mudancas = [];
    if (d.categoria && d.categoria !== ch.Categoria && lista_('Categorias', 'Categoria', CATEGORIAS_PADRAO).indexOf(d.categoria) >= 0) {
      campos.Categoria = d.categoria; mudancas.push('categoria: ' + d.categoria);
    }
    if (d.modulo && d.modulo !== ch.Modulo && modulosDoProjeto_(projetoPorId_(ch.ProjetoId)).indexOf(d.modulo) >= 0) {
      campos.Modulo = d.modulo; mudancas.push('módulo: ' + d.modulo);
    }
    if ((d.prioridade === 'Bloqueio' || d.prioridade === 'Normal') && d.prioridade !== ch.Prioridade) {
      campos.Prioridade = d.prioridade;
      campos.Prazo = calcularPrazo_(ch.Abertura, d.prioridade);
      campos.AvisoAtrasoEnviado = '';
      mudancas.push('prioridade: ' + d.prioridade);
    }
    const abrirTriagem = ch.Status === STATUS.ABERTO;
    if (!mudancas.length && !abrirTriagem) return { msg: 'Nada mudou.' };
    if (mudancas.length) {
      campos.UltimaAtualizacao = new Date();
      atualizar_('Chamados', ch._linha, campos);
      Object.keys(campos).forEach(function (k) { ch[k] = campos[k]; });
    }
    registrar_(ch.Id, p, 'NOTA_INTERNA', 'Triagem confirmada' + (mudancas.length ? ' — ' + mudancas.join(', ') : ''), false);
    if (abrirTriagem) mudarStatus_(ch, STATUS.TRIAGEM, p);
    return { msg: abrirTriagem ? 'Triagem confirmada. O chamado está em triagem e o cliente foi avisado.' : 'Triagem salva.', ch: abrirTriagem ? ch : null };
  });
  if (r.ch) emailStatus_(r.ch);
  return r.msg;
}

function encaminhar(token, id, setor, nota) {
  const p = exigirN1_(sessao_(token));
  nota = limpa_(nota, 20000);
  if (setores_().indexOf(setor) < 0) throw new Error('Escolha o setor.');
  if (!nota) throw new Error('Escreva o que o setor precisa fazer.');
  const r = comTrava_(function () {
    const ch = obterChamado_(id);
    if (PODE_ENCAMINHAR.indexOf(ch.Status) < 0) throw new Error('Não é possível encaminhar no status "' + ch.Status + '".');
    registrar_(ch.Id, p, 'NOTA_INTERNA', 'Para ' + setor + ': ' + nota, false);
    const mesmo = ch.Status === STATUS.ENCAMINHADO;
    if (mesmo) {
      atualizar_('Chamados', ch._linha, { Setor: setor, UltimaAtualizacao: new Date() });
      ch.Setor = setor;
    } else {
      ch.Setor = setor;
      mudarStatus_(ch, STATUS.ENCAMINHADO, p, { Setor: setor });
    }
    return { ch: ch, mesmo: mesmo };
  });
  if (!r.mesmo) emailStatus_(r.ch);
  const emails = emailsEquipe_(setor);
  if (emails.length) {
    enviarEmail_(emails.join(','), '[' + r.ch.Id + '] Encaminhado ao setor ' + setor,
      '<p>O N1 encaminhou o chamado <b>' + r.ch.Id + '</b> — ' + esc_(r.ch.Titulo) + '.</p>' + citacao_(nota) +
      botao_('Abrir chamado', linkChamado_(r.ch.Id)));
  }
  return true;
}

function devolverAoN1(token, id, nota) {
  const p = sessao_(token);
  nota = limpa_(nota, 20000);
  if (p.tipo !== 'equipe' || setores_().indexOf(p.perfil) < 0) throw new Error('Ação exclusiva dos setores.');
  if (!nota) throw new Error('Escreva o retorno para o N1.');
  const ch = comTrava_(function () {
    const ch = obterChamado_(id);
    exigirAcesso_(p, ch);
    registrar_(ch.Id, p, 'NOTA_INTERNA', 'Retorno de ' + p.perfil + ': ' + nota, false);
    return mudarStatus_(ch, STATUS.ATENDIMENTO, p);
  });
  emailStatus_(ch);
  notificarN1_('Retorno do setor ' + p.perfil + ' — ' + ch.Id, citacao_(nota), ch.Id, true);
  return true;
}

function notaInterna(token, id, texto) {
  const p = sessao_(token);
  texto = limpa_(texto, 20000);
  if (p.tipo !== 'equipe') throw new Error('Notas internas são só da equipe.');
  if (!texto) throw new Error('Escreva a nota.');
  const ch = comTrava_(function () {
    const ch = obterChamado_(id);
    exigirAcesso_(p, ch);
    registrar_(ch.Id, p, 'NOTA_INTERNA', texto, false);
    tocar_(ch);
    return ch;
  });
  if (!ehN1_(p) && !online_(ch.Id, 'n1') && podeAvisar_(ch.Id, 'n1-interno')) {
    notificarN1_('Chat interno (' + p.perfil + ') — ' + ch.Id, citacao_(texto), ch.Id, true);
  } else if (ehN1_(p) && ch.Status === STATUS.ENCAMINHADO && ch.Setor && !online_(ch.Id, 'setor') && podeAvisar_(ch.Id, 'setor')) {
    const emails = emailsEquipe_(ch.Setor);
    if (emails.length) enviarEmail_(emails.join(','), '[' + ch.Id + '] Nova mensagem do N1 no chat interno', citacao_(texto) + botao_('Abrir chamado', linkChamado_(ch.Id)));
  }
  return true;
}

// ───────────────────────── Chat do chamado ─────────────────────────
// Canal "cliente": mensagens entre cliente e N1. Canal "equipe": conversa interna entre N1 e setores.

function canaisDe_(p) {
  if (p.tipo === 'cliente') return ['cliente'];
  return ehN1_(p) ? ['cliente', 'equipe'] : ['equipe', 'cliente'];
}

function ladoDe_(p) { return p.tipo === 'cliente' ? 'cliente' : (ehN1_(p) ? 'n1' : 'setor'); }

function ehMeu_(p, h) {
  return p.tipo === 'cliente' ? h.Perfil === 'Cliente' : (h.Perfil === p.perfil && String(h.Autor) === p.nome);
}

function itensChat_(p, id) {
  const equipe = p.tipo === 'equipe';
  return ler_('Historico')
    .filter(function (h) { return String(h.Chamado) === String(id) && (equipe || String(h.Visivel).toUpperCase() === 'SIM'); })
    .map(function (h) {
      return pub_({ DataHora: h.DataHora, Autor: !equipe && h.Perfil === 'Cliente' && h.Autor === p.projeto ? nomeProjetoCliente_(h.Autor) : h.Autor, Perfil: h.Perfil, Tipo: h.Tipo, Texto: h.Texto,
        Ref: h.Ref || '', interno: String(h.Visivel).toUpperCase() !== 'SIM', meu: ehMeu_(p, h) });
    });
}

// Versão única a cada gravação (a hora em milissegundos podia se repetir e esconder mensagens novas)
function marcarVersaoChat_(id) { CacheService.getScriptCache().put('ver:' + id, Utilities.getUuid(), 21600); }

function versaoChat_(id) {
  const cache = CacheService.getScriptCache();
  let v = cache.get('ver:' + id);
  if (!v) { v = Utilities.getUuid(); cache.put('ver:' + id, v, 21600); }
  return v;
}

function online_(id, lado) { return !!CacheService.getScriptCache().get('online:' + id + ':' + lado); }

function ladoOnline_(id, p) {
  const lado = ladoDe_(p);
  if (lado === 'cliente') return { atendimento: online_(id, 'n1') };
  if (lado === 'n1') return { cliente: online_(id, 'cliente'), setor: online_(id, 'setor') };
  return { atendimento: online_(id, 'n1') };
}

function podeAvisar_(id, alvo) {
  const cache = CacheService.getScriptCache();
  const k = 'aviso:' + id + ':' + alvo;
  if (cache.get(k)) return false;
  cache.put(k, '1', 600);
  return true;
}

function acessoChat_(token, p, id) {
  const cache = CacheService.getScriptCache();
  const k = 'acesso:' + token.slice(0, 16) + ':' + id;
  if (cache.get(k)) return;
  exigirAcesso_(p, obterChamado_(id));
  cache.put(k, '1', 60);
}

/** Chamado a cada poucos segundos pela tela do chamado. Só lê a planilha quando há novidade. */
function chatAtualizar(token, id, desde, ver, digitandoCanal) {
  const p = sessao_(token);
  acessoChat_(token, p, id);
  const cache = CacheService.getScriptCache();
  cache.put('online:' + id + ':' + ladoDe_(p), '1', 30);
  if (digitandoCanal && canaisDe_(p).indexOf(digitandoCanal) >= 0) {
    cache.put('dig:' + id + ':' + digitandoCanal, JSON.stringify({ nome: p.tipo === 'cliente' ? p.nome : p.nome + ' (' + p.perfil + ')', quem: p.perfil + '|' + p.nome }), 8);
  }
  const digitando = {};
  canaisDe_(p).forEach(function (canal) {
    const d = cache.get('dig:' + id + ':' + canal);
    if (!d) return;
    const o = JSON.parse(d);
    if (o.quem !== p.perfil + '|' + p.nome) digitando[canal] = p.tipo === 'cliente' ? 'Atendimento' : o.nome;
  });
  const atual = versaoChat_(id);
  const r = { ver: atual, itens: [], total: Number(desde) || 0, digitando: digitando, online: ladoOnline_(id, p) };
  if (String(ver) === atual) return r;
  const todos = itensChat_(p, id);
  r.itens = todos.slice(Number(desde) || 0);
  r.total = todos.length;
  return r;
}

function enviarChat(token, id, canal, texto) {
  const p = sessao_(token);
  if (canal === 'equipe') return notaInterna(token, id, texto);
  return responder(token, id, texto);
}

function chatMarcarLido(token, id, canal) {
  const p = sessao_(token);
  acessoChat_(token, p, id);
  if (canaisDe_(p).indexOf(canal) < 0) return false;
  marcarLido_(p, id, canal);
  return true;
}

function marcarLido_(p, id, canal) {
  const chave = id + '|' + p.login + '|' + canal;
  comTrava_(function () {
    const l = ler_('Leituras').filter(function (x) { return String(x.Chave) === chave; })[0];
    if (l) atualizar_('Leituras', l._linha, { LidoEm: new Date() });
    else inserir_('Leituras', { Chave: chave, Chamado: id, Email: p.login, Canal: canal, LidoEm: new Date() });
  });
}

function naoLidas_(p) {
  const lidos = {};
  ler_('Leituras').forEach(function (l) {
    if (normLogin_(l.Email) === p.login) lidos[l.Chamado + '|' + l.Canal] = l.LidoEm;
  });
  const canais = p.tipo === 'cliente' ? ['cliente'] : (ehN1_(p) ? ['cliente', 'equipe'] : ['equipe']);
  const m = {};
  ler_('Historico').forEach(function (h) {
    const canal = h.Tipo === 'MENSAGEM' ? 'cliente' : (h.Tipo === 'NOTA_INTERNA' ? 'equipe' : null);
    if (!canal || canais.indexOf(canal) < 0 || !(h.DataHora instanceof Date) || ehMeu_(p, h)) return;
    if (p.tipo === 'cliente' && String(h.Visivel).toUpperCase() !== 'SIM') return;
    const lido = lidos[h.Chamado + '|' + canal];
    if (lido instanceof Date && h.DataHora <= lido) return;
    m[h.Chamado] = (m[h.Chamado] || 0) + 1;
  });
  return m;
}

// ───────────────────────── Anexos (Drive: SC - <projeto>/<id>/) ─────────────────────────

function pastaGeral_() {
  const id = String(cfg_().PASTA_GERAL_ID || '').trim();
  if (!id) throw new Error('Preencha PASTA_GERAL_ID na aba Config.');
  try { return DriveApp.getFolderById(id); }
  catch (e) { throw new Error('Sem acesso à pasta geral de projetos. A conta que instalou o SAC precisa ser editora dela.'); }
}

function pastaDoProjeto_(pj) {
  if (pj.PastaId) { try { return DriveApp.getFolderById(String(pj.PastaId)); } catch (e) { } }
  const pasta = pastaGeral_().createFolder(String(pj.Projeto));
  atualizar_('Projetos', pj._linha, { PastaId: pasta.getId() });
  return pasta;
}

function pastaChamado_(ch) {
  if (ch.PastaId) { try { return DriveApp.getFolderById(String(ch.PastaId)); } catch (e) { } }
  const pj = projetoPorId_(ch.ProjetoId);
  if (!pj) throw new Error('Projeto do chamado não encontrado.');
  const nomeSC = 'SC - ' + pj.Projeto;
  const projeto = pastaDoProjeto_(pj);
  const itSC = projeto.getFoldersByName(nomeSC);
  const sc = itSC.hasNext() ? itSC.next() : projeto.createFolder(nomeSC);
  const it = sc.getFoldersByName(String(ch.Id));
  const pasta = it.hasNext() ? it.next() : sc.createFolder(String(ch.Id));
  atualizar_('Chamados', ch._linha, { PastaId: pasta.getId() });
  return pasta;
}

function anexar(token, id, arquivo, interno) {
  const p = sessao_(token);
  if (!arquivo || !arquivo.b64) throw new Error('Arquivo vazio.');
  const nome = limpa_(arquivo.nome, 180).replace(/[\\/:*?"<>|]/g, '_') || 'arquivo';
  const ehInterno = p.tipo === 'equipe' && (interno === true || !ehN1_(p));
  return comTrava_(function () {
    const ch = obterChamado_(id);
    exigirAcesso_(p, ch);
    if (!acoes_(p, ch).anexar) throw new Error('Este chamado não aceita anexos no status "' + ch.Status + '".');
    const blob = Utilities.newBlob(Utilities.base64Decode(arquivo.b64), arquivo.tipo || 'application/octet-stream', nome);
    const f = pastaChamado_(ch).createFile(blob);
    inserir_('Anexos', {
      Chamado: ch.Id, DataHora: new Date(), Autor: p.nome, Nome: nome, ArquivoId: f.getId(),
      Tamanho: f.getSize(), Visivel: ehInterno ? 'NAO' : 'SIM'
    });
    registrar_(ch.Id, p, 'ANEXO', nome, !ehInterno, f.getId());
    tocar_(ch);
    return true;
  });
}

function baixarAnexo(token, id, arquivoId) {
  const p = sessao_(token);
  const ch = obterChamado_(id);
  exigirAcesso_(p, ch);
  const a = ler_('Anexos').filter(function (x) { return String(x.Chamado) === String(id) && String(x.ArquivoId) === String(arquivoId); })[0];
  if (!a || (p.tipo === 'cliente' && String(a.Visivel).toUpperCase() !== 'SIM')) throw new Error('Anexo não encontrado.');
  const blob = DriveApp.getFileById(String(arquivoId)).getBlob();
  return { nome: String(a.Nome), tipo: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
}

// ───────────────────────── Pesquisa de satisfação ─────────────────────────

function dadosPesquisa(id, chave) {
  if (!chave || chave !== chavePesquisa_(id)) throw new Error('Link de pesquisa inválido.');
  const ch = obterChamado_(id);
  return { id: ch.Id, titulo: String(ch.Titulo), pendente: pesquisaPendente_(ch), nome: cfg_().NOME_SISTEMA };
}

function responderPesquisa(cred, id, nota, resolvido, comentario) {
  cred = cred || {};
  const ch = obterChamado_(id);
  let ok = !!cred.chave && cred.chave === chavePesquisa_(id);
  if (!ok && cred.token) {
    const p = sessao_(cred.token);
    ok = p.tipo === 'cliente' && podeVer_(p, ch);
  }
  if (!ok) throw new Error('Não foi possível validar a pesquisa.');
  nota = Number(nota);
  if (!(nota >= 1 && nota <= 5)) throw new Error('Escolha uma nota de 1 a 5.');
  comTrava_(function () {
    const atual = obterChamado_(id);
    if (atual.Status !== STATUS.FECHADO) throw new Error('A pesquisa abre quando o chamado é fechado.');
    if (!pesquisaPendente_(atual)) throw new Error('Esta pesquisa já foi respondida. Obrigado!');
    inserir_('Pesquisa', {
      Chamado: atual.Id, DataHora: new Date(), Nota: nota, Resolvido: resolvido === 'Não' ? 'Não' : 'Sim',
      Comentario: limpa_(comentario, 3000)
    });
    registrar_(atual.Id, SISTEMA, 'PESQUISA', 'Pesquisa de satisfação respondida', true);
  });
  return true;
}

// ───────────────────────── Meu cadastro (o cliente mantém nome e e-mail) ─────────────────────────

function projetoDoUsuario_(p) {
  if (p.tipo !== 'cliente') throw new Error('Tela exclusiva do projeto.');
  const pj = projetoPorId_(p.projetoId);
  if (!pj) throw new Error('Projeto não encontrado.');
  return pj;
}

function meuCadastro(token) {
  const p = sessao_(token);
  const pj = projetoDoUsuario_(p);
  return {
    projeto: nomeProjetoCliente_(pj.Projeto), login: String(pj.Login), nomePreferido: String(pj.NomePreferido || ''),
    responsavel: String(pj.Responsavel || ''), email: normEmail_(pj.Email), telefone: String(pj.Telefone || '')
  };
}

function salvarMeuNome(token, nome, telefone) {
  const p = sessao_(token);
  nome = limpa_(nome, 60);
  if (!nome) throw new Error('Escreva como você prefere ser chamado.');
  comTrava_(function () {
    const pj = projetoDoUsuario_(p);
    const campos = { NomePreferido: nome };
    if (telefone !== undefined) campos.Telefone = limpa_(telefone, 40);
    atualizar_('Projetos', pj._linha, campos);
  });
  esquecerPerfil_(p.login);
  return 'Pronto. Os e-mails vão chegar com "Olá, ' + nome + '."';
}

function pedirTrocaEmail(token, novo) {
  const p = sessao_(token);
  novo = normEmail_(novo);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(novo)) throw new Error('Digite um e-mail válido.');
  const pj = projetoDoUsuario_(p);
  if (normEmail_(pj.Email) === novo) throw new Error('Este já é o e-mail cadastrado.');
  const cache = CacheService.getScriptCache();
  if (cache.get('email-espera:' + p.login)) throw new Error('Aguarde um minuto para pedir outro código.');
  cache.put('email-espera:' + p.login, '1', 60);
  const codigo = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 10), 16) % 1000000).padStart(6, '0');
  cache.put('email-troca:' + p.login, JSON.stringify({ email: novo, c: codigo, t: 0 }), 900);
  enviarEmail_(novo, 'Confirme seu e-mail no SAC',
    '<p>Olá, ' + esc_(p.nomePreferido || p.nome) + '.</p><p>Use este código para confirmar este e-mail como o contato do projeto <b>' +
    esc_(nomeProjetoCliente_(pj.Projeto)) + '</b>. Ele vale por 15 minutos.</p>' +
    '<p style="font-size:28px;letter-spacing:6px;font-weight:bold">' + codigo + '</p>' +
    '<p>Se você não pediu, ignore este e-mail.</p>');
  return 'Enviamos um código para ' + novo + '. Confira também a caixa de spam.';
}

function confirmarTrocaEmail(token, codigo) {
  const p = sessao_(token);
  const cache = CacheService.getScriptCache();
  const bruto = cache.get('email-troca:' + p.login);
  if (!bruto) throw new Error('Código expirado. Peça um novo.');
  const o = JSON.parse(bruto);
  if (o.t >= 5) { cache.remove('email-troca:' + p.login); throw new Error('Muitas tentativas. Peça um novo código.'); }
  if (String(codigo || '').trim() !== o.c) {
    o.t++;
    cache.put('email-troca:' + p.login, JSON.stringify(o), 900);
    throw new Error('Código incorreto.');
  }
  const antigo = comTrava_(function () {
    const pj = projetoDoUsuario_(p);
    const anterior = normEmail_(pj.Email);
    atualizar_('Projetos', pj._linha, { Email: o.email });
    return { email: anterior, projeto: String(pj.Projeto) };
  });
  cache.remove('email-troca:' + p.login);
  esquecerPerfil_(p.login);
  if (antigo.email) {
    enviarEmail_(antigo.email, 'O e-mail do projeto foi alterado no SAC',
      '<p>O e-mail de contato do projeto <b>' + esc_(antigo.projeto) + '</b> foi alterado para <b>' + esc_(o.email) +
      '</b>. Os próximos avisos vão para o novo endereço.</p><p>Se não foi você, fale com o atendimento pelo telefone ' + esc_(cfg_().TELEFONE) + '.</p>');
  }
  return 'E-mail confirmado. Os avisos agora vão para ' + o.email + '.';
}

// ───────────────────────── Configurações do sistema (admin) ─────────────────────────

const TIPOS_CONFIG = {
  HORA_INICIO: 'hora', HORA_FIM: 'hora', PRAZO_NORMAL_DIAS_UTEIS: 'dias', PRAZO_BLOQUEIO_DIAS_UTEIS: 'dias',
  DIAS_UTEIS_AUTOFECHAMENTO: 'dias', DIAS_UTEIS_REABERTURA: 'dias', NOTIFICAR_EQUIPE: 'simnao', BUSCAR_PROJETOS_NOVOS: 'simnao',
  URL_APP: 'url', URL_PORTAL: 'portal', PASTA_GERAL_ID: 'pasta', EMAIL_ADMIN: 'email'
};

function iso_(d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(d || ''); }

function configuracoes(token) {
  exigirAdmin_(sessao_(token));
  const atuais = {};
  ler_('Config').forEach(function (l) { if (l.Chave) atuais[String(l.Chave).trim()] = l.Valor; });
  return pub_({
    geral: CONFIG_PADRAO.map(function (l) {
      let v = atuais[l[0]] !== undefined ? atuais[l[0]] : l[1];
      if (l[0] === 'URL_APP' && !String(v || '').trim()) v = ScriptApp.getService().getUrl() || '';
      return { chave: l[0], valor: String(v === null ? '' : v), descricao: l[2], tipo: TIPOS_CONFIG[l[0]] || 'texto' };
    }),
    categorias: lista_('Categorias', 'Categoria', CATEGORIAS_PADRAO),
    perfis: listarPerfisEquipe(token),
    feriados: ler_('Feriados').filter(function (f) { return f.Data; })
      .map(function (f) { return { data: iso_(f.Data instanceof Date ? f.Data : null) || String(f.Data), descricao: String(f.Descricao || '') }; })
      .sort(function (a, b) { return a.data < b.data ? -1 : 1; }),
    manuais: ler_('Manuais').filter(function (m) { return m.Titulo; }).map(function (m) {
      return { id: String(m.Id || ''), titulo: String(m.Titulo), descricao: String(m.Descricao || ''), link: String(m.Link || ''),
        ordem: Number(m.Ordem || 99), projeto: String(m.Projeto || ''), publico: publicoDe_(m), arquivo: !!m.ArquivoId };
    }).sort(function (a, b) { return a.ordem - b.ordem; }),
    projetos: ler_('Projetos').map(function (pj) { return { id: String(pj.ProjetoId), nome: String(pj.Projeto), modulos: modulosDoProjeto_(pj), modulosDetalhes: detalhesModulos_(pj.Modulos) }; })
      .sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); }),
    linave: MODULOS_LINAVE
  });
}

function salvarConfiguracoes(token, valores) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Configurações gerais', resumoArgs_(arguments));
  valores = valores || {};
  const limpos = {};
  CONFIG_PADRAO.forEach(function (l) {
    const k = l[0];
    if (valores[k] === undefined) return;
    let v = String(valores[k]).trim();
    const tipo = TIPOS_CONFIG[k] || 'texto';
    if (tipo === 'hora') {
      const n = Number(v);
      if (!(n >= 0 && n <= 23) || Math.floor(n) !== n) throw new Error(k + ': use uma hora cheia de 0 a 23.');
      v = n;
    } else if (tipo === 'dias') {
      const n = Number(v.replace(',', '.'));
      if (!(n > 0 && n <= 60)) throw new Error(k + ': use um número de dias úteis entre 0,5 e 60.');
      v = n;
    } else if (tipo === 'simnao') {
      v = /^s/i.test(v) ? 'SIM' : 'NAO';
    } else if (tipo === 'email') {
      v = normEmail_(v);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('E-mail do administrador inválido.');
    } else if (tipo === 'portal' || tipo === 'url') {
      if (v && !urlHttpValida_(v)) throw new Error('Informe um endereço completo começando com http:// ou https://. Ex.: http://localhost:3000.');
    } else if (tipo === 'pasta') {
      const m = v.match(/folders\/([A-Za-z0-9_-]+)/);
      if (m) v = m[1];
      try { DriveApp.getFolderById(v).getName(); }
      catch (e) { throw new Error('PASTA_GERAL_ID: não consegui abrir essa pasta. A conta que instalou o SAC precisa ser editora dela.'); }
    } else {
      v = limpa_(v, 300);
      if (k === 'NOME_SISTEMA' && !v) throw new Error('Dê um nome ao SAC.');
    }
    limpos[k] = v;
  });
  const ini = limpos.HORA_INICIO !== undefined ? limpos.HORA_INICIO : cfg_().HORA_INICIO;
  const fim = limpos.HORA_FIM !== undefined ? limpos.HORA_FIM : cfg_().HORA_FIM;
  if (ini >= fim) throw new Error('O horário de início precisa ser antes do fim.');
  comTrava_(function () {
    const linhas = ler_('Config');
    Object.keys(limpos).forEach(function (k) {
      const l = linhas.filter(function (x) { return String(x.Chave).trim() === k; })[0];
      if (l) atualizar_('Config', l._linha, { Valor: limpos[k] });
      else {
        const d = CONFIG_PADRAO.filter(function (x) { return x[0] === k; })[0];
        inserir_('Config', { Chave: k, Valor: limpos[k], Descricao: d ? d[2] : '' });
      }
    });
  });
  _cfg = null; _feriados = null;
  return 'Configurações salvas.';
}

function reescreverAba_(nome, linhas) {
  const sh = aba_(nome);
  const n = cabecalho_(nome).length;
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, n).clearContent();
  if (linhas.length) sh.getRange(2, 1, linhas.length, n).setValues(linhas.map(function (l) {
    const r = l.map(seguro_);
    while (r.length < n) r.push('');
    return r;
  }));
}

function salvarCategorias(token, texto) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Categorias', resumoArgs_(arguments));
  const lista = limparModulos_(texto).split('\n').filter(String);
  if (!lista.length) throw new Error('Deixe pelo menos uma categoria.');
  comTrava_(function () { reescreverAba_('Categorias', lista.map(function (c) { return [c]; })); });
  return 'Categorias salvas.';
}

function salvarCategoria(token, nome, anterior) {
  const eu = exigirAdmin_(sessao_(token));
  nome = limpa_(nome, 80);
  if (!nome || /[\r\n]/.test(nome)) throw new Error('Informe o nome da categoria.');
  return comTrava_(function () {
    const lista = lista_('Categorias', 'Categoria', CATEGORIAS_PADRAO).slice();
    const indice = anterior === undefined || anterior === null ? -1 : lista.indexOf(String(anterior));
    if (anterior !== undefined && anterior !== null && indice < 0) throw new Error('Categoria não encontrada. Atualize a lista.');
    if (lista.some(function (c, i) { return i !== indice && c.toLowerCase() === nome.toLowerCase(); })) throw new Error('Já existe uma categoria com esse nome.');
    if (indice < 0) lista.push(nome); else lista[indice] = nome;
    reescreverAba_('Categorias', lista.map(function (c) { return [c]; }));
    auditar_(eu, indice < 0 ? 'Categoria criada' : 'Categoria editada', nome);
    return 'Categoria salva.';
  });
}

function excluirCategoria(token, nome) {
  const eu = exigirAdmin_(sessao_(token));
  return comTrava_(function () {
    const lista = lista_('Categorias', 'Categoria', CATEGORIAS_PADRAO);
    if (lista.indexOf(nome) < 0) throw new Error('Categoria não encontrada.');
    if (lista.length <= 1) throw new Error('Mantenha pelo menos uma categoria para os chamados.');
    reescreverAba_('Categorias', lista.filter(function (c) { return c !== nome; }).map(function (c) { return [c]; }));
    auditar_(eu, 'Categoria excluída', nome);
    return 'Categoria excluída.';
  });
}

function salvarFeriados(token, lista) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Feriados', resumoArgs_(arguments));
  const vistos = {};
  const linhas = (lista || []).map(function (f) {
    const m = String(f.data || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error('Data inválida: ' + f.data);
    return [new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), limpa_(f.descricao, 120)];
  }).filter(function (l) { const k = iso_(l[0]); if (vistos[k]) return false; vistos[k] = true; return true; })
    .sort(function (a, b) { return a[0] - b[0]; });
  comTrava_(function () { reescreverAba_('Feriados', linhas); });
  _feriados = null;
  return 'Feriados salvos. Os próximos prazos já consideram a lista nova.';
}

function salvarModulosProjeto(token, id, texto) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Módulos do projeto', resumoArgs_(arguments));
  return comTrava_(function () {
    const pj = projetoPorId_(id);
    if (!pj) throw new Error('Projeto não encontrado.');
    atualizar_('Projetos', pj._linha, { Modulos: serializarModulos_(texto) });
    return 'Módulos de ' + pj.Projeto + ' salvos.';
  });
}

function pastaManuais_() {
  const geral = pastaGeral_();
  const nome = 'SC - Manuais do SAC'; // "SC - " no início evita que vire projeto
  const it = geral.getFoldersByName(nome);
  return it.hasNext() ? it.next() : geral.createFolder(nome);
}

function salvarManual(token, d, arquivo) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Manual salvo', resumoArgs_(arguments));
  d = d || {};
  const titulo = limpa_(d.titulo, 150);
  if (!titulo) throw new Error('Dê um título ao manual.');
  const publico = ['Clientes', 'Equipe', 'Todos'].indexOf(d.publico) >= 0 ? d.publico : 'Clientes';
  let link = limpa_(d.link, 1000);
  let arquivoId = '';
  let aviso = '';
  if (arquivo && arquivo.b64) {
    const blob = Utilities.newBlob(Utilities.base64Decode(arquivo.b64), arquivo.tipo || 'application/pdf',
      limpa_(arquivo.nome, 180).replace(/[\\/:*?"<>|]/g, '_') || 'manual');
    const f = pastaManuais_().createFile(blob);
    try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
    catch (e) { aviso = ' Atenção: o Drive da empresa não deixou compartilhar por link; quem estiver fora da organização pode não conseguir abrir.'; }
    link = f.getUrl();
    arquivoId = f.getId();
  }
  if (!link) throw new Error('Cole o link do manual ou envie o arquivo.');
  if (!/^https?:\/\//i.test(link)) throw new Error('O link precisa começar com https://');
  comTrava_(function () {
    const campos = {
      Titulo: titulo, Descricao: limpa_(d.descricao, 300), Link: link, Ordem: Number(d.ordem) || 99,
      Projeto: limpa_(d.projeto, 150), Publico: publico
    };
    const atual = d.id ? ler_('Manuais').filter(function (m) { return String(m.Id) === String(d.id); })[0] : null;
    if (atual) {
      if (arquivoId) {
        if (atual.ArquivoId) { try { DriveApp.getFileById(String(atual.ArquivoId)).setTrashed(true); } catch (e) { } }
        campos.ArquivoId = arquivoId;
      } else if (link !== String(atual.Link)) campos.ArquivoId = '';
      atualizar_('Manuais', atual._linha, campos);
    } else {
      campos.Id = Utilities.getUuid().slice(0, 8);
      campos.ArquivoId = arquivoId;
      inserir_('Manuais', campos);
    }
  });
  return 'Manual salvo.' + aviso;
}

function excluirManual(token, id) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Manual excluído', resumoArgs_(arguments));
  comTrava_(function () {
    const m = ler_('Manuais').filter(function (x) { return String(x.Id) === String(id); })[0];
    if (!m) throw new Error('Manual não encontrado.');
    if (m.ArquivoId) { try { DriveApp.getFileById(String(m.ArquivoId)).setTrashed(true); } catch (e) { } }
    aba_('Manuais').deleteRow(m._linha);
  });
  return 'Manual excluído.';
}

function pascoa_(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

function feriadosNacionais_(ano) {
  const P = pascoa_(ano);
  const desloc = function (n) { return new Date(P.getFullYear(), P.getMonth(), P.getDate() + n); };
  const F = 'ponto facultativo: apague se houver expediente';
  return [
    [new Date(ano, 0, 1), 'Confraternização Universal'], [desloc(-48), 'Carnaval (' + F + ')'], [desloc(-47), 'Carnaval (' + F + ')'],
    [desloc(-2), 'Sexta-feira Santa'], [new Date(ano, 3, 21), 'Tiradentes'], [new Date(ano, 4, 1), 'Dia do Trabalho'],
    [desloc(60), 'Corpus Christi (' + F + ')'], [new Date(ano, 8, 7), 'Independência'], [new Date(ano, 9, 12), 'Nossa Senhora Aparecida'],
    [new Date(ano, 10, 2), 'Finados'], [new Date(ano, 10, 15), 'Proclamação da República'], [new Date(ano, 10, 20), 'Consciência Negra'],
    [new Date(ano, 11, 25), 'Natal']
  ];
}

function adicionarFeriadosNacionais(token, ano) {
  const eu = exigirAdmin_(sessao_(token));
  ano = Number(ano);
  if (!(ano >= 2024 && ano <= 2100)) throw new Error('Ano inválido.');
  auditar_(eu, 'Feriados nacionais adicionados', String(ano));
  _feriados = null;
  const existentes = feriados_();
  const novos = feriadosNacionais_(ano).filter(function (f) { return !existentes[fmtDia_(f[0])]; });
  comTrava_(function () { novos.forEach(function (f) { inserir_('Feriados', { Data: f[0], Descricao: f[1] }); }); });
  _feriados = null;
  return novos.length ? novos.length + ' feriados nacionais de ' + ano + ' adicionados. Inclua os estaduais e municipais.' : 'Os feriados nacionais de ' + ano + ' já estavam cadastrados.';
}

function situacaoSistema(token) {
  exigirAdmin_(sessao_(token));
  const c = cfg_();
  const itens = [];
  const add = function (ok, titulo, detalhe, acao) { itens.push({ ok: ok, titulo: titulo, detalhe: detalhe, acao: acao || '' }); };

  add(urlHttpValida_(urlApp_()), 'Endereço do app nos e-mails', urlApp_() || 'Preencha o endereço do SAC em Configurações > Geral.');
  try { add(true, 'Pasta geral dos projetos', pastaGeral_().getName()); } catch (e) { add(false, 'Pasta geral dos projetos', e.message); }

  const gat = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  add(gat.indexOf('rotinaHoraria') >= 0, 'Rotina automática (de hora em hora)',
    gat.indexOf('rotinaHoraria') >= 0 ? 'Ativa: avisos de atraso, fechamento automático e projetos novos.' : 'Desligada: prazos e fechamento automático não estão rodando.', 'gatilhos');
  const ult = PropertiesService.getScriptProperties().getProperty('ULTIMO_BACKUP');
  const backupOk = gat.indexOf('backupDiario') >= 0 && ult && (Date.now() - new Date(ult).getTime()) < 3 * 86400000;
  add(!!backupOk, 'Backup diário da planilha',
    (gat.indexOf('backupDiario') >= 0 ? 'Agendado para as 2h. ' : 'Não agendado. ') + (ult ? 'Último: ' + Utilities.formatDate(new Date(ult), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') + '. ' : 'Nenhum backup feito ainda. ') +
    'Os backups ficam em "SC - Backups do SAC" no Meu Drive de quem instalou (os últimos 15).', 'backup');

  const cota = MailApp.getRemainingDailyQuota();
  add(cota >= 20, 'E-mails que ainda podem sair hoje', cota + (cota < 20 ? '. Está acabando: os avisos podem parar até amanhã.' : '.'), 'email');

  const ativos = ler_('Projetos').filter(function (p) { return ativo_(p.Ativo); });
  const semEmail = ativos.filter(function (p) { return !p.Email; }).map(function (p) { return String(p.Projeto); });
  add(!semEmail.length, 'E-mail dos projetos', semEmail.length
    ? semEmail.length + ' de ' + ativos.length + ' projetos sem e-mail (não recebem avisos): ' + semEmail.slice(0, 8).join(', ') + (semEmail.length > 8 ? '…' : '')
    : 'Todos os ' + ativos.length + ' projetos ativos têm e-mail.');
  const temporarias = ativos.filter(function (p) { return String(p.TrocarSenha).toUpperCase() === 'SIM'; }).length;
  add(true, 'Projetos que ainda não entraram', temporarias ? temporarias + ' projetos ainda estão com a senha temporária (nunca entraram).' : 'Todos os projetos já criaram a própria senha.');

  const equipe = ler_('Equipe').filter(function (m) { return ativo_(m.Ativo); });
  const n1 = equipe.filter(function (m) { return /^(n1|admin)$/i.test(String(m.Perfil).trim()); }).length;
  add(n1 > 0, 'Atendimento N1', n1 + ' pessoa(s) com perfil N1 ou Admin.');
  const setoresSem = setores_().filter(function (st) { return !equipe.some(function (m) { return String(m.Perfil).trim().toLowerCase() === st.toLowerCase(); }); });
  add(!setoresSem.length, 'Setores com pessoas', setoresSem.length ? 'Sem ninguém: ' + setoresSem.join(', ') + '. Chamados encaminhados a eles não avisam ninguém.' : 'Software, Comercial e Financeiro têm pessoas.');

  _feriados = null;
  const prox = new Date().getFullYear() + 1;
  const temProx = Object.keys(feriados_()).some(function (k) { return k.indexOf(String(prox)) === 0; });
  add(temProx, 'Feriados de ' + prox, temProx ? 'Cadastrados.' : 'Nenhum feriado de ' + prox + ' cadastrado: os prazos do ano que vem vão contar feriados como dia útil.', 'feriados:' + prox);

  const aud = ler_('Auditoria').slice(-60).reverse().map(function (a) {
    return { data: a.DataHora, login: String(a.Login), perfil: String(a.Perfil), acao: String(a.Acao), detalhe: String(a.Detalhe || '') };
  });
  return pub_({ itens: itens, auditoria: aud });
}

function testarEmail(token) {
  const eu = exigirAdmin_(sessao_(token));
  if (!eu.email) throw new Error('Cadastre o seu e-mail em Equipe para receber o teste.');
  MailApp.sendEmail({ to: eu.email, subject: 'Teste de e-mail do SAC', name: 'SAC ' + cfg_().NOME_SISTEMA,
    htmlBody: moldura_('<p>Olá, ' + esc_(eu.nome) + '.</p><p>Se você está lendo isto, os e-mails do SAC estão saindo normalmente.</p>' + botao_('Abrir o SAC', linkEntrada_())) });
  return 'E-mail de teste enviado para ' + eu.email + '. Confira também o spam.';
}

function recriarGatilhos(token) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Rotinas automáticas recriadas', '');
  criarGatilhos_();
  return 'Rotinas automáticas ligadas: de hora em hora e backup diário às 2h.';
}

function backupAgora(token) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Backup manual', '');
  return 'Backup criado: ' + backupDiario() + ' (pasta "SC - Backups do SAC" no Meu Drive).';
}

function exportarChamados(token, filtro) {
  const eu = exigirN1_(sessao_(token));
  auditar_(eu, 'Exportação de chamados', JSON.stringify(filtro || {}));
  filtro = filtro || {};
  const de = filtro.de ? new Date(filtro.de + 'T00:00:00') : null;
  const ate = filtro.ate ? new Date(filtro.ate + 'T23:59:59') : null;
  const notas = {};
  ler_('Pesquisa').forEach(function (r) { notas[r.Chamado] = Number(r.Nota); });
  const tz = Session.getScriptTimeZone();
  const f = function (d) { return d instanceof Date ? Utilities.formatDate(d, tz, 'dd/MM/yyyy HH:mm') : ''; };
  const linhas = [['Número', 'Projeto', 'Abertura', 'Canal', 'Categoria', 'Módulo', 'Título', 'Prioridade', 'Status', 'Setor',
    'Prazo', 'Resolvido em', 'Fechado em', 'Fechado por', 'Horas úteis até resolver', 'Resolvido no prazo', 'Reaberturas', 'Nota da pesquisa']];
  ler_('Chamados').filter(function (c) {
    return c.Abertura instanceof Date && (!de || c.Abertura >= de) && (!ate || c.Abertura <= ate);
  }).forEach(function (c) {
    const res = c.ResolvidoEm instanceof Date;
    linhas.push([c.Id, c.Projeto, f(c.Abertura), c.Canal, c.Categoria, c.Modulo, c.Titulo, c.Prioridade, c.Status, c.Setor,
      f(c.Prazo), f(c.ResolvidoEm), f(c.FechadoEm), c.FechadoPor,
      res ? String(Math.round(horasUteisEntre_(c.Abertura, c.ResolvidoEm) * 10) / 10).replace('.', ',') : '',
      res ? (c.Prazo instanceof Date && c.ResolvidoEm <= c.Prazo ? 'Sim' : 'Não') : '', Number(c.Reaberturas || 0), notas[c.Id] || '']
      .map(function (v) { return v === null || v === undefined ? '' : String(v); }));
  });
  return linhas;
}

// ───────────────────────── Projetos e equipe (administração) ─────────────────────────

function projetoPorId_(id) {
  return ler_('Projetos').filter(function (x) { return String(x.ProjetoId) === String(id); })[0] || null;
}

function novoIdProjeto_() {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('SEQ_PROJETO') || 0) + 1;
  props.setProperty('SEQ_PROJETO', String(n));
  return 'PRJ-' + String(n).padStart(4, '0');
}

// Chamar sempre dentro de comTrava_
function criarProjetoInterno_(nome, pastaId, d) {
  d = d || {};
  const senha = novaSenha_();
  const login = loginLivre_(nome, d.login);
  const campos = {
    ProjetoId: novoIdProjeto_(), Projeto: nome, PastaId: pastaId, Responsavel: limpa_(d.responsavel, 120),
    Email: normEmail_(d.email), Telefone: limpa_(d.telefone, 40), Login: login, Ativo: 'SIM', CriadoEm: new Date(),
    Modulos: d.modulos !== undefined ? serializarModulos_(d.modulos) : (ehProjetoLinave_(nome) ? MODULOS_LINAVE.join('\n') : '')
  };
  Object.assign(campos, camposSenha_(senha, true));
  inserir_('Projetos', campos);
  return { projetoId: campos.ProjetoId, projeto: nome, login: login, senha: senha, email: campos.Email };
}

// Toda pasta da pasta geral sem projeto vinculado vira um projeto com login (chamar dentro de comTrava_)
function sincronizarProjetos_() {
  const geral = pastaGeral_();
  const vinculadas = {};
  ler_('Projetos').forEach(function (p) { if (p.PastaId) vinculadas[String(p.PastaId)] = true; });
  const novos = [];
  const it = geral.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (vinculadas[f.getId()] || /^SC - /i.test(f.getName())) continue;
    novos.push(criarProjetoInterno_(f.getName(), f.getId(), {}));
  }
  return novos;
}

function limparModulos_(texto) {
  const vistos = {};
  return String(texto || '').split(/[\n;,]+/).map(function (m) { return limpa_(m, 60); })
    .filter(function (m) { if (!m || vistos[m.toLowerCase()]) return false; vistos[m.toLowerCase()] = true; return true; })
    .join('\n');
}

function serializarModulos_(valor) {
  return JSON.stringify(detalhesModulos_(valor));
}

function listarPastasProjetos(token) {
  exigirAdmin_(sessao_(token));
  const vinculadas = {};
  ler_('Projetos').forEach(function (p) { vinculadas[String(p.PastaId)] = true; });
  const it = pastaGeral_().getFolders();
  const pastas = [];
  while (it.hasNext()) {
    const pasta = it.next();
    if (!/^SC - /i.test(pasta.getName())) pastas.push({ id: pasta.getId(), nome: pasta.getName(), vinculada: !!vinculadas[pasta.getId()] });
  }
  return pastas.sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
}

function obterPastaGeralProjetos(token) {
  exigirN1_(sessao_(token));
  return { url: 'https://drive.google.com/drive/folders/' + encodeURIComponent(String(cfg_().PASTA_GERAL_ID || '').trim()) };
}

function resumoProjeto_(pj) {
  return pub_({
    ProjetoId: pj.ProjetoId, Projeto: pj.Projeto, Responsavel: pj.Responsavel, NomePreferido: pj.NomePreferido || '', Email: pj.Email, Telefone: pj.Telefone,
    Login: pj.Login, Ativo: ativo_(pj.Ativo), UltimoAcesso: pj.UltimoAcesso, CriadoEm: pj.CriadoEm, modulos: modulosDoProjeto_(pj),
    modulosDetalhes: detalhesModulos_(pj.Modulos),
    senhaTemporaria: String(pj.TrocarSenha).toUpperCase() === 'SIM',
    pastaUrl: pj.PastaId ? 'https://drive.google.com/drive/folders/' + pj.PastaId : ''
  });
}

function listarProjetos(token) {
  exigirN1_(sessao_(token));
  return ler_('Projetos').map(resumoProjeto_).sort(function (a, b) { return String(a.Projeto).localeCompare(String(b.Projeto), 'pt-BR'); });
}

function sincronizarProjetos(token) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Busca de pastas novas', resumoArgs_(arguments));
  const novos = comTrava_(sincronizarProjetos_);
  return novos.map(function (n) { return { projeto: n.projeto, login: n.login, senha: n.senha }; });
}

function criarProjeto(token, d) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Projeto criado', resumoArgs_(arguments));
  d = d || {};
  if (!d.pastaId) throw new Error('Selecione a pasta do projeto.');
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail_(d.email))) throw new Error('E-mail inválido.');
  const r = comTrava_(function () {
    const it = pastaGeral_().getFolders();
    let pasta = null;
    while (it.hasNext()) {
      const f = it.next();
      if (f.getId() === String(d.pastaId) && !/^SC - /i.test(f.getName())) pasta = f;
    }
    if (!pasta) throw new Error('A pasta selecionada não está na pasta geral. Atualize a lista.');
    const nome = pasta.getName();
    if (ler_('Projetos').some(function (p) { return String(p.PastaId) === String(d.pastaId); })) throw new Error('Esta pasta já tem um projeto. Edite o projeto existente.');
    if (ler_('Projetos').some(function (p) { return String(p.Projeto).toLowerCase() === nome.toLowerCase(); })) {
      throw new Error('Já existe um projeto com esse nome.');
    }
    return criarProjetoInterno_(nome, pasta.getId(), d);
  });
  return { projeto: r.projeto, login: r.login, senha: r.senha, emailEnviado: false };
}

function salvarProjeto(token, d) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, 'Projeto editado', resumoArgs_(arguments));
  d = d || {};
  const email = normEmail_(d.Email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido.');
  return comTrava_(function () {
    const pj = projetoPorId_(d.ProjetoId);
    if (!pj) throw new Error('Projeto não encontrado.');
    const login = loginLivre_(pj.Projeto, d.Login || pj.Login, pj.Login);
    atualizar_('Projetos', pj._linha, {
      Responsavel: limpa_(d.Responsavel, 120), Email: email, Telefone: limpa_(d.Telefone, 40),
      Login: login, Ativo: d.Ativo === false ? 'NAO' : 'SIM', Modulos: serializarModulos_(d.Modulos)
    });
    esquecerPerfil_(pj.Login); esquecerPerfil_(login);
    return 'Projeto salvo.';
  });
}

function redefinirSenhaAcesso(token, tipo, chave, enviarEmail) {
  const eu = exigirAdmin_(sessao_(token));
  if (tipo !== 'projeto' && tipo !== 'equipe') throw new Error('Tipo de acesso inválido.');
  auditar_(eu, 'Nova senha gerada', resumoArgs_(arguments));
  const senha = novaSenha_();
  const r = comTrava_(function () {
    if (tipo === 'projeto') {
      const pj = projetoPorId_(chave);
      if (!pj) throw new Error('Projeto não encontrado.');
      atualizar_('Projetos', pj._linha, Object.assign(camposSenha_(senha, true), { SenhaTempHash: '', SenhaTempSal: '', SenhaTempExpira: '' }));
      return { login: String(pj.Login), email: normEmail_(pj.Email), nome: String(pj.Responsavel || pj.Projeto), quem: 'do projeto ' + pj.Projeto };
    }
    const m = ler_('Equipe').filter(function (x) { return normLogin_(x.Login) === normLogin_(chave); })[0];
    if (!m) throw new Error('Pessoa da equipe não encontrada.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail_(m.Email))) throw new Error('Cadastre um e-mail válido para esta pessoa antes de gerar uma nova senha.');
    atualizar_('Equipe', m._linha, Object.assign(camposSenha_(senha, true), { SenhaTempHash: '', SenhaTempSal: '', SenhaTempExpira: '' }));
    return { login: normLogin_(m.Login), email: normEmail_(m.Email), nome: String(m.Nome), quem: 'da equipe (' + m.Perfil + ')' };
  });
  CacheService.getScriptCache().remove('falhas:' + r.login);
  const enviar = tipo === 'equipe';
  if (enviar) emailAcesso_(r.email, r.nome, r.quem, r.login, senha);
  return { login: r.login, senha: senha, emailEnviado: enviar };
}

// Chamar dentro de comTrava_
function criarMembro_(d) {
  const perfil = perfisEquipe_().filter(function (p) { return p.toLowerCase() === String(d.perfil || '').toLowerCase(); })[0];
  if (!perfil) throw new Error('Escolha o perfil.');
  const senha = novaSenha_();
  const login = loginLivre_(d.nome, d.login);
  const campos = { Email: normEmail_(d.email), Nome: limpa_(d.nome, 120), Perfil: perfil, Login: login, Ativo: 'SIM' };
  Object.assign(campos, camposSenha_(senha, true));
  inserir_('Equipe', campos);
  return { login: login, senha: senha };
}

function listarEquipe(token) {
  exigirAdmin_(sessao_(token));
  return ler_('Equipe').map(function (m) {
    return pub_({ Nome: m.Nome, Email: m.Email, Perfil: m.Perfil, Login: m.Login, Ativo: ativo_(m.Ativo),
      UltimoAcesso: m.UltimoAcesso, senhaTemporaria: String(m.TrocarSenha).toUpperCase() === 'SIM' });
  });
}

function salvarMembro(token, d) {
  const eu = exigirAdmin_(sessao_(token));
  auditar_(eu, d && d.loginOriginal ? 'Equipe editada' : 'Pessoa adicionada à equipe', resumoArgs_(arguments));
  d = d || {};
  const nome = limpa_(d.Nome, 120);
  const email = normEmail_(d.Email);
  if (!nome) throw new Error('Preencha o nome.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido.');
  const r = comTrava_(function () {
    if (!d.loginOriginal) return criarMembro_({ nome: nome, email: email, perfil: d.Perfil, login: d.Login });
    const m = ler_('Equipe').filter(function (x) { return normLogin_(x.Login) === normLogin_(d.loginOriginal); })[0];
    if (!m) throw new Error('Pessoa não encontrada.');
    const perfil = perfisEquipe_().filter(function (p) { return p.toLowerCase() === String(d.Perfil || '').toLowerCase(); })[0];
    if (!perfil) throw new Error('Escolha o perfil.');
    if (normLogin_(m.Login) === eu.login && (perfil !== 'Admin' || d.Ativo === false)) throw new Error('Você não pode tirar o seu próprio acesso de administrador.');
    const login = loginLivre_(nome, d.Login || m.Login, m.Login);
    atualizar_('Equipe', m._linha, { Nome: nome, Email: email, Perfil: perfil, Login: login, Ativo: d.Ativo === false ? 'NAO' : 'SIM' });
    esquecerPerfil_(m.Login); esquecerPerfil_(login);
    return null;
  });
  if (r) emailAcesso_(email, nome, 'da equipe (' + d.Perfil + ')', r.login, r.senha);
  return r ? { login: r.login, senha: r.senha, emailEnviado: true } : null;
}

function emailAcesso_(email, nome, quem, login, senha) {
  enviarEmail_(email, 'Seu acesso ao SAC ' + cfg_().NOME_SISTEMA,
    '<p>Olá, ' + esc_(nome) + '.</p><p>Este é o seu acesso ' + esc_(quem) + ' ao SAC:</p>' +
    '<p>Login: <b>' + esc_(login) + '</b><br>Senha temporária: <b style="font-family:monospace">' + esc_(senha) + '</b></p>' +
    '<p>No primeiro acesso, o sistema pede para você criar uma senha nova. Antes de abrir um chamado, vale consultar os manuais na entrada do portal.</p>' +
    botao_('Acessar o SAC', linkEntrada_()));
}

// ───────────────────────── Rotina automática (gatilho de hora em hora) ─────────────────────────

function rotinaHoraria() {
  _cfg = null; _feriados = null;
  const agora = new Date();
  const c = cfg_();
  const envios = [];
  if (String(c.BUSCAR_PROJETOS_NOVOS).toUpperCase() === 'SIM') {
    try {
      const novos = comTrava_(sincronizarProjetos_);
      if (novos.length) {
        const admins = emailsEquipe_('Admin').concat([emailAdmin_()]).filter(function (e, i, a) { return a.indexOf(e) === i; });
        if (admins.length) enviarEmail_(admins.join(','), 'Novos projetos no SAC: ' + novos.length,
          '<p>Encontrei pastas novas na pasta geral e criei um login para cada projeto.</p>' +
          tabelaAcessos_(novos.map(function (n) { return [n.projeto, n.login, n.senha]; })) +
          '<p>Complete o responsável e o e-mail de cada projeto na tela Projetos para que ele receba os avisos.</p>');
      }
    } catch (e) { console.error('Busca de projetos: ' + e.message); }
  }
  comTrava_(function () {
    ler_('Chamados').forEach(function (ch) {
      if (FINAIS.indexOf(ch.Status) >= 0) return;

      // Regra 8: 5 dias úteis sem resposta do cliente em "Aguardando cliente" ou "Resolvido" → fecha
      if ((ch.Status === STATUS.AGUARDANDO || ch.Status === STATUS.RESOLVIDO) && ch.UltimaMudancaStatus instanceof Date) {
        if (agora >= limiteResposta_(ch)) {
          registrar_(ch.Id, SISTEMA, 'MENSAGEM',
            'Fechado automaticamente: ' + c.DIAS_UTEIS_AUTOFECHAMENTO + ' dias úteis sem resposta do cliente.', true);
          mudarStatus_(ch, STATUS.FECHADO, SISTEMA, { FechadoPor: 'Sistema' });
          envios.push({ tipo: 'status', ch: ch });
          return;
        }
      }

      // Regra 5: prazo estourado → e-mail de desculpas (uma vez por prazo)
      if (ch.Prazo instanceof Date && agora > ch.Prazo && !ch.AvisoAtrasoEnviado &&
        ch.Status !== STATUS.AGUARDANDO && ch.Status !== STATUS.RESOLVIDO) {
        atualizar_('Chamados', ch._linha, { AvisoAtrasoEnviado: agora });
        registrar_(ch.Id, SISTEMA, 'AVISO', 'Prazo de solução ultrapassado; cliente avisado por e-mail.', true);
        envios.push({ tipo: 'atraso', ch: ch });
      }
    });
  });

  envios.forEach(function (e) {
    if (e.tipo === 'status') { emailStatus_(e.ch); return; }
    enviarEmail_(emailCliente_(e.ch), '[' + e.ch.Id + '] Pedimos desculpas pelo atraso',
      '<p>Olá, ' + esc_(nomeCliente_(e.ch)) + '.</p>' +
      '<p>O prazo do chamado <b>' + e.ch.Id + '</b> — ' + esc_(e.ch.Titulo) + ' passou e pedimos desculpas pelo atraso no atendimento.</p>' +
      '<p>Estamos com muitos processos na frente e atendemos por ordem de chegada. Seu chamado continua na fila e você recebe um e-mail a cada mudança.</p>' +
      botao_('Acompanhar chamado', linkChamado_(e.ch.Id)));
    notificarN1_('Prazo estourado — ' + e.ch.Id, '<p>' + esc_(e.ch.Projeto) + ': ' + esc_(e.ch.Titulo) + ' (status: ' + e.ch.Status + ').</p>', e.ch.Id, true);
  });
}

// ───────────────────────── Relatórios ─────────────────────────

function relatorio(token, filtro) {
  exigirN1_(sessao_(token));
  filtro = filtro || {};
  const de = filtro.de ? new Date(filtro.de + 'T00:00:00') : null;
  const ate = filtro.ate ? new Date(filtro.ate + 'T23:59:59') : null;
  const agora = new Date();
  const chamados = ler_('Chamados').filter(function (c) {
    return c.Abertura instanceof Date && (!de || c.Abertura >= de) && (!ate || c.Abertura <= ate);
  });
  const pesquisas = ler_('Pesquisa');

  const agrupar = function (campo, vazio) {
    const m = {};
    chamados.forEach(function (c) { const k = String(c[campo] || vazio); (m[k] = m[k] || []).push(c); });
    return Object.keys(m).map(function (k) {
      const r = metricas_(m[k], pesquisas, agora); r.nome = k; return r;
    }).sort(function (a, b) { return b.total - a.total; });
  };

  const porMes = {};
  chamados.forEach(function (c) {
    const k = Utilities.formatDate(c.Abertura, Session.getScriptTimeZone(), 'yyyy-MM');
    porMes[k] = (porMes[k] || 0) + 1;
  });

  const ids = {};
  chamados.forEach(function (c) { ids[c.Id] = c; });
  const respostas = pesquisas.filter(function (p) { return ids[p.Chamado]; });
  const distribuicao = [1, 2, 3, 4, 5].map(function (n) {
    return { nota: n, total: respostas.filter(function (r) { return Number(r.Nota) === n; }).length };
  });
  const comentarios = respostas.filter(function (r) { return String(r.Comentario || '').trim(); })
    .sort(function (a, b) { return b.DataHora - a.DataHora; }).slice(0, 15)
    .map(function (r) { return { chamado: r.Chamado, projeto: ids[r.Chamado].Projeto, nota: Number(r.Nota), texto: String(r.Comentario), data: r.DataHora }; });

  return pub_({
    periodo: { de: filtro.de || '', ate: filtro.ate || '' }, geradoEm: agora,
    prazoNormal: cfg_().PRAZO_NORMAL_DIAS_UTEIS, horasDia: horasDia_(),
    geral: metricas_(chamados, pesquisas, agora),
    porStatus: LISTA_STATUS.map(function (s) { return { nome: s, total: chamados.filter(function (c) { return c.Status === s; }).length }; }),
    porMes: Object.keys(porMes).sort().map(function (k) { return { nome: k, total: porMes[k] }; }),
    porModulo: agrupar('Modulo', '(sem módulo)'),
    porCategoria: agrupar('Categoria', '(sem categoria)'),
    porPrioridade: agrupar('Prioridade', 'Normal'),
    porSetor: agrupar('Setor', 'Só N1'),
    porCliente: agrupar('Projeto', '(sem projeto)'),
    satisfacao: { distribuicao: distribuicao, comentarios: comentarios, resolvidoSim: respostas.filter(function (r) { return r.Resolvido !== 'Não'; }).length, respostas: respostas.length }
  });
}

function metricas_(lista, pesquisas, agora) {
  const resolvidos = lista.filter(function (c) { return c.ResolvidoEm instanceof Date; });
  const noPrazo = resolvidos.filter(function (c) { return c.Prazo instanceof Date && c.ResolvidoEm <= c.Prazo; }).length;
  const horas = resolvidos.map(function (c) { return horasUteisEntre_(c.Abertura, c.ResolvidoEm); });
  const ativos = lista.filter(function (c) { return FINAIS.indexOf(c.Status) < 0; });
  const ids = {};
  lista.forEach(function (c) { ids[c.Id] = true; });
  const notas = pesquisas.filter(function (p) { return ids[p.Chamado]; }).map(function (p) { return Number(p.Nota); }).filter(function (n) { return n >= 1; });
  const media = function (a) { return a.length ? Math.round(a.reduce(function (s, x) { return s + x; }, 0) / a.length * 10) / 10 : null; };
  return {
    total: lista.length,
    ativos: ativos.length,
    resolvidos: resolvidos.length,
    fechados: lista.filter(function (c) { return c.Status === STATUS.FECHADO; }).length,
    cancelados: lista.filter(function (c) { return c.Status === STATUS.CANCELADO; }).length,
    bloqueios: lista.filter(function (c) { return c.Prioridade === 'Bloqueio'; }).length,
    atrasados: ativos.filter(function (c) { return c.Prazo instanceof Date && agora > c.Prazo && c.Status !== STATUS.RESOLVIDO; }).length,
    slaPct: resolvidos.length ? Math.round(noPrazo * 100 / resolvidos.length) : null,
    tempoMedioHoras: media(horas),
    satisfacao: media(notas),
    respostas: notas.length
  };
}

// ───────────────────────── E-mail ─────────────────────────

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function citacao_(t) {
  return '<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #41a639;background:#eef7ec;color:#1c2a1b">' +
    esc_(t).replace(/\n/g, '<br>') + '</blockquote>';
}

function botao_(texto, url) {
  if (!url) return '';
  return '<p style="margin:20px 0"><a href="' + esc_(url) + '" style="display:inline-block;background:#2b7f26;color:#ffffff;' +
    'padding:11px 18px;border-radius:6px;text-decoration:none;font-weight:bold">' + esc_(texto) + '</a></p>';
}

// Endereço para "entrar no SAC": o bonito, se configurado; senão o /exec.
function linkEntrada_() { return String(cfg_().URL_PORTAL || '').trim() || urlApp_(); }

function linkChamado_(id) {
  const u = urlApp_();
  return u ? u + '?chamado=' + encodeURIComponent(id) : '';
}

function moldura_(conteudo) {
  const c = cfg_();
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:580px;margin:0 auto;color:#1c2a1b;font-size:15px;line-height:1.5">' +
    '<div style="background:#41a639;color:#0f2a0d;padding:14px 20px;border-radius:8px 8px 0 0;font-weight:bold;font-size:18px">SAC ' + esc_(c.NOME_SISTEMA) + '</div>' +
    '<div style="border:1px solid #d6e1d4;border-top:0;padding:20px;border-radius:0 0 8px 8px">' + conteudo +
    '<p style="color:#5b6b5a;font-size:12px;margin-top:28px">Atendimento de segunda a sexta, das ' + c.HORA_INICIO + 'h às ' + c.HORA_FIM +
    'h, exceto feriados. Telefone: ' + esc_(c.TELEFONE) + '.<br>Aviso automático: para responder, use o portal.</p></div></div>';
}

function enviarEmail_(para, assunto, html) {
  if (!para) return;
  try {
    MailApp.sendEmail({ to: para, subject: assunto, htmlBody: moldura_(html), name: 'SAC ' + cfg_().NOME_SISTEMA });
  } catch (e) {
    console.error('Falha ao enviar e-mail para ' + para + ': ' + e.message + ' (cota restante hoje: ' + MailApp.getRemainingDailyQuota() + ')');
  }
}

function nomeCliente_(ch) {
  const pj = projetoPorId_(ch.ProjetoId);
  const nome = String((pj && (pj.NomePreferido || pj.Responsavel)) || ch.Usuario || ch.Projeto || '');
  return nome === ch.Projeto || (pj && nome === pj.Projeto) ? nomeProjetoCliente_(nome) : nome;
}

function emailCliente_(ch) {
  const pj = projetoPorId_(ch.ProjetoId);
  return pj && pj.Email ? normEmail_(pj.Email) : normEmail_(ch.Email);
}

function emailsEquipe_(perfil) {
  return ler_('Equipe').filter(function (m) { return String(m.Perfil).trim().toLowerCase() === perfil.toLowerCase() && ativo_(m.Ativo) && m.Email; })
    .map(function (m) { return normEmail_(m.Email); });
}

function notificarN1_(assunto, html, id, sempre) {
  if (!sempre && String(cfg_().NOTIFICAR_EQUIPE).toUpperCase() !== 'SIM') return;
  const emails = emailsEquipe_('N1').concat(emailsEquipe_('Admin'));
  if (emails.length) enviarEmail_(emails.join(','), assunto, html + botao_('Abrir chamado', linkChamado_(id)));
}

function textoStatus_(status) {
  const c = cfg_();
  return {
    'Aberto': 'Recebemos seu chamado. Ele entrou na fila e é atendido por ordem de chegada, com prazo de solução de ' + c.PRAZO_NORMAL_DIAS_UTEIS + ' dias úteis.',
    'Em triagem': 'O atendimento está conferindo a categoria, o módulo e a prioridade do seu chamado.',
    'Em atendimento': 'Seu chamado está em atendimento.',
    'Aguardando cliente': 'Precisamos de uma informação ou de um teste seu para continuar. Responda pelo portal em até ' + c.DIAS_UTEIS_AUTOFECHAMENTO + ' dias úteis; sem resposta, o chamado é fechado.',
    'Encaminhado ao setor': 'Seu chamado foi encaminhado ao setor responsável. O atendimento continua sendo o seu contato.',
    'Resolvido': 'Enviamos a correção ou a resposta. Confira e, pelo portal, confirme a correção ou peça um reajuste em até ' + c.DIAS_UTEIS_AUTOFECHAMENTO + ' dias úteis.',
    'Fechado': 'Seu chamado foi encerrado. Se precisar, você pode reabri-lo em até ' + c.DIAS_UTEIS_REABERTURA + ' dias úteis.',
    'Cancelado': 'Seu chamado foi cancelado.'
  }[status] || '';
}

function emailStatus_(ch, mensagem) {
  let html = '<p>Olá, ' + esc_(nomeCliente_(ch)) + '.</p>' +
    '<p>O chamado <b>' + ch.Id + '</b> — ' + esc_(ch.Titulo) + ' está agora em <b>' + esc_(ch.Status) + '</b>.</p>' +
    '<p>' + textoStatus_(ch.Status) + '</p>';
  if (ch.Status === STATUS.CANCELADO && (mensagem || ch.MotivoCancelamento)) html += '<p>Motivo:</p>' + citacao_(mensagem || ch.MotivoCancelamento);
  else if (mensagem) html += citacao_(mensagem);
  if (ch.Status === STATUS.FECHADO && urlApp_()) {
    html += '<p><b>Como foi o atendimento?</b> Leva menos de um minuto.</p>' +
      botao_('Responder a pesquisa', urlApp_() + '?pesquisa=' + encodeURIComponent(ch.Id) + '&k=' + chavePesquisa_(ch.Id));
  } else {
    html += botao_('Ver chamado', linkChamado_(ch.Id));
  }
  enviarEmail_(emailCliente_(ch), '[' + ch.Id + '] ' + ch.Status + ' — ' + ch.Titulo, html);
}
