'use strict';
// Exercises the rendered controls against the real business rules, with disposable data.
// Browser-only APIs (clipboard, downloads, recording and printing) are simulated here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sac-botoes-'));
process.env.AUTH_MODE = 'senha';
process.env.SMTP_HOST = '';
const gas = require('../backend/src/gas/servicos');
const { criarExecutor } = require('../backend/src/nucleo/executor');
const mensagens = [];
const regras = criarExecutor(fs.readFileSync(path.join(__dirname, '../backend/src/regras/Codigo.gs'), 'utf8'),
  { ativo: false, despachar: msgs => mensagens.push(...msgs) });
const executar = (fn, ...args) => regras.executar(fn, args);

async function main() {
  const originalLog = console.log;
  console.log = () => {};
  try {
    executar('instalar');
    const cache = gas.makeServices(vm.createContext({})).CacheService.getScriptCache();
    const sessao = (token, login) => cache.put('sess:' + token, JSON.stringify({ login, trocar: false }), 21600);
    sessao('admin', 'admin');
    const n1 = executar('salvarMembro', 'admin', { Nome: 'Ana', Email: 'ana@example.com', Perfil: 'N1' });
    const setor = executar('salvarMembro', 'admin', { Nome: 'Sofia', Email: 'sofia@example.com', Perfil: 'Software' });
    sessao('n1', n1.login); sessao('setor', setor.login);
    fs.mkdirSync(path.join(gas.DRIVE, 'Projetos', 'Projeto teste'));
    const pasta = executar('listarPastasProjetos', 'admin')[0];
    executar('criarProjeto', 'admin', { pastaId: pasta.id, email: 'cliente@example.com', responsavel: 'Maria' });
    let projeto = executar('listarProjetos', 'admin')[0];
    sessao('cliente', projeto.Login);
    executar('salvarMeuNome', 'cliente', 'Maria', '');
    const publico = path.join(__dirname, '../frontend/public');
    const { window } = parseHTML(fs.readFileSync(path.join(publico, 'index.html'), 'utf8'));
    const { document } = window;
    let focused = document.body, confirmar = true, falhar = '', adiar = null;
    const chamadas = [], downloads = [], copias = [], timers = new Map();
    let impressos = 0, timerId = 0;
    const exercitados = new Set(), vistos = new Set();
    const chave = b => b.id ? '#' + b.id : [...b.attributes].find(a => a.name.startsWith('data-'))?.name || b.textContent.trim();
    Object.defineProperty(document, 'activeElement', { get: () => focused });
    window.HTMLElement.prototype.focus = function () { focused = this; };
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.HTMLElement.prototype.reset = function () { this.querySelectorAll('input').forEach(i => { i.value = ''; }); };
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
      get() { const o = this.querySelector('option[selected]') || this.querySelector('option:not([disabled])'); return o ? (o.getAttribute('value') ?? o.textContent) : ''; },
      set(v) { for (const o of this.querySelectorAll('option')) { if ((o.getAttribute('value') ?? o.textContent) === String(v)) o.setAttribute('selected', ''); else o.removeAttribute('selected'); } }
    });
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
      get() { return this.hasAttribute('checked'); }, set(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
    });
    window.HTMLAnchorElement.prototype.click = function () { downloads.push({ nome: this.download, href: this.href }); };
    const createElement = document.createElement.bind(document);
    document.createElement = nome => {
      const el = createElement(nome);
      if (nome === 'dialog') {
        el.showModal = () => el.setAttribute('open', '');
        el.close = () => { el.removeAttribute('open'); el.dispatchEvent(new window.Event('close')); };
      }
      if (nome === 'audio') el.play = async () => {};
      return el;
    };
    const blobs = [];
    class TestURL extends URL {
      static createObjectURL(blob) { blobs.push(blob); return 'blob:teste-' + blobs.length; }
      static revokeObjectURL() {}
    }
    class TestReader {
      readAsDataURL(f) { this.result = 'data:' + f.type + ';base64,' + Buffer.from(f.conteudo || 'teste').toString('base64'); this.onload(); }
    }
    const storage = new Map();
    const ctx = vm.createContext({
      window, document, console, URL: TestURL, URLSearchParams, Blob, File, FileReader: TestReader,
      atob, Uint8Array, CSS: { escape: s => s },
      location: { href: 'http://localhost/', pathname: '/', search: '' },
      navigator: { clipboard: { writeText: async s => copias.push(s) }, mediaDevices: {} },
      matchMedia: () => ({ matches: true }), confirm: () => confirmar,
      setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
      setInterval: () => ++timerId, clearInterval() {},
      sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
      fetch: async (url, options) => {
        if (url.endsWith('/api/auth/info')) return { ok: true, json: async () => ({ modo: 'senha' }) };
        const fn = decodeURIComponent(url.split('/').pop()), args = JSON.parse(options.body).args;
        chamadas.push([fn, ...args]);
        if (adiar && adiar.fn === fn) await adiar.promise;
        try {
          if (falhar === fn) throw new Error('Falha simulada em ' + fn);
          const resultado = executar(fn, ...args);
          return { ok: true, json: async () => ({ resultado }) };
        } catch (e) { return { ok: false, json: async () => ({ erro: e.message }) }; }
      }
    });
    window.print = () => impressos++;
    window.prompt = () => '';
    window.open = () => {};
    for (const f of ['js/api.js', 'js/app.js']) vm.runInContext(fs.readFileSync(path.join(publico, f), 'utf8'), ctx, { filename: f });
    const run = code => vm.runInContext(code, ctx);
    const $ = s => document.querySelector(s);
    const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
    const inventario = () => {
      for (const b of document.querySelectorAll('button')) {
        vistos.add(chave(b));
        assert(b.onclick || (b.type !== 'button' && b.closest('form')?.onsubmit), 'Botão sem ação: ' + chave(b));
      }
    };
    const click = async seletor => {
      const b = typeof seletor === 'string' ? $(seletor) : seletor;
      assert(b, 'Botão ausente: ' + seletor);
      inventario(); exercitados.add(chave(b));
      const ev = { target: b, currentTarget: b, preventDefault() {} };
      if (b.onclick) await b.onclick(ev);
      else { assert(b.closest('form')?.onsubmit, 'Sem submit: ' + chave(b)); await b.closest('form').onsubmit(ev); }
      await settle();
    };
    const preencher = (s, valor) => {
      const el = $(s); assert(el, s);
      if (el.tagName === 'SELECT') {
        for (const o of el.querySelectorAll('option')) {
          if ((o.getAttribute('value') ?? o.textContent) === valor) o.setAttribute('selected', '');
          else o.removeAttribute('selected');
        }
      } else el.value = valor;
    };
    const radio = (nome, valor) => {
      for (const el of document.querySelectorAll('input[name="' + nome + '"]')) {
        if (el.value === valor) el.setAttribute('checked', ''); else el.removeAttribute('checked');
      }
    };
    const arquivos = (s, lista) => Object.defineProperty($(s), 'files', { value: lista, configurable: true });
    const usuario = async token => {
      ctx.base = executar('iniciar', token); ctx.token = token;
      run('S.auth = { modo: "senha" }; S.base = base; S.usuario = base.usuario; S.token = token; S.publico = ' + JSON.stringify(executar('dadosPublicos')) + '; topo();');
      await settle();
    };
    const novaSolicitacao = () => executar('abrirChamado', 'cliente', { categoria: executar('iniciar', 'cliente').categorias[0], titulo: 'Teste dos botões', descricao: 'Descrição', bloqueio: 'Não' });

    // Login, password visibility, recovery and return buttons.
    run('S.publico = {}; telaLogin();');
    await click('[data-ver=senha]'); assert.equal($('#senha').type, 'text'); assert.equal($('[data-ver=senha]').getAttribute('aria-label'), 'Ocultar senha');
    await click('[data-ver=senha]'); assert.equal($('#senha').type, 'password');
    preencher('#login', 'admin'); preencher('#senha', 'incorreta');
    await click('#b-entrar'); assert.match($('#aviso').textContent, /incorretos/);
    await click('#b-esqueci'); preencher('#r-email', 'ninguem@example.com'); await click('#b-reset');
    assert.equal($('#esqueci-ok').hidden, false); await click('#b-voltar-login2');
    await click('#b-esqueci'); await click('#b-voltar-login');

    // Project create, edit, module controls, reset password, copy credentials and sync.
    await usuario('admin'); await click('[data-aba=projetos]');
    fs.mkdirSync(path.join(gas.DRIVE, 'Projetos', 'Novo projeto'));
    await click('#b-novo-pj');
    const novaPasta = executar('listarPastasProjetos', 'admin').find(p => !p.vinculada);
    preencher('#pj-nome', novaPasta.id); $('#pj-nome').onchange();
    await click('[data-modulo-add]'); preencher('[data-modulo-nome]', 'Compras');
    await click('[data-modulo-padrao]'); assert(document.querySelectorAll('[data-modulo-nome]').length > 1);
    await click('[data-modulo-remover]');
    await click('#b-pj'); assert(!document.querySelector('dialog'));
    await click('[data-copiar]'); assert(copias.at(-1).includes('Login:'));
    await click('[data-editar]'); preencher('#pj-resp', 'Contato atualizado'); await click('#b-pj');
    assert(executar('listarProjetos', 'admin').some(p => p.Responsavel === 'Contato atualizado'));
    await click('[data-editar]'); await click('#b-pj-x');
    await click('[data-senha]'); await click('[data-copiar]');
    fs.mkdirSync(path.join(gas.DRIVE, 'Projetos', 'Sincronizado'));
    await click('#b-sinc'); assert(executar('listarProjetos', 'admin').some(p => p.Projeto === 'Sincronizado'));

    // Team create/edit and a nested profile editor, then remove the unused profile.
    await click('[data-aba=equipe]'); await click('#b-nova-pessoa');
    preencher('#m-nome', 'Bruno'); preencher('#m-email', 'bruno@example.com');
    await click('#b-adicionar-perfil'); preencher('#perfil-nome', 'Campo'); await click('#b-salvar-perfil');
    assert($('#m-nome')); preencher('#m-perfil', 'N1'); await click('#b-m');
    assert(executar('listarEquipe', 'admin').some(m => m.Nome === 'Bruno'), $('#aviso').textContent + ' / ' + JSON.stringify(chamadas.at(-1)));
    await click('[data-editar]'); await click('#b-m');
    await click('[data-editar]'); await click('#b-m-x');
    await click('[data-senha]');
    await click('[data-aba=config]');
    await click('#b-cfg'); assert.match($('#aviso').textContent, /salvas/);
    for (const sub of ['automaticas', 'categorias', 'perfis', 'modulos', 'manuais', 'feriados', 'situacao', 'geral']) {
      await click('[data-sub=' + sub + ']'); inventario();
    }
    await click('[data-sub=automaticas]'); await click('#b-copiar-sim'); await click('#b-auto');
    assert(copias.length >= 3);
    await click('[data-sub=categorias]'); await click('#b-nova-categoria'); preencher('#categoria-nome', 'Categoria teste'); await click('#b-salvar-categoria');
    await click('[data-categoria-editar]'); await click('#b-cancelar-categoria');
    await click('#b-nova-categoria'); await click('[data-editor-fechar]');
    await click('[data-categoria-excluir]');
    await click('[data-sub=perfis]'); await click('#b-novo-perfil'); await click('#b-cancelar-perfil');
    await click('[data-perfil-excluir]');
    await click('[data-sub=modulos]'); await click('[data-editar-modulos]');
    await click('[data-salvar-modulos]');
    await click('[data-editar-modulos]'); await click('[data-cancelar-modulos]');
    await click('[data-sub=manuais]'); await click('#b-novo-manual');
    preencher('#man-tit', 'Manual teste'); preencher('#man-link', 'https://example.com/manual'); arquivos('#man-arq', []);
    await click('#b-man'); assert(executar('configuracoes', 'admin').manuais.some(m => m.titulo === 'Manual teste'));
    await click('[data-ed]'); await click('#b-man-x');
    await click('[data-ex]');
    await click('[data-sub=feriados]'); await click('#b-fer-add');
    preencher('#lista-fer .feriado:last-child input[type=date]', '2026-12-31');
    await click('#b-fer'); await click('[data-rem]'); await click('#b-fer'); await click('#b-fer-nac');
    await click('[data-sub=situacao]');
    await click('[data-feriados]');
    for (const acao of ['recriarGatilhos', 'backupAgora', 'testarEmail']) {
      // The page offers these actions according to the actual system diagnosis.
      const b = $('[data-acao=' + acao + ']'); if (b) await click(b);
    }
    await click('[data-aba=ajuda]'); assert.match($('#app').textContent, /manuais/i);

    // Client account, confirmation code, and choosing a different email.
    await usuario('cliente'); await click('#btn-cadastro');
    preencher('#c-nome', 'Maria teste'); await click('#b-nome');
    preencher('#c-email', 'novo@example.com'); await click('#b-email'); await click('#b-email-outro');
    cache.remove('email-espera:' + projeto.Login);
    preencher('#c-email', 'novo@example.com'); await click('#b-email');
    const codigo = JSON.parse(cache.get('email-troca:' + projeto.Login)).c; preencher('#c-codigo', codigo); await click('#b-email');
    assert.equal(executar('meuCadastro', 'cliente').email, 'novo@example.com');
    await click('#b-voltar'); await click('[data-aba=como]'); await click('[data-aba=novo]');
    await click('#b-cancelar-chamado'); await click('#b-novo'); await click('#b-voltar');
    await click('#b-novo');
    preencher('#n-categoria', executar('iniciar', 'cliente').categorias[0]);
    preencher('#n-titulo', 'Chamado pela interface'); preencher('#n-aconteceu', 'Teste completo'); radio('bloq', 'Não');
    arquivos('#n-arquivos', [{ name: 'teste.txt', size: 5, type: 'text/plain', conteudo: 'teste' }]); $('#n-arquivos').onchange();
    await click('[data-arquivo-ver]'); await click('[data-arquivo-tirar]');
    await click('#b-enviar'); assert($('#chat-env'));
    const id = run('S.chat.id');
    // File upload/download, image viewer and simulated audio controls.
    arquivos('#chat-arq', [{ name: 'imagem.png', type: 'image/png', conteudo: 'imagem', size: 6 }]);
    await $('#chat-arq').onchange({ target: $('#chat-arq') });
    await run('telaDetalhe(' + JSON.stringify(id) + ')'); await settle();
    await click('[data-baixar]'); await click('[data-arq]'); await click('[data-ver-img]');
    await click('[data-visor-baixar]'); await click('[data-visor-fechar]'); assert.equal($('.visor-imagem'), null);
    let tracksParados = 0;
    class GravadorTeste {
      static isTypeSupported() { return true; }
      constructor(stream, options) { this.mimeType = options?.mimeType || 'audio/webm'; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio'], { type: this.mimeType }) }); this.onstop(); }
    }
    ctx.MediaRecorder = window.MediaRecorder = GravadorTeste;
    ctx.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() { tracksParados++; } }] });
    await run('telaDetalhe(' + JSON.stringify(id) + ')');
    await click('#chat-mic'); await click('#grav-cancelar'); assert(tracksParados > 0);
    await click('#chat-mic'); await click('#grav-enviar');
    await run('telaDetalhe(' + JSON.stringify(id) + ')'); await click('[data-ouvir]');
    assert($('audio[data-audio]'));
    let liberarMicrofone, pedidosMicrofone = 0;
    ctx.navigator.mediaDevices.getUserMedia = () => {
      pedidosMicrofone++;
      return new Promise(resolve => { liberarMicrofone = () => resolve({ getTracks: () => [{ stop() { tracksParados++; } }] }); });
    };
    const primeiroPedido = $('#chat-mic').onclick();
    const segundoPedido = $('#chat-mic').onclick();
    assert.equal(pedidosMicrofone, 1, 'A pending microphone request must not be duplicated.');
    liberarMicrofone(); await primeiroPedido; await segundoPedido; await click('#grav-cancelar');
    // Upload completion after navigation must not access controls from the departed chat.
    let liberarUpload;
    adiar = { fn: 'anexar', promise: new Promise(resolve => { liberarUpload = resolve; }) };
    arquivos('#chat-arq', [{ name: 'pendente.txt', type: 'text/plain', size: 5 }]);
    const envio = $('#chat-arq').onchange({ target: $('#chat-arq') }); await settle();
    await run('telaCliente()'); liberarUpload(); await envio; adiar = null;
    assert($('#lista')); await run('telaDetalhe(' + JSON.stringify(id) + ')');
    // Returning to a visible tab must not tear down its active chat.
    run('S.tituloNovas = 2'); document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(run('S.chat.id'), id);
    preencher('#chat-txt', 'Mensagem teste'); await click('#chat-env');
    await run('telaDetalhe(' + JSON.stringify(id) + ')');
    await click('[data-abrir-reacoes]'); await click('.seletor-reacao [data-emoji="👍"]');
    await run('telaDetalhe(' + JSON.stringify(id) + ')'); await click('[data-reagir]');
    await click('[data-responder]'); await click('#b-cancelar-resposta');
    await click('[data-responder]'); preencher('#chat-txt', 'Resposta citada'); await click('#chat-env');
    await run('telaDetalhe(' + JSON.stringify(id) + ')'); await click('[data-ir]');
    // Leaving a detail through the client menu stops its polling and preserves its draft.
    preencher('#chat-txt', 'Rascunho'); await click('[data-aba=novo]');
    assert.equal(run('S.chat'), null); assert.equal(run('S.rascunhos[' + JSON.stringify(id + ':cliente') + ']'), 'Rascunho');
    await click('#b-cancelar-chamado'); await click('.linha-ch');
    await click('#b-fechar'); await click('#b-cancelar-fechar'); await click('#b-fechar'); await click('#b-confirmar-fechar');
    await click('[data-nota="5"]'); await click('#b-pesq');
    preencher('#t-reabrir', 'Problema voltou'); await click('#b-reabrir');
    assert.equal(executar('detalheChamado', 'cliente', id).chamado.Status, 'Em atendimento');

    // N1 ownership, triage, status, forwarding, sector return and transfer.
    await usuario('n1'); await click('[data-aba=fila]'); await click('#b-atualizar'); await click('.linha-ch');
    await click('#b-assumir');
    const abrirAcao = async titulo => click([...document.querySelectorAll('[data-abrir-acao]')].find(b => b.textContent === titulo));
    await abrirAcao('Editar triagem'); await click([...document.querySelectorAll('dialog button')].find(b => b.textContent === 'Cancelar'));
    await abrirAcao('Editar triagem'); await click('#b-classif');
    await abrirAcao('Alterar status'); preencher('#s-novo', 'Aguardando cliente'); preencher('#s-msg', 'Pode testar?'); await click('#b-status');
    await abrirAcao('Encaminhar ao setor'); preencher('#e-setor', 'Software'); preencher('#e-nota', 'Verifique'); await click('#b-encaminhar');
    await click('[data-canal=equipe]'); preencher('#chat-txt', 'Nota interna'); await click('#chat-env'); await click('[data-canal=cliente]');
    await usuario('setor'); await run('telaDetalhe(' + JSON.stringify(id) + ')'); preencher('#d-nota', 'Corrigido'); await click('#b-devolver');
    await usuario('n1'); await run('telaDetalhe(' + JSON.stringify(id) + ')');
    await abrirAcao('Transferir para outro N1'); preencher('#t-para', 'admin'); await click('#b-transferir');
    assert.equal(executar('obterChamado_', id).Atendente, 'admin');

    await usuario('admin'); await run('telaDetalhe(' + JSON.stringify(id) + ')');
    await abrirAcao('Alterar status'); preencher('#s-novo', 'Resolvido'); preencher('#s-msg', 'Resolvido'); await click('#b-status');
    await usuario('cliente'); await run('telaDetalhe(' + JSON.stringify(id) + ')');
    await click('#b-reajuste'); preencher('#t-reajuste', 'Ainda com erro'); await click('#b-env-reajuste');
    executar('alterarStatus', 'admin', id, 'Resolvido', 'Corrigido'); await run('telaDetalhe(' + JSON.stringify(id) + ')');
    await click('#b-confirmar'); await click('[data-nota="4"]'); await click('#b-pesq');
    // Reports, CSV, surveys, printing and deletion.
    const idCsv = novaSolicitacao();
    executar('atualizar_', 'Chamados', executar('obterChamado_', idCsv)._linha, { Categoria: '__proto__', Modulo: 'constructor', Titulo: '=1+1' });
    assert(executar('relatorio', 'admin', {}).porCategoria.some(c => c.nome === '__proto__'));
    assert.equal(executar('limparModulos_', 'constructor;__proto__;Compras'), 'constructor\n__proto__\nCompras');
    await usuario('admin'); await click('[data-aba=relatorios]'); await click('#b-gerar');
    await click('#b-imprimir'); await click('#b-csv'); assert.equal(impressos, 1); assert(downloads.length);
    assert.match(await blobs.at(-1).text(), /'=1\+1/);
    await click('[data-aba=pesquisas]'); await click('#b-atualizar'); await click('[data-abrir]');
    confirmar = false; await click('#b-excluir-chamado'); assert(executar('obterChamado_', id));
    confirmar = true; await click('#b-excluir-chamado'); assert.throws(() => executar('obterChamado_', id), /não encontrado/);
    // Phone ticket and cancellation.
    await click('[data-aba=telefone]'); await click('#b-cancelar-chamado');
    await click('[data-aba=telefone]'); preencher('#n-cliente', projeto.ProjetoId); $('#n-cliente').onchange();
    preencher('#n-categoria', executar('iniciar', 'admin').categorias[0]); preencher('#n-titulo', 'Ligação'); preencher('#n-aconteceu', 'Cliente ligou'); radio('bloq', 'Não');
    await click('#b-enviar'); await abrirAcao('Alterar status'); preencher('#s-novo', 'Cancelado'); preencher('#s-msg', 'Duplicado'); await click('#b-status');
    await click('#b-voltar');

    // Every asynchronous loading page must show API failures, rather than a permanent spinner.
    for (const [tela, fn, token] of [['telaProjetos()', 'listarProjetos', 'admin'], ['telaEquipeAdmin()', 'listarEquipe', 'admin'],
      ['telaConfig("geral")', 'configuracoes', 'admin'], ['telaMeuCadastro()', 'meuCadastro', 'cliente'], ['telaNovoChamado(true)', 'listarProjetos', 'admin']]) {
      await usuario(token); falhar = fn; await run(tela); await settle();
      assert.match($('#app').textContent, /Falha simulada/, tela); falhar = '';
    }
    // Pending attendee options must not overwrite a newly opened ticket.
    await usuario('admin');
    let liberar;
    adiar = { fn: 'atendentesN1', promise: new Promise(resolve => { liberar = resolve; }) };
    await run('telaDetalhe(' + JSON.stringify(idCsv) + ')'); adiar = null;
    await run('telaDetalhe(' + JSON.stringify(idCsv) + ')'); await settle();
    $('#t-para').innerHTML = '<option value="atual">Lista atual</option>';
    liberar(); await settle();
    assert.equal($('#t-para').textContent, 'Lista atual');
    // Password change cancellation, mandatory change and normal login success.
    await click('#btn-senha'); await click('#b-troca-sair');
    const novoAcesso = executar('salvarMembro', 'admin', { Nome: 'Login teste', Email: 'login@example.com', Perfil: 'N1' });
    run('telaLogin()'); preencher('#login', novoAcesso.login); preencher('#senha', novoAcesso.senha); await click('#b-entrar');
    for (const idSenha of ['t-atual', 't-nova', 't-conf']) await click('[data-ver=' + idSenha + ']');
    preencher('#t-atual', novoAcesso.senha); preencher('#t-nova', 'NovaSenha123'); preencher('#t-conf', 'Diferente123');
    await click('#b-troca'); assert.match($('#aviso').textContent, /não são iguais/);
    preencher('#t-conf', 'NovaSenha123'); await click('#b-troca'); assert($('#lista'));
    await click('#btn-sair'); assert($('#f-login'));
    run('S.tituloNovas = 1'); document.dispatchEvent(new window.Event('visibilitychange')); assert.equal(document.title, 'SAC');
    // First-time registration, postponed registration and expired reopening.
    executar('atualizar_', 'Projetos', executar('projetoPorId_', projeto.ProjetoId)._linha, { NomePreferido: '' });
    executar('esquecerPerfil_', projeto.Login);
    await usuario('cliente'); await run('home()'); await click('#b-depois'); await click('#b-completar');
    preencher('#c-nome', 'Maria'); await click('#b-nome');
    executar('atualizar_', 'Chamados', executar('obterChamado_', idCsv)._linha, { Status: 'Fechado', FechadoEm: new Date('2020-01-01T12:00:00Z') });
    executar('inserir_', 'Pesquisa', { Chamado: idCsv, Nota: 5, Resolvido: 'Sim', DataHora: new Date() });
    await run('telaDetalhe(' + JSON.stringify(idCsv) + ')'); await click('#b-novo2');
    // A real session can be restored after a temporary API failure.
    run('guarda.set("admin"); S.params = {};'); falhar = 'iniciar'; await run('iniciarApp()');
    assert($('#b-reconectar')); falhar = ''; await click('#b-reconectar'); assert($('#lista'));
    run('S.auth = { modo: "authelia" }; telaLogin();'); await click('#b-entrar-sso');
    assert.equal(ctx.location.href, '/');
    // Static contract: every function called by a UI control is available through the API.
    const fonte = fs.readFileSync(path.join(publico, 'js/app.js'), 'utf8');
    for (const [, fn] of fonte.matchAll(/api\('([A-Za-z][A-Za-z0-9]*)'/g)) assert(regras.publicas.has(fn), fn);
    originalLog('OK: ' + exercitados.size + ' famílias de botões exercitadas com regras reais; ' + chamadas.length + ' chamadas; ' + vistos.size + ' famílias renderizadas com ação vinculada.');
    const estaticos = [...fonte.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(m => '#' + m[1]);
    const faltantes = [...new Set(estaticos)].filter(k => !k.includes('${') && !exercitados.has(k));
    assert.deepEqual(faltantes, [], 'Todo botão com ID estático deve ser exercitado.');
    assert.deepEqual([...vistos].filter(k => !exercitados.has(k)), [], 'Todo controle renderizado deve ser exercitado.');
    // Landing links in every login state preserve the destination and offer a retry/logout.
    for (const estado of ['anonimo', 'sem-acesso', 'indisponivel']) {
      const pagina = parseHTML(fs.readFileSync(path.join(publico, 'landing.html'), 'utf8'));
      pagina.window.SAC_LANDING = { estado, entrar: 'https://auth.example/?rd=antigo', sair: 'https://auth.example/logout', erro: 'Acesso de teste' };
      vm.runInContext(fs.readFileSync(path.join(publico, 'js/landing.js'), 'utf8'), vm.createContext({
        window: pagina.window, document: pagina.document, URL, location: { href: 'https://sac.example/?chamado=CH-1' },
        fetch: async () => ({ json: async () => ({ resultado: { telefone: '(21) 99999-9999', rodape: 'Atendimento' } }) })
      }));
      await settle();
      const entrar = pagina.document.getElementById('lp-entrar');
      const destino = entrar.getAttribute('href');
      assert.equal(estado === 'anonimo' ? new URL(destino).searchParams.get('rd') : destino, 'https://sac.example/?chamado=CH-1');
      assert.equal(pagina.document.getElementById('lp-ligar').hidden, false);
      if (estado === 'sem-acesso') assert.equal(pagina.document.getElementById('lp-outra').href, 'https://auth.example/logout');
    }
    const entrada = { S: { params: { chamado: 'existente' } }, URLSearchParams, location: { search: '?chamado=outro&pesquisa=P1&k=K1' }, iniciarApp: () => {} };
    vm.runInContext(fs.readFileSync(path.join(publico, 'js/inicio.js'), 'utf8'), vm.createContext(entrada));
    assert.deepEqual(entrada.S.params, { chamado: 'existente', pesquisa: 'P1', k: 'K1' });
  } finally { console.log = originalLog; }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
