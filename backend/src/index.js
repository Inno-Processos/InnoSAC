// SAC Innomaker — backend (API). Uso: node src/index.js   (porta API_PORT, padrão 3001)
'use strict';
const config = require('./config');
const fs = require('fs');
const http = require('http');
const gas = require('./gas/servicos');
const { criarCorreio } = require('./nucleo/correio');
const { criarExecutor } = require('./nucleo/executor');
const { iniciarAgendador } = require('./nucleo/agendador');
const { criarApp } = require('./http/app');
const { criarOidc } = require('./auth/oidc');

const executor = criarExecutor(fs.readFileSync(config.CODIGO, 'utf8'), criarCorreio(gas.EMAILS));
iniciarAgendador(executor.executar, gas.DATA);
const auth = { modo: config.AUTH_MODO, urlPublica: config.URL_PUBLICA, oidc: config.OIDC ? criarOidc(config.OIDC) : null };

http.createServer(criarApp({ executor, limiteCorpo: config.LIMITE_CORPO, origensCors: config.ORIGENS_CORS, auth }))
  .listen(config.PORTA, () => console.log(`API do SAC em http://localhost:${config.PORTA} (dados: ${gas.DATA}, login: ${
    config.OIDC ? 'Authelia ' + config.OIDC.emissor : 'senha do SAC'})`));
