// Configuração do backend: lê backend/.env (sem sobrescrever variáveis já definidas no ambiente).
// Deve ser o primeiro require: o fuso horário precisa estar definido antes de qualquer data.
'use strict';
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
try { fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}); } catch (e) { }

process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
// A pasta data/ (o banco de dados) fica na raiz do projeto, fora de backend/ e frontend/
process.env.DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(RAIZ, '..', 'data'));

const URL_PUBLICA = String(process.env.PUBLIC_URL || 'http://localhost:' + (process.env.WEB_PORT || 3000)).replace(/\/$/, '');
const AUTH_MODO = String(process.env.AUTH_MODE || 'senha').trim().toLowerCase();
if (!['senha', 'oidc'].includes(AUTH_MODO)) throw new Error('AUTH_MODE deve ser "senha" ou "oidc".');
const OIDC = AUTH_MODO === 'oidc' ? {
  emissor: String(process.env.OIDC_ISSUER || '').replace(/\/$/, ''),
  clienteId: process.env.OIDC_CLIENT_ID || '',
  segredo: process.env.OIDC_CLIENT_SECRET || '',
  urlPublica: URL_PUBLICA
} : null;
if (OIDC && (!OIDC.emissor || !OIDC.clienteId || !OIDC.segredo)) {
  throw new Error('Com AUTH_MODE=oidc, preencha OIDC_ISSUER, OIDC_CLIENT_ID e OIDC_CLIENT_SECRET no backend/.env.');
}

module.exports = {
  RAIZ,
  URL_PUBLICA,
  AUTH_MODO,
  OIDC,
  PORTA: Number(process.env.API_PORT || 3001),
  // Origens que podem chamar a API direto do navegador (separadas por vírgula). Vazio = só via frontend.
  ORIGENS_CORS: String(process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  LIMITE_CORPO: 60 * 1024 * 1024, // anexos chegam em base64 dentro do JSON
  CODIGO: path.join(__dirname, 'regras', 'Codigo.gs')
};
