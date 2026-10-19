// Sobe backend e frontend juntos num só terminal (Ctrl+C encerra os dois).
// Uso: node scripts/iniciar.js [--watch]   (--watch reinicia cada parte ao salvar um arquivo)
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.join(__dirname, '..');
const watch = process.argv.includes('--watch') ? ['--watch'] : [];
const partes = [
  { nome: 'api', cwd: path.join(raiz, 'backend'), entrada: 'src/index.js' },
  { nome: 'web', cwd: path.join(raiz, 'frontend'), entrada: 'server.js' }
];

let encerrando = false;
const filhos = partes.map(p => {
  const filho = spawn(process.execPath, [...watch, p.entrada], { cwd: p.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefixar = destino => dados => String(dados).split(/\r?\n/).filter(Boolean).forEach(l => destino.write(`[${p.nome}] ${l}\n`));
  filho.stdout.on('data', prefixar(process.stdout));
  filho.stderr.on('data', prefixar(process.stderr));
  filho.on('exit', codigo => {
    if (encerrando) return;
    console.error(`[${p.nome}] parou (código ${codigo}). Encerrando tudo.`);
    encerrar(codigo || 1);
  });
  return filho;
});

function encerrar(codigo) {
  encerrando = true;
  filhos.forEach(f => f.kill());
  process.exitCode = codigo;
}
process.on('SIGINT', () => encerrar(0));
process.on('SIGTERM', () => encerrar(0));
