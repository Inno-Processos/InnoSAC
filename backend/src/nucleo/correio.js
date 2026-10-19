// Envio dos e-mails gerados pelo MailApp: por SMTP (.env) ou, sem SMTP_HOST, salvos em data/emails/.
'use strict';
const fs = require('fs');
const path = require('path');

function criarCorreio(pastaEmails) {
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
        const f = path.join(pastaEmails, Date.now() + '-' + String(m.to).replace(/[^a-z0-9@._-]/gi, '_') + '.html');
        fs.writeFileSync(f, `<!-- Para: ${m.to}\nAssunto: ${m.subject} -->\n` + (m.htmlBody || `<pre>${m.body || ''}</pre>`));
        console.log('[e-mail salvo] para', m.to, '—', m.subject);
      }
    });
  }

  return { ativo: !!transporte, despachar };
}

module.exports = { criarCorreio };
