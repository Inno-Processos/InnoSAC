// Executa as funções das regras de negócio (regras/Codigo.gs) com os serviços do Google emulados.
'use strict';
const vm = require('vm');
const servicos = require('../gas/servicos');

// Funções que só o dono roda (no Apps Script eram executadas pelo editor ou por gatilho)
const SO_MANUTENCAO = ['instalar', 'redefinirSenhaAdmin', 'backupDiario', 'rotinaHoraria', 'doGet', 'recriarGatilhosInterno'];

function criarExecutor(codigo, correio, arquivo) {
  const script = new vm.Script(codigo, { filename: arquivo || 'Codigo.gs' });

  function contexto() {
    const ctx = vm.createContext({ console });
    const svc = servicos.makeServices(ctx);
    Object.keys(svc).forEach(k => { if (!k.startsWith('_')) ctx[k] = svc[k]; });
    script.runInContext(ctx, { timeout: 60000 });
    return { ctx, svc };
  }

  // Cada chamada roda num contexto novo, como uma execução do Apps Script (variáveis globais zeradas)
  function executar(fn, args) {
    const { ctx, svc } = contexto();
    if (typeof ctx[fn] !== 'function') throw new Error('Função não encontrada: ' + fn);
    try {
      const r = ctx[fn].apply(null, args || []);
      const resultado = r === undefined ? null : JSON.parse(JSON.stringify(r));
      if (resultado && resultado.emailEnviado && !correio.ativo) {
        resultado.emailEnviado = false;
        resultado.emailSalvoLocal = true;
      }
      return resultado;
    } finally {
      svc._salvar();
      correio.despachar(svc._enviados);
    }
  }

  // Funções que o navegador pode chamar: as públicas do Codigo.gs (sem "_" no fim), exceto as de manutenção
  const { ctx, svc } = contexto();
  const publicas = new Set(Object.keys(ctx).filter(k => typeof ctx[k] === 'function' && /^[A-Za-z][A-Za-z0-9]*$/.test(k)
    && !SO_MANUTENCAO.includes(k) && !(k in svc)));

  return { executar, publicas };
}

module.exports = { criarExecutor, SO_MANUTENCAO };
