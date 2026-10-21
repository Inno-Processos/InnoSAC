// ───────── Estado e utilitários ─────────
const S = { token: null, base: null, usuario: null, publico: null, params: {}, cache: {}, filtroCliente: {}, filtroFila: { status: 'ativos' } };
const app = document.getElementById('app');
const TZ = 'America/Sao_Paulo';
const TRILHA = ['Aberto', 'Em triagem', 'Em atendimento', 'Resolvido', 'Fechado'];
const FINAIS = ['Fechado', 'Cancelado'];
const MODULOS_LINAVE = ['Financeiro', 'Suprimentos', 'Compras', 'Comercial', 'Cadastros', 'Relatórios', 'Outro'];

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const fmtDH = iso => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtD = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ }) : '—';
const diaISO = iso => iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: TZ }) : '';
const chipStatus = s => `<span class="chip st-${slug(s)}">${esc(s)}</span>`;
const num = (v, suf) => (v === null || v === undefined) ? '—' : Number(v).toLocaleString('pt-BR') + (suf || '');
const tamanho = b => { b = Number(b) || 0; return b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; };

// Login pelo Authelia/LLDAP (AUTH_MODE=authelia no backend): a sessão é o cookie do Authelia, sem senhas no SAC;
// o acesso vem dos grupos sac_* do LLDAP. Quem não entrou recebe a landing page (landing.html) do servidor.
const sso = () => !!(S.auth && S.auth.modo === 'authelia');
// Mesmo nome que o backend usa (grupoLldap_ no Codigo.gs): "Suporte de campo" -> sac_suporte_de_campo
const grupoLldap = nome => 'sac_' + String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

const guarda = {
  get() { try { return sessionStorage.getItem('sac_token') || S.token; } catch (e) { return S.token; } },
  set(t) { S.token = t; try { sessionStorage.setItem('sac_token', t); } catch (e) { } },
  del() { S.token = null; try { sessionStorage.removeItem('sac_token'); sessionStorage.removeItem('sac_tela'); } catch (e) { } }
};

function lembrarTela(tela, valor) {
  if (!S.usuario) return;
  try { sessionStorage.setItem('sac_tela', JSON.stringify({ login: S.usuario.login, tela, valor })); } catch (e) { }
}

function restaurarTela() {
  let rota;
  try { rota = JSON.parse(sessionStorage.getItem('sac_tela')); } catch (e) { return false; }
  if (!rota || rota.login !== S.usuario.login) return false;
  if (rota.tela === 'detalhe' && typeof rota.valor === 'string') { telaDetalhe(rota.valor); return true; }
  if (S.usuario.tipo === 'cliente') {
    if (rota.tela === 'cadastro' && !S.usuario.contaLldap) { telaMeuCadastro(); return true; }
    if (rota.tela === 'novo') { telaNovoChamado(false); return true; }
    if (rota.tela === 'como') { telaComoFunciona(); return true; }
    return false;
  }
  const permitidas = ['fila', 'ajuda'];
  if (S.usuario.n1) permitidas.push('telefone', 'relatorios', 'pesquisas');
  if (S.usuario.admin) permitidas.push('projetos', 'equipe', 'config');
  if (!permitidas.includes(rota.tela)) return false;
  const sub = ['situacao', 'geral', 'automaticas', 'categorias', 'perfis', 'modulos', 'manuais', 'feriados'].includes(rota.valor) ? rota.valor : undefined;
  telaEquipe(rota.tela, sub);
  return true;
}

// Chama uma função do backend (ver js/api.js) e trata sessão expirada e troca de senha obrigatória
function api(fn, ...args) {
  return SacApi.chamar(fn, args).catch(e => {
    const msg = String((e && e.message) || e).replace(/^(Exception|Error|Erro):\s*/i, '');
    if (msg.indexOf('TROCAR_SENHA') >= 0) {
      telaTrocarSenha(true);
      throw new Error('SESSAO_EXPIRADA');
    }
    if (msg.indexOf('SESSAO_EXPIRADA') >= 0) {
      guarda.del(); S.usuario = null;
      telaLogin('Sua sessão terminou. Entre de novo para continuar.');
      throw new Error('SESSAO_EXPIRADA');
    }
    throw new Error(msg);
  });
}

let avisoTimer;
function aviso(msg, tipo) {
  const el = $('#aviso');
  el.textContent = msg; el.className = tipo || ''; el.style.display = 'block';
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { el.style.display = 'none'; }, tipo === 'erro' ? 7000 : 4000);
}

// Executa uma ação com o botão travado; devolve o resultado ou false em caso de erro
async function acao(btn, fn, msgOk) {
  let texto;
  if (btn && btn.disabled) return false;
  if (btn) { btn.disabled = true; texto = btn.textContent; btn.textContent = 'Aguarde…'; }
  try {
    const r = await fn();
    if (msgOk) aviso(msgOk, 'ok');
    return r === undefined || r === null ? true : r;
  } catch (e) {
    if (e.message !== 'SESSAO_EXPIRADA') aviso(e.message, 'erro');
    return false;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = texto; }
  }
}

function lerArquivo(f) {
  return new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok({ nome: f.name, tipo: f.type || 'application/octet-stream', b64: String(r.result).split(',')[1] || '' });
    r.onerror = () => falha(new Error('Não foi possível ler ' + f.name));
    r.readAsDataURL(f);
  });
}

async function enviarArquivos(id, arquivos, interno, progresso) {
  const falhas = [];
  for (let i = 0; i < arquivos.length; i++) {
    if (progresso) progresso(i + 1, arquivos.length, arquivos[i].name);
    try {
      const a = await lerArquivo(arquivos[i]);
      await api('anexar', S.token, id, a, !!interno);
    } catch (e) {
      if (e.message === 'SESSAO_EXPIRADA') throw e;
      falhas.push(arquivos[i].name);
    }
  }
  if (falhas.length) aviso('Não foi possível enviar: ' + falhas.join(', ') + '. Arquivos muito grandes podem passar do limite do Google; compacte ou divida e tente de novo.', 'erro');
  return falhas;
}

async function baixar(id, arquivoId, btn) {
  const r = await acao(btn, () => api('baixarAnexo', S.token, id, arquivoId));
  if (!r) return;
  const bin = atob(r.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: r.tipo }));
  const a = document.createElement('a');
  a.href = url; a.download = r.nome; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function campoArquivos(id) {
  return `<div class="campo"><label for="${id}">Anexos</label>
    <input type="file" id="${id}" multiple>
    <div class="ajuda">Print, XML da nota, planilha… quantos arquivos precisar.</div>
    <ul class="lista-arquivos" id="${id}-lista"></ul></div>`;
}
// Anexos escolhidos antes de enviar: cada arquivo pode ser visto (abre numa nova aba) ou retirado.
// Escolher mais arquivos soma à lista em vez de substituí-la.
function ligarArquivos(id) {
  const inp = $('#' + id);
  if (!inp) return;
  inp._arquivos = [];
  const lista = $('#' + id + '-lista');
  const chave = f => f.name + '|' + f.size + '|' + f.lastModified;
  const sincronizar = () => {
    // Mantém o campo nativo igual à lista (o navegador mostra a contagem certa)
    try { const dt = new DataTransfer(); inp._arquivos.forEach(f => dt.items.add(f)); inp.files = dt.files; } catch (e) { }
    lista.innerHTML = inp._arquivos.map((f, i) => `<li><span class="arquivo-nome">${esc(f.name)} <span class="suave">(${tamanho(f.size)})</span></span>
      <span class="arquivo-acoes">${botaoIcone('ver', 'Ver ' + f.name, `data-arquivo-ver="${i}"`)}${botaoIcone('excluir', 'Retirar ' + f.name, `data-arquivo-tirar="${i}"`)}</span></li>`).join('');
    $$('[data-arquivo-ver]', lista).forEach(b => b.onclick = () => {
      const url = URL.createObjectURL(inp._arquivos[Number(b.dataset.arquivoVer)]);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    $$('[data-arquivo-tirar]', lista).forEach(b => b.onclick = () => {
      inp._arquivos.splice(Number(b.dataset.arquivoTirar), 1);
      sincronizar();
    });
  };
  inp.onchange = () => {
    const novos = Array.from(inp.files).filter(f => !inp._arquivos.some(a => chave(a) === chave(f)));
    inp._arquivos = inp._arquivos.concat(novos);
    sincronizar();
  };
}
// Arquivos que vão ser enviados (a lista acima, ou o campo nativo se ela não existir)
const arquivosDe = id => { const inp = $('#' + id); return inp ? (inp._arquivos || Array.from(inp.files || [])) : []; };

// Trava cada botão por um instante depois do clique: impede o duplo clique.
// Botões de ação ficam desabilitados até o servidor responder (função acao).
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.hasAttribute('data-ver') || b.hasAttribute('data-nota')) return;
  if (b.dataset.travado) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  b.dataset.travado = '1';
  setTimeout(() => { delete b.dataset.travado; }, 400); // cobre o duplo clique; a ação em si trava o botão até o servidor responder
}, true);

// ───────── Topo e navegação ─────────
// Cada troca de tela ganha um número; respostas atrasadas de uma tela antiga são descartadas.
S.nav = 0;
function novaTela() { while (editorAberto) fecharEditor(true); guardarRascunho(); pararChat(); return ++S.nav; }

let editorAberto = null;
let editorSequencia = 0;
function fecharEditor(forcar) {
  const editor = editorAberto;
  if (!editor) return;
  if (!forcar && $('button:disabled', editor.conteudo)) return;
  editorAberto = editor.anterior;
  editor.dialogo.close();
  editor.conteudo.hidden = true;
  if (editor.marcador.isConnected) editor.marcador.replaceWith(editor.conteudo);
  editor.dialogo.remove();
  app.hidden = editor.appOculto;
  editor.bloqueados.forEach(([el, anterior]) => { el.inert = anterior; });
  if (!editorAberto) document.body.classList.remove('editor-aberto');
  if (!forcar && editor.origem && editor.origem.isConnected) editor.origem.focus();
}

function abrirEditor(conteudo, titulo, aninhado) {
  if (!aninhado) while (editorAberto) fecharEditor(true);
  const anterior = editorAberto;
  const origem = document.activeElement;
  const marcador = document.createComment('formulário em edição');
  conteudo.before(marcador);
  const formulario = $('form', conteudo) || conteudo;
  const botoes = Array.from(formulario.children).filter(el => el.matches('button.btn'));
  if (botoes.length) {
    const acoes = document.createElement('div');
    acoes.className = 'editor-acoes';
    botoes.forEach(el => acoes.appendChild(el));
    formulario.appendChild(acoes);
  }
  const dialogo = document.createElement('dialog');
  dialogo.className = 'editor-modal';
  const tituloId = anterior ? 'editor-titulo-' + (++editorSequencia) : 'editor-titulo';
  dialogo.setAttribute('aria-labelledby', tituloId);
  dialogo.innerHTML = `<header class="editor-cabeca"><h2 id="${tituloId}"></h2><button type="button" class="btn" data-editor-fechar aria-label="Fechar formulário">Fechar</button></header><div class="editor-conteudo"></div>`;
  $('h2', dialogo).textContent = titulo;
  conteudo.hidden = false;
  $('.editor-conteudo', dialogo).appendChild(conteudo);
  const bloqueados = $$('.topo, #abas, #rodape').map(el => [el, !!el.inert]);
  editorAberto = { dialogo, conteudo, marcador, origem, bloqueados, appOculto: app.hidden, anterior };
  app.hidden = true;
  bloqueados.forEach(([el]) => { el.inert = true; });
  document.body.appendChild(dialogo);
  document.body.classList.add('editor-aberto');
  $('[data-editor-fechar]', dialogo).onclick = () => fecharEditor();
  dialogo.addEventListener('cancel', e => { e.preventDefault(); fecharEditor(); });
  dialogo.showModal();
  const primeiro = $('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])', conteudo);
  if (primeiro) primeiro.focus();
}

function confirmarExclusao(nome, detalhe) {
  return confirm(`Excluir ${nome}?\n\n${detalhe || 'Confirme para continuar com a exclusão.'}`);
}

