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
const { criarAuthelia } = require('./auth/authelia');

const executor = criarExecutor(fs.readFileSync(config.CODIGO, 'utf8'), criarCorreio(gas.EMAILS));
iniciarAgendador(executor.executar, gas.DATA);
const authelia = config.AUTHELIA ? criarAuthelia({ ...config.AUTHELIA,
  entrarExterno: identidade => executor.executar('entrarExterno_', [identidade]),
  sair: token => executor.executar('sair', [token]) }) : null;
const auth = { modo: config.AUTH_MODO, urlPublica: config.URL_PUBLICA, authelia };

http.createServer(criarApp({ executor, limiteCorpo: config.LIMITE_CORPO, origensCors: config.ORIGENS_CORS, auth }))
  .listen(config.PORTA, () => console.log(`API do SAC em http://localhost:${config.PORTA} (dados: ${gas.DATA}, login: ${
    authelia ? 'Authelia ' + config.AUTHELIA.url : 'senha do SAC'})`));
