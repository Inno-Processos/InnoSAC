// Cliente HTTP da API do backend. Toda comunicação com o servidor passa por aqui:
//   POST {apiUrl}/api/<funcao>   corpo: { "args": [...] }
//   resposta 200: { "ok": true, "resultado": ... }   erro: { "erro": "mensagem" }
const SacApi = (() => {
  const base = String((window.SAC_CONFIG && window.SAC_CONFIG.apiUrl) || '').replace(/\/$/, '');

  async function chamar(funcao, args) {
    let resposta;
    try {
      resposta = await fetch(`${base}/api/${encodeURIComponent(funcao)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: args || [] })
      });
    } catch (e) {
      throw new Error('Sem conexão com o servidor. Verifique a internet e tente de novo.');
    }
    let dados;
    try { dados = await resposta.json(); } catch (e) {
      throw new Error(`Resposta inválida do servidor (HTTP ${resposta.status}).`);
    }
    if (!resposta.ok || dados.erro !== undefined) throw new Error(dados.erro || `Erro HTTP ${resposta.status}`);
    return dados.resultado === undefined ? null : dados.resultado;
  }

  // Como entrar: { modo: 'senha' } (login do SAC) ou { modo: 'oidc', sair } (Authelia)
  async function infoLogin() {
    try {
      const r = await fetch(`${base}/api/auth/info`);
      if (r.ok) return await r.json();
    } catch (e) { }
    return { modo: 'senha', sair: '' };
  }

  // Endereço que leva ao login do Authelia e, depois, de volta para "volta" (caminho do portal)
  const urlEntrar = volta => `${base}/api/auth/entrar?volta=${encodeURIComponent(volta || '/')}`;

  return { chamar, infoLogin, urlEntrar };
})();
