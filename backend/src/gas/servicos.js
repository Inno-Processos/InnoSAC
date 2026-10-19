// Emulação local dos serviços do Google Apps Script usados pelo regras/Codigo.gs.
// Planilha -> data/planilha.json | Drive -> data/drive/ | Cache e Propriedades -> memória + data/props.json
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data'));
const DRIVE = path.join(DATA, 'drive');
const LIXEIRA = path.join(DATA, '.lixeira');
const DB_FILE = path.join(DATA, 'planilha.json');
const PROPS_FILE = path.join(DATA, 'props.json');
const EMAILS = path.join(DATA, 'emails');
const PLANILHA_ID = 'planilha-sac';
// O Codigo.gs vem com o ID da pasta geral do Google Drive; aqui ele aponta para data/drive/Projetos
const ALIASES = { '1SCQQuXBj7wZfbr-72Lp5OtFyPYrjXu30': 'Projetos' };

[DATA, DRIVE, LIXEIRA, EMAILS, path.join(DRIVE, 'Projetos')].forEach(d => fs.mkdirSync(d, { recursive: true }));

const isDate = v => Object.prototype.toString.call(v) === '[object Date]';
const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } };
const gravarJson = (f, o) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, f); };

// ───────── Estado persistente ─────────
let db = lerJson(DB_FILE, { abas: {}, ordem: [] }); // abas[nome] = matriz de células
let props = lerJson(PROPS_FILE, {});
let sujo = false;
function salvar() {
  if (!sujo) return;
  gravarJson(DB_FILE, db); gravarJson(PROPS_FILE, props); sujo = false;
}
const cache = new Map(); // chave -> { v, expira }
const SESSIONS_FILE = path.join(DATA, 'sessoes.json');
const sessoes = new Map(Object.entries(lerJson(SESSIONS_FILE, {})).filter(([, e]) =>
  e && typeof e.v === 'string' && Number.isFinite(e.expira) && e.expira > Date.now()));
const chaveSessao = k => crypto.createHash('sha256').update(k).digest('hex');
function salvarSessoes() {
  for (const [k, e] of sessoes) if (e.expira <= Date.now()) sessoes.delete(k);
  gravarJson(SESSIONS_FILE, Object.fromEntries(sessoes));
}
function cacheGet(k) {
  const persistente = k.startsWith('sess:');
  const mapa = persistente ? sessoes : cache;
  const chave = persistente ? chaveSessao(k) : k;
  const e = mapa.get(chave);
  if (!e) return null;
  if (e.expira <= Date.now()) {
    mapa.delete(chave);
    if (persistente) salvarSessoes();
    return null;
  }
  return e.v;
}
function cachePut(k, v, s) {
  const e = { v: String(v), expira: Date.now() + Math.min(s || 600, 21600) * 1000 };
  if (k.startsWith('sess:')) {
    sessoes.set(chaveSessao(k), e);
    salvarSessoes();
  } else cache.set(k, e);
}
function cacheRemove(k) {
  if (k.startsWith('sess:')) {
    if (sessoes.delete(chaveSessao(k))) salvarSessoes();
  } else cache.delete(k);
}

const MIMES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mp4: 'video/mp4', html: 'text/html' };
const mimeDe = n => MIMES[String(n).split('.').pop().toLowerCase()] || 'application/octet-stream';

const toBytes = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
const fromBytes = arr => Buffer.from(arr.map(b => b & 255));
const asBuffer = (v, charset) => Array.isArray(v) ? fromBytes(v) : Buffer.from(String(v), 'utf8');

function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(d.getTime())).forEach(p => { parts[p.type] = p.value; });
  const map = { yyyy: parts.year, yy: parts.year.slice(2), MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second };
  return fmt.replace(/'([^']*)'|yyyy|yy|MM|dd|HH|mm|ss/g, (m, lit) => lit !== undefined ? lit : map[m]);
}

