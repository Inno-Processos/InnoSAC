// Gatilhos de tempo (rotinaHoraria, backupDiario), como os do Apps Script, guardados em data/props.json.
'use strict';
const fs = require('fs');
const path = require('path');

function iniciarAgendador(executar, pastaDados) {
  let ultimaHora = -1;
  return setInterval(() => {
    const agora = new Date();
    if (agora.getMinutes() !== 0 || agora.getHours() === ultimaHora) return;
    ultimaHora = agora.getHours();
    let gat = [];
    try { gat = JSON.parse(JSON.parse(fs.readFileSync(path.join(pastaDados, 'props.json'), 'utf8')).__gatilhos || '[]'); } catch (e) { }
    gat.forEach(t => {
      if (t.everyHours || (t.everyDays && (t.atHour === undefined || t.atHour === agora.getHours()))) {
        try { executar(t.fn); console.log('[gatilho]', t.fn); } catch (e) { console.error('[gatilho]', t.fn, e.message); }
      }
    });
  }, 20000);
}

module.exports = { iniciarAgendador };
