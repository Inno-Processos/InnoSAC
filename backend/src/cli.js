// Linha de comando de manutenção. Uso: node src/cli.js <funcao> [args...]
//   instalar             -> cria as abas e o login admin (rode uma vez)
//   redefinirSenhaAdmin  -> nova senha temporária para o admin
//   backupDiario         -> backup manual em data/drive/SC - Backups do SAC/
'use strict';
const config = require('./config');
const fs = require('fs');
const gas = require('./gas/servicos');
const { criarCorreio } = require('./nucleo/correio');
const { criarExecutor } = require('./nucleo/executor');

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('Uso: node src/cli.js <funcao> [args...]   (ex.: instalar, redefinirSenhaAdmin, backupDiario)');
  process.exit(1);
}
try {
  const r = criarExecutor(fs.readFileSync(config.CODIGO, 'utf8'), criarCorreio(gas.EMAILS)).executar(cmd, args);
  if (r !== null) console.log(JSON.stringify(r, null, 2));
  console.log('OK:', cmd);
} catch (e) { console.error('Erro:', e.message); process.exitCode = 1; }