// ───────── Drive local ─────────
const idDe = rel => 'd_' + Buffer.from(rel, 'utf8').toString('base64url');
function relDe(id) {
  id = String(id);
  if (ALIASES[id] !== undefined) return ALIASES[id];
  if (!id.startsWith('d_')) throw new Error('Arquivo ou pasta não encontrado: ' + id);
  const rel = Buffer.from(id.slice(2), 'base64url').toString('utf8');
  if (rel.split(/[\\/]/).includes('..')) throw new Error('ID inválido');
  if (!fs.existsSync(path.join(DRIVE, rel))) throw new Error('Arquivo ou pasta não encontrado: ' + id);
  return rel;
}
const seguroNome = n => String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'sem-nome';
// Catálogo importado do Drive: mantém IDs e links reais, com armazenamento local.
// Não contém credenciais e não realiza sincronização automática com o Google.
const catalogoProjetos = lerJson(path.join(DATA, 'drive-projects.json'), null);
if (catalogoProjetos && ALIASES[catalogoProjetos.folderId] === 'Projetos' && Array.isArray(catalogoProjetos.folders)) {
  const caminhos = new Set();
  catalogoProjetos.folders.forEach(pasta => {
    if (!pasta || !/^[A-Za-z0-9_-]+$/.test(pasta.id) || typeof pasta.name !== 'string' || !pasta.name.trim() || /^SC - /i.test(pasta.name)) return;
    const nome = seguroNome(pasta.name.trim());
    if (nome === '.' || nome === '..') return;
    const rel = path.join('Projetos', nome);
    if (caminhos.has(rel.toLowerCase()) || Object.hasOwn(ALIASES, pasta.id)) throw new Error('Pasta duplicada no catálogo do Drive: ' + pasta.name);
    caminhos.add(rel.toLowerCase());
    ALIASES[pasta.id] = rel;
    fs.mkdirSync(path.join(DRIVE, rel), { recursive: true });
  });
}
const iterador = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
// Endereço público do portal (o frontend): vai nos e-mails e nos links do Drive, que o frontend repassa ao backend
const URL_BASE = () => (process.env.PUBLIC_URL || ('http://localhost:' + (process.env.WEB_PORT || 3000))).replace(/\/$/, '');

