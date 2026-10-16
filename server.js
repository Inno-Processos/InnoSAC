// SAC Innomaker — versão self-hosted. Roda o Codigo.gs original em Node.js, sem Google.
// Uso:  node server.js            -> sobe o portal (porta 3000)
//       node server.js instalar   -> cria as abas e o login admin (rode uma vez)
//       node server.js <funcao>   -> roda qualquer função de manutenção (ex.: redefinirSenhaAdmin, backupDiario)
'use strict';
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
try { require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}); } catch (e) { }

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const gas = require('./lib/gas');

const PORT = Number(process.env.PORT || 3000);
const CODIGO = fs.readFileSync(path.join(__dirname, 'app', 'Codigo.gs'), 'utf8');
const script = new vm.Script(CODIGO, { filename: 'Codigo.gs' });
// Funções que só o dono roda (no Apps Script eram executadas pelo editor ou por gatilho)
const SO_MANUTENCAO = ['instalar', 'redefinirSenhaAdmin', 'backupDiario', 'rotinaHoraria', 'doGet', 'recriarGatilhosInterno'];

// ───────── E-mail ─────────
let transporte = null;
if (process.env.SMTP_HOST) {
  try {
    transporte = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  } catch (e) { console.warn('nodemailer não instalado: rode "npm install". E-mails serão salvos em data/emails.'); }
}
function despachar(msgs) {
  msgs.forEach(m => {
    const de = process.env.SMTP_FROM || process.env.SMTP_USER || 'sac@localhost';
    if (transporte) {
      transporte.sendMail({ from: m.name ? `"${m.name}" <${de}>` : de, to: m.to, cc: m.cc, bcc: m.bcc, replyTo: m.replyTo,
        subject: m.subject, text: m.body, html: m.htmlBody }).catch(e => console.error('Falha no e-mail para', m.to, e.message));
    } else {
      const f = path.join(gas.EMAILS, Date.now() + '-' + String(m.to).replace(/[^a-z0-9@._-]/gi, '_') + '.html');
      fs.writeFileSync(f, `<!-- Para: ${m.to}\nAssunto: ${m.subject} -->\n` + (m.htmlBody || `<pre>${m.body || ''}</pre>`));
      console.log('[e-mail salvo] para', m.to, '—', m.subject);
    }
  });
}

// Cada chamada roda num contexto novo, como uma execução do Apps Script (variáveis globais zeradas)
function executar(fn, args) {
  const ctx = vm.createContext({ console });
  const svc = gas.makeServices(ctx);
  Object.keys(svc).forEach(k => { if (!k.startsWith('_')) ctx[k] = svc[k]; });
  script.runInContext(ctx, { timeout: 60000 });
  if (typeof ctx[fn] !== 'function') throw new Error('Função não encontrada: ' + fn);
  try {
    const r = ctx[fn].apply(null, args || []);
    return r === undefined ? null : JSON.parse(JSON.stringify(r));
  } finally {
    svc._salvar();
    despachar(svc._enviados);
  }
}

// ───────── Linha de comando ─────────
const cmd = process.argv[2];
if (cmd) {
  try { const r = executar(cmd, process.argv.slice(3)); if (r !== null) console.log(JSON.stringify(r, null, 2)); console.log('OK:', cmd); }
  catch (e) { console.error('Erro:', e.message); process.exitCode = 1; }
  return;
}

// ───────── Gatilhos (rotinaHoraria e backupDiario) ─────────
let ultimaHora = -1;
setInterval(() => {
  const agora = new Date();
  if (agora.getMinutes() !== 0 || agora.getHours() === ultimaHora) return;
  ultimaHora = agora.getHours();
  let gat = [];
  try { gat = JSON.parse(JSON.parse(fs.readFileSync(path.join(gas.DATA, 'props.json'), 'utf8')).__gatilhos || '[]'); } catch (e) { }
  gat.forEach(t => {
    if (t.everyHours || (t.everyDays && (t.atHour === undefined || t.atHour === agora.getHours()))) {
      try { executar(t.fn); console.log('[gatilho]', t.fn); } catch (e) { console.error('[gatilho]', t.fn, e.message); }
    }
  });
}, 20000);

// ───────── HTTP ─────────
const PAGINA = fs.readFileSync(path.join(__dirname, 'app', 'Index.html'), 'utf8')
  .replace('<head>', '<head>\n<script src="/gas-client.js"></script>');
const CLIENTE = fs.readFileSync(path.join(__dirname, 'lib', 'gas-client.js'), 'utf8');

function corpo(req, limite) {
  return new Promise((ok, falha) => {
    const partes = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limite) { falha(new Error('Arquivo grande demais')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const { fn, args } = JSON.parse(await corpo(req, 60 * 1024 * 1024));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (typeof fn !== 'string' || /_$/.test(fn) || SO_MANUTENCAO.includes(fn) || !/^[A-Za-z][A-Za-z0-9]*$/.test(fn)) {
        res.statusCode = 400; return res.end(JSON.stringify({ erro: 'Função não permitida' }));
      }
      try { return res.end(JSON.stringify({ ok: true, r: executar(fn, Array.isArray(args) ? args : []) })); }
      catch (e) { return res.end(JSON.stringify({ erro: String(e && e.message || e) })); }
    }
    if (url.pathname === '/gas-client.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(CLIENTE); }
    // Links públicos dos manuais (equivalente a "qualquer pessoa com o link" no Drive)
    if (url.pathname.startsWith('/drive/')) {
      const rel = gas.relDe(url.pathname.slice(7));
      if (!/^Projetos[\\/]SC - Manuais/.test(rel) && !/[\\/]SC - Manuais[\\/]/.test(rel)) { res.statusCode = 403; return res.end('Acesso negado'); }
      const abs = path.join(gas.DRIVE, rel);
      res.setHeader('Content-Type', gas.mimeDe(abs));
      res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(abs)));
      return fs.createReadStream(abs).pipe(res);
    }
    if (url.pathname === '/' || url.pathname === '/exec' || url.pathname === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(PAGINA);
    }
    res.statusCode = 404; res.end('Não encontrado');
  } catch (e) {
    res.statusCode = 500; res.end(String(e.message || e));
  }
}).listen(PORT, () => console.log('SAC rodando em http://localhost:' + PORT));
