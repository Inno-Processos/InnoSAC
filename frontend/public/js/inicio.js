// Ponto de entrada: lê os parâmetros da URL (?id=..., ?pesquisa=...&k=...) e abre o app.
// Fica separado de app.js para que os testes carreguem as telas sem iniciar o portal.
new URLSearchParams(location.search).forEach((valor, chave) => {
  if (!(chave in S.params)) S.params[chave] = valor;
});
iniciarApp();