function makeServices(ctx) {
  const CDate = require('vm').runInContext('Date', ctx);
  const reviver = c => (c && typeof c === 'object' && c.$d) ? new CDate(c.$d) : c;
  const paraCelula = v => {
    if (isDate(v)) return { $d: v.toISOString() };
    if (typeof v === 'string' && v.startsWith("'")) return v.slice(1);
    if (v === null || v === undefined) return '';
    return v;
  };

  function Folder(rel) {
    const abs = () => path.join(DRIVE, rel);
    const filhos = tipo => fs.readdirSync(abs(), { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && (tipo === 'd' ? e.isDirectory() : e.isFile()))
      .map(e => tipo === 'd' ? Folder(path.join(rel, e.name)) : File(path.join(rel, e.name)));
    const f = {
      getId: () => (Object.keys(ALIASES).find(k => ALIASES[k] === rel) || idDe(rel)),
      getName: () => rel ? path.basename(rel) : 'Meu Drive',
      getUrl: () => URL_BASE() + '/drive/' + idDe(rel),
      getFolders: () => iterador(filhos('d')),
      getFiles: () => iterador(filhos('f')),
      getFoldersByName: n => iterador(filhos('d').filter(x => x.getName() === String(n))),
      getFilesByName: n => iterador(filhos('f').filter(x => x.getName() === String(n))),
      createFolder: n => { const r = path.join(rel, seguroNome(n)); fs.mkdirSync(path.join(DRIVE, r), { recursive: true }); return Folder(r); },
      createFile: (blob) => {
        let nome = seguroNome(blob.getName() || 'arquivo'); let r = path.join(rel, nome); let i = 1;
        while (fs.existsSync(path.join(DRIVE, r))) { const ext = path.extname(nome); r = path.join(rel, path.basename(nome, ext) + ' (' + (i++) + ')' + ext); }
        fs.writeFileSync(path.join(DRIVE, r), blob._buf); return File(r);
      },
      setTrashed: t => { if (t) fs.renameSync(abs(), path.join(LIXEIRA, Date.now() + '-' + path.basename(rel))); return f; },
      setSharing: () => f
    };
    return f;
  }
  function Blob(buf, tipo, nome) {
    const b = { _buf: buf, getBytes: () => toBytes(buf), getContentType: () => tipo || mimeDe(nome || ''), getName: () => nome,
      setName: n => { nome = n; return b; }, getDataAsString: () => buf.toString('utf8'), setContentType: t => { tipo = t; return b; } };
    return b;
  }
  function File(rel) {
    const abs = () => path.join(DRIVE, rel);
    const f = {
      getId: () => idDe(rel), getName: () => path.basename(rel), getSize: () => fs.statSync(abs()).size,
      getDateCreated: () => new CDate(fs.statSync(abs()).birthtimeMs || fs.statSync(abs()).mtimeMs),
      getBlob: () => Blob(fs.readFileSync(abs()), mimeDe(rel), path.basename(rel)),
      getMimeType: () => mimeDe(rel), getUrl: () => URL_BASE() + '/drive/' + idDe(rel),
      setTrashed: t => { if (t) fs.renameSync(abs(), path.join(LIXEIRA, Date.now() + '-' + path.basename(rel))); return f; },
      setSharing: () => f
    };
    return f;
  }
  const arquivoPlanilha = {
    getId: () => PLANILHA_ID,
    makeCopy: (nome, pasta) => { salvar(); return pasta.createFile(Blob(Buffer.from(JSON.stringify(db)), 'application/json', nome + '.json')); }
  };

  // ───────── Planilha ─────────
  function Sheet(nome) {
    const m = () => db.abas[nome];
    const lastRow = () => { const a = m(); for (let i = a.length - 1; i >= 0; i--) if (a[i].some(c => c !== '' && c !== null)) return i + 1; return 0; };
    const lastCol = () => { let n = 0; m().forEach(r => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] !== null) { n = Math.max(n, j + 1); break; } }); return n; };
    function Range(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      const rg = {
        getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; const src = m()[r - 1 + i] || []; for (let j = 0; j < nc; j++) { const v = src[c - 1 + j]; row.push(v === undefined || v === null ? '' : reviver(v)); } out.push(row); } return out; },
        getValue: () => rg.getValues()[0][0],
        setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => put(r + i, c + j, v))); sujo = true; return rg; },
        setValue: v => { put(r, c, v); sujo = true; return rg; },
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) put(r + i, c + j, ''); sujo = true; return rg; },
        setFontWeight: () => rg, setBackground: () => rg, setFontColor: () => rg, setNumberFormat: () => rg
      };
      return rg;
    }
    function put(r, c, v) { const a = m(); while (a.length < r) a.push([]); const row = a[r - 1]; while (row.length < c) row.push(''); row[c - 1] = paraCelula(v); }
    const sh = {
      getName: () => nome,
      getLastRow: lastRow, getLastColumn: lastCol,
      getRange: (r, c, nr, nc) => Range(r, c, nr, nc),
      getDataRange: () => Range(1, 1, Math.max(lastRow(), 1), Math.max(lastCol(), 1)),
      appendRow: vals => { const r = lastRow() + 1; vals.forEach((v, j) => put(r, j + 1, v)); sujo = true; return sh; },
      deleteRow: r => { m().splice(r - 1, 1); sujo = true; return sh; },
      setFrozenRows: () => sh, autoResizeColumns: () => sh
    };
    return sh;
  }
  const planilha = {
    getId: () => PLANILHA_ID,
    getSheetByName: n => db.abas[n] ? Sheet(n) : null,
    insertSheet: n => { if (!db.abas[n]) { db.abas[n] = []; db.ordem.push(n); sujo = true; } return Sheet(n); },
    getSheets: () => db.ordem.map(Sheet),
    deleteSheet: s => { delete db.abas[s.getName()]; db.ordem = db.ordem.filter(x => x !== s.getName()); sujo = true; }
  };

  const tz = process.env.TZ || 'America/Sao_Paulo';
  const enviados = [];

  return {
    SpreadsheetApp: { getActiveSpreadsheet: () => planilha, openById: () => planilha, flush: salvar },
    DriveApp: {
      getRootFolder: () => Folder(''),
      getFolderById: id => { const r = relDe(id); if (!fs.statSync(path.join(DRIVE, r)).isDirectory()) throw new Error('Não é pasta'); return Folder(r); },
      getFileById: id => { if (String(id) === PLANILHA_ID) return arquivoPlanilha; const r = relDe(id); return File(r); },
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', ANYONE: 'ANYONE', PRIVATE: 'PRIVATE' },
      Permission: { VIEW: 'VIEW', EDIT: 'EDIT' }
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: (k, v) => { props[k] = String(v); sujo = true; },
      deleteProperty: k => { delete props[k]; sujo = true; },
      getProperties: () => Object.assign({}, props)
    }) },
    CacheService: { getScriptCache: () => ({
      get: cacheGet, put: cachePut, remove: cacheRemove
    }) },
    LockService: { getScriptLock: () => ({ waitLock: () => true, tryLock: () => true, releaseLock: () => {}, hasLock: () => true }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => process.env.ADMIN_EMAIL || 'admin@localhost' }),
      getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => tz },
    ScriptApp: {
      getService: () => ({ getUrl: () => URL_BASE() }),
      getProjectTriggers: () => (JSON.parse(props.__gatilhos || '[]')).map(t => ({ getHandlerFunction: () => t.fn, _id: t.id })),
      deleteTrigger: t => { props.__gatilhos = JSON.stringify(JSON.parse(props.__gatilhos || '[]').filter(x => x.id !== t._id)); sujo = true; },
      newTrigger: fn => { const t = { fn, id: crypto.randomUUID() }; const b = {
        timeBased: () => b, everyHours: n => { t.everyHours = n; return b; }, everyDays: n => { t.everyDays = n; return b; },
        atHour: h => { t.atHour = h; return b; }, everyMinutes: n => { t.everyMinutes = n; return b; },
        create: () => { const l = JSON.parse(props.__gatilhos || '[]'); l.push(t); props.__gatilhos = JSON.stringify(l); sujo = true; return t; } }; return b; }
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256', SHA_1: 'sha1', MD5: 'md5', SHA_512: 'sha512' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, v, cs) => toBytes(crypto.createHash(alg).update(asBuffer(v, cs)).digest()),
      computeHmacSha256Signature: (v, k) => toBytes(crypto.createHmac('sha256', asBuffer(k)).update(asBuffer(v)).digest()),
      base64Encode: v => asBuffer(v).toString('base64'),
      base64EncodeWebSafe: v => asBuffer(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Decode: s => toBytes(Buffer.from(String(s), 'base64')),
      newBlob: (data, tipo, nome) => Blob(asBuffer(data), tipo, nome),
      formatDate: (d, z, f) => formatDate(d, z || tz, f),
      sleep: () => {}
    },
    MailApp: {
      getRemainingDailyQuota: () => Number(process.env.MAIL_QUOTA || 1000),
      sendEmail: function (a, b, c, d) {
        const msg = typeof a === 'object' ? a : Object.assign({ to: a, subject: b, body: c }, d || {});
        enviados.push(msg);
      }
    },
    HtmlService: { createHtmlOutputFromFile: () => { const o = { setTitle: () => o, addMetaTag: () => o, setXFrameOptionsMode: () => o }; return o; },
      XFrameOptionsMode: { ALLOWALL: 1, DEFAULT: 0 } },
    Logger: { log: (...a) => console.log('[Logger]', ...a) },
    _enviados: enviados,
    _salvar: salvar
  };
}

module.exports = { makeServices, salvar, DATA, DRIVE, EMAILS, relDe, mimeDe };
