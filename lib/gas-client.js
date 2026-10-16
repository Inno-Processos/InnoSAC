// Substitui google.script.run / google.script.url no navegador, falando com o servidor local.
(function () {
  function runner(ok, falha) {
    return new Proxy({}, {
      get(_, nome) {
        if (nome === 'withSuccessHandler') return f => runner(f, falha);
        if (nome === 'withFailureHandler') return f => runner(ok, f);
        if (nome === 'withUserObject') return () => runner(ok, falha);
        return (...args) => {
          fetch('api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: nome, args }) })
            .then(r => r.json())
            .then(d => { if (d.erro !== undefined) throw new Error(d.erro); ok && ok(d.r); })
            .catch(e => { falha ? falha(e) : console.error(e); });
        };
      }
    });
  }
  function local() {
    const sp = new URLSearchParams(location.search), parameter = {}, parameters = {};
    sp.forEach((v, k) => { if (!(k in parameter)) parameter[k] = v; (parameters[k] = parameters[k] || []).push(v); });
    return { hash: location.hash.slice(1), parameter, parameters };
  }
  window.google = { script: {
    get run() { return runner(null, null); },
    url: { getLocation: cb => setTimeout(() => cb(local()), 0) },
    history: { push: (s, p, h) => history.pushState(s, '', '?' + new URLSearchParams(p || {}) + (h ? '#' + h : '')),
      replace: (s, p, h) => history.replaceState(s, '', '?' + new URLSearchParams(p || {}) + (h ? '#' + h : '')),
      setChangeHandler: () => {} },
    host: { close: () => window.close(), setHeight: () => {}, setWidth: () => {}, editor: { focus: () => {} } }
  } };
})();
