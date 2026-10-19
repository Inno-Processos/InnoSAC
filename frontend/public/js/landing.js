// Landing page: o servidor do frontend coloca em window.SAC_LANDING o motivo de não abrir o SAC
// ({ estado: 'anonimo' | 'sem-acesso' | 'indisponivel', erro, entrar, sair }).
(() => {
  const estado = window.SAC_LANDING || { estado: 'anonimo' };
  const $ = id => document.getElementById(id);
  // Depois do login, o Authelia devolve a pessoa para a página que ela tentou abrir (ex.: link de um chamado)
  const voltarAqui = link => {
    try { const u = new URL(link); u.searchParams.set('rd', location.href); return u.toString(); } catch (e) { return link; }
  };
  if (estado.entrar) $('lp-entrar').href = voltarAqui(estado.entrar);

  if (estado.estado === 'sem-acesso') {
    $('lp-titulo').textContent = 'Acesso não liberado';
    $('lp-texto').textContent = 'Você entrou com a conta Innomaker, mas ela ainda não tem acesso ao SAC.';
    $('lp-erro').textContent = estado.erro || '';
    $('lp-erro').hidden = !estado.erro;
    $('lp-entrar').textContent = 'Tentar de novo';
    $('lp-entrar').href = location.href;
    if (estado.sair) { $('lp-outra').href = estado.sair; $('lp-outra').hidden = false; }
  } else if (estado.estado === 'indisponivel') {
    $('lp-titulo').textContent = 'SAC fora do ar';
    $('lp-erro').textContent = estado.erro || 'Tente de novo em instantes.';
    $('lp-erro').hidden = false;
    $('lp-entrar').textContent = 'Tentar de novo';
    $('lp-entrar').href = location.href;
  }

  fetch('api/dadosPublicos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"args":[]}' })
    .then(r => r.json())
    .then(d => {
      const pub = d.resultado || {};
      const dig = String(pub.telefone || '').replace(/\D/g, '');
      if (!dig) return;
      const a = document.createElement('a');
      a.href = 'tel:' + (dig.length >= 10 && dig.length <= 11 ? '+55' + dig : dig);
      a.textContent = pub.telefone;
      const el = $('lp-ligar');
      el.append('Prefere ligar? ', a);
      if (pub.rodape) el.append(document.createElement('br'), pub.rodape);
      el.hidden = false;
    })
    .catch(() => { });
})();