function iconeInterface(nome) {
  const desenhos = {
    fila: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h4"/>',
    telefone: '<path d="m7 3 3 5-3 3a14 14 0 0 0 6 6l3-3 5 3c-1 5-5 5-9 3A21 21 0 0 1 4 12C2 8 2 4 7 3Z"/>',
    relatorios: '<path d="M4 4v16h16M8 15v-4M13 15V7M18 15v-6"/>',
    pesquisas: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/>',
    projetos: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    equipe: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
    config: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    ajuda: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2M12 17h.01"/>',
    senha: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    sair: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M13 7l5 5-5 5M8 12h13"/>',
    cadastro: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    novo: '<path d="M12 5v14M5 12h14"/>',
    editar: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    excluir: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    ver: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    clipe: '<path d="m20 11.5-8.2 8.2a5.5 5.5 0 0 1-7.8-7.8L12.6 3.3a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
    enviar: '<path d="M4 12 20 4l-4 16-4.5-6.5L4 12Z"/><path d="m11.5 13.5 4-4"/>',
    microfone: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    modulos: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'
  };
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${desenhos[nome] || desenhos.fila}</svg>`;
}

// Telas de cadastro (Categorias, Módulos): cabeçalho com ícone, título, descrição e ação principal
function cabecalhoPainel(icone, titulo, descricao, botao) {
  return `<div class="painel-cab"><span class="painel-cab-ico">${iconeInterface(icone)}</span>
    <div class="painel-cab-texto"><h2>${esc(titulo)}</h2><p>${esc(descricao)}</p></div>${botao || ''}</div>`;
}
// Botão só com ícone (editar ou excluir); o rótulo vai para leitores de tela e para a dica do mouse
const botaoIcone = (tipo, rotulo, atributos) =>
  `<button type="button" class="btn-ico ${tipo}" ${atributos} aria-label="${esc(rotulo)}" title="${esc(rotulo)}">${iconeInterface(tipo)}</button>`;

function topo() {
  novaTela();
  pararChat();
  document.body.classList.remove('modo-login');
  document.body.classList.toggle('sac-interno', !!S.usuario);
  document.body.classList.toggle('sac-equipe', !!S.usuario && S.usuario.tipo === 'equipe');
  document.body.classList.toggle('sac-lateral', !!S.usuario); // equipe e clientes têm menu lateral
  const quem = $('#quem');
  const abas = $('#abas');
  $('#nome-projeto').hidden = !S.usuario;
  if (!S.usuario) { quem.innerHTML = ''; abas.hidden = true; document.title = 'SAC'; return; }
  const titulo = S.usuario.tipo === 'cliente' ? S.usuario.projeto : 'Equipe ' + S.publico.nome;
  $('#nome-projeto').textContent = titulo;
  document.title = 'SAC · ' + titulo;
  const u = S.usuario;
  const iniciais = String(u.nome || u.projeto || 'SAC').trim().split(/\s+/).slice(0, 2).map(n => n.charAt(0)).join('').toUpperCase();
  quem.innerHTML = `<span class="avatar" aria-hidden="true">${esc(iniciais)}</span><span class="quem-id" translate="no">${esc(u.tipo === 'cliente' ? (u.contaLldap ? u.nome : 'Login ' + u.login) : u.nome + ' · ' + u.perfil)}</span>
    ${u.tipo === 'cliente' && !u.contaLldap ? `<button class="btn btn-fantasma" id="btn-cadastro">${iconeInterface('cadastro')}Meu cadastro</button>` : ''}
    ${sso() ? '' : `<button class="btn btn-fantasma" id="btn-senha">${iconeInterface('senha')}Trocar senha</button>`}
    <button class="btn btn-fantasma" id="btn-sair">${iconeInterface('sair')}Sair</button>`;
  if ($('#btn-senha')) $('#btn-senha').onclick = () => telaTrocarSenha(false);
  if ($('#btn-cadastro')) $('#btn-cadastro').onclick = () => telaMeuCadastro(false);
  $('#btn-sair').onclick = async () => {
    try { await api('sair', S.token); } catch (e) { }
    guarda.del(); S.usuario = null;
    // Com o Authelia, sai também da conta Innomaker (senão o próximo "Entrar" seria automático)
    if (sso() && S.auth.sair) { location.href = S.auth.sair; return; }
    telaLogin();
  };
  if (u.tipo === 'equipe') {
    const itens = [['fila', 'Fila de chamados']];
    if (u.n1) itens.push(['telefone', 'Abrir por telefone'], ['relatorios', 'Relatórios'], ['pesquisas', 'Pesquisas de satisfação']);
    if (u.admin) itens.push(['projetos', 'Projetos'], ['equipe', 'Equipe'], ['config', 'Configurações']);
    itens.push(['ajuda', 'Ajuda e manuais']);
    const grupos = [
      ['Atendimento', itens.filter(([k]) => ['fila', 'telefone', 'relatorios', 'pesquisas'].includes(k))],
      ['Administração', itens.filter(([k]) => ['projetos', 'equipe', 'config'].includes(k))],
      ['Ajuda', itens.filter(([k]) => k === 'ajuda')]
    ];
    abas.setAttribute('aria-label', 'Navegação principal');
    abas.innerHTML = grupos.filter(([, links]) => links.length).map(([nome, links]) => `<div class="nav-grupo" role="group" aria-label="${nome}"><span class="nav-grupo-titulo">${nome}</span>${links.map(([k, t]) => `<button data-aba="${k}">${iconeInterface(k)}<span>${t}</span></button>`).join('')}</div>`).join('');
    abas.hidden = false;
    $$('button', abas).forEach(b => b.onclick = () => telaEquipe(b.dataset.aba));
  } else {
    // Cliente: Meus chamados, Abrir chamado e Como funciona
    abas.setAttribute('aria-label', 'Navegação principal');
    abas.innerHTML = `<div class="nav-grupo" role="group" aria-label="Atendimento"><span class="nav-grupo-titulo">Atendimento</span>
        <button data-aba="cliente">${iconeInterface('fila')}<span>Meus chamados</span></button>
        <button data-aba="novo">${iconeInterface('novo')}<span>Abrir chamado</span></button></div>
      <div class="nav-grupo" role="group" aria-label="Ajuda"><span class="nav-grupo-titulo">Ajuda</span>
        <button data-aba="como">${iconeInterface('ajuda')}<span>Como funciona</span></button></div>`;
    abas.hidden = false;
    const telas = { cliente: () => telaCliente(), novo: () => telaNovoChamado(false), como: () => telaComoFunciona() };
    $$('button', abas).forEach(b => b.onclick = () => telas[b.dataset.aba]());
  }
}
function marcarAba(k) { $$('#abas button').forEach(b => b.setAttribute('aria-current', b.dataset.aba === k ? 'page' : 'false')); }

function listaManuais(manuais) {
  if (!manuais || !manuais.length) return '<p class="suave">Nenhum manual publicado ainda.</p>';
  return `<ul class="manuais">${manuais.map(m => `<li><a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.titulo)}</a>${m.projeto && S.usuario && S.usuario.tipo === 'equipe' ? ` <span class="chip st-fechado">${esc(m.projeto)}</span>` : ''}
    ${m.descricao ? `<div class="suave pequeno">${esc(m.descricao)}</div>` : ''}</li>`).join('')}</ul>`;
}

function montarRodape() {
  const pub = S.publico || {};
  const el = $('#rodape');
  if (!pub.telefone) { el.hidden = true; return; }
  const dig = String(pub.telefone).replace(/\D/g, '');
  const tel = dig.length >= 10 && dig.length <= 11 ? '+55' + dig : dig;
  el.innerHTML = `<p>Prefere ligar? <a href="tel:${esc(tel)}">${esc(pub.telefone)}</a></p>${pub.rodape ? `<p>${esc(pub.rodape)}</p>` : ''}`;
  el.hidden = false;
}

async function iniciarApp() {
  try { [S.publico, S.auth] = await Promise.all([api('dadosPublicos'), SacApi.infoLogin()]); }
  catch (e) { app.innerHTML = `<div class="vazio">Não foi possível carregar o SAC: ${esc(e.message)}</div>`; return; }
  document.title = 'SAC';
  montarRodape();
  if (S.params.pesquisa && S.params.k) return telaPesquisaAvulsa(S.params.pesquisa, S.params.k);
  // Com o Authelia, quem decide a sessão é o cookie: o backend troca o token enviado pela sessão certa
  const t = sso() ? 'authelia' : guarda.get();
  if (t) {
    S.token = t;
    try { await carregarSessao(); return home(true); }
    catch (e) {
      if (S.trocandoSenha || e.message === 'SESSAO_EXPIRADA') return;
      app.innerHTML = '<div class="vazio">Não foi possível recuperar sua sessão. <button class="btn" id="b-reconectar">Tentar novamente</button></div>';
      $('#b-reconectar').onclick = iniciarApp;
      return;
    }
  }
  telaLogin();
}

async function carregarSessao() {
  S.base = await api('iniciar', S.token);
  S.usuario = S.base.usuario;
}

function home(restaurar) {
  topo();
  const alvo = S.params.chamado;
  if (S.usuario.tipo === 'cliente' && S.usuario.cadastroIncompleto && (!S.usuario.email || !S.cadastroAdiado)) return telaMeuCadastro(true);
  if (alvo) { delete S.params.chamado; return telaDetalhe(alvo); }
  if (restaurar && restaurarTela()) return;
  return S.usuario.tipo === 'cliente' ? telaCliente() : telaEquipe('fila');
}

// ───────── Login com usuário e senha ─────────
function campoSenha(id, rotulo, auto, opcional) {
  return `<div class="campo"><label for="${id}">${rotulo}</label><div class="senha-campo">
    <input type="password" id="${id}" autocomplete="${auto}" ${opcional ? '' : 'required'}>
    <button type="button" data-ver="${id}" aria-label="Mostrar senha">Mostrar</button></div></div>`;
}
function ligarVerSenha() {
  $$('[data-ver]').forEach(b => b.onclick = () => {
    const i = $('#' + b.dataset.ver);
    const mostrar = i.type === 'password';
    i.type = mostrar ? 'text' : 'password';
    b.textContent = mostrar ? 'Ocultar' : 'Mostrar';
    b.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
  });
}

function telaLogin(msg) {
  S.usuario = null; S.trocandoSenha = false; topo();
  document.body.classList.add('modo-login');
  // Recarregar faz o servidor decidir: abre o SAC se a sessão do Authelia vale, senão mostra a landing page
  const entrarSso = () => { location.href = location.pathname + location.search; };
  const pub = S.publico || {};
  const dig = String(pub.telefone || '').replace(/\D/g, '');
  const tel = dig.length >= 10 && dig.length <= 11 ? '+55' + dig : dig;
  app.innerHTML = `
  <div class="login">
    <section class="login-marca" aria-hidden="true">
      <div></div>
      <div>
        <p class="login-sigla">SAC</p>
        <p class="login-frase">Abra um chamado e acompanhe cada etapa até a solução.</p>
      </div>
      <ol class="login-trilha"><li>Aberto</li><li>Em triagem</li><li>Em atendimento</li><li>Resolvido</li><li>Fechado</li></ol>
    </section>
    <section class="login-lado">
      <div class="login-form">${sso() ? `
        <div>
          <h1>Entrar</h1>
          <p class="sub">Use a sua conta Innomaker. O login acontece na página segura auth.innomaker.com.br.</p>
          <p class="atrasado">${esc(msg || 'Sua sessão terminou.')}</p>
          <button type="button" class="btn btn-primario" id="b-entrar-sso">Entrar de novo</button>
        </div>` : `
        <form id="f-login">
          <h1>Entrar</h1>
          <p class="sub">Use o login e a senha do seu projeto. No primeiro acesso, a senha é a que o administrador enviou.</p>
          ${msg ? `<p class="atrasado">${esc(msg)}</p>` : ''}
          <div class="campo"><label for="login">Login</label>
            <input type="text" id="login" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
          ${campoSenha('senha', 'Senha', 'current-password')}
          <button class="btn btn-primario" id="b-entrar">Entrar</button>
          <button type="button" class="btn-link esqueci" id="b-esqueci">Esqueci minha senha</button>
        </form>
        <form id="f-esqueci" hidden>
          <h1>Esqueci minha senha</h1>
          <p class="sub">Digite o e-mail que você cadastrou no seu acesso. Se ele estiver no sistema, enviamos uma senha temporária.</p>
          <div class="campo"><label for="r-email">E-mail cadastrado</label>
            <input type="email" id="r-email" autocomplete="email" autocapitalize="none" spellcheck="false" required placeholder="nome@empresa.com.br…">
            <div class="ajuda">Sua senha atual continua valendo até você entrar com a temporária.</div></div>
          <p class="suave pequeno">Primeiro acesso? Não há recuperação: use o login e a senha que o administrador enviou para você.</p>
          <button class="btn btn-primario" id="b-reset">Enviar senha temporária</button>
          <button type="button" class="btn-link esqueci" id="b-voltar-login">Voltar para o login</button>
        </form>
        <div id="esqueci-ok" hidden>
          <h1>Confira seu e-mail</h1>
          <p class="sub" id="esqueci-msg"></p>
          <p class="suave pequeno">Entre com a senha temporária no lugar da senha: o sistema pede para você criar uma senha nova.</p>
          <button type="button" class="btn btn-primario" id="b-voltar-login2">Voltar para o login</button>
        </div>`}
      </div>
      ${pub.telefone ? `<div class="login-ligar"><p>Prefere ligar? <a href="tel:${esc(tel)}">${esc(pub.telefone)}</a></p>${pub.rodape ? `<p>${esc(pub.rodape)}</p>` : ''}</div>` : ''}
    </section>
  </div>`;
  if (sso()) { $('#b-entrar-sso').onclick = entrarSso; return; }
  ligarVerSenha();
  if (matchMedia('(pointer: fine)').matches) $('#login').focus();
  $('#f-login').onsubmit = async ev => {
    ev.preventDefault();
    const r = await acao($('#b-entrar'), () => api('entrar', $('#login').value, $('#senha').value));
    if (!r) return;
    guarda.set(r.token);
    if (r.trocarSenha) return telaTrocarSenha(true);
    if (await acao(null, carregarSessao)) home();
  };
  $('#b-esqueci').onclick = () => {
    $('#f-login').hidden = true; $('#f-esqueci').hidden = false;
    $('#r-email').focus();
  };
  $('#b-voltar-login').onclick = () => telaLogin();
  $('#b-voltar-login2').onclick = () => telaLogin();
  $('#f-esqueci').onsubmit = async ev => {
    ev.preventDefault();
    const r = await acao($('#b-reset'), () => api('esqueciSenha', $('#r-email').value));
    if (!r) return;
    $('#f-esqueci').hidden = true; $('#esqueci-ok').hidden = false;
    $('#esqueci-msg').textContent = r;
  };
}

function telaTrocarSenha(obrigatoria) {
  S.trocandoSenha = obrigatoria;
  if (obrigatoria) { S.usuario = null; topo(); } else topo();
  app.innerHTML = `
  <div class="bloco" style="max-width:520px;margin:auto">
    <h1>${obrigatoria ? 'Crie sua senha' : 'Trocar senha'}</h1>
    <p class="suave">${obrigatoria ? 'Este é o seu primeiro acesso ou sua senha foi redefinida. Troque a senha temporária para continuar.' : 'Use pelo menos 8 caracteres, com letras e números.'}</p>
    <form id="f-troca">
      ${campoSenha('t-atual', obrigatoria ? 'Senha temporária' : 'Senha atual', 'current-password')}
      ${campoSenha('t-nova', 'Nova senha', 'new-password')}
      ${campoSenha('t-conf', 'Repita a nova senha', 'new-password')}
      <div class="opcoes" style="align-items:center">
        <button class="btn btn-primario" id="b-troca">Salvar senha</button>
        <button type="button" class="btn-link" id="b-troca-sair">${obrigatoria ? 'Sair' : 'Cancelar'}</button>
      </div>
    </form>
  </div>`;
  ligarVerSenha();
  $('#t-atual').focus();
  $('#b-troca-sair').onclick = async () => {
    if (!obrigatoria) return home();
    try { await api('sair', S.token); } catch (e) { }
    guarda.del(); telaLogin();
  };
  $('#f-troca').onsubmit = async ev => {
    ev.preventDefault();
    if ($('#t-nova').value !== $('#t-conf').value) return aviso('As duas senhas novas não são iguais.', 'erro');
    const ok = await acao($('#b-troca'), () => api('trocarSenha', S.token, $('#t-atual').value, $('#t-nova').value), 'Senha salva.');
    if (!ok) return;
    S.trocandoSenha = false;
    if (await acao(null, carregarSessao)) home();
  };
}

// ───────── Meu cadastro (cliente) ─────────
async function telaMeuCadastro(primeiraVez) {
  lembrarTela('cadastro');
  topo();
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Carregando seu cadastro…</div>';
  let d;
  try { d = await api('meuCadastro', S.token); }
  catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  const saudacao = n => `Olá, ${n || '…'}.`;
  app.innerHTML = `
  ${primeiraVez ? '' : '<button class="btn-link voltar" id="b-voltar">Voltar para meus chamados</button>'}
  <div style="max-width:640px">
    <h1>${primeiraVez ? 'Complete seu cadastro' : 'Meu cadastro'}</h1>
    <p class="suave">Projeto <b>${esc(d.projeto)}</b>, login <b>${esc(d.login)}</b>. Com seu nome e e-mail, os avisos dos chamados chegam direto para você, do jeito que prefere ser chamado.</p>
    <div class="bloco">
      <h2>Como prefere ser chamado</h2>
      <form id="f-nome" autocomplete="off">
        <div class="grade-2">
          <div class="campo"><label for="c-nome">Nome de preferência</label>
            <input type="text" id="c-nome" maxlength="60" required value="${esc(d.nomePreferido || d.responsavel)}" placeholder="Ex.: Maria, Dr. Paulo, Equipe Fiscal…"></div>
          <div class="campo"><label for="c-tel">Telefone (opcional)</label><input type="tel" id="c-tel" value="${esc(d.telefone)}"></div>
        </div>
        <p class="suave pequeno" style="margin-top:-4px">Os e-mails vão começar assim: <b id="c-previa">${esc(saudacao(d.nomePreferido || d.responsavel))}</b></p>
        <button class="btn btn-primario" id="b-nome">Salvar nome</button>
      </form>
    </div>
    <div class="bloco">
      <h2>E-mail para os avisos</h2>
      <p>${d.email ? `${sso() ? 'Os avisos dos chamados vão' : 'Os avisos e a senha temporária, se você esquecer a sua, vão'} para <b>${esc(d.email)}</b>.` : '<span class="atrasado">Obrigatório: cadastre o e-mail de quem usa este login.</span>'}</p>
      <form id="f-email">
        <div class="campo"><label for="c-email">${d.email ? 'Novo e-mail' : 'Seu e-mail'}</label><input type="email" id="c-email" spellcheck="false" autocapitalize="none" autocomplete="email" required></div>
        <div class="campo" id="c-passo2" hidden><p class="suave" id="c-msg"></p>
          <label for="c-codigo">Código de 6 dígitos</label><input type="text" id="c-codigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code" spellcheck="false"></div>
        <div class="opcoes" style="align-items:center">
          <button class="btn btn-primario" id="b-email">Enviar código de confirmação</button>
          <button type="button" class="btn-link" id="b-email-outro" hidden>Usar outro e-mail</button>
        </div>
        <p class="suave pequeno" style="margin-top:10px">Confirmamos o e-mail com um código para garantir que os avisos${sso() ? '' : ' e a recuperação de senha'} cheguem no endereço certo.</p>
      </form>
    </div>
    ${primeiraVez && d.email ? '<p style="margin-top:16px"><button class="btn" id="b-depois">Continuar para meus chamados</button></p>' : ''}
    ${primeiraVez && !d.email ? '<p class="suave" style="margin-top:16px">Para continuar, confirme o e-mail de quem usa este login. É para ele que enviamos os avisos dos chamados' + (sso() ? '' : ' e a senha temporária se você esquecer a sua') + '.</p>' : ''}
  </div>`;
  if ($('#b-voltar')) $('#b-voltar').onclick = telaCliente;
  if ($('#b-depois')) $('#b-depois').onclick = () => { S.cadastroAdiado = true; telaCliente(); };
  $('#c-nome').oninput = () => { $('#c-previa').textContent = saudacao($('#c-nome').value.trim()); };
  const atualizarSessao = async () => { await acao(null, carregarSessao); topo(); };
  $('#f-nome').onsubmit = async ev => {
    ev.preventDefault();
    const r = await acao($('#b-nome'), () => api('salvarMeuNome', S.token, $('#c-nome').value, $('#c-tel').value));
    if (!r) return;
    aviso(r, 'ok');
    await atualizarSessao();
    if (primeiraVez && !S.usuario.cadastroIncompleto) home();
  };
  let passo = 1;
  $('#b-email-outro').onclick = () => {
    passo = 1; $('#c-passo2').hidden = true; $('#b-email-outro').hidden = true; $('#c-email').readOnly = false;
    $('#b-email').textContent = 'Enviar código de confirmação'; $('#c-email').focus();
  };
  $('#f-email').onsubmit = async ev => {
    ev.preventDefault();
    if (passo === 1) {
      const r = await acao($('#b-email'), () => api('pedirTrocaEmail', S.token, $('#c-email').value));
      if (!r) return;
      passo = 2;
      $('#c-msg').textContent = r; $('#c-passo2').hidden = false; $('#b-email-outro').hidden = false; $('#c-email').readOnly = true;
      $('#b-email').textContent = 'Confirmar e-mail'; $('#c-codigo').focus();
      return;
    }
    const r = await acao($('#b-email'), () => api('confirmarTrocaEmail', S.token, $('#c-codigo').value));
    if (!r) return;
    aviso(r, 'ok');
    await atualizarSessao();
    if (primeiraVez && !S.usuario.cadastroIncompleto) return home();
    telaMeuCadastro(primeiraVez);
  };
}

// ───────── Cliente: meus chamados ─────────
async function telaCliente() {
  lembrarTela('cliente');
  topo();
  marcarAba('cliente');
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Carregando seus chamados…</div>';
  let lista;
  try { lista = await api('meusChamados', S.token); } catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  S.cache.meus = lista;
  const pend = lista.filter(c => c.pesquisaPendente);
  const f = S.filtroCliente;
  // Cliente em vários projetos (conta Innomaker): mostra o projeto de cada chamado e permite filtrar
  const projetos = S.base.projetos || [];
  const varios = projetos.length > 1;
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>Meus chamados</h1><p class="suave" style="margin:0">Acompanhe o atendimento e converse com a nossa equipe.</p></div>
      <button class="btn btn-primario" id="b-novo">${iconeInterface('novo')}Abrir chamado</button></div>
    <div class="contadores">
      <div><b>${lista.filter(c => !FINAIS.includes(c.Status)).length}</b>em andamento</div>
      <div><b>${lista.filter(c => c.Status === 'Aguardando cliente').length}</b>aguardando sua resposta</div>
      <div><b>${lista.filter(c => c.Status === 'Resolvido').length}</b>soluções para conferir</div>
      <div><b>${lista.filter(c => c.Status === 'Fechado').length}</b>finalizados</div>
    </div>
    ${S.usuario.cadastroIncompleto ? `<div class="painel-acao atencao"><b>${S.usuario.email ? 'Diga como prefere ser chamado.' : 'Cadastre seu e-mail para receber os avisos dos chamados.'}</b>
      <button class="btn-link" id="b-completar">Completar meu cadastro</button></div>` : ''}
    ${pend.length ? `<div class="painel-acao"><b>Conte como foi o atendimento.</b> ${pend.length === 1 ? 'Um chamado fechado espera' : pend.length + ' chamados fechados esperam'} sua avaliação:
      ${pend.map(c => `<button class="btn-link" data-abrir="${esc(c.Id)}">${esc(c.Id)}</button>`).join(', ')}</div>` : ''}
    <div class="filtros">
      ${varios ? `<select id="f-projeto" aria-label="Projeto"><option value="">Todos os projetos</option>${projetos.map(p => `<option value="${esc(p.id)}" ${f.projeto === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select>` : ''}
      <input type="search" id="f-busca" placeholder="Buscar por número ou palavra…" value="${esc(f.busca || '')}" aria-label="Buscar">
      <select id="f-status" aria-label="Status"><option value="">Todos os status</option>${S.base.status.map(s => `<option ${f.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <input type="date" id="f-de" value="${esc(f.de || '')}" aria-label="Aberto a partir de">
      <input type="date" id="f-ate" value="${esc(f.ate || '')}" aria-label="Aberto até">
    </div>
    <div id="lista" class="lista"></div>`;
  $('#b-novo').onclick = () => telaNovoChamado(false);
  if ($('#b-completar')) $('#b-completar').onclick = () => telaMeuCadastro(false);
  $$('[data-abrir]').forEach(b => b.onclick = () => telaDetalhe(b.dataset.abrir));
  const render = () => {
    Object.assign(f, { busca: $('#f-busca').value, status: $('#f-status').value, de: $('#f-de').value, ate: $('#f-ate').value, projeto: varios ? $('#f-projeto').value : '' });
    const q = (f.busca || '').toLowerCase();
    const itens = lista.filter(c => (!f.status || c.Status === f.status) && (!f.projeto || c.ProjetoId === f.projeto) &&
      (!q || (c.Id + ' ' + c.Titulo + ' ' + c.Modulo + ' ' + c.Categoria).toLowerCase().includes(q)) &&
      (!f.de || diaISO(c.Abertura) >= f.de) && (!f.ate || diaISO(c.Abertura) <= f.ate));
    $('#lista').innerHTML = !lista.length
      ? `<div class="vazio">Você ainda não abriu chamados. Use <b>Abrir chamado</b> quando precisar de suporte.</div>`
      : !itens.length ? `<div class="vazio">Nenhum chamado com esses filtros.</div>`
      : itens.map(c => linhaChamado(c, false, varios)).join('');
    $$('#lista .linha-ch').forEach(b => b.onclick = () => telaDetalhe(b.dataset.id));
  };
  ['#f-busca', '#f-status', '#f-de', '#f-ate', '#f-projeto'].forEach(s => { if ($(s)) $(s).oninput = render; });
  render();
}

// Cliente: o que cada status significa e o que fazer (item "Como funciona" do menu)
function telaComoFunciona() {
  lembrarTela('como');
  topo();
  marcarAba('como');
  app.innerHTML = `<div class="cabeca-lista"><div><h1>Como funciona</h1><p class="suave" style="margin:0">O caminho de um chamado, do registro até o fechamento.</p></div></div>
    <div class="bloco">
      <div class="rolagem"><table><thead><tr><th>Status</th><th>O que significa</th><th>O que você faz</th></tr></thead><tbody>
      ${[['Aberto', 'Chamado registrado, na fila por ordem de chegada', 'Aguarda; pode complementar pelo chat'],
         ['Em triagem', 'O atendimento confere categoria, módulo e se o sistema está bloqueado', 'Aguarda'],
         ['Em atendimento', 'O atendimento está trabalhando na solução', 'Acompanha e responde pelo chat'],
         ['Aguardando cliente', 'Falta uma informação ou um teste seu', `Responde em até ${S.base.diasAutoFechamento} dias úteis; sem resposta, o chamado fecha`],
         ['Encaminhado ao setor', 'Um setor especializado está cuidando do seu caso', 'Aguarda; o atendimento continua sendo seu contato'],
         ['Resolvido', 'A correção ou a resposta foi enviada', `Confirma a correção ou pede reajuste em até ${S.base.diasAutoFechamento} dias úteis`],
         ['Fechado', 'Chamado encerrado', `Responde a pesquisa; pode reabrir em até ${S.base.diasReabertura} dias úteis`],
         ['Cancelado', 'Duplicado, aberto por engano ou fora do escopo', 'Nada; o motivo chega por e-mail']]
        .map(([st, sig, faz]) => `<tr><td>${chipStatus(st)}</td><td>${sig}</td><td>${faz}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="pequeno suave" style="margin:14px 0 0">Prazo de solução: ${S.base.prazoNormal} dias úteis, de segunda a sexta, das ${S.publico.horaInicio}h às ${S.publico.horaFim}h, sem contar feriados. Se o sistema estiver bloqueado, o chamado passa à frente da fila. Você recebe um e-mail a cada mudança de status e pode fechar um chamado a qualquer momento pelo botão <b>Fechar chamado</b>.</p>
    </div>`;
}

function linhaChamado(c, equipe, mostrarProjeto) {
  const prazo = FINAIS.includes(c.Status) ? '' : `<span class="${c.atrasado ? 'atrasado' : ''}">Prazo ${fmtDH(c.Prazo)}${c.atrasado ? ' (vencido)' : ''}</span>`;
  return `<button class="linha-ch ${c.Prioridade === 'Bloqueio' ? 'bloq' : ''}" data-id="${esc(c.Id)}">
    <span class="protocolo" translate="no">${esc(c.Id)}</span>
    <span class="tit">${equipe || mostrarProjeto ? `<span class="suave">${esc(c.Projeto)}:</span> ` : ''}${esc(c.Titulo)}</span>
    <span>${c.naoLidas ? `<span class="chip chip-nova">${c.naoLidas} ${c.naoLidas === 1 ? 'nova' : 'novas'}</span>` : ''}${c.Prioridade === 'Bloqueio' ? '<span class="chip chip-bloqueio">Bloqueio</span> ' : ''}${chipStatus(c.Status)}</span>
    <span class="meta"><span>${c.Modulo ? esc(c.Modulo) + ', ' : ''}${esc(c.Categoria)}</span><span>Aberto ${fmtDH(c.Abertura)}</span>
      <span>Atualizado ${fmtDH(c.UltimaAtualizacao)}</span>${equipe && c.Setor ? `<span>Setor ${esc(c.Setor)}</span>` : ''}${equipe && !FINAIS.includes(c.Status) ? (c.Atendente ? `<span>Atendente ${esc(c.Atendente)}</span>` : '<span class="sem-atendente">Sem atendente</span>') : ''}${prazo}
      ${c.pesquisaPendente ? '<span class="atrasado">Pesquisa pendente</span>' : ''}</span>
  </button>`;
}

// ───────── Novo chamado (cliente ou N1 por telefone) ─────────
async function telaNovoChamado(porTelefone) {
  lembrarTela(porTelefone ? 'telefone' : 'novo');
  if (!porTelefone) marcarAba('novo');
  const nav = novaTela();
  let clientes = [];
  if (porTelefone) {
    app.innerHTML = '<div class="carregando">Carregando projetos…</div>';
    try { clientes = (await api('listarProjetos', S.token)).filter(c => c.Ativo); }
    catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
    if (nav !== S.nav) return;
  } else if ((S.base.projetos || []).length > 1) {
    // Cliente em vários projetos escolhe o projeto do chamado
    clientes = S.base.projetos.map(p => ({ ProjetoId: p.id, Projeto: p.nome, modulos: p.modulos }));
  }
  const escolher = porTelefone || clientes.length > 1;
  const b = S.base;
  app.innerHTML = `
  ${porTelefone ? '' : '<button class="btn-link voltar" id="b-voltar">Voltar para meus chamados</button>'}
  <div class="bloco" style="max-width:760px">
    <h1>${porTelefone ? 'Registrar ligação como chamado' : 'Abrir chamado'}</h1>
    <p class="suave">Um chamado por assunto. Se forem dois problemas diferentes, abra dois chamados.</p>
    <form id="f-novo" autocomplete="off">
      ${escolher ? `<div class="campo"><label for="n-cliente">${porTelefone ? 'Projeto de quem ligou' : 'Projeto'}</label>
        <select id="n-cliente" required><option value="">Escolha…</option>${clientes.map(c => `<option value="${esc(c.ProjetoId)}">${esc(c.Projeto)}${c.Responsavel ? ', ' + esc(c.Responsavel) : ''}</option>`).join('')}</select>
        ${clientes.length ? '' : '<div class="ajuda">Nenhum projeto ativo. O administrador cria projetos na aba Projetos.</div>'}</div>` : ''}
      <div class="grade-2">
        <div class="campo"><label for="n-categoria">Categoria</label>
          <select id="n-categoria" required><option value="">Escolha…</option>${b.categorias.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="campo" id="campo-modulo"><label for="n-modulo">Módulo do sistema</label>
          <select id="n-modulo"></select></div>
      </div>
      <div class="campo"><label for="n-titulo">Título</label><input type="text" id="n-titulo" maxlength="150" required placeholder="Ex.: Nota fiscal não é emitida no pedido de venda…"></div>
      <div class="campo"><label for="n-aconteceu">O que aconteceu ou o que você precisa</label><textarea id="n-aconteceu" required></textarea></div>
      <div class="grade-2">
        <div class="campo"><label for="n-fez">O que você fez antes</label><textarea id="n-fez" placeholder="Passo a passo, se for um erro…"></textarea></div>
        <div class="campo"><label for="n-esperava">O que esperava que acontecesse</label><textarea id="n-esperava"></textarea></div>
      </div>
      <div class="campo"><label id="lb-bloq">O sistema está bloqueado?</label>
        <div class="opcoes" role="radiogroup" aria-labelledby="lb-bloq">
          <label><input type="radio" name="bloq" value="Sim" required> Sim, não consigo operar</label>
          <label><input type="radio" name="bloq" value="Não"> Não</label></div>
        <div class="ajuda">Bloqueio é quando a operação para, por exemplo: não emite nota ou não fatura. Esses chamados passam à frente da fila.</div></div>
      ${campoArquivos('n-arquivos')}
      <button class="btn btn-primario" id="b-enviar">${porTelefone ? 'Registrar chamado' : 'Abrir chamado'}</button>
      <button type="button" class="btn" id="b-cancelar-chamado">Cancelar</button>
      <span id="progresso" class="suave pequeno" style="margin-left:10px"></span>
    </form>
  </div>`;
  if ($('#b-voltar')) $('#b-voltar').onclick = telaCliente;
  $('#b-cancelar-chamado').onclick = () => porTelefone ? telaEquipe('fila') : telaCliente();
  ligarArquivos('n-arquivos');
  const montarModulos = mods => {
    const tem = mods && mods.length;
    $('#campo-modulo').hidden = !tem;
    $('#n-modulo').required = !!tem;
    $('#n-modulo').innerHTML = tem ? '<option value="">Escolha…</option>' + mods.map(m => `<option>${esc(m)}</option>`).join('') : '';
  };
  if (escolher) {
    montarModulos([]);
    $('#n-cliente').onchange = () => montarModulos((clientes.find(c => c.ProjetoId === $('#n-cliente').value) || {}).modulos);
  } else montarModulos(b.modulos);
  $('#f-novo').onsubmit = async ev => {
    ev.preventDefault();
    const partes = [];
    const fez = $('#n-fez').value.trim(), esp = $('#n-esperava').value.trim(), acon = $('#n-aconteceu').value.trim();
    if (fez) partes.push('O que fez:\n' + fez);
    if (esp) partes.push('O que esperava:\n' + esp);
    partes.push((fez || esp ? 'O que aconteceu:\n' : '') + acon);
    const dados = {
      projetoId: escolher ? $('#n-cliente').value : '', categoria: $('#n-categoria').value, modulo: $('#n-modulo').value,
      titulo: $('#n-titulo').value, descricao: partes.join('\n\n'), bloqueio: ($('input[name=bloq]:checked') || {}).value || ''
    };
    const btn = $('#b-enviar');
    const id = await acao(btn, () => api('abrirChamado', S.token, dados));
    if (!id) return;
    const arquivos = arquivosDe('n-arquivos');
    if (arquivos.length) {
      btn.disabled = true;
      try { await enviarArquivos(id, arquivos, false, (i, n, nome) => { $('#progresso').textContent = `Enviando anexo ${i} de ${n}: ${nome}`; }); }
      catch (e) { return; }
    }
    aviso(`Chamado ${id} aberto. Você recebe um e-mail a cada mudança de status.`, 'ok');
    telaDetalhe(id);
  };
}

// ───────── Detalhe do chamado ─────────
function trilha(status) {
  if (status === 'Cancelado') return '<div class="trilha-cancelada">Este chamado foi cancelado.</div>';
  let pos = TRILHA.indexOf(status), desvio = '';
  if (status === 'Aguardando cliente' || status === 'Encaminhado ao setor') { pos = 2; desvio = status; }
  return `<ol class="trilha" aria-label="Andamento do chamado">${TRILHA.map((s, i) =>
    `<li class="${i < pos ? 'feito' : i === pos ? 'atual' : ''}" ${i === pos ? 'aria-current="step"' : ''}><span>${s}</span>${i === pos && desvio ? `<em>${desvio}</em>` : ''}</li>`).join('')}</ol>`;
}

async function telaDetalhe(id) {
  lembrarTela('detalhe', id);
  topo();
  if (S.usuario.tipo === 'cliente') marcarAba('cliente');
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Abrindo chamado…</div>';
  let d;
  try { d = await api('detalheChamado', S.token, id); }
  catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  const c = d.chamado, a = d.acoes, ehCliente = S.usuario.tipo === 'cliente', ehN1 = !!S.usuario.n1;

  app.innerHTML = `
  <button class="btn-link voltar" id="b-voltar">${ehCliente ? 'Voltar para meus chamados' : 'Voltar para a fila'}</button>
  <header class="det-cabeca">
    <span class="protocolo" translate="no">${esc(c.Id)}</span>
    <h1>${esc(c.Titulo)}</h1>
    <div class="chips">${chipStatus(c.Status)}${c.Prioridade === 'Bloqueio' ? '<span class="chip chip-bloqueio">Bloqueio</span>' : ''}</div>
  </header>
  ${trilha(c.Status)}
  <div class="det-grade">
    <div>
      <div id="painel"></div>
      <section class="bloco chat" id="chat"></section>
      <section class="bloco"><h2>Anexos</h2>
        ${d.anexos.length ? `<ul class="anexos">${d.anexos.map(x => `<li>${ehImagem(x.Nome) ? miniatura(x.ArquivoId, x.Nome) : ''}<span><b>${esc(x.Nome)}</b> <span class="suave pequeno">${tamanho(x.Tamanho)}, ${esc(x.Autor)}, ${fmtDH(x.DataHora)}${x.interno ? ', interno' : ''}</span></span>
          <button class="btn" data-baixar="${esc(x.ArquivoId)}">Baixar</button></li>`).join('')}</ul>` : '<p class="suave">Nenhum anexo.</p>'}
      </section>
    </div>
    <aside class="lateral" id="lateral">
      <div class="bloco"><h3>Dados do chamado</h3>
        <dl class="dados">
          ${!ehCliente ? `<dt>Projeto</dt><dd>${esc(c.Projeto)}</dd>` : ''}
          <dt>Categoria</dt><dd>${esc(c.Categoria)}</dd>
          ${c.Modulo ? `<dt>Módulo</dt><dd>${esc(c.Modulo)}</dd>` : ''}
          <dt>Bloqueado</dt><dd>${esc(c.Bloqueio)}</dd>
          <dt>Aberto em</dt><dd>${fmtDH(c.Abertura)}</dd>
          <dt>Canal</dt><dd>${esc(c.Canal)}</dd>
          ${FINAIS.includes(c.Status) ? '' : `<dt>Prazo</dt><dd>${fmtDH(c.Prazo)}</dd>`}
          <dt>Atualizado</dt><dd>${fmtDH(c.UltimaAtualizacao)}</dd>
          ${c.Setor ? `<dt>Setor</dt><dd>${esc(c.Setor)}</dd>` : ''}
          ${Number(c.Reaberturas) ? `<dt>Reaberturas</dt><dd>${esc(c.Reaberturas)}</dd>` : ''}
          ${c.MotivoCancelamento ? `<dt>Motivo</dt><dd>${esc(c.MotivoCancelamento)}</dd>` : ''}
        </dl>
        ${ehN1 && sso() ? `<hr style="border:0;border-top:1px solid var(--linha);margin:14px 0"><dl class="dados">
          <dt>Cliente</dt><dd>${esc(c.Usuario || '—')}</dd><dt>E-mail</dt><dd>${esc(c.Email || 'sem e-mail: não recebe avisos')}</dd></dl>`
        : ehN1 && c.contato ? `<hr style="border:0;border-top:1px solid var(--linha);margin:14px 0"><dl class="dados">
          <dt>Login</dt><dd>${esc(c.contato.login)}</dd><dt>Responsável</dt><dd>${esc(c.contato.usuario || '—')}</dd><dt>E-mail</dt><dd>${esc(c.contato.email || 'sem e-mail: não recebe avisos')}</dd>
          ${c.contato.telefone ? `<dt>Telefone</dt><dd>${esc(c.contato.telefone)}</dd>` : ''}</dl>` : ''}
      </div>
      ${a.excluir ? '<div class="bloco"><button type="button" class="btn btn-perigo" id="b-excluir-chamado">Excluir chamado</button></div>' : ''}
    </aside>
  </div>`;

  $('#b-voltar').onclick = () => ehCliente ? telaCliente() : telaEquipe('fila');
  if ($('#b-excluir-chamado')) $('#b-excluir-chamado').onclick = async e => {
    if (!confirmarExclusao(`o chamado ${c.Id}`, 'O chamado, o histórico, as mensagens, os anexos e a pesquisa serão removidos. Esta ação não pode ser desfeita pelo portal.')) return;
    if (await acao(e.target, () => api('excluirChamado', S.token, c.Id), 'Chamado excluído.')) {
      pararChat();
      telaEquipe('fila');
    }
  };
  $$('[data-baixar]').forEach(b => b.onclick = () => baixar(c.Id, b.dataset.baixar, b));
  if ($('ul.anexos')) mostrarImagens($('ul.anexos'), c.Id);
  const recarregar = () => telaDetalhe(c.Id);

  if (ehCliente) painelCliente(c, d, a, recarregar);
  else if (ehN1) painelN1(c, a, recarregar);
  else painelSetor(c, a, recarregar);
  montarChat(c, d);
}

function painelCliente(c, d, a, recarregar) {
  const p = $('#painel');
  // Fechar chamado: o cliente encerra quando quiser (resolveu por conta própria, não precisa mais...)
  const fechar = a.fechar ? `<div class="painel-acao painel-fechar"><div class="painel-fechar-linha">
      <p style="margin:0"><b>Não precisa mais deste chamado?</b> Você pode encerrá-lo agora. Se o problema voltar, dá para reabrir.</p>
      <button class="btn" id="b-fechar">Fechar chamado</button></div>
    <div id="fechar-form" hidden style="margin-top:12px"><div class="campo"><label for="t-fechar">Motivo (opcional)</label><textarea id="t-fechar" placeholder="Ex.: resolvi por conta própria"></textarea></div>
      <div class="botoes"><button class="btn btn-primario" id="b-confirmar-fechar">Confirmar fechamento</button><button class="btn" id="b-cancelar-fechar">Cancelar</button></div></div></div>` : '';
  const ligarFechar = () => {
    if (!$('#b-fechar')) return;
    $('#b-fechar').onclick = () => { $('#fechar-form').hidden = false; $('#b-fechar').hidden = true; $('#t-fechar').focus(); };
    $('#b-cancelar-fechar').onclick = () => { $('#fechar-form').hidden = true; $('#b-fechar').hidden = false; };
    $('#b-confirmar-fechar').onclick = async e => {
      if (await acao(e.target, () => api('fecharChamado', S.token, c.Id, $('#t-fechar').value), 'Chamado fechado.')) recarregar();
    };
  };
  if (a.pesquisa) {
    p.innerHTML = `<div class="painel-acao"><h3>Como foi o atendimento?</h3><div id="pesq"></div></div>`;
    formPesquisa({ token: S.token }, c.Id, $('#pesq'), recarregar);
    return;
  }
  if (a.confirmar) {
    p.innerHTML = `<div class="painel-acao"><h3>Confira a correção</h3>
      <p>Teste no sistema e diga se ficou certo. Sem resposta até <b>${fmtDH(d.limiteResposta)}</b>, o chamado é fechado.</p>
      <div class="botoes"><button class="btn btn-primario" id="b-confirmar">Confirmar correção</button>
      <button class="btn" id="b-reajuste">Pedir reajuste</button></div>
      <div id="reajuste" hidden style="margin-top:12px"><div class="campo"><label for="t-reajuste">O que ainda não está certo?</label><textarea id="t-reajuste"></textarea></div>
      <button class="btn btn-primario" id="b-env-reajuste">Enviar pedido de reajuste</button></div></div>`;
    $('#b-confirmar').onclick = async e => { if (await acao(e.target, () => api('confirmarCorrecao', S.token, c.Id), 'Correção confirmada. Chamado fechado.')) recarregar(); };
    $('#b-reajuste').onclick = () => { $('#reajuste').hidden = false; $('#t-reajuste').focus(); };
    $('#b-env-reajuste').onclick = async e => { if (await acao(e.target, () => api('solicitarReajuste', S.token, c.Id, $('#t-reajuste').value), 'Reajuste pedido. O chamado voltou para atendimento.')) recarregar(); };
    return;
  }
  if (c.Status === 'Aguardando cliente') {
    p.innerHTML = `<div class="painel-acao atencao"><h3>Precisamos da sua resposta</h3>
      <p style="margin:0">Responda no chat abaixo até <b>${fmtDH(d.limiteResposta)}</b>. Depois disso, o chamado é fechado.</p></div>${fechar}`;
    ligarFechar();
    return;
  }
  if (c.Status === 'Fechado') {
    if (a.reabrir) {
      p.innerHTML = `<div class="painel-acao"><h3>O problema voltou?</h3>
        <p>Você pode reabrir este chamado até <b>${fmtDH(d.limiteReabertura)}</b>.</p>
        <div class="campo"><label for="t-reabrir">O que aconteceu</label><textarea id="t-reabrir"></textarea></div>
        <button class="btn btn-primario" id="b-reabrir">Reabrir chamado</button></div>`;
      $('#b-reabrir').onclick = async e => { if (await acao(e.target, () => api('reabrir', S.token, c.Id, $('#t-reabrir').value), 'Chamado reaberto.')) recarregar(); };
    } else {
      p.innerHTML = `<div class="painel-acao atencao"><p style="margin:0">O prazo para reabrir terminou. Se precisar, <button class="btn-link" id="b-novo2">abra um novo chamado</button>.</p></div>`;
      $('#b-novo2').onclick = () => telaNovoChamado(false);
    }
    return;
  }
  // Em andamento (aberto, em triagem, em atendimento, encaminhado): só a opção de fechar
  p.innerHTML = fechar;
  ligarFechar();
}

function painelN1(c, a, recarregar) {
  const lat = $('#lateral');
  const b = S.base;
  let html = '';
  if (a.classificar) html += `<div class="bloco" data-editor-acao="Editar triagem"><h3>Triagem</h3>
    <div class="campo"><label for="c-cat">Categoria</label><select id="c-cat">${b.categorias.map(x => `<option ${x === c.Categoria ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
    ${(c.modulosProjeto || []).length ? `<div class="campo"><label for="c-mod">Módulo</label><select id="c-mod">${c.Modulo ? '' : '<option value="">Escolha…</option>'}${c.modulosProjeto.map(x => `<option ${x === c.Modulo ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>` : ''}
    <div class="campo"><label for="c-pri">Prioridade</label><select id="c-pri">${['Normal', 'Bloqueio'].map(x => `<option ${x === c.Prioridade ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <div class="ajuda">O cliente respondeu "${esc(c.Bloqueio)}" para sistema bloqueado.</div></div>
    <button class="btn ${c.Status === 'Aberto' ? 'btn-primario' : ''}" id="b-classif">${c.Status === 'Aberto' ? 'Confirmar triagem' : 'Salvar triagem'}</button></div>`;
  if (a.transicoes.length) html += `<div class="bloco" data-editor-acao="Alterar status"><h3>Mudar status</h3>
    <div class="campo"><label for="s-novo">Novo status</label><select id="s-novo">${a.transicoes.map(x => `<option>${esc(x)}</option>`).join('')}</select></div>
    <div class="campo"><label for="s-msg">Mensagem ao cliente</label><textarea id="s-msg"></textarea>
      <div class="ajuda">Obrigatória para Aguardando cliente (o que falta), Resolvido (o que foi feito) e Cancelado (motivo). Vai no e-mail.</div></div>
    <button class="btn btn-primario" id="b-status">Aplicar status</button></div>`;
  if (a.encaminhar) html += `<div class="bloco" data-editor-acao="Encaminhar ao setor"><h3>Encaminhar ao setor</h3>
    <div class="campo"><label for="e-setor">Setor</label><select id="e-setor">${b.setores.map(x => `<option ${x === (c.Setor || setorSugerido(c.Categoria)) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      ${c.Setor ? '' : `<div class="ajuda">Sugestão pela categoria: ${esc(setorSugerido(c.Categoria))}.</div>`}</div>
    <div class="campo"><label for="e-nota">O que o setor precisa fazer</label><textarea id="e-nota"></textarea><div class="ajuda">Nota interna; o cliente não vê.</div></div>
    <button class="btn" id="b-encaminhar">Encaminhar</button></div>`;
  // Atendimento: quem cuida do chamado; assumir, ou transferir para outro N1 (quem transfere deixa de ver)
  if (a.assumir || a.transferir) {
    html = `<div class="bloco"><h3>Atendimento</h3>
      <p class="atendente-atual">${c.atendenteNome ? `Atendente: <b>${esc(c.atendenteNome)}</b>` : 'Ninguém assumiu este chamado ainda.'}</p>
      ${a.assumir ? `<button class="btn ${c.atendenteNome ? '' : 'btn-primario'}" id="b-assumir">Assumir atendimento</button>` : ''}</div>
      ${a.transferir ? `<div class="bloco" data-editor-acao="Transferir para outro N1"><h3>Transferir</h3>
        <div class="campo"><label for="t-para">Para quem</label><select id="t-para"><option value="">Carregando…</option></select></div>
        <div class="campo"><label for="t-nota">Nota para quem recebe (opcional)</label><textarea id="t-nota"></textarea>
          <div class="ajuda">Depois de transferir, você deixa de ver este chamado. Para só pedir ajuda a um setor sem perder o chamado, use Encaminhar ao setor.</div></div>
        <button class="btn btn-primario" id="b-transferir">Transferir</button></div>` : ''}` + html;
  }
  lat.insertAdjacentHTML('beforeend', html);
  const selectAtendente = $('#t-para'), navAtendente = S.nav;
  if (selectAtendente) api('atendentesN1', S.token).then(lista => {
    if (navAtendente !== S.nav || !selectAtendente.isConnected) return;
    const outros = lista.filter(x => x.login !== S.usuario.login);
    selectAtendente.innerHTML = outros.length ? '<option value="">Escolha…</option>' + outros.map(x => `<option value="${esc(x.login)}">${esc(x.nome)}${x.perfil === 'Admin' ? ' (Admin)' : ''}</option>`).join('')
      : '<option value="">Ninguém mais no N1</option>';
  }).catch(() => { });
  $$('[data-editor-acao]', lat).forEach(painel => {
    const titulo = painel.dataset.editorAcao;
    const bloco = document.createElement('div');
    bloco.className = 'bloco';
    bloco.innerHTML = `<h3>${esc($('h3', painel).textContent)}</h3><button type="button" class="btn" data-abrir-acao>${esc(titulo)}</button>`;
    painel.before(bloco);
    painel.hidden = true;
    const cancelar = document.createElement('button');
    cancelar.type = 'button'; cancelar.className = 'btn'; cancelar.textContent = 'Cancelar';
    cancelar.onclick = () => fecharEditor();
    painel.appendChild(cancelar);
    $('[data-abrir-acao]', bloco).onclick = () => abrirEditor(painel, titulo);
  });
  if ($('#b-assumir')) $('#b-assumir').onclick = async e => {
    if (await acao(e.target, () => api('assumirChamado', S.token, c.Id), 'Você assumiu o atendimento.')) recarregar();
  };
  if ($('#b-transferir')) $('#b-transferir').onclick = async e => {
    if (!$('#t-para').value) return aviso('Escolha para quem transferir.', 'erro');
    const r = await acao(e.target, () => api('transferirChamado', S.token, c.Id, $('#t-para').value, $('#t-nota').value));
    if (!r) return;
    fecharEditor(true);
    aviso('Chamado transferido para ' + r.para + '.', 'ok');
    if (r.saiu) telaEquipe('fila'); else recarregar();
  };
  if ($('#b-classif')) $('#b-classif').onclick = async e => {
    const r = await acao(e.target, () => api('salvarClassificacao', S.token, c.Id, { categoria: $('#c-cat').value, modulo: $('#c-mod') ? $('#c-mod').value : '', prioridade: $('#c-pri').value }));
    if (r) { aviso(r, 'ok'); recarregar(); }
  };
  if ($('#b-status')) $('#b-status').onclick = async e => {
    const novo = $('#s-novo').value;
    if (novo === 'Cancelado' && !confirm('Cancelar este chamado? O cliente recebe o motivo por e-mail.')) return;
    if (await acao(e.target, () => api('alterarStatus', S.token, c.Id, novo, $('#s-msg').value), 'Status alterado para ' + novo + '. Cliente avisado por e-mail.')) recarregar();
  };
  if ($('#b-encaminhar')) $('#b-encaminhar').onclick = async e => {
    if (await acao(e.target, () => api('encaminhar', S.token, c.Id, $('#e-setor').value, $('#e-nota').value), 'Encaminhado ao setor ' + $('#e-setor').value + '.')) recarregar();
  };
}

// Regra 6: melhorias e erros vão para Software; financeiro/contrato para Financeiro
function setorSugerido(categoria) {
  const k = slug(categoria);
  if (/financeiro|contrato|cobranca|boleto/.test(k)) return 'Financeiro';
  if (/comercial|venda|proposta|plano/.test(k)) return 'Comercial';
  return 'Software';
}

function painelSetor(c, a, recarregar) {
  if (!a.devolver) return;
  $('#lateral').insertAdjacentHTML('beforeend', `<div class="bloco"><h3>Devolver ao N1</h3>
    <div class="campo"><label for="d-nota">Retorno para o atendimento</label><textarea id="d-nota" placeholder="O que foi feito, versão corrigida, orientação ao cliente…"></textarea></div>
    <button class="btn btn-primario" id="b-devolver">Devolver ao N1</button></div>`);
  $('#b-devolver').onclick = async e => {
    if (await acao(e.target, () => api('devolverAoN1', S.token, c.Id, $('#d-nota').value), 'Devolvido ao N1.')) telaEquipe('fila');
  };
}

// ───────── Chat do chamado ─────────
S.rascunhos = {};

function pararChat() {
  cancelarGravacao();
  if (S.chat && S.chat.timer) clearTimeout(S.chat.timer);
  S.chat = null;
}

function canalDoItem(h) {
  if (h.Tipo === 'NOTA_INTERNA') return 'equipe';
  if (h.Tipo === 'ANEXO') return h.interno ? 'equipe' : 'cliente';
  if (h.Tipo === 'STATUS') return 'ambos';
  return 'cliente';
}

function montarChat(c, d) {
  const u = S.usuario;
  const canais = d.chat.canais;
  const ch = S.chat = {
    id: c.Id, c: c, acoes: d.acoes, itens: d.historico.slice(), total: d.historico.length, ver: d.chat.ver,
    canal: canais[0], canais: canais, naoVistas: {}, digitandoAte: 0, timer: null, rodando: false, denovo: false,
    podeCliente: d.chat.podeEscreverCliente
  };
  const rotulo = { cliente: u.tipo === 'cliente' ? 'Atendimento' : 'Chat com o projeto', equipe: 'Chat interno da equipe' };
  $('#chat').innerHTML = `
    <div class="chat-topo"><h2>Conversa</h2><div class="presenca" id="presenca"></div></div>
    ${canais.length > 1 ? `<div class="chat-abas" role="tablist">${canais.map(k => `<button role="tab" data-canal="${k}">${rotulo[k]}<span class="badge" data-badge="${k}" hidden></span></button>`).join('')}</div>` : ''}
    <div class="chat-feed" id="feed" role="log" aria-live="polite"></div>
    <div class="digitando" id="digitando"></div>
    <div id="chat-rodape"></div>`;
  $$('.chat-abas button').forEach(b => b.onclick = () => trocarCanal(b.dataset.canal));
  desenharPresenca(d.chat.ladoOnline);
  trocarCanal(ch.canal, true);
  agendarChat(4000);
}

function trocarCanal(canal, inicial) {
  const ch = S.chat;
  if (!ch) return;
  guardarRascunho();
  ch.canal = canal;
  ch.naoVistas[canal] = 0;
  $$('.chat-abas button').forEach(b => b.setAttribute('aria-selected', b.dataset.canal === canal));
  atualizarBadges();
  $('#feed').classList.toggle('interno', canal === 'equipe');
  desenharFeed(true);
  desenharRodape();
  if (!inicial) api('chatMarcarLido', S.token, ch.id, canal).catch(() => { });
}

function itensDoCanal(canal) {
  return S.chat.itens.filter(h => { const k = canalDoItem(h); return k === 'ambos' || k === canal; });
}

function desenharFeed(rolar) {
  const ch = S.chat, feed = $('#feed');
  if (!ch || !feed) return;
  const perto = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  let dia = '', html = '';
  const separador = iso => {
    const d = new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: 'long', year: 'numeric' });
    if (d === dia) return '';
    dia = d;
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: 'long', year: 'numeric' });
    return `<div class="dia">${d === hoje ? 'Hoje' : d}</div>`;
  };
  html += separador(ch.c.Abertura) + `<div class="bolha abertura"><div class="autor">${esc(ch.c.Usuario || ch.c.Projeto)} abriu o chamado</div>
    <div class="corpo">${esc(ch.c.Descricao)}</div><div class="hora">${fmtDH(ch.c.Abertura)}</div></div>`;
  // Mensagens seguidas do mesmo autor (até 5 min) formam um grupo: o nome aparece só na primeira
  let anterior = null;
  itensDoCanal(ch.canal).forEach(h => {
    const sep = separador(h.DataHora);
    const evento = !reagivel(h);
    const quem = h.meu ? 'eu' : h.Perfil + '|' + h.Autor;
    const continua = !evento && !sep && anterior && anterior.quem === quem && new Date(h.DataHora) - anterior.hora < 5 * 60000;
    html += sep + bolhaChat(h, continua);
    anterior = evento ? null : { quem, hora: new Date(h.DataHora) };
  });
  // Um áudio tocando continua tocando: o elemento antigo volta para o lugar do novo
  const tocando = $$('audio[data-audio]', feed).filter(a => !a.paused);
  feed.innerHTML = html;
  tocando.forEach(a => { const novo = $(`audio[data-audio="${CSS.escape(a.dataset.audio)}"]`, feed); if (novo) novo.replaceWith(a); });
  $$('[data-arq]', feed).forEach(b => b.onclick = () => baixar(ch.id, b.dataset.arq, b));
  $$('[data-ouvir]', feed).forEach(b => b.onclick = () => ouvirAudio(ch.id, b.dataset.ouvir, b));
  mostrarImagens(feed, ch.id);
  ligarAcoesChat(feed);
  if (rolar || perto) feed.scrollTop = feed.scrollHeight;
}

// Reações (como no WhatsApp) e respostas a uma mensagem específica
const EMOJIS_REACAO = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const reagivel = h => !!h.Id && ['MENSAGEM', 'NOTA_INTERNA', 'ANEXO'].includes(h.Tipo);
function nomeAutorChat(h) {
  if (h.meu) return 'Você';
  if (h.Perfil === 'Cliente' || h.Perfil === 'Sistema') return h.Perfil === 'Sistema' ? (h.Autor || 'Sistema') : h.Autor;
  return S.usuario.tipo === 'cliente' ? `${h.Autor}, atendimento` : `${h.Autor} (${h.Perfil})`;
}
const resumoChat = h => h.Tipo === 'ANEXO' ? (ehAudio(h.Texto) ? 'Áudio' : 'Arquivo: ' + h.Texto) : String(h.Texto || '').slice(0, 140);
// Gravações do próprio chat se chamam audio-....webm; outros .webm podem ser vídeo
const ehAudio = nome => /\.(ogg|oga|opus|mp3|m4a|wav|aac)$/i.test(nome) || /^audio-.*\.webm$/i.test(nome);

const ehImagem = nome => /\.(png|jpe?g|gif|webp|bmp)$/i.test(nome);

// Anexos vêm do Drive em base64: cada um é baixado uma vez e guardado como URL local para os redesenhos da tela
S.blobs = {};
const baixandoBlob = {};
function urlDoAnexo(id, ref) {
  if (S.blobs[ref]) return Promise.resolve(S.blobs[ref]);
  if (!baixandoBlob[ref]) baixandoBlob[ref] = api('baixarAnexo', S.token, id, ref).then(r => {
    const bin = atob(r.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return (S.blobs[ref] = URL.createObjectURL(new Blob([bytes], { type: r.tipo })));
  }).finally(() => { delete baixandoBlob[ref]; });
  return baixandoBlob[ref];
}

// O áudio só é baixado quando alguém pede para ouvir
async function ouvirAudio(id, ref, btn) {
  const url = await acao(btn, () => urlDoAnexo(id, ref));
  if (!url || !btn.isConnected) return;
  const audio = document.createElement('audio');
  audio.controls = true; audio.src = url; audio.dataset.audio = ref;
  btn.replaceWith(audio);
  audio.play().catch(() => { });
}

// Imagens aparecem direto como miniatura; um clique abre em tamanho grande
function mostrarImagens(raiz, id) {
  $$('img[data-img]', raiz).forEach(img => {
    const ref = img.dataset.img;
    if (S.blobs[ref]) img.src = S.blobs[ref];
    else urlDoAnexo(id, ref).then(url => { img.src = url; }).catch(e => { if (e.message !== 'SESSAO_EXPIRADA') img.closest('.miniatura').classList.add('falhou'); });
  });
  $$('[data-ver-img]', raiz).forEach(b => b.onclick = () => verImagem(id, b.dataset.verImg, b.dataset.nome));
}

async function verImagem(id, ref, nome) {
  let url;
  try { url = await urlDoAnexo(id, ref); } catch (e) { if (e.message !== 'SESSAO_EXPIRADA') aviso(e.message, 'erro'); return; }
  const d = document.createElement('dialog');
  d.className = 'visor-imagem';
  d.setAttribute('aria-label', nome);
  d.innerHTML = `<div class="visor-topo"><span>${esc(nome)}</span><button type="button" class="btn" data-visor-baixar>Baixar</button><button type="button" class="btn" data-visor-fechar>Fechar</button></div><img alt="${esc(nome)}">`;
  $('img', d).src = url;
  $('[data-visor-fechar]', d).onclick = () => d.close();
  $('[data-visor-baixar]', d).onclick = e => baixar(id, ref, e.currentTarget);
  d.onclick = e => { if (e.target === d) d.close(); };
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d);
  d.showModal();
}

const miniatura = (ref, nome) => `<button type="button" class="miniatura" data-ver-img="${esc(ref)}" data-nome="${esc(nome)}" aria-label="Ver imagem ${esc(nome)}" title="Ver imagem">
  <img data-img="${esc(ref)}" alt="${esc(nome)}"${S.blobs[ref] ? ` src="${S.blobs[ref]}"` : ''}></button>`;

// Mensagem de voz: grava com o microfone e envia como anexo (precisa de HTTPS ou localhost)
const LIMITE_GRAVACAO = 5 * 60000;
function podeGravar() { return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

function cancelarGravacao() {
  const g = S.gravacao;
  if (!g) return;
  S.gravacao = null;
  clearInterval(g.relogio); clearTimeout(g.limite);
  g.descartar = true;
  if (g.rec.state !== 'inactive') g.rec.stop();
  g.stream.getTracks().forEach(t => t.stop());
}

async function gravarAudio() {
  const ch = S.chat;
  if (!ch || S.gravacao || ch.pedindoMicrofone) return;
  ch.pedindoMicrofone = true;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) {
    aviso(window.isSecureContext ? 'Não foi possível usar o microfone. Verifique a permissão do navegador.' : 'Gravar áudio só funciona com o SAC aberto em HTTPS.', 'erro');
    return;
  } finally { ch.pedindoMicrofone = false; }
  if (S.chat !== ch) { stream.getTracks().forEach(t => t.stop()); return; }
  const tipo = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined);
  const g = S.gravacao = { rec, stream, partes: [], inicio: Date.now(), canal: ch.canal };
  rec.ondataavailable = e => { if (e.data.size) g.partes.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    if (g.descartar || !g.partes.length) return;
    const mime = rec.mimeType || g.partes[0].type || 'audio/webm';
    const ext = /ogg/.test(mime) ? 'ogg' : /mp4|aac/.test(mime) ? 'm4a' : 'webm';
    const agora = new Date(), dois = n => String(n).padStart(2, '0');
    const nome = `audio-${agora.getFullYear()}${dois(agora.getMonth() + 1)}${dois(agora.getDate())}-${dois(agora.getHours())}${dois(agora.getMinutes())}${dois(agora.getSeconds())}.${ext}`;
    const arquivo = new File(g.partes, nome, { type: mime.split(';')[0] });
    if ($('#digitando')) $('#digitando').textContent = 'Enviando arquivo…';
    try { await enviarArquivos(ch.id, [arquivo], g.canal === 'equipe'); } catch (err) { return; }
    if ($('#digitando')) $('#digitando').textContent = '';
    agendarChat(0);
  };
  rec.start(1000);
  const rod = $('#chat-rodape');
  rod.innerHTML = `<div class="chat-compor gravando">
    <button type="button" class="clip" id="grav-cancelar" aria-label="Descartar áudio" title="Descartar áudio">✕</button>
    <div class="campo-msg"><span class="ponto-gravando" aria-hidden="true"></span><span id="grav-tempo" aria-live="off">0:00</span><span class="suave pequeno">Gravando…</span></div>
    <button class="btn-enviar" id="grav-enviar" aria-label="Enviar áudio" title="Enviar áudio">${iconeInterface('enviar')}</button></div>`;
  g.relogio = setInterval(() => {
    const s = Math.floor((Date.now() - g.inicio) / 1000);
    if ($('#grav-tempo')) $('#grav-tempo').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 500);
  const terminar = enviar => {
    if (S.gravacao !== g) return;
    S.gravacao = null;
    clearInterval(g.relogio); clearTimeout(g.limite);
    g.descartar = !enviar;
    if (rec.state !== 'inactive') rec.stop();
    if (S.chat === ch) desenharRodape();
  };
  g.limite = setTimeout(() => { aviso('Áudio limitado a 5 minutos: enviando o que foi gravado.', 'ok'); terminar(true); }, LIMITE_GRAVACAO);
  $('#grav-cancelar').onclick = () => terminar(false);
  $('#grav-enviar').onclick = () => terminar(true);
}
// Pode responder no canal aberto? (mesma regra do campo de mensagem)
const podeEscreverCanal = () => { const ch = S.chat; return !!ch && (ch.canal === 'equipe' || (ch.podeCliente && ch.acoes.responder)); };

function bolhaChat(h, continua) {
  const hora = new Date(h.DataHora).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  if (h.Tipo === 'STATUS') return `<div class="evento">Status: <b>${esc(h.Texto)}</b> <span>${hora}</span></div>`;
  if (h.Tipo === 'AVISO' || h.Tipo === 'PESQUISA') return `<div class="evento">${esc(h.Texto)} <span>${hora}</span></div>`;
  const autor = h.meu || continua ? '' : esc(nomeAutorChat(h));
  const corpo = h.Tipo === 'ANEXO' && h.Ref && ehAudio(h.Texto)
    ? `<div class="arquivo audio">${S.blobs[h.Ref]
      ? `<audio controls src="${S.blobs[h.Ref]}" data-audio="${esc(h.Ref)}"></audio>`
      : `<button data-ouvir="${esc(h.Ref)}">▶ Ouvir áudio</button>`}<button data-arq="${esc(h.Ref)}">Baixar</button></div>`
    : h.Tipo === 'ANEXO' && h.Ref && ehImagem(h.Texto)
    ? `<div class="arquivo imagem">${miniatura(h.Ref, h.Texto)}<div class="arquivo-linha"><span>${esc(h.Texto)}</span><button data-arq="${esc(h.Ref)}">Baixar</button></div></div>`
    : h.Tipo === 'ANEXO'
    ? `<div class="arquivo"><span>Arquivo: <b>${esc(h.Texto)}</b></span>${h.Ref ? `<button data-arq="${esc(h.Ref)}">Baixar</button>` : ''}</div>`
    : `<div class="corpo">${esc(h.Texto)}</div>`;
  const citada = h.RespostaA ? S.chat.itens.find(x => x.Id === h.RespostaA) : null;
  const citacao = h.RespostaA ? `<button type="button" class="citacao" data-ir="${esc(h.RespostaA)}" title="Ver a mensagem respondida">
    <b>${esc(citada ? nomeAutorChat(citada) : 'Mensagem')}</b><span>${esc(citada ? resumoChat(citada) : 'mensagem indisponível')}</span></button>` : '';
  const reacoes = (h.reacoes || []).length ? `<div class="reacoes">${h.reacoes.map(r =>
    `<button type="button" class="reacao ${r.meu ? 'minha' : ''}" data-reagir="${esc(h.Id)}" data-emoji="${esc(r.emoji)}" title="${esc(r.nomes.join(', '))}" aria-label="${esc(r.emoji + ' ' + r.total + (r.meu ? ', sua reação' : ''))}">${esc(r.emoji)}<span>${r.total}</span></button>`).join('')}</div>` : '';
  const acoes = reagivel(h) ? `<div class="msg-acoes">
    <button type="button" class="msg-acao" data-abrir-reacoes="${esc(h.Id)}" aria-label="Reagir" title="Reagir">☺</button>
    ${podeEscreverCanal() ? `<button type="button" class="msg-acao" data-responder="${esc(h.Id)}" aria-label="Responder" title="Responder">↩</button>` : ''}</div>` : '';
  const classes = ['bolha', h.meu ? 'meu' : '', continua ? 'cont' : '', reacoes ? 'com-reacoes' : '', h.Perfil === 'Sistema' ? 'sistema' : ''].filter(Boolean).join(' ');
  return `<div class="${classes}" ${h.Id ? `data-msg="${esc(h.Id)}"` : ''}>${acoes}${autor ? `<div class="autor">${autor}</div>` : ''}${citacao}${corpo}<div class="hora">${hora}</div>${reacoes}</div>`;
}

function ligarAcoesChat(feed) {
  const ch = S.chat;
  $$('[data-abrir-reacoes]', feed).forEach(b => b.onclick = () => {
    const bolha = b.closest('.bolha');
    const aberto = $('.seletor-reacao', bolha);
    $$('.seletor-reacao', feed).forEach(s => s.remove());
    if (aberto) return;
    bolha.insertAdjacentHTML('beforeend', `<div class="seletor-reacao" role="group" aria-label="Escolha uma reação">${EMOJIS_REACAO.map(e =>
      `<button type="button" data-reagir="${esc(b.dataset.abrirReacoes)}" data-emoji="${e}" aria-label="Reagir com ${e}">${e}</button>`).join('')}</div>`);
    ligarAcoesChat(bolha);
  });
  $$('[data-reagir]', feed).forEach(b => b.onclick = async () => {
    $$('.seletor-reacao', $('#feed')).forEach(s => s.remove());
    try { await api('reagirChat', S.token, ch.id, b.dataset.reagir, b.dataset.emoji); } catch (e) { if (e.message !== 'SESSAO_EXPIRADA') aviso(e.message, 'erro'); return; }
    agendarChat(0);
  });
  $$('[data-responder]', feed).forEach(b => b.onclick = () => {
    const item = ch.itens.find(x => x.Id === b.dataset.responder);
    if (!item) return;
    guardarRascunho();
    ch.respondendo = { canal: ch.canal, item };
    desenharRodape();
    if ($('#chat-txt')) $('#chat-txt').focus();
  });
  $$('[data-ir]', feed).forEach(b => b.onclick = () => {
    const alvo = $(`#feed [data-msg="${CSS.escape(b.dataset.ir)}"]`);
    if (!alvo) return;
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    alvo.classList.add('destaque');
    setTimeout(() => alvo.classList.remove('destaque'), 1600);
  });
}

function desenharRodape() {
  cancelarGravacao();
  const ch = S.chat, rod = $('#chat-rodape');
  const u = S.usuario;
  let podeEscrever = false, motivo = '';
  if (ch.canal === 'equipe') podeEscrever = true;
  else if (!ch.podeCliente) motivo = 'O setor conversa com o cliente só enquanto o chamado está encaminhado a ele. Use o chat interno da equipe.';
  else if (ch.acoes.responder) podeEscrever = true;
  else motivo = ch.c.Status === 'Fechado' && u.tipo === 'cliente'
    ? 'Chat encerrado. Para continuar, reabra o chamado no quadro acima.'
    : 'Chat encerrado porque o chamado está ' + ch.c.Status.toLowerCase() + '.';
  if (!podeEscrever) { rod.innerHTML = `<div class="chat-fechado">${esc(motivo)}</div>`; return; }
  const ph = ch.canal === 'equipe' ? 'Mensagem para a equipe (o cliente não vê)' : 'Escreva uma mensagem';
  const resp = ch.respondendo && ch.respondendo.canal === ch.canal ? ch.respondendo.item : null;
  rod.innerHTML = `${resp ? `<div class="respondendo"><div><b>Respondendo a ${esc(nomeAutorChat(resp))}</b><span>${esc(resumoChat(resp))}</span></div>
      <button type="button" class="msg-acao" id="b-cancelar-resposta" aria-label="Cancelar resposta" title="Cancelar resposta">✕</button></div>` : ''}<div class="chat-compor">
    <div class="campo-msg">
      ${ch.acoes.anexar || ch.canal === 'equipe' ? `<label class="clip" title="Enviar arquivo" aria-label="Enviar arquivo"><input type="file" id="chat-arq" multiple>${iconeInterface('clipe')}</label>` : ''}
      <textarea id="chat-txt" rows="1" placeholder="${ph}" aria-label="${ph}"></textarea>
      ${(ch.acoes.anexar || ch.canal === 'equipe') && podeGravar() ? `<button type="button" class="clip" id="chat-mic" title="Gravar áudio" aria-label="Gravar áudio">${iconeInterface('microfone')}</button>` : ''}
    </div>
    <button class="btn-enviar" id="chat-env" aria-label="Enviar mensagem" title="Enviar (Enter)">${iconeInterface('enviar')}</button></div>`;
  const ta = $('#chat-txt');
  ta.value = S.rascunhos[ch.id + ':' + ch.canal] || '';
  const crescer = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
  crescer();
  ta.oninput = () => { crescer(); ch.digitandoAte = Date.now() + 4000; S.rascunhos[ch.id + ':' + ch.canal] = ta.value; };
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enviarMensagemChat(); } };
  $('#chat-env').onclick = enviarMensagemChat;
  if ($('#chat-mic')) $('#chat-mic').onclick = () => { guardarRascunho(); return gravarAudio(); };
  if ($('#b-cancelar-resposta')) $('#b-cancelar-resposta').onclick = () => { guardarRascunho(); ch.respondendo = null; desenharRodape(); $('#chat-txt').focus(); };
  if ($('#chat-arq')) $('#chat-arq').onchange = async e => {
    const arquivos = Array.from(e.target.files);
    if (!arquivos.length) return;
    $('#digitando').textContent = 'Enviando arquivo…';
    try { await enviarArquivos(ch.id, arquivos, ch.canal === 'equipe'); } catch (err) { return; }
    e.target.value = '';
    if (S.chat !== ch) return;
    $('#digitando').textContent = '';
    agendarChat(0);
  };
}

function guardarRascunho() {
  const ch = S.chat, ta = $('#chat-txt');
  if (ch && ta) S.rascunhos[ch.id + ':' + ch.canal] = ta.value;
}

async function enviarMensagemChat() {
  const ch = S.chat, ta = $('#chat-txt'), btn = $('#chat-env');
  if (!ch || !ta) return;
  const texto = ta.value.trim();
  if (!texto) return;
  const canal = ch.canal;
  const respostaA = ch.respondendo && ch.respondendo.canal === canal ? ch.respondendo.item.Id : '';
  const ok = await acao(btn, () => api('enviarChat', S.token, ch.id, canal, texto, respostaA));
  if (!ok) return;
  delete S.rascunhos[ch.id + ':' + canal];
  if (respostaA) { ch.respondendo = null; if (S.chat === ch) desenharRodape(); }
  if (S.chat === ch && $('#chat-txt')) { ta.value = ''; ta.style.height = 'auto'; ta.focus(); }
  ch.digitandoAte = 0;
  agendarChat(0);
}

function agendarChat(ms) {
  const ch = S.chat;
  if (!ch) return;
  if (ch.rodando) { ch.denovo = true; return; }
  clearTimeout(ch.timer);
  ch.timer = setTimeout(() => cicloChat(ch), ms);
}

async function cicloChat(ch) {
  if (S.chat !== ch) return;
  if (editorAberto) { agendarChat(2000); return; }
  ch.rodando = true;
  try {
    const r = await api('chatAtualizar', S.token, ch.id, ch.total, ch.ver, ch.digitandoAte > Date.now() ? ch.canal : '');
    if (S.chat !== ch || editorAberto) return;
    ch.ver = r.ver;
    desenharPresenca(r.online);
    const dig = r.digitando[ch.canal];
    if ($('#digitando').textContent !== 'Enviando arquivo…') $('#digitando').textContent = dig ? dig + ' está digitando…' : '';
    // Reações podem mudar em mensagens antigas: atualiza e redesenha só se algo mudou
    if (r.reacoes) {
      let mudou = false;
      ch.itens.forEach(h => { const n = r.reacoes[h.Id] || []; if (JSON.stringify(n) !== JSON.stringify(h.reacoes || [])) { h.reacoes = n; mudou = true; } });
      if (mudou && !r.itens.length && !$('#feed .seletor-reacao')) desenharFeed(false);
    }
    if (r.itens.length) {
      ch.itens = ch.itens.concat(r.itens);
      ch.total = r.total;
      if (r.itens.some(h => h.Tipo === 'STATUS' || h.Tipo === 'PESQUISA')) {
        guardarRascunho();
        aviso('O chamado foi atualizado.', 'ok');
        return telaDetalhe(ch.id);
      }
      const novas = r.itens.filter(h => !h.meu && h.Tipo !== 'STATUS');
      let viuAtual = false;
      novas.forEach(h => {
        const k = canalDoItem(h);
        if (k === ch.canal) viuAtual = true;
        else if (ch.canais.includes(k)) ch.naoVistas[k] = (ch.naoVistas[k] || 0) + 1;
      });
      atualizarBadges();
      desenharFeed(r.itens.some(h => h.meu));
      if (viuAtual) {
        if (document.hidden) { S.tituloNovas = (S.tituloNovas || 0) + novas.length; document.title = `(${S.tituloNovas}) SAC`; }
        else api('chatMarcarLido', S.token, ch.id, ch.canal).catch(() => { });
      }
    }
  } catch (e) {
    if (e.message === 'SESSAO_EXPIRADA') return;
  } finally {
    ch.rodando = false;
    if (S.chat === ch) {
      const espera = ch.denovo ? 0 : (document.hidden ? 15000 : 4000);
      ch.denovo = false;
      ch.timer = setTimeout(() => cicloChat(ch), espera);
    }
  }
}

function atualizarBadges() {
  const ch = S.chat;
  $$('[data-badge]').forEach(b => {
    const n = ch.naoVistas[b.dataset.badge] || 0;
    b.hidden = !n; b.textContent = n;
  });
}

function desenharPresenca(o) {
  const el = $('#presenca');
  if (!el || !o) return;
  const item = (on, t) => `<span class="${on ? 'on' : ''}">${t} ${on ? 'online' : 'offline'}</span>`;
  el.innerHTML = S.usuario.tipo === 'cliente' || !S.usuario.n1
    ? item(o.atendimento, 'Atendimento')
    : item(o.cliente, 'Projeto') + item(o.setor, 'Setor');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (S.tituloNovas) {
    S.tituloNovas = 0;
    const u = S.usuario;
    document.title = u ? 'SAC · ' + (u.tipo === 'cliente' ? u.projeto : 'Equipe ' + S.publico.nome) : 'SAC';
  }
  if (S.chat) { api('chatMarcarLido', S.token, S.chat.id, S.chat.canal).catch(() => { }); agendarChat(0); }
});

// ───────── Pesquisa de satisfação ─────────
function formPesquisa(cred, id, alvo, aoConcluir) {
  let nota = 0;
  alvo.innerHTML = `
    <div class="campo"><label id="lb-nota">Nota de 1 (ruim) a 5 (ótimo)</label>
      <div class="estrelas" role="group" aria-labelledby="lb-nota">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-nota="${n}" aria-pressed="false">${n}</button>`).join('')}</div></div>
    <div class="campo"><label id="lb-res">O problema foi resolvido?</label>
      <div class="opcoes" role="radiogroup" aria-labelledby="lb-res"><label><input type="radio" name="res" value="Sim" checked> Sim</label><label><input type="radio" name="res" value="Não"> Não</label></div></div>
    <div class="campo"><label for="p-com">Comentário (opcional)</label><textarea id="p-com"></textarea></div>
    <button class="btn btn-primario" id="b-pesq">Enviar avaliação</button>`;
  $$('[data-nota]', alvo).forEach(b => b.onclick = () => {
    nota = Number(b.dataset.nota);
    $$('[data-nota]', alvo).forEach(x => x.setAttribute('aria-pressed', Number(x.dataset.nota) <= nota));
  });
  $('#b-pesq', alvo).onclick = async e => {
    if (!nota) return aviso('Escolha uma nota de 1 a 5.', 'erro');
    const res = ($('input[name=res]:checked', alvo) || {}).value;
    if (await acao(e.target, () => api('responderPesquisa', cred, id, nota, res, $('#p-com', alvo).value), 'Obrigado pela avaliação!')) aoConcluir();
  };
}

async function telaPesquisaAvulsa(id, chave) {
  topo();
  const nav = novaTela();
  let d;
  try { d = await api('dadosPesquisa', id, chave); }
  catch (e) { app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  const fim = () => { app.innerHTML = `<div class="bloco" style="max-width:620px;margin:auto"><h1>Obrigado!</h1><p>Sua avaliação ajuda a melhorar o suporte do ${esc(d.nome)}.</p></div>`; };
  if (!d.pendente) return fim();
  app.innerHTML = `<div class="bloco" style="max-width:620px;margin:auto">
    <span class="protocolo" translate="no">${esc(d.id)}</span><h1>Como foi o atendimento?</h1>
    <p class="suave">${esc(d.titulo)}</p><div id="pesq"></div></div>`;
  formPesquisa({ chave: chave }, d.id, $('#pesq'), fim);
}

// ───────── Equipe ─────────
function telaEquipe(aba, sub) {
  lembrarTela(aba || 'fila');
  topo(); marcarAba(aba);
  if (aba === 'telefone') return telaNovoChamado(true);
  if (aba === 'projetos') return telaProjetos();
  if (aba === 'config') return telaConfig(sub || 'geral');
  if (aba === 'ajuda') return telaAjuda();
  if (aba === 'equipe') return telaEquipeAdmin();
  if (aba === 'relatorios') return telaRelatorios();
  if (aba === 'pesquisas') return telaPesquisas();
  return telaFila();
}

// ───────── Pesquisas de satisfação respondidas (N1 e Admin) ─────────
async function telaPesquisas() {
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Carregando pesquisas…</div>';
  let lista;
  try { lista = await api('listarPesquisas', S.token); } catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  const f = S.filtroPesquisas = S.filtroPesquisas || {};
  const projetos = [...new Set(lista.map(r => r.projeto).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>Pesquisas de satisfação</h1>
      <p class="suave" style="margin:0">Respostas dos clientes depois que o chamado é fechado. Clique no número para abrir o chamado.</p></div>
      <button class="btn" id="b-atualizar">Atualizar</button></div>
    <div class="contadores" id="pq-kpis"></div>
    <div class="filtros">
      <input type="search" id="pq-q" placeholder="Buscar por número, projeto, cliente ou comentário…" aria-label="Buscar">
      <select id="pq-nota" aria-label="Nota"><option value="">Todas as notas</option>${[5, 4, 3, 2, 1].map(n => `<option value="${n}">Nota ${n}</option>`).join('')}<option value="baixas">Notas 1 e 2</option></select>
      <select id="pq-res" aria-label="Resolvido"><option value="">Resolvido ou não</option><option>Sim</option><option>Não</option></select>
      <select id="pq-proj" aria-label="Projeto"><option value="">Todos os projetos</option>${projetos.map(p => `<option>${esc(p)}</option>`).join('')}</select>
      <label class="pequeno" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="pq-com"> Só com comentário</label>
      <input type="date" id="pq-de" aria-label="Respondidas desde"><input type="date" id="pq-ate" aria-label="Respondidas até">
    </div>
    <div id="pq-lista"></div>`;
  const campos = { busca: '#pq-q', nota: '#pq-nota', resolvido: '#pq-res', projeto: '#pq-proj', de: '#pq-de', ate: '#pq-ate' };
  Object.entries(campos).forEach(([k, s]) => { $(s).value = f[k] || ''; });
  $('#pq-com').checked = !!f.comentario;
  $('#b-atualizar').onclick = telaPesquisas;
  const dia = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ });
  const estrelas = n => `<span class="estrelas" aria-label="Nota ${n} de 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`;
  const render = () => {
    Object.entries(campos).forEach(([k, s]) => { f[k] = $(s).value; });
    f.comentario = $('#pq-com').checked;
    const q = f.busca.toLowerCase();
    const itens = lista.filter(r =>
      (!f.nota || (f.nota === 'baixas' ? r.nota <= 2 : r.nota === Number(f.nota))) &&
      (!f.resolvido || r.resolvido === f.resolvido) && (!f.projeto || r.projeto === f.projeto) &&
      (!f.comentario || r.comentario.trim()) && (!f.de || dia(r.data) >= f.de) && (!f.ate || dia(r.data) <= f.ate) &&
      (!q || [r.chamado, r.projeto, r.cliente, r.titulo, r.comentario, r.atendente].join(' ').toLowerCase().includes(q)));
    const media = itens.length ? itens.reduce((s, r) => s + r.nota, 0) / itens.length : null;
    $('#pq-kpis').innerHTML = `
      <div><b>${itens.length}</b>respostas</div>
      <div><b>${media === null ? '–' : media.toFixed(1).replace('.', ',')}</b>nota média (1 a 5)</div>
      <div><b>${itens.length ? Math.round(itens.filter(r => r.resolvido === 'Sim').length * 100 / itens.length) + '%' : '–'}</b>disseram que foi resolvido</div>
      <div class="${itens.some(r => r.nota <= 2) ? 'alerta' : ''}"><b>${itens.filter(r => r.nota <= 2).length}</b>notas 1 e 2</div>`;
    $('#pq-lista').innerHTML = itens.length ? `<div class="rolagem"><table class="tabela-pesquisas"><thead><tr>
        <th>Chamado</th><th>Respondida em</th><th>Projeto e cliente</th><th>Atendente</th><th>Nota</th><th>Resolvido</th><th>Comentário</th></tr></thead><tbody>
      ${itens.map(r => `<tr class="${r.nota <= 2 ? 'nota-baixa' : ''}">
        <td><button type="button" class="btn-link protocolo" data-abrir="${esc(r.chamado)}" translate="no">${esc(r.chamado)}</button><div class="suave pequeno">${esc(r.titulo)}</div></td>
        <td>${fmtDH(r.data)}</td>
        <td>${esc(r.projeto)}${r.cliente ? `<div class="suave pequeno">${esc(r.cliente)}</div>` : ''}</td>
        <td>${esc(r.atendente || '–')}${r.setor ? `<div class="suave pequeno">Setor: ${esc(r.setor)}</div>` : ''}</td>
        <td>${estrelas(r.nota)}</td><td>${r.resolvido}</td>
        <td class="comentario">${r.comentario ? esc(r.comentario) : '<span class="suave">–</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="vazio">${lista.length ? 'Nenhuma resposta com esses filtros.' : 'Nenhuma pesquisa respondida ainda.'}</div>`;
    $$('#pq-lista [data-abrir]').forEach(b => b.onclick = () => telaDetalhe(b.dataset.abrir));
  };
  [...Object.values(campos), '#pq-com'].forEach(s => { $(s).oninput = render; $(s).onchange = render; });
  render();
}

async function telaFila() {
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Carregando fila…</div>';
  let lista;
  try { lista = await api('filaEquipe', S.token); } catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  const ativos = lista.filter(c => !FINAIS.includes(c.Status));
  const n1 = !!S.usuario.n1;
  const f = S.filtroFila;
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>${n1 ? 'Fila de chamados' : 'Chamados do setor ' + esc(S.usuario.perfil)}</h1>
      <p class="suave" style="margin:0">${n1 ? 'Bloqueios primeiro; depois, ordem de chegada.' : 'Chamados que o N1 encaminhou para o seu setor.'}</p></div>
      <button class="btn" id="b-atualizar">Atualizar</button></div>
    <div class="contadores">
      <div><b>${ativos.length}</b>ativos</div>
      <div class="${ativos.some(c => c.Prioridade === 'Bloqueio') ? 'alerta' : ''}"><b>${ativos.filter(c => c.Prioridade === 'Bloqueio').length}</b>bloqueios</div>
      <div class="${ativos.some(c => c.atrasado) ? 'alerta' : ''}"><b>${ativos.filter(c => c.atrasado).length}</b>com prazo vencido</div>
      <div><b>${ativos.filter(c => c.Status === 'Aberto').length}</b>sem triagem</div>
      <div><b>${ativos.filter(c => c.Status === 'Aguardando cliente').length}</b>aguardando cliente</div>
    </div>
    <div class="filtros">
      <input type="search" id="q" placeholder="Buscar por número, projeto ou palavra…" value="${esc(f.busca || '')}" aria-label="Buscar">
      <select id="fs" aria-label="Status"><option value="ativos">Ativos</option><option value="">Todos</option>${S.base.status.map(s => `<option>${esc(s)}</option>`).join('')}</select>
      <select id="fp" aria-label="Prioridade"><option value="">Todas as prioridades</option><option>Bloqueio</option><option>Normal</option></select>
      <select id="fprojeto" aria-label="Projeto"><option value="">Todos os projetos</option>${[...new Set(lista.map(c => c.Projeto).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')).map(p => `<option>${esc(p)}</option>`).join('')}</select>
      ${n1 ? '<select id="fatend" aria-label="Atendimento"><option value="">Todos os atendimentos</option><option value="meus">Meus atendimentos</option><option value="livres">Sem atendente</option></select>' : ''}
    </div>
    <div class="lista" id="lista"></div>`;
  $('#fs').value = f.status === undefined ? 'ativos' : f.status;
  $('#fp').value = f.prioridade || '';
  $('#fprojeto').value = f.projeto || '';
  if ($('#fatend')) $('#fatend').value = f.atendimento || '';
  $('#b-atualizar').onclick = telaFila;
  const render = () => {
    Object.assign(f, { busca: $('#q').value, status: $('#fs').value, prioridade: $('#fp').value, projeto: $('#fprojeto').value, atendimento: $('#fatend') ? $('#fatend').value : '' });
    const q = f.busca.toLowerCase();
    const itens = lista.filter(c =>
      (f.status === 'ativos' ? !FINAIS.includes(c.Status) : (!f.status || c.Status === f.status)) &&
      (!f.prioridade || c.Prioridade === f.prioridade) && (!f.projeto || c.Projeto === f.projeto) &&
      (!f.atendimento || (f.atendimento === 'meus' ? c.meuAtendimento : !c.Atendente)) &&
      (!q || (c.Id + ' ' + c.Projeto + ' ' + c.Titulo + ' ' + c.Modulo + ' ' + c.Categoria).toLowerCase().includes(q)));
    $('#lista').innerHTML = itens.length ? itens.map(c => linhaChamado(c, true)).join('') : '<div class="vazio">Nenhum chamado aqui. Fila em dia.</div>';
    $$('#lista .linha-ch').forEach(b => b.onclick = () => telaDetalhe(b.dataset.id));
  };
  ['#q', '#fs', '#fp', '#fprojeto', '#fatend'].forEach(s => { if ($(s)) $(s).oninput = render; });
  render();
}

function caixaAcessos(linhas, titulo) {
  if (!linhas || !linhas.length) return '';
  if (sso()) return `<div class="acessos" role="alert"><h3>${esc(titulo || 'Projetos criados')}</h3>
    <p class="pequeno">Para os clientes entrarem, ligue cada projeto ao seu grupo <code>Projeto_...</code> do LLDAP em <b>Editar</b>.</p>
    <div class="rolagem"><table><thead><tr><th>Projeto</th><th>Grupo no LLDAP</th></tr></thead><tbody>
    ${linhas.map(l => `<tr><td>${esc(l.projeto || '')}</td><td>${l.grupoLldap ? `<code translate="no">${esc(l.grupoLldap)}</code>` : '<span class="atrasado">não definido</span>'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  return `<div class="acessos" role="alert"><h3>${esc(titulo || 'Acessos criados')}</h3>
    <p class="pequeno">Anote ou envie agora: a senha temporária só aparece nesta tela. No primeiro login, a pessoa cria a própria senha.</p>
    <div class="rolagem"><table><thead><tr><th>Acesso</th><th>Login</th><th>Senha temporária</th><th scope="col">Ações</th></tr></thead><tbody>
    ${linhas.map((l, i) => `<tr><td>${esc(l.projeto || l.nome || '')}</td><td><code translate="no">${esc(l.login)}</code></td><td><code translate="no">${esc(l.senha)}</code></td>
      <td><button class="btn-link" data-copiar="${i}">Copiar</button>${l.emailEnviado ? ' <span class="suave pequeno">envio por e-mail solicitado</span>' : l.emailSalvoLocal ? ' <span class="atrasado pequeno">E-mail salvo localmente; configure o SMTP para enviar.</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function ligarCopiar(linhas) {
  $$('[data-copiar]').forEach(b => b.onclick = async () => {
    const l = linhas[Number(b.dataset.copiar)];
    const texto = `Acesso ao SAC ${S.publico.nome}\nLogin: ${l.login}\nSenha temporária: ${l.senha}`;
    try { await navigator.clipboard.writeText(texto); aviso('Copiado.', 'ok'); }
    catch (e) { window.prompt('Copie o texto:', texto); }
  });
}

function tabelaModulos() {
  return `<div class="campo"><h3>Módulos do sistema</h3>
    <div class="rolagem"><table><thead><tr><th scope="col">Módulo</th><th scope="col">Descrição</th><th scope="col">Ações</th></tr></thead><tbody data-modulos-linhas></tbody></table></div>
    <div class="opcoes"><button type="button" class="btn" data-modulo-add>Adicionar módulo</button>
    <button type="button" class="btn-link" data-modulo-padrao>Usar os módulos do ERP Linave</button></div>
    <div class="ajuda">O nome aparece ao abrir um chamado. A descrição é opcional. Deixe as linhas vazias se o projeto não tiver módulos.</div></div>`;
}

function lerTabelaModulos(raiz) {
  return $$('[data-modulos-linhas] tr', raiz).map(tr => ({
    nome: $('[data-modulo-nome]', tr).value.trim(), descricao: $('[data-modulo-descricao]', tr).value.trim()
  })).filter(m => m.nome || m.descricao);
}

function preencherTabelaModulos(raiz, modulos) {
  const corpo = $('[data-modulos-linhas]', raiz);
  corpo.innerHTML = '';
  const adicionar = (m = {}) => {
    if (typeof m === 'string') m = { nome: m };
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="text" data-modulo-nome maxlength="60" aria-label="Nome do módulo" placeholder="Nome do módulo" value="${esc(m.nome || '')}"></td>
      <td><textarea data-modulo-descricao maxlength="1000" rows="2" aria-label="Descrição do módulo" placeholder="Descrição opcional">${esc(m.descricao || '')}</textarea></td>
      <td><button type="button" class="btn-link" data-modulo-remover>Remover</button></td>`;
    const nome = $('[data-modulo-nome]', tr);
    const descricao = $('[data-modulo-descricao]', tr);
    const validar = () => { nome.required = !!descricao.value.trim(); };
    descricao.oninput = validar;
    validar();
    $('[data-modulo-remover]', tr).onclick = () => {
      if (!confirmarExclusao(nome.value.trim() ? `o módulo "${nome.value.trim()}"` : 'esta linha de módulo', 'A remoção será aplicada quando você salvar o formulário.')) return;
      tr.remove();
      if (!corpo.children.length) adicionar();
    };
    corpo.appendChild(tr);
    return tr;
  };
  (modulos && modulos.length ? modulos : [{}]).forEach(adicionar);
  $('[data-modulo-add]', raiz).onclick = () => $('[data-modulo-nome]', adicionar()).focus();
  $('[data-modulo-padrao]', raiz).onclick = () => {
    const atuais = lerTabelaModulos(raiz);
    const nomes = new Set(atuais.map(m => m.nome.toLowerCase()));
    preencherTabelaModulos(raiz, atuais.concat(MODULOS_LINAVE.filter(nome => !nomes.has(nome.toLowerCase())).map(nome => ({ nome }))));
  };
}

async function telaProjetos(acessos) {
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Carregando projetos…</div>';
  let lista, pastaGeral, gruposVistos = [], clientesLldap = [];
  try {
    [lista, pastaGeral, gruposVistos, clientesLldap] = await Promise.all([api('listarProjetos', S.token), api('obterPastaGeralProjetos', S.token),
      sso() ? api('gruposProjetoLldap', S.token) : [], sso() ? api('listarClientesLldap', S.token) : []]);
  } catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  // Clientes (grupo Clientes do LLDAP) de um projeto
  const clientesDe = id => clientesLldap.filter(c => (c.projetoIds || []).includes(String(id)));
  // Campo do grupo Projeto_... (modo Authelia), com os grupos já vistos nos logins como sugestão
  const campoGrupo = valor => sso() ? `<div class="campo"><label for="pj-grupo">Grupo do projeto no LLDAP</label>
    <input type="text" id="pj-grupo" list="pj-grupos" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="Projeto_..." value="${esc(valor || '')}">
    <datalist id="pj-grupos">${gruposVistos.filter(g => !g.projeto).map(g => `<option value="${esc(g.grupo)}">`).join('')}</datalist>
    <div class="ajuda">Clientes (grupo Clientes) que estiverem neste grupo veem os chamados do projeto. As sugestões são grupos que já apareceram nos logins.</div></div>` : '';
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>Projetos</h1>
      <p class="suave" style="margin:0">${sso() ? 'Os projetos vêm dos grupos Projeto_... do LLDAP: cada grupo aparece aqui no primeiro login de alguém dele. Aqui você define os módulos de cada projeto e vê os clientes que já entraram.' : 'Gerencie os acessos, responsáveis e módulos de cada projeto.'}</p></div>
      <div class="opcoes"><a class="btn" href="${esc(pastaGeral.url)}" target="_blank" rel="noopener">Ver pastas no Drive</a>${sso() ? '' : '<button class="btn" id="b-sinc">Buscar pastas novas</button><button class="btn btn-primario" id="b-novo-pj">Criar projeto</button>'}</div></div>
    ${caixaAcessos(acessos)}
    <div class="bloco" id="form-pj" hidden style="margin-bottom:18px"></div>
    <div class="bloco rolagem">${lista.length ? (sso() ? `<table><thead><tr><th>Projeto</th><th>Grupo no LLDAP</th><th class="num">Clientes</th><th>Acesso</th><th>Último login</th><th scope="col">Ações</th></tr></thead>
      <tbody>${lista.map((c, i) => { const cli = clientesDe(c.ProjetoId); const ultimo = cli.map(x => x.UltimoAcesso).filter(Boolean).sort().pop(); return `<tr>
        <td><b>${esc(c.Projeto)}</b><div class="suave pequeno">${esc(c.ProjetoId)}${c.modulos.length ? ', ' + c.modulos.length + ' módulos' : ', sem módulos'}${c.pastaUrl ? `, <a href="${esc(c.pastaUrl)}" target="_blank" rel="noopener">pasta</a>` : ''}</div></td>
        <td>${c.GrupoLldap ? `<code translate="no">${esc(c.GrupoLldap)}</code>` : '<span class="atrasado">não definido</span>'}</td>
        <td class="num">${cli.length}</td>
        <td>${c.Ativo ? 'Ativo' : '<span class="suave">Desativado</span>'}</td><td>${ultimo ? fmtDH(ultimo) : '<span class="suave">nunca</span>'}</td>
        <td class="acoes-linha">${botaoIcone('ver', 'Ver clientes de ' + c.Projeto, `data-ver-clientes="${i}"`)}${botaoIcone('editar', 'Editar ' + c.Projeto, `data-editar="${i}"`)}</td></tr>`; }).join('')}</tbody></table>`
    : `<table><thead><tr><th>Projeto</th><th>Login</th><th>Responsável</th><th>E-mail</th><th>Acesso</th><th>Último login</th><th scope="col">Ações</th></tr></thead>
      <tbody>${lista.map((c, i) => `<tr>
        <td><b>${esc(c.Projeto)}</b><div class="suave pequeno">${esc(c.ProjetoId)}${c.modulos.length ? ', ' + c.modulos.length + ' módulos' : ', sem módulos'}${c.pastaUrl ? `, <a href="${esc(c.pastaUrl)}" target="_blank" rel="noopener">pasta</a>` : ''}</div></td>
        <td><code translate="no">${esc(c.Login)}</code>${c.senhaTemporaria ? '<div class="suave pequeno">senha temporária</div>' : ''}</td>
        <td>${esc(c.Responsavel || '—')}${c.NomePreferido ? `<div class="suave pequeno">prefere "${esc(c.NomePreferido)}"</div>` : ''}</td><td>${c.Email ? esc(c.Email) : '<span class="atrasado">sem e-mail</span>'}</td>
        <td>${c.Ativo ? 'Ativo' : '<span class="suave">Desativado</span>'}</td><td>${c.UltimoAcesso ? fmtDH(c.UltimoAcesso) : '<span class="suave">nunca</span>'}</td>
        <td class="acoes-linha"><button class="btn-link" data-editar="${i}">Editar</button><button class="btn-link" data-senha="${i}">Nova senha</button></td></tr>`).join('')}</tbody></table>`)
      : `<div class="vazio">${sso() ? 'Nenhum projeto ainda. Eles aparecem quando alguém de um grupo Projeto_... do LLDAP entra no SAC.' : 'Nenhum projeto ainda. Use <b>Buscar pastas novas</b> para trazer as pastas da pasta geral ou <b>Criar projeto</b>.'}</div>`}</div>
    ${sso() ? `<div class="bloco rolagem" style="margin-top:18px"><h2>Clientes que já entraram</h2>
      <p class="suave pequeno">Usuários do grupo Clientes no LLDAP. Os projetos de cada um vêm dos grupos Projeto_... e são atualizados a cada login.</p>
      ${clientesLldap.length ? `<table><thead><tr><th>Nome</th><th>Usuário</th><th>E-mail</th><th>Projetos</th><th>Acesso</th><th>Último login</th></tr></thead>
      <tbody>${clientesLldap.map(c => `<tr><td>${esc(c.Nome)}</td><td><code translate="no">${esc(c.Login)}</code></td><td>${esc(c.Email)}</td>
        <td>${c.projetos.map(esc).join('<br>')}</td><td>${c.Ativo ? 'Ativo' : '<span class="suave">Desativado</span>'}</td>
        <td>${c.UltimoAcesso ? fmtDH(c.UltimoAcesso) : '<span class="suave">nunca</span>'}</td></tr>`).join('')}</tbody></table>`
      : '<p class="suave">Nenhum cliente entrou pela conta Innomaker ainda.</p>'}</div>` : ''}`;
  ligarCopiar(acessos || []);

  // Olhinho: clientes daquele projeto, numa janela
  $$('[data-ver-clientes]').forEach(b => b.onclick = () => {
    const pj = lista[Number(b.dataset.verClientes)];
    const cli = clientesDe(pj.ProjetoId);
    const painel = $('#form-pj');
    painel.innerHTML = cli.length ? `<div class="rolagem"><table><thead><tr><th>Nome</th><th>Usuário</th><th>E-mail</th><th>Acesso</th><th>Último login</th></tr></thead>
      <tbody>${cli.map(c => `<tr><td>${esc(c.Nome)}</td><td><code translate="no">${esc(c.Login)}</code></td><td>${esc(c.Email)}</td>
        <td>${c.Ativo ? 'Ativo' : '<span class="suave">Desativado</span>'}</td><td>${c.UltimoAcesso ? fmtDH(c.UltimoAcesso) : '<span class="suave">nunca</span>'}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="suave">Nenhum cliente deste projeto entrou ainda. Os clientes aparecem aqui no primeiro login: precisam estar nos grupos <code translate="no">Clientes</code> e <code translate="no">${esc(pj.GrupoLldap || 'Projeto_...')}</code> do LLDAP.</p>`;
    abrirEditor(painel, 'Clientes de ' + pj.Projeto);
  });

  if ($('#b-sinc')) $('#b-sinc').onclick = async e => {
    const r = await acao(e.target, () => api('sincronizarProjetos', S.token));
    if (!r) return;
    if (!r.length) return aviso('Nenhuma pasta nova na pasta geral.', 'ok');
    telaProjetos(r);
  };
  const form = $('#form-pj');
  if ($('#b-novo-pj')) $('#b-novo-pj').onclick = async () => {
    const pastas = await acao($('#b-novo-pj'), () => api('listarPastasProjetos', S.token));
    if (!pastas || nav !== S.nav) return;
    form.hidden = false;
    form.innerHTML = `<h2>Criar projeto</h2><p class="suave">${sso() ? 'Selecione uma pasta da pasta geral para criar o projeto e informe o grupo Projeto_... do LLDAP que dá acesso a ele.' : 'Selecione uma pasta da pasta geral para criar o projeto e seu login com senha temporária.'}</p>
      <form id="f-pj" autocomplete="off"><div class="grade-2">
        <div class="campo"><label for="pj-nome">Nome do projeto</label><select id="pj-nome" required><option value="">Selecione uma pasta…</option>${pastas.map(p => `<option value="${esc(p.id)}" ${p.vinculada ? 'disabled' : ''}>${esc(p.nome)}${p.vinculada ? ' (já cadastrada)' : ''}</option>`).join('')}</select>
        ${pastas.some(p => !p.vinculada) ? '' : '<div class="ajuda">Nenhuma pasta disponível. Adicione uma pasta à pasta geral e abra este formulário novamente, ou edite um projeto existente.</div>'}</div>
        <div class="campo"><label for="pj-login">Login</label><input type="text" id="pj-login" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="Gerado pelo nome se ficar vazio"></div>
        <div class="campo"><label for="pj-resp">Responsável (quem abre os chamados)</label><input type="text" id="pj-resp"></div>
        <div class="campo"><label for="pj-email">E-mail para os avisos</label><input type="email" id="pj-email" spellcheck="false" autocapitalize="none"></div>
        <div class="campo"><label for="pj-tel">Telefone</label><input type="tel" id="pj-tel"></div>
        ${campoGrupo('')}
      </div>
      ${tabelaModulos()}
      <p class="suave pequeno">${sso() ? 'Os clientes do projeto precisam estar no grupo Clientes e no grupo do projeto no LLDAP.' : 'A senha temporária será exibida para você entregar ao cliente. Ele cria a própria senha no primeiro acesso. Depois, pode usar “Esqueci minha senha” com o e-mail cadastrado.'}</p>
      <button class="btn btn-primario" id="b-pj">Criar projeto</button> <button type="button" class="btn" id="b-pj-x">Cancelar</button></form>`;
    $('#pj-nome').focus();
    preencherTabelaModulos(form, []);
    $('#pj-nome').onchange = () => {
      const pasta = pastas.find(p => p.id === $('#pj-nome').value);
      if (pasta && /4\.2\.22|linave|servinave/i.test(pasta.nome) && !lerTabelaModulos(form).length) preencherTabelaModulos(form, MODULOS_LINAVE);
    };
    $('#b-pj-x').onclick = () => fecharEditor();
    $('#f-pj').onsubmit = async ev => {
      ev.preventDefault();
      const d = { pastaId: $('#pj-nome').value, login: $('#pj-login').value, responsavel: $('#pj-resp').value,
        email: $('#pj-email').value, telefone: $('#pj-tel').value, modulos: lerTabelaModulos(form) };
      if ($('#pj-grupo')) d.grupoLldap = $('#pj-grupo').value;
      const r = await acao($('#b-pj'), () => api('criarProjeto', S.token, d), 'Projeto criado.');
      if (r) telaProjetos([r]);
    };
    abrirEditor(form, 'Criar projeto');
  };
  $$('[data-editar]').forEach(b => b.onclick = () => {
    const c = lista[Number(b.dataset.editar)];
    form.hidden = false;
    form.innerHTML = `<h2>Editar ${esc(c.Projeto)}</h2>
      <form id="f-pj" autocomplete="off"><div class="grade-2">
        ${sso() ? '' : `<div class="campo"><label for="pj-login">Login</label><input type="text" id="pj-login" autocapitalize="none" spellcheck="false" autocomplete="off" value="${esc(c.Login)}" required></div>
        <div class="campo"><label for="pj-resp">Responsável (quem abre os chamados)</label><input type="text" id="pj-resp" value="${esc(c.Responsavel || '')}"></div>
        <div class="campo"><label for="pj-email">E-mail para os avisos</label><input type="email" id="pj-email" spellcheck="false" autocapitalize="none" value="${esc(c.Email || '')}"></div>
        <div class="campo"><label for="pj-tel">Telefone</label><input type="tel" id="pj-tel" value="${esc(c.Telefone || '')}"></div>`}
        ${campoGrupo(c.GrupoLldap)}
      </div>
      ${sso() ? '<p class="ajuda" style="margin-top:-6px">Nome, e-mail e acesso são de cada cliente do projeto, na conta Innomaker (LLDAP). Veja quem já entrou no botão de olho da lista.</p>' : ''}
      ${tabelaModulos()}
      <label class="check" style="margin-bottom:14px"><input type="checkbox" id="pj-ativo" ${c.Ativo ? 'checked' : ''}> Acesso ativo</label>
      <button class="btn btn-primario" id="b-pj">Salvar alterações</button> <button type="button" class="btn" id="b-pj-x">Cancelar</button></form>`;
    preencherTabelaModulos(form, c.modulosDetalhes || c.modulos);
    $('#b-pj-x').onclick = () => fecharEditor();
    $('#f-pj').onsubmit = async ev => {
      ev.preventDefault();
      const d = { ProjetoId: c.ProjetoId, Ativo: $('#pj-ativo').checked, Modulos: lerTabelaModulos(form) };
      // Sem Authelia, o projeto tem login e contato próprios; com Authelia, isso é de cada cliente
      if ($('#pj-login')) Object.assign(d, { Login: $('#pj-login').value, Responsavel: $('#pj-resp').value, Email: $('#pj-email').value, Telefone: $('#pj-tel').value });
      if ($('#pj-grupo')) d.GrupoLldap = $('#pj-grupo').value;
      if (await acao($('#b-pj'), () => api('salvarProjeto', S.token, d), 'Projeto salvo.')) telaProjetos();
    };
    abrirEditor(form, 'Editar projeto: ' + c.Projeto);
  });
  $$('[data-senha]').forEach(b => b.onclick = async () => {
    const c = lista[Number(b.dataset.senha)];
    if (!confirm(`Gerar uma nova senha temporária para ${c.Projeto}? A senha atual deixa de funcionar.`)) return;
    const r = await acao(b, () => api('redefinirSenhaAcesso', S.token, 'projeto', c.ProjetoId));
    if (r) telaProjetos([Object.assign({ projeto: c.Projeto }, r)]);
  });
}

async function telaEquipeAdmin(acessos) {
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Carregando equipe…</div>';
  let lista;
  try { lista = await api('listarEquipe', S.token); }
  catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  if (sso()) return equipeLldap(lista);
  const opcoes = sel => ['Admin', 'N1'].concat(S.base.setores).map(p => `<option ${p === sel ? 'selected' : ''}>${esc(p)}</option>`).join('');
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>Equipe</h1>
      <p class="suave" style="margin:0">Gerencie as pessoas, os perfis de atendimento e os acessos da equipe.</p></div><button class="btn btn-primario" id="b-nova-pessoa">Adicionar pessoa</button></div>
    ${caixaAcessos(acessos)}
    <div class="bloco" id="form-m" hidden>
      <h2 id="m-tit">Adicionar pessoa</h2>
      <form id="f-m" autocomplete="off"><input type="hidden" id="m-orig">
        <div class="grade-2">
          <div class="campo"><label for="m-nome">Nome</label><input type="text" id="m-nome" required></div>
          <div class="campo"><label for="m-email">E-mail</label><input type="email" id="m-email" spellcheck="false" autocapitalize="none" required></div>
          <div class="campo"><label for="m-perfil">Perfil</label><div class="campo-com-acao"><select id="m-perfil">${opcoes('N1')}</select><button type="button" class="btn" id="b-adicionar-perfil">Adicionar perfil</button></div></div>
          <div class="campo"><label for="m-login">Login</label><input type="text" id="m-login" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="Gerado pelo nome se ficar vazio"></div>
        </div>
        <div class="opcoes" style="margin-bottom:14px">
          <label class="check" style="border:0;padding:0" id="lb-m-ativo" hidden><input type="checkbox" id="m-ativo" checked> Acesso ativo</label>
          <p class="suave pequeno" id="lb-m-env">O login e a senha temporária serão enviados para o e-mail informado. A pessoa cria uma nova senha no primeiro acesso.</p>
        </div>
        <button class="btn btn-primario" id="b-m">Adicionar pessoa</button> <button type="button" class="btn" id="b-m-x">Cancelar</button>
      </form>
    </div>
    <div id="form-novo-perfil" hidden></div>
    <div class="bloco rolagem"><table><thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>E-mail</th><th>Acesso</th><th>Último login</th><th scope="col">Ações</th></tr></thead>
      <tbody>${lista.map((m, i) => `<tr><td>${esc(m.Nome)}</td><td><code translate="no">${esc(m.Login)}</code>${m.senhaTemporaria ? '<div class="suave pequeno">senha temporária</div>' : ''}</td>
        <td>${esc(m.Perfil)}</td><td>${esc(m.Email)}</td><td>${m.Ativo ? 'Ativo' : '<span class="suave">Desativado</span>'}</td>
        <td>${m.UltimoAcesso ? fmtDH(m.UltimoAcesso) : '<span class="suave">nunca</span>'}</td>
        <td class="acoes-linha"><button class="btn-link" data-editar="${i}">Editar</button><button class="btn-link" data-senha="${i}">Nova senha</button></td></tr>`).join('')}</tbody></table></div>`;
  ligarCopiar(acessos || []);
  $('#b-adicionar-perfil').onclick = () => formularioPerfil($('#form-novo-perfil'), resultado => {
    S.base.setores = resultado.setores;
    $('#m-perfil').innerHTML = opcoes(resultado.nome);
  }, true);
  $('#b-nova-pessoa').onclick = () => {
    $('#f-m').reset();
    $('#m-orig').value = '';
    $('#m-tit').textContent = 'Adicionar pessoa';
    $('#b-m').textContent = 'Adicionar pessoa';
    $('#m-perfil').innerHTML = opcoes('N1');
    $('#lb-m-ativo').hidden = true;
    $('#lb-m-env').hidden = false;
    abrirEditor($('#form-m'), 'Adicionar pessoa');
  };
  $$('[data-editar]').forEach(b => b.onclick = () => {
    const m = lista[Number(b.dataset.editar)];
    $('#m-orig').value = m.Login; $('#m-nome').value = m.Nome; $('#m-email').value = m.Email;
    $('#m-perfil').innerHTML = opcoes(m.Perfil); $('#m-login').value = m.Login; $('#m-ativo').checked = !!m.Ativo;
    $('#m-tit').textContent = 'Editar ' + m.Nome; $('#b-m').textContent = 'Salvar alterações';
    $('#lb-m-ativo').hidden = false; $('#lb-m-env').hidden = true;
    abrirEditor($('#form-m'), 'Editar pessoa: ' + m.Nome);
  });
  $('#b-m-x').onclick = () => fecharEditor();
  $('#f-m').onsubmit = async ev => {
    ev.preventDefault();
    const d = { loginOriginal: $('#m-orig').value, Nome: $('#m-nome').value, Email: $('#m-email').value, Perfil: $('#m-perfil').value,
      Login: $('#m-login').value, Ativo: $('#m-ativo').checked };
    const r = await acao($('#b-m'), () => api('salvarMembro', S.token, d), d.loginOriginal ? 'Alterações salvas.' : 'Pessoa adicionada.');
    if (r) telaEquipeAdmin(r === true ? null : [Object.assign({ nome: d.Nome }, r)]);
  };
  $$('[data-senha]').forEach(b => b.onclick = async () => {
    const m = lista[Number(b.dataset.senha)];
    if (!confirm(`Gerar uma nova senha temporária para ${m.Nome} e enviar para ${m.Email}? A senha atual deixa de funcionar.`)) return;
    const r = await acao(b, () => api('redefinirSenhaAcesso', S.token, 'equipe', m.Login));
    if (r) telaEquipeAdmin([Object.assign({ nome: m.Nome }, r)]);
  });
}

// Com o Authelia, a equipe vem do LLDAP: o grupo define o perfil e o SAC só mostra quem já entrou
function equipeLldap(lista) {
  const perfis = ['Admin', 'N1'].concat(S.base.setores);
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>Equipe</h1>
      <p class="suave" style="margin:0">As pessoas e os perfis vêm do LLDAP. Para dar ou tirar acesso, mude os grupos da pessoa no LLDAP.</p></div></div>
    <div class="bloco rolagem"><h2>Grupos do LLDAP</h2>
      <p class="suave pequeno">Coloque cada pessoa em um destes grupos. Quem estiver em mais de um fica com o perfil mais alto da lista.</p>
      <table class="tabela-chave"><thead><tr><th>Perfil no SAC</th><th>Grupo no LLDAP</th></tr></thead>
      <tbody>${perfis.map(p => `<tr><td>${esc(p)}</td><td><code translate="no">${esc(grupoLldap(p))}</code></td></tr>`).join('')}</tbody></table>
      <p class="suave pequeno">Clientes: grupo <code translate="no">Clientes</code> mais o grupo <code translate="no">Projeto_...</code> de cada projeto (ligue os grupos aos projetos em Projetos). Quem está em Clientes nunca recebe acesso de equipe. Mudanças de grupo valem em até 15 minutos.</p></div>
    <div class="bloco rolagem"><h2>Quem já entrou</h2>${lista.length ? `<table><thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>E-mail</th><th>Acesso</th><th>Último login</th></tr></thead>
      <tbody>${lista.map(m => `<tr><td>${esc(m.Nome)}</td><td><code translate="no">${esc(m.Login)}</code></td><td>${esc(m.Perfil)}</td><td>${esc(m.Email)}</td>
        <td>${m.Ativo ? 'Ativo' : '<span class="suave">Desativado</span>'}</td><td>${m.UltimoAcesso ? fmtDH(m.UltimoAcesso) : '<span class="suave">nunca</span>'}</td></tr>`).join('')}</tbody></table>`
      : '<p class="suave">Ninguém da equipe entrou pelo LLDAP ainda.</p>'}</div>`;
}

// ───────── Configurações (admin) ─────────
async function telaConfig(aba) {
  lembrarTela('config', aba);
  const nav = novaTela();
  app.innerHTML = '<div class="carregando">Carregando configurações…</div>';
  let c;
  try { c = await api('configuracoes', S.token); }
  catch (e) { if (nav === S.nav && e.message !== 'SESSAO_EXPIRADA') app.innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  const nomes = { geral: 'Geral', automaticas: 'Horário e mensagens', categorias: 'Categorias', perfis: 'Perfis', modulos: 'Módulos', manuais: 'Manuais', feriados: 'Feriados', situacao: 'Situação do sistema' };
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>Configurações</h1><p class="suave" style="margin:0">Tudo o que o SAC usa se ajusta aqui, sem abrir a planilha.</p></div></div>
    <div class="sub-abas">${Object.keys(nomes).map(k => `<button data-sub="${k}" aria-pressed="${k === aba}">${nomes[k]}</button>`).join('')}</div>
    <div id="cfg"></div>`;
  $$('[data-sub]').forEach(b => b.onclick = () => telaConfig(b.dataset.sub));
  ({ situacao: cfgSituacao, geral: cfgGeral, automaticas: cfgAutomaticas, categorias: cfgCategorias, perfis: cfgPerfis, modulos: cfgModulos, manuais: cfgManuais, feriados: cfgFeriados })[aba](c);
}

const ROTULOS_CONFIG = {
  NOME_SISTEMA: 'Nome do SAC', PASTA_GERAL_ID: 'Pasta geral dos projetos', TELEFONE: 'Telefone do rodapé (Prefere ligar?)', RODAPE_TEXTO: 'Texto do rodapé',
  URL_APP: 'Endereço do SAC', URL_PORTAL: 'Endereço alternativo de acesso (opcional)', HORA_INICIO: 'Início do atendimento', HORA_FIM: 'Fim do atendimento',
  PRAZO_NORMAL_DIAS_UTEIS: 'Prazo da prioridade Normal (dias úteis)', PRAZO_BLOQUEIO_DIAS_UTEIS: 'Prazo da prioridade Bloqueio (dias úteis)',
  DIAS_UTEIS_AUTOFECHAMENTO: 'Dias úteis sem resposta até fechar', DIAS_UTEIS_REABERTURA: 'Dias úteis para o cliente reabrir',
  NOTIFICAR_EQUIPE: 'Avisar o N1 por e-mail', EMAIL_ADMIN: 'E-mail do administrador', BUSCAR_PROJETOS_NOVOS: 'Criar projetos das pastas novas a cada hora'
};

async function cfgSituacao() {
  const nav = novaTela();
  $('#cfg').innerHTML = '<div class="carregando">Verificando o sistema…</div>';
  let r;
  try { r = await api('situacaoSistema', S.token); } catch (e) { if (nav === S.nav && $('#cfg')) $('#cfg').innerHTML = `<div class="vazio">${esc(e.message)}</div>`; return; }
  if (nav !== S.nav) return;
  const botao = a => {
    if (a === 'gatilhos') return '<button class="btn" data-acao="recriarGatilhos">Ligar rotinas</button>';
    if (a === 'backup') return '<button class="btn" data-acao="backupAgora">Fazer backup agora</button>';
    if (a === 'email') return '<button class="btn" data-acao="testarEmail">Enviar e-mail de teste</button>';
    if (a.indexOf('feriados:') === 0) return `<button class="btn" data-feriados="${a.split(':')[1]}">Adicionar feriados nacionais</button>`;
    return '';
  };
  const pend = r.itens.filter(i => !i.ok).length;
  $('#cfg').innerHTML = `
    <div class="bloco" style="margin-bottom:18px">
      <h2>${pend ? pend + (pend === 1 ? ' ponto pede atenção' : ' pontos pedem atenção') : 'Tudo certo com o SAC'}</h2>
      ${r.itens.map(i => `<div class="cfg-linha"><div><b style="color:${i.ok ? 'var(--ok)' : 'var(--bloqueio)'}">${i.ok ? '✓' : '!'}</b> <b>${esc(i.titulo)}</b></div>
        <div><div class="${i.ok ? '' : 'atrasado'}" style="font-weight:${i.ok ? 400 : 600};overflow-wrap:anywhere">${esc(i.detalhe)}</div>${i.acao ? `<div style="margin-top:6px">${botao(i.acao)}</div>` : ''}</div></div>`).join('')}
    </div>
    <div class="bloco rolagem"><h2>Últimas ações e acessos</h2>
      <p class="suave pequeno">Registro de logins, tentativas recusadas e alterações feitas pelo admin (aba Auditoria da planilha).</p>
      ${r.auditoria.length ? `<table><thead><tr><th>Quando</th><th>Login</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>
      ${r.auditoria.map(a => `<tr><td style="white-space:nowrap">${fmtDH(a.data)}</td><td>${esc(a.login)} <span class="suave pequeno">${esc(a.perfil)}</span></td>
        <td class="${a.acao === 'Login recusado' ? 'atrasado' : ''}">${esc(a.acao)}</td><td class="suave pequeno" style="max-width:380px;overflow-wrap:anywhere">${esc(a.detalhe)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="suave">Nada registrado ainda.</p>'}</div>`;
  $$('[data-acao]').forEach(b => b.onclick = async () => {
    const m = await acao(b, () => api(b.dataset.acao, S.token));
    if (m) { aviso(m, 'ok'); cfgSituacao(); }
  });
  $$('[data-feriados]').forEach(b => b.onclick = async () => {
    const m = await acao(b, () => api('adicionarFeriadosNacionais', S.token, b.dataset.feriados));
    if (m) { aviso(m, 'ok'); cfgSituacao(); }
  });
}

function cfgGeral(c) {
  const campo = i => {
    const id = 'cfg-' + i.chave;
    if (i.tipo === 'simnao') return `<select id="${id}" data-chave="${i.chave}"><option value="SIM" ${/^s/i.test(i.valor) ? 'selected' : ''}>Sim</option><option value="NAO" ${/^s/i.test(i.valor) ? '' : 'selected'}>Não</option></select>`;
    if (i.tipo === 'hora') return `<select id="${id}" data-chave="${i.chave}">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${Number(i.valor) === h ? 'selected' : ''}>${h}h</option>`).join('')}</select>`;
    if (i.tipo === 'dias') return `<input type="text" inputmode="decimal" id="${id}" data-chave="${i.chave}" value="${esc(String(i.valor).replace('.', ','))}">`;
    return `<input type="text" id="${id}" data-chave="${i.chave}" value="${esc(i.valor)}" ${i.tipo === 'pasta' ? 'placeholder="Cole o ID ou o link da pasta do Drive…"' : ''}>`;
  };
  $('#cfg').innerHTML = `<div class="bloco"><form id="f-cfg" autocomplete="off">
    ${c.geral.filter(i => !CHAVES_AUTOMATICAS.includes(i.chave)).map(i => `<div class="cfg-linha"><div><label for="cfg-${i.chave}">${esc(ROTULOS_CONFIG[i.chave] || i.chave)}</label><div class="ajuda">${esc(i.descricao)}</div></div><div>${campo(i)}</div></div>`).join('')}
    <button class="btn btn-primario" id="b-cfg" style="margin-top:12px">Salvar configurações</button></form></div>`;
  $('#f-cfg').onsubmit = async ev => {
    ev.preventDefault();
    const v = {};
    $$('[data-chave]').forEach(el => { v[el.dataset.chave] = el.value; });
    const r = await acao($('#b-cfg'), () => api('salvarConfiguracoes', S.token, v));
    if (r) { aviso(r, 'ok'); try { S.publico = await api('dadosPublicos'); montarRodape(); } catch (e) { } }
  };
}

// ───────── Horário de funcionamento e mensagens automáticas (tabela de decisão M01/M02/M03) ─────────
const CHAVES_AUTOMATICAS = ['HORA_INICIO', 'HORA_FIM', 'NOTIFICAR_EQUIPE', 'DIAS_FUNCIONAMENTO', 'LIMITE_ALTO_VOLUME', 'MENSAGEM_AUTOMATICA', 'MSG_M01', 'MSG_M02', 'MSG_M03'];
const DIAS_SEMANA = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];
const MENSAGENS_AUTO = [
  ['M01', 'Fora do horário de funcionamento', 'Antes ou depois do expediente, fins de semana e feriados.'],
  ['M02', 'Atendimento normal', 'Dentro do horário e até o limite de chamados ativos.'],
  ['M03', 'Alto volume de atendimentos', 'Dentro do horário e acima do limite de chamados ativos.']
];
// Mesma regra do backend (regraAutomatica_): fora do horário tem prioridade sobre o volume
const regraAuto = (dentro, ativos, limite) => !dentro ? 'M01' : ativos > limite ? 'M03' : 'M02';
const SITUACAO_AUTO = { M01: 'Fora do expediente', M02: 'Atendimento normal', M03: 'Alto volume de chamados' };

function cfgAutomaticas(c) {
  const v = {};
  c.geral.forEach(i => { v[i.chave] = i.valor; });
  const ag = c.automatico || {};
  const dias = String(v.DIAS_FUNCIONAMENTO || '1,2,3,4,5').split(',').map(Number);
  const limite = Number(v.LIMITE_ALTO_VOLUME) || 10;
  const hora = chave => `<select id="au-${chave}" data-chave="${chave}">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${Number(v[chave]) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>`;
  const simnao = chave => `<select id="au-${chave}" data-chave="${chave}"><option value="SIM" ${/^s/i.test(v[chave]) ? 'selected' : ''}>Sim</option><option value="NAO" ${/^s/i.test(v[chave]) ? '' : 'selected'}>Não</option></select>`;
  const linhasDecisao = [[false, false], [false, true], [true, false], [true, true]];
  $('#cfg').innerHTML = `${cabecalhoPainel('relogio', 'Horário e mensagens automáticas', 'Quando a equipe é avisada e qual resposta o cliente recebe ao abrir um chamado.')}
    <div class="auto-agora" role="status"><span>Agora</span> <b>${ag.dentro ? 'dentro do horário' : 'fora do horário'}</b>, ${num(ag.ativos)} ${ag.ativos === 1 ? 'chamado ativo' : 'chamados ativos'}:
      um chamado aberto agora recebe <span class="chip-codigo">${esc(ag.codigo || '')}</span> ${esc(ag.situacao || '')}.
      ${ag.avisosNaFila ? `<br>${ag.avisosNaFila} ${ag.avisosNaFila === 1 ? 'aviso de chamado novo espera' : 'avisos de chamados novos esperam'} o início do expediente para ir à equipe.` : ''}</div>
    <form id="f-auto" autocomplete="off">
      <div class="bloco"><h2>Horário de funcionamento</h2>
        <div class="campo"><span class="rotulo" id="lb-dias">Dias de funcionamento</span>
          <div class="dias-semana" role="group" aria-labelledby="lb-dias">${DIAS_SEMANA.map(([n, t]) => `<label class="dia"><input type="checkbox" data-dia="${n}" ${dias.includes(n) ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div></div>
        <div class="grade-2">
          <div class="campo"><label for="au-HORA_INICIO">Início do expediente</label>${hora('HORA_INICIO')}</div>
          <div class="campo"><label for="au-HORA_FIM">Fim do expediente</label>${hora('HORA_FIM')}</div>
        </div>
        <p class="ajuda">Feriados (Configurações &gt; Feriados) ficam fora do horário. O horário também vale para os prazos dos chamados.</p>
        <div class="campo"><label for="au-NOTIFICAR_EQUIPE">Avisar Admin e N1 por e-mail a cada chamado novo</label>${simnao('NOTIFICAR_EQUIPE')}
          <div class="ajuda">O e-mail vai para quem está nos grupos sac_admin e sac_n1, só no horário de funcionamento. Chamados que chegam fora dele são avisados num resumo quando o expediente começa.</div></div>
      </div>
      <div class="bloco"><h2>Tabela de decisão</h2>
        <div class="grade-2">
          <div class="campo"><label for="au-MENSAGEM_AUTOMATICA">Responder o cliente automaticamente</label>${simnao('MENSAGEM_AUTOMATICA')}</div>
          <div class="campo"><label for="au-LIMITE_ALTO_VOLUME">Limite de chamados ativos</label><input type="number" min="1" max="1000" step="1" id="au-LIMITE_ALTO_VOLUME" data-chave="LIMITE_ALTO_VOLUME" value="${limite}"></div>
        </div>
        <div class="rolagem"><table class="tabela-decisao"><thead><tr><th>Dentro do horário?</th><th>Chamados ativos acima do limite?</th><th>Situação</th><th>Mensagem</th></tr></thead><tbody>
          ${linhasDecisao.map(([dentro, acima]) => { const cod = regraAuto(dentro, acima ? limite + 1 : 0, limite); const atual = dentro === !!ag.dentro && acima === (ag.ativos > limite);
            return `<tr class="${atual ? 'atual' : ''}"><td>${dentro ? 'Sim' : 'Não'}</td><td>${acima ? 'Sim' : 'Não'}</td><td>${SITUACAO_AUTO[cod]}</td><td><span class="chip-codigo">${cod}</span>${atual ? ' <span class="suave pequeno">agora</span>' : ''}</td></tr>`; }).join('')}
        </tbody></table></div>
        <p class="ajuda">Fora do expediente, M01 tem prioridade, qualquer que seja o volume. A resposta sai uma vez só, quando o chamado é aberto, no chat e no e-mail de abertura.</p>
      </div>
      <div class="bloco"><h2>Mensagens</h2>
        <p class="ajuda" style="margin-top:0">Use <code>{saudacao}</code> para "Bom dia", "Boa tarde" ou "Boa noite", conforme a hora.</p>
        ${MENSAGENS_AUTO.map(([cod, tit, cond]) => `<div class="campo"><label for="au-MSG_${cod}"><span class="chip-codigo">${cod}</span> ${tit}</label><div class="ajuda">${cond}</div>
          <textarea id="au-MSG_${cod}" data-chave="MSG_${cod}" rows="7">${esc(v['MSG_' + cod] || '')}</textarea></div>`).join('')}
      </div>
      <div class="bloco simulador"><h2>Simulador</h2><p class="ajuda" style="margin-top:0">Teste as regras sem abrir um chamado. Usa os textos e o limite acima, mesmo antes de salvar.</p>
        <div class="sim-controles">
          <fieldset><legend>Dentro do horário?</legend><label><input type="radio" name="sim-dentro" value="1" ${ag.dentro ? 'checked' : ''}> Sim</label><label><input type="radio" name="sim-dentro" value="0" ${ag.dentro ? '' : 'checked'}> Não</label></fieldset>
          <div class="campo"><label for="sim-ativos">Chamados ativos: <b id="sim-ativos-n"></b></label><input type="range" id="sim-ativos" min="0" max="30" value="${Math.min(ag.ativos || 0, 30)}">
            <div class="ajuda">0 a 30 chamados · limite: <span id="sim-limite"></span></div></div>
          <fieldset><legend>Saudação</legend>${[['Bom dia', 'Manhã'], ['Boa tarde', 'Tarde'], ['Boa noite', 'Noite']].map(([s, t]) => `<label><input type="radio" name="sim-saudacao" value="${s}" ${ag.saudacao === s ? 'checked' : ''}> ${t}</label>`).join('')}</fieldset>
        </div>
        <div class="sim-resultado"><div class="sim-cabeca"><span>Resultado</span> <span class="chip-codigo" id="sim-codigo"></span> <span id="sim-situacao"></span></div>
          <div class="sim-previa" id="sim-previa"></div>
          <button type="button" class="btn" id="b-copiar-sim">Copiar mensagem</button></div>
      </div>
      <button class="btn btn-primario" id="b-auto">Salvar horário e mensagens</button>
    </form>`;
  const simular = () => {
    const lim = Number($('#au-LIMITE_ALTO_VOLUME').value) || 10;
    const ativos = Number($('#sim-ativos').value);
    const dentro = ($('input[name=sim-dentro]:checked') || {}).value === '1';
    const saud = ($('input[name=sim-saudacao]:checked') || {}).value || 'Bom dia';
    const cod = regraAuto(dentro, ativos, lim);
    $('#sim-ativos-n').textContent = ativos;
    $('#sim-limite').textContent = lim;
    $('#sim-codigo').textContent = cod;
    $('#sim-situacao').textContent = SITUACAO_AUTO[cod];
    $('#sim-previa').textContent = $('#au-MSG_' + cod).value.replace(/\{saudacao\}/gi, saud);
  };
  $$('#f-auto input, #f-auto textarea, #f-auto select').forEach(el => { el.oninput = simular; el.onchange = simular; });
  simular();
  $('#b-copiar-sim').onclick = async () => {
    try { await navigator.clipboard.writeText($('#sim-previa').textContent); aviso('Mensagem copiada.', 'ok'); }
    catch (e) { window.prompt('Copie a mensagem:', $('#sim-previa').textContent); }
  };
  $('#f-auto').onsubmit = async ev => {
    ev.preventDefault();
    const valores = {};
    $$('#f-auto [data-chave]').forEach(el => { valores[el.dataset.chave] = el.value; });
    valores.DIAS_FUNCIONAMENTO = $$('#f-auto [data-dia]').filter(el => el.checked).map(el => el.dataset.dia).join(',');
    const r = await acao($('#b-auto'), () => api('salvarConfiguracoes', S.token, valores));
    if (r) { aviso(r, 'ok'); telaConfig('automaticas'); }
  };
}

function cfgCategorias(c) {
  $('#cfg').innerHTML = `${cabecalhoPainel('projetos', 'Categorias do chamado', 'Organize as opções que o cliente escolhe ao abrir um chamado.',
      '<button type="button" class="btn btn-primario" id="b-nova-categoria">Adicionar categoria</button>')}
    <div id="form-categoria" hidden></div>
    ${c.categorias.length ? `<div class="tabela-cadastro"><table><thead><tr><th class="col-n">#</th><th>Categoria</th><th class="col-acoes">Ações</th></tr></thead><tbody>
      ${c.categorias.map((nome, i) => `<tr><td class="col-n">${i + 1}</td><td class="col-nome">${esc(nome)}</td>
        <td class="col-acoes">${botaoIcone('editar', 'Editar ' + nome, `data-categoria-editar="${i}"`)}${botaoIcone('excluir', 'Excluir ' + nome, `data-categoria-excluir="${i}"`)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="vazio">Nenhuma categoria. Use <b>Adicionar categoria</b>.</div>'}`;
  const editar = indice => {
    const anterior = indice === undefined ? null : c.categorias[indice];
    const host = $('#form-categoria');
    host.innerHTML = `<form id="f-categoria" autocomplete="off"><div class="campo"><label for="categoria-nome">Nome da categoria</label><input type="text" id="categoria-nome" maxlength="80" required value="${esc(anterior || '')}"><div class="ajuda">Alterar o nome não modifica os chamados antigos.</div></div><button class="btn btn-primario" id="b-salvar-categoria">Salvar categoria</button><button type="button" class="btn" id="b-cancelar-categoria">Cancelar</button></form>`;
    $('#b-cancelar-categoria').onclick = () => fecharEditor();
    $('#f-categoria').onsubmit = async ev => {
      ev.preventDefault();
      const r = await acao($('#b-salvar-categoria'), () => api('salvarCategoria', S.token, $('#categoria-nome').value, anterior));
      if (r) { aviso(r, 'ok'); await carregarSessao(); telaConfig('categorias'); }
    };
    abrirEditor(host, anterior === null ? 'Adicionar categoria' : 'Editar categoria');
  };
  $('#b-nova-categoria').onclick = () => editar();
  $$('[data-categoria-editar]').forEach(b => b.onclick = () => editar(Number(b.dataset.categoriaEditar)));
  $$('[data-categoria-excluir]').forEach(b => b.onclick = async () => {
    const nome = c.categorias[Number(b.dataset.categoriaExcluir)];
    if (!confirmarExclusao(`a categoria "${nome}"`, 'Ela deixará de estar disponível para novos chamados. Os chamados antigos serão preservados.')) return;
    const r = await acao(b, () => api('excluirCategoria', S.token, nome));
    if (r) { aviso(r, 'ok'); await carregarSessao(); telaConfig('categorias'); }
  });
}

function formularioPerfil(host, aoSalvar, aninhado) {
  host.innerHTML = `<form id="f-perfil" autocomplete="off"><div class="campo"><label for="perfil-nome">Nome do perfil</label><input type="text" id="perfil-nome" maxlength="60" required placeholder="Ex.: Suporte de campo"><div class="ajuda">O novo perfil funciona como um setor: a pessoa vê os chamados encaminhados ao próprio setor. O acesso de administrador continua exclusivo do perfil Admin.</div></div><button class="btn btn-primario" id="b-salvar-perfil">Adicionar perfil</button><button type="button" class="btn" id="b-cancelar-perfil">Cancelar</button></form>`;
  $('#b-cancelar-perfil').onclick = () => fecharEditor();
  $('#f-perfil').onsubmit = async ev => {
    ev.preventDefault();
    const r = await acao($('#b-salvar-perfil'), () => api('criarPerfilEquipe', S.token, $('#perfil-nome').value));
    if (r) { fecharEditor(); aoSalvar(r); aviso('Perfil adicionado.', 'ok'); }
  };
  abrirEditor(host, 'Adicionar perfil', aninhado);
}

function cfgPerfis(c) {
  const perfis = c.perfis || [];
  const descricao = nome => nome === 'Admin' ? 'Administra o SAC, a equipe e as configurações.' : nome === 'N1' ? 'Atende os clientes e encaminha chamados aos setores.' : 'Acessa os chamados encaminhados a este setor.';
  $('#cfg').innerHTML = `${cabecalhoPainel('equipe', 'Perfis da equipe',
      sso() ? 'Os perfis vêm dos grupos sac_ do LLDAP: coloque cada pessoa no grupo do seu perfil.' : 'Cadastre setores para organizar os acessos e o encaminhamento de chamados.',
      sso() ? '' : '<button type="button" class="btn btn-primario" id="b-novo-perfil">Adicionar perfil</button>')}
    <div id="form-perfil" hidden></div>
    <div class="tabela-cadastro"><table><thead><tr><th class="col-n">#</th><th>Perfil</th><th>O que faz</th>${sso() ? '<th>Grupo no LLDAP</th>' : ''}<th class="col-acoes">Ações</th></tr></thead><tbody>
      ${perfis.map((p, i) => `<tr><td class="col-n">${i + 1}</td><td class="col-nome">${esc(p.nome)}</td><td class="suave">${descricao(p.nome)}</td>
        ${sso() ? `<td><code translate="no">${esc(grupoLldap(p.nome))}</code></td>` : ''}
        <td class="col-acoes">${p.fixo ? '<span class="suave pequeno">Perfil padrão</span>' : botaoIcone('excluir', 'Excluir ' + p.nome, `data-perfil-excluir="${i}"`)}</td></tr>`).join('')}
    </tbody></table></div>`;
  if ($('#b-novo-perfil')) $('#b-novo-perfil').onclick = () => formularioPerfil($('#form-perfil'), r => { S.base.setores = r.setores; telaConfig('perfis'); });
  $$('[data-perfil-excluir]').forEach(b => b.onclick = async () => {
    const nome = perfis[Number(b.dataset.perfilExcluir)].nome;
    if (!confirmarExclusao(`o perfil "${nome}"`, 'O perfil só pode ser excluído se não houver pessoas ou chamados em andamento usando-o.')) return;
    const r = await acao(b, () => api('excluirPerfilEquipe', S.token, nome));
    if (r) { aviso(r, 'ok'); await carregarSessao(); telaConfig('perfis'); }
  });
}

function cfgModulos(c) {
  $('#cfg').innerHTML = `${cabecalhoPainel('modulos', 'Módulos do sistema', 'Os módulos de cada projeto aparecem para o cliente escolher ao abrir um chamado.')}
    <div id="form-modulos" hidden></div>
    ${c.projetos.length ? `<div class="tabela-cadastro"><table><thead><tr><th class="col-n">#</th><th>Projeto</th><th>Módulos</th><th class="col-acoes">Ações</th></tr></thead><tbody>
      ${c.projetos.map((pj, i) => `<tr><td class="col-n">${i + 1}</td><td class="col-nome">${esc(pj.nome)}</td>
        <td>${pj.modulos.length ? esc(pj.modulos.join(', ')) : '<span class="suave">Sem módulos</span>'}</td>
        <td class="col-acoes">${botaoIcone('editar', 'Editar módulos de ' + pj.nome, `data-editar-modulos="${i}"`)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="vazio">${sso() ? 'Nenhum projeto ainda. Eles vêm dos grupos Projeto_... do LLDAP.' : 'Nenhum projeto ainda. Crie ou busque projetos na aba Projetos.'}</div>`}`;
  $$('[data-editar-modulos]').forEach(b => b.onclick = () => {
    const pj = c.projetos[Number(b.dataset.editarModulos)];
    const painel = $('#form-modulos');
    painel.innerHTML = `<form autocomplete="off">${tabelaModulos()}<button class="btn btn-primario" data-salvar-modulos>Salvar módulos</button><button type="button" class="btn" data-cancelar-modulos>Cancelar</button></form>`;
    preencherTabelaModulos(painel, pj.modulosDetalhes || pj.modulos);
    $('[data-cancelar-modulos]', painel).onclick = () => fecharEditor();
    $('form', painel).onsubmit = async ev => {
      ev.preventDefault();
      const r = await acao($('[data-salvar-modulos]', painel), () => api('salvarModulosProjeto', S.token, pj.id, lerTabelaModulos(painel)));
      if (r) { aviso(r, 'ok'); telaConfig('modulos'); }
    };
    abrirEditor(painel, 'Editar módulos: ' + pj.nome);
  });
}

function cfgManuais(c, editar, novo) {
  fecharEditor(true);
  const m = editar || null;
  const projetos = c.projetos;
  $('#cfg').innerHTML = `
    <div class="cabeca-lista"><div><h2>Manuais</h2><p class="suave">Organize os materiais de apoio para clientes e equipe.</p></div><button class="btn btn-primario" id="b-novo-manual">Adicionar manual</button></div>
    <div class="bloco" id="form-man" hidden><h2>${m ? 'Editar manual' : 'Adicionar manual'}</h2>
      <form id="f-man" autocomplete="off"><div class="grade-2">
        <div class="campo"><label for="man-tit">Título</label><input type="text" id="man-tit" required value="${esc(m ? m.titulo : '')}"></div>
        <div class="campo"><label for="man-ordem">Ordem na lista</label><input type="text" inputmode="numeric" id="man-ordem" value="${esc(m ? m.ordem : 1)}"></div>
        <div class="campo"><label for="man-pub">Quem vê</label><select id="man-pub">
          ${[['Clientes', 'Clientes (portal do projeto)'], ['Equipe', 'Equipe (Ajuda e manuais)'], ['Todos', 'Clientes e equipe']].map(([v, t]) => `<option value="${v}" ${m && m.publico === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="campo"><label for="man-proj">Projeto</label><select id="man-proj"><option value="">Todos os projetos</option>
          ${projetos.map(pj => `<option value="${esc(pj.nome)}" ${m && m.projeto.toLowerCase() === pj.nome.toLowerCase() ? 'selected' : ''}>${esc(pj.nome)}</option>`).join('')}</select></div>
      </div>
      <div class="campo"><label for="man-desc">Descrição curta</label><input type="text" id="man-desc" value="${esc(m ? m.descricao : '')}"></div>
      <div class="grade-2">
        <div class="campo"><label for="man-link">Link do manual</label><input type="text" id="man-link" placeholder="https://… (YouTube, Google Drive, site)" value="${esc(m && !m.arquivo ? m.link : '')}"></div>
        <div class="campo"><label for="man-arq">ou envie o arquivo</label><input type="file" id="man-arq" accept=".pdf,.doc,.docx,.ppt,.pptx,.mp4,.png,.jpg">
          <div class="ajuda">${m && m.arquivo ? 'Já tem um arquivo enviado; escolha outro só se quiser trocar. ' : ''}O arquivo fica na pasta "SC - Manuais do SAC" e abre por link.</div></div>
      </div>
      <button class="btn btn-primario" id="b-man">${m ? 'Salvar alterações' : 'Adicionar manual'}</button>
      <button type="button" class="btn" id="b-man-x">Cancelar</button></form></div>
    <div class="bloco rolagem">${c.manuais.length ? `<table><thead><tr><th>Ordem</th><th>Título</th><th>Quem vê</th><th>Projeto</th><th scope="col">Ações</th></tr></thead><tbody>
      ${c.manuais.map((x, i) => `<tr><td class="num">${esc(x.ordem)}</td><td><a href="${esc(x.link)}" target="_blank" rel="noopener"><b>${esc(x.titulo)}</b></a>
        <div class="suave pequeno">${esc(x.descricao)}${x.arquivo ? ' (arquivo enviado)' : ''}</div></td><td>${esc(x.publico)}</td><td>${esc(x.projeto || 'Todos')}</td>
        <td class="acoes-linha">${x.id ? `<button class="btn-link" data-ed="${i}">Editar</button><button class="btn-link" data-ex="${i}" style="color:var(--bloqueio)">Excluir</button>` : '<span class="suave pequeno">rode instalar() para editar</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="vazio">Nenhum manual. Use Adicionar manual para cadastrar o primeiro.</div>'}</div>`;
  $('#b-novo-manual').onclick = () => cfgManuais(c, null, true);
  $('#b-man-x').onclick = () => fecharEditor();
  $$('[data-ed]').forEach(b => b.onclick = () => cfgManuais(c, c.manuais[Number(b.dataset.ed)]));
  $$('[data-ex]').forEach(b => b.onclick = async () => {
    const x = c.manuais[Number(b.dataset.ex)];
    if (!confirmarExclusao(`o manual "${x.titulo}"`, 'O manual deixará de aparecer no portal. Confirme a exclusão.')) return;
    if (await acao(b, () => api('excluirManual', S.token, x.id), 'Manual excluído.')) telaConfig('manuais');
  });
  $('#f-man').onsubmit = async ev => {
    ev.preventDefault();
    const d = { id: m ? m.id : '', titulo: $('#man-tit').value, ordem: $('#man-ordem').value, publico: $('#man-pub').value,
      projeto: $('#man-proj').value, descricao: $('#man-desc').value, link: $('#man-link').value || (m && m.arquivo ? m.link : '') };
    const f = $('#man-arq').files[0];
    const btn = $('#b-man');
    let arquivo = null;
    if (f) { try { arquivo = await lerArquivo(f); } catch (e) { return aviso(e.message, 'erro'); } }
    const r = await acao(btn, () => api('salvarManual', S.token, d, arquivo));
    if (!r) return;
    aviso(r, 'ok');
    await carregarSessao();
    telaConfig('manuais');
  };
  if (m || novo) abrirEditor($('#form-man'), m ? 'Editar manual: ' + m.titulo : 'Adicionar manual');
}

function cfgFeriados(c) {
  const linha = (f, i) => `<div class="feriado" data-f="${i}"><input type="date" value="${esc(f.data)}" aria-label="Data">
    <input type="text" value="${esc(f.descricao)}" placeholder="Descrição…" aria-label="Descrição"><button type="button" class="btn-link" data-rem style="color:var(--bloqueio)">Remover</button></div>`;
  $('#cfg').innerHTML = `<div class="bloco" style="max-width:760px"><h2>Feriados</h2>
    <p class="suave">Dias sem atendimento. Os prazos de 3 dias úteis, o fechamento automático e a reabertura pulam essas datas. Inclua os feriados estaduais e municipais.</p>
    <form id="f-fer" autocomplete="off"><div id="lista-fer">${c.feriados.map(linha).join('')}</div>
    <div class="opcoes" style="margin-top:10px"><button type="button" class="btn" id="b-fer-add">Adicionar feriado</button>
    <button class="btn btn-primario" id="b-fer">Salvar feriados</button></div></form>
    <hr style="border:0;border-top:1px solid var(--linha);margin:18px 0">
    <div class="opcoes" style="align-items:center"><span>Feriados nacionais de</span>
      <select id="fer-ano" style="width:auto" aria-label="Ano dos feriados nacionais">${[0, 1, 2].map(i => { const a = new Date().getFullYear() + i; return `<option>${a}</option>`; }).join('')}</select>
      <button type="button" class="btn" id="b-fer-nac">Adicionar automaticamente</button></div>
    <p class="suave pequeno" style="margin-top:6px">Calcula Carnaval, Sexta-feira Santa e Corpus Christi pelo ano escolhido. Não duplica datas já cadastradas.</p></div>`;
  const ligar = () => $$('[data-rem]').forEach(b => b.onclick = () => {
    const linha = b.closest('.feriado');
    const nome = $('input[type=text]', linha).value || $('input[type=date]', linha).value || 'sem descrição';
    if (confirmarExclusao(`o feriado "${nome}"`, 'A remoção será aplicada quando você salvar os feriados.')) linha.remove();
  });
  ligar();
  $('#b-fer-nac').onclick = async e => {
    const m = await acao(e.target, () => api('adicionarFeriadosNacionais', S.token, $('#fer-ano').value));
    if (m) { aviso(m, 'ok'); telaConfig('feriados'); }
  };
  $('#b-fer-add').onclick = () => { $('#lista-fer').insertAdjacentHTML('beforeend', linha({ data: '', descricao: '' }, Date.now())); ligar(); $('#lista-fer .feriado:last-child input').focus(); };
  $('#f-fer').onsubmit = async ev => {
    ev.preventDefault();
    const lista = $$('#lista-fer .feriado').map(el => ({ data: $('input[type=date]', el).value, descricao: $('input[type=text]', el).value })).filter(f => f.data);
    const r = await acao($('#b-fer'), () => api('salvarFeriados', S.token, lista));
    if (r) aviso(r, 'ok');
  };
}

// ───────── Ajuda e manuais da equipe ─────────
const GUIA = [
  { titulo: 'Acesso pelo Authelia e LLDAP', para: ['Admin'], so: 'authelia', html: `
    <p>Todos entram com a conta Innomaker (auth.innomaker.com.br). O SAC não guarda senhas: as orientações de senha das outras seções não se aplicam.</p>
    <ul><li><b>Equipe</b>: coloque a pessoa no grupo do perfil no LLDAP (<code>sac_admin</code>, <code>sac_n1</code>, <code>sac_software</code>...). No primeiro login, ela aparece em <b>Equipe</b>.</li>
    <li><b>Projetos</b>: cada grupo <code>Projeto_...</code> do LLDAP vira um projeto do SAC no primeiro login de alguém do grupo (um projeto antigo com o mesmo nome ou código é reaproveitado). Em <b>Projetos &gt; Editar</b>, defina os módulos; nome e e-mail são de cada cliente, na conta Innomaker.</li>
    <li><b>Clientes</b>: o usuário precisa estar no grupo <code>Clientes</code> e no grupo <code>Projeto_...</code> de cada projeto em que participa. Quem participa de vários projetos vê todos e escolhe o projeto ao abrir um chamado.</li>
    <li><b>Grupos de projeto e equipe</b>: para funcionários, os grupos <code>Projeto_...</code> não mudam nada no SAC; o perfil vem só dos grupos <code>sac_</code>. Quem está em <code>Clientes</code> nunca recebe acesso de equipe.</li>
    <li><b>Tirar o acesso</b>: remova a pessoa do grupo ou desative o usuário no LLDAP. Sair da conta Innomaker ou desativá-la corta o SAC em até 30 segundos; mudanças de grupo valem em até 15 minutos.</li>
    <li><b>Perfis</b>: Admin, N1 e os setores Software, Comercial e Financeiro, pelos grupos <code>sac_admin</code>, <code>sac_n1</code>, <code>sac_software</code>, <code>sac_comercial</code> e <code>sac_financeiro</code>.</li></ul>` },
  { titulo: 'Primeiros passos do administrador', para: ['Admin'], html: `
    <ol><li>Entre com o login <b>admin</b> e a senha temporária que chegou no seu e-mail (ou no Registro de execução do Apps Script). O sistema pede para você criar uma senha nova.</li>
    <li>Abra <b>Configurações &gt; Geral</b> e confira o nome do SAC, o telefone, o horário de atendimento e o endereço do app (URL /exec). O endereço vai nos links dos e-mails.</li>
    <li>Em <b>Configurações &gt; Feriados</b>, inclua os feriados estaduais e municipais.</li>
    <li>Em <b>Projetos</b>, confira se todas as pastas da pasta geral viraram projetos e complete o responsável e o e-mail de cada um.</li>
    <li>Em <b>Equipe</b>, cadastre o N1 e as pessoas dos setores Software, Comercial e Financeiro.</li>
    <li>Em <b>Configurações &gt; Manuais</b>, publique os manuais de cada sistema para os clientes.</li></ol>` },
  { titulo: 'Projetos e logins', para: ['Admin'], html: `
    <p>Cada pasta da pasta geral do Drive é um projeto, com <b>um único login</b> para o cliente.</p>
    <ul><li><b>Buscar pastas novas</b> cria o projeto e o login das pastas que ainda não estão no SAC. Isso também acontece sozinho a cada hora, e você recebe os acessos por e-mail.</li>
    <li><b>Criar projeto</b> vincula uma pasta da pasta geral e gera o login com senha temporária. Entregue esse acesso ao cliente; não há envio automático de senha por e-mail nos projetos.</li>
    <li><b>Nova senha</b> gera uma senha temporária. A anterior para de funcionar e a pessoa troca a senha no próximo login.</li>
    <li><b>Editar</b> muda login, responsável, e-mail, telefone, módulos e desativa o acesso. Projeto desativado não entra mais no portal.</li>
    <li>O cliente pode atualizar o próprio nome de preferência e o e-mail em <b>Meu cadastro</b>. O e-mail é confirmado por código.</li>
    <li>Os anexos de cada chamado ficam em <i>pasta do projeto / SC - nome do projeto / número do chamado</i>.</li></ul>` },
  { titulo: 'Equipe e perfis', para: ['Admin'], html: `
    <ul><li><b>Admin</b>: tudo, inclusive projetos, equipe e configurações. Também atende como N1.</li>
    <li><b>N1</b>: analisa todos os chamados, faz a triagem, conversa com o cliente e encaminha aos setores. É o único contato do cliente.</li>
    <li><b>Software, Comercial, Financeiro</b>: veem só os chamados encaminhados ao seu setor, usam o chat interno e devolvem ao N1.</li></ul>
    <p>Para tirar o acesso de alguém, edite e desmarque <b>Acesso ativo</b>. O bloqueio vale em até 5 minutos.</p>` },
  { titulo: 'Configurações do sistema', para: ['Admin'], html: `
    <ul><li><b>Geral</b>: nome, telefone e texto do rodapé da tela de login, horário, prazos, avisos por e-mail e pasta geral. Os prazos aceitam meio dia (0,5).</li>
    <li><b>Categorias</b>: uma por linha, aparecem no formulário de abertura.</li>
    <li><b>Módulos</b>: lista de cada projeto. Só o 4.2.22 ERP Linave &amp; Servinave vem com módulos; projeto sem módulos não mostra o campo.</li>
    <li><b>Manuais</b>: link (YouTube, Drive, site) ou arquivo enviado. Escolha quem vê (clientes, equipe ou todos) e para qual projeto. Os clientes veem os manuais no portal, depois de entrar.</li>
    <li><b>Feriados</b>: dias que não contam no prazo.</li></ul>` },
  { titulo: 'Atender a fila', para: ['Admin', 'N1'], html: `
    <ol><li>Abra a <b>Fila de chamados</b>. Bloqueios vêm primeiro; o resto segue a ordem de chegada. Vermelho indica prazo vencido.</li>
    <li>No chamado, confira <b>Triagem</b> (categoria, módulo e prioridade) e salve. Mudar para Bloqueio recalcula o prazo.</li>
    <li>Use <b>Mudar status</b>: Em triagem, Em atendimento, Aguardando cliente (escreva o que falta), Resolvido (escreva o que foi feito) ou Cancelado (escreva o motivo). Cada mudança vai por e-mail ao cliente.</li>
    <li>Para passar a um setor, use <b>Encaminhar ao setor</b> e explique o que precisa. Você continua sendo o contato do cliente.</li>
    <li>Ligações viram chamado em <b>Abrir por telefone</b>.</li></ol>
    <p>Quem fecha o chamado é o cliente: ele confirma a correção ou pede reajuste.</p>` },
  { titulo: 'Chat do chamado', para: ['Admin', 'N1', 'Software', 'Comercial', 'Financeiro'], html: `
    <ul><li><b>Chat com o projeto</b>: conversa com o cliente. Só Admin e N1 escrevem aqui.</li>
    <li><b>Chat interno da equipe</b> (amarelo): conversa entre N1 e setores. O cliente nunca vê.</li>
    <li>Enter envia, Shift+Enter pula linha, o clipe envia arquivos. As mensagens novas aparecem sozinhas em poucos segundos.</li>
    <li>Se a outra pessoa não estiver com o chamado aberto, ela recebe um e-mail (no máximo um a cada 10 minutos por chamado).</li></ul>` },
  { titulo: 'Setores: chamados encaminhados', para: ['Software', 'Comercial', 'Financeiro'], html: `
    <ol><li>A fila mostra só os chamados que o N1 encaminhou ao seu setor. Você recebe um e-mail a cada encaminhamento.</li>
    <li>Leia a descrição, o chat com o projeto e a orientação do N1 no chat interno.</li>
    <li>Tire dúvidas com o N1 pelo chat interno e anexe arquivos por lá.</li>
    <li>Quando terminar, use <b>Devolver ao N1</b> com o que foi feito. O N1 responde ao cliente.</li></ol>` },
  { titulo: 'Regras automáticas', para: ['Admin', 'N1'], html: `
    <ul><li>Prazo: dias úteis no horário de atendimento, sem fins de semana e feriados.</li>
    <li>Prazo vencido: o cliente recebe um e-mail pedindo desculpas pelo atraso (uma vez por prazo). Não conta enquanto está Aguardando cliente ou Resolvido.</li>
    <li>Sem resposta do cliente em Aguardando cliente ou Resolvido: o chamado fecha sozinho no prazo configurado.</li>
    <li>Fechado: o cliente pode reabrir dentro do prazo configurado; depois, só abrindo outro. Ao fechar, o cliente recebe a pesquisa de satisfação.</li></ul>` },
  { titulo: 'Relatórios', para: ['Admin', 'N1'], html: `
    <p>Escolha o período e clique em <b>Gerar</b>. A primeira página traz a visão geral; as seguintes trazem módulos, categorias, tempo médio de resolução, prazo cumprido por projeto e satisfação. <b>Imprimir ou salvar PDF</b> separa cada parte em uma página.</p>` },
  { titulo: 'Problemas comuns', para: ['Admin'], html: `
    <ul><li><b>Primeira senha e recuperação</b>: na Equipe, o cadastro e o botão <b>Nova senha</b> enviam o acesso para o e-mail da pessoa. Nos Projetos, a senha temporária aparece para o administrador entregar ao cliente. No primeiro acesso, a pessoa cria a própria senha e cadastra o e-mail. Depois, "Esqueci minha senha" envia uma senha temporária válida por 24 horas para o e-mail cadastrado. Acessos que nunca entraram não têm recuperação. O administrador recebe um aviso de cada pedido.</li>
    <li><b>Esqueci a senha do admin</b>: abra o Apps Script, selecione a função <code>redefinirSenhaAdmin</code> e clique em Executar. A senha nova aparece no Registro de execução e no seu e-mail.</li>
    <li><b>E-mails não chegam</b>: confira o spam. Contas Gmail gratuitas enviam cerca de 100 e-mails por dia pelo Apps Script; com Google Workspace o limite é maior.</li>
    <li><b>Mudei o código e nada mudou</b>: em Implantar &gt; Gerenciar implantações, edite e escolha Nova versão.</li>
    <li><b>Anexo não sobe</b>: arquivos muito grandes passam do limite do Google. Compacte ou divida.</li>
    <li><b>Pasta nova não virou projeto</b>: confira se a conta do SAC é editora da pasta geral e clique em Buscar pastas novas.</li></ul>` }
];

function telaAjuda() {
  const perfil = S.usuario.perfil;
  const secoes = GUIA.filter(g => g.para.includes(perfil) && (!g.so || (g.so === 'authelia') === sso()));
  app.innerHTML = `
    <div class="cabeca-lista"><div><h1>Ajuda e manuais</h1><p class="suave" style="margin:0">Como usar o SAC no seu perfil (${esc(perfil)}).</p></div></div>
    <div class="ajuda-grade">
      <div class="guia">${secoes.map((g, i) => `<details ${i === 0 ? 'open' : ''}><summary>${g.titulo}</summary><div class="conteudo">${g.html}</div></details>`).join('')}</div>
      <aside class="bloco"><h2>Manuais da equipe</h2>
        ${S.base.manuais.length ? listaManuais(S.base.manuais) : `<p class="suave">Nenhum manual da equipe publicado.${S.usuario.admin ? ' Publique em Configurações &gt; Manuais, escolhendo "Equipe" em Quem vê.' : ''}</p>`}
      </aside>
    </div>`;
}

// ───────── Relatórios ─────────
async function telaRelatorios() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
  const inicio = hoje.slice(0, 8) + '01';
  app.innerHTML = `
    <div class="cabeca-lista nao-imprimir"><div><h1>Relatórios</h1><p class="suave" style="margin:0">Visão geral na primeira página; módulos, tempos, prazo e satisfação nas seguintes.</p></div>
      <div class="opcoes" style="align-items:flex-end">
        <div><label for="r-de">De</label><input type="date" id="r-de" value="${inicio}"></div>
        <div><label for="r-ate">Até</label><input type="date" id="r-ate" value="${hoje}"></div>
        <button class="btn btn-primario" id="b-gerar">Gerar</button>
        <button class="btn" id="b-imprimir">Imprimir ou salvar PDF</button>
        <button class="btn" id="b-csv">Exportar chamados (CSV)</button>
      </div></div>
    <div id="rel"></div>`;
  $('#b-imprimir').onclick = () => window.print();
  $('#b-csv').onclick = async e => {
    const linhas = await acao(e.target, () => api('exportarChamados', S.token, { de: $('#r-de').value, ate: $('#r-ate').value }));
    if (!linhas) return;
    const cel = v => {
      v = String(v === null || v === undefined ? '' : v);
      if (/^[=+@\-\t\r]/.test(v)) v = "'" + v;
      return /[;"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    const csv = '\ufeff' + linhas.map(l => l.map(cel).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `chamados_${$('#r-de').value || 'inicio'}_a_${$('#r-ate').value || 'hoje'}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    aviso((linhas.length - 1) + ' chamados exportados. Abra no Excel, Google Planilhas ou Looker Studio.', 'ok');
  };
  const gerar = async () => {
    const r = await acao($('#b-gerar'), () => api('relatorio', S.token, { de: $('#r-de').value, ate: $('#r-ate').value }));
    if (r && $('#rel')) $('#rel').innerHTML = montarRelatorio(r);
  };
  $('#b-gerar').onclick = gerar;
  gerar();
}

function barras(itens) {
  const max = Math.max(1, ...itens.map(i => i.total));
  return `<div class="barras">${itens.map(i => `<span>${esc(i.nome)}</span><span class="trilho"><i style="width:${(i.total / max * 100).toFixed(1)}%"></i></span><b>${i.total}</b>`).join('')}</div>`;
}

function tabela(linhas, r) {
  if (!linhas.length) return '<p class="suave">Sem chamados no período.</p>';
  const dias = h => h === null ? '' : ` <span class="suave">(${(h / r.horasDia).toFixed(1).replace('.', ',')} d)</span>`;
  return `<div class="rolagem"><table><thead><tr><th>Nome</th><th class="num">Total</th><th class="num">Ativos</th><th class="num">Resolvidos</th>
    <th class="num">Prazo vencido</th><th class="num">Tempo médio (h úteis)</th><th class="num">No prazo</th><th class="num">Satisfação</th></tr></thead>
    <tbody>${linhas.map(l => `<tr><td>${esc(l.nome)}</td><td class="num">${l.total}</td><td class="num">${l.ativos}</td><td class="num">${l.resolvidos}</td>
      <td class="num">${l.atrasados}</td><td class="num">${num(l.tempoMedioHoras)}${dias(l.tempoMedioHoras)}</td><td class="num">${num(l.slaPct, '%')}</td><td class="num">${num(l.satisfacao)}</td></tr>`).join('')}</tbody></table></div>`;
}

function montarRelatorio(r) {
  const g = r.geral;
  const per = `${r.periodo.de ? fmtD(r.periodo.de + 'T12:00:00') : 'início'} a ${r.periodo.ate ? fmtD(r.periodo.ate + 'T12:00:00') : 'hoje'}`;
  const cab = t => `<header><h2>${t}</h2><span class="suave pequeno">${per}</span></header>`;
  const s = r.satisfacao;
  return `
  <section class="pagina">${cab('Visão geral')}
    <div class="kpis">
      <div><b>${g.total}</b><span>chamados abertos no período</span></div>
      <div><b>${g.ativos}</b><span>ainda ativos</span></div>
      <div><b>${g.resolvidos}</b><span>resolvidos</span></div>
      <div><b>${num(g.slaPct, '%')}</b><span>resolvidos no prazo</span></div>
      <div><b>${num(g.tempoMedioHoras)}</b><span>horas úteis em média até resolver</span></div>
      <div><b>${num(g.satisfacao)}</b><span>satisfação média (1 a 5), ${g.respostas} respostas</span></div>
      <div><b>${g.bloqueios}</b><span>bloqueios</span></div>
      <div><b>${g.atrasados}</b><span>ativos com prazo vencido</span></div>
    </div>
    <div class="duas-col"><div><h3>Por status</h3>${barras(r.porStatus)}</div><div><h3>Aberturas por mês</h3>${r.porMes.length ? barras(r.porMes) : '<p class="suave">Sem dados.</p>'}</div></div>
    <p class="suave pequeno" style="margin-top:16px">Gerado em ${fmtDH(r.geradoEm)}. Prazo da prioridade Normal: ${r.prazoNormal} dias úteis (${r.horasDia} h úteis por dia).</p>
  </section>
  <section class="pagina">${cab('Chamados por módulo')}${tabela(r.porModulo, r)}
    <h3 style="margin-top:20px">Por categoria</h3>${tabela(r.porCategoria, r)}</section>
  <section class="pagina">${cab('Tempo médio de resolução')}
    <p class="suave">Contado em horas úteis, da abertura até o status Resolvido, só dentro do horário de atendimento e sem feriados.</p>
    <h3>Por prioridade</h3>${tabela(r.porPrioridade, r)}
    <h3 style="margin-top:20px">Por setor encaminhado</h3>${tabela(r.porSetor, r)}</section>
  <section class="pagina">${cab('Prazo cumprido por projeto')}${tabela(r.porCliente, r)}</section>
  <section class="pagina">${cab('Satisfação')}
    <p>${s.respostas} respostas; ${s.respostas ? Math.round(s.resolvidoSim * 100 / s.respostas) + '% disseram que o problema foi resolvido' : 'nenhuma no período'}.</p>
    ${barras(s.distribuicao.map(d => ({ nome: 'Nota ' + d.nota, total: d.total })))}
    <h3 style="margin-top:20px">Comentários recentes</h3>
    ${s.comentarios.length ? `<div class="rolagem"><table><thead><tr><th>Chamado</th><th>Projeto</th><th class="num">Nota</th><th>Comentário</th></tr></thead><tbody>
      ${s.comentarios.map(c => `<tr><td class="protocolo" translate="no">${esc(c.chamado)}</td><td>${esc(c.projeto)}</td><td class="num">${c.nota}</td><td>${esc(c.texto)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="suave">Nenhum comentário no período.</p>'}
  </section>`;
}
