# SAC Innomaker — versão self-hosted

O mesmo portal do Google Apps Script (mesma tela, mesmas regras), rodando no seu próprio servidor.
`app/Codigo.gs` e `app/Index.html` são os arquivos originais, sem alteração: o servidor imita
os serviços do Google (Planilhas, Drive, Gmail, Cache, gatilhos) localmente.

| No Google                  | Aqui                                                   |
|----------------------------|--------------------------------------------------------|
| Planilha (abas)            | `data/planilha.json`                                   |
| Pasta geral do Drive       | `data/drive/Projetos/` (cada subpasta = um projeto)    |
| Anexos / manuais           | `data/drive/Projetos/<projeto>/SC - .../`              |
| Backups (Meu Drive)        | `data/drive/SC - Backups do SAC/` (últimos 15)         |
| Gmail (MailApp)            | SMTP do `.env` — ou arquivos em `data/emails/`         |
| Gatilhos de hora em hora   | relógio interno do servidor                            |

## Instalação (Node 18+)

```bash
cp .env.example .env        # ajuste PUBLIC_URL, ADMIN_EMAIL e SMTP
npm install
npm run instalar            # cria as abas e mostra login "admin" + senha temporária
npm start                   # http://localhost:3000
```

Com Docker:

```bash
cp .env.example .env
docker compose run --rm sac node server.js instalar
docker compose up -d
```

Depois de entrar, cole o endereço público em **Configurações > Geral > URL do app**.

## Projetos
Crie uma pasta por projeto em `data/drive/Projetos/` e clique em **Projetos > Buscar pastas novas**
(ou use **Criar projeto**). Pastas que começam com `SC - ` são ignoradas, como no original.

## Manutenção
- Nova senha do admin: `npm run senha-admin`
- Backup manual: `npm run backup` — ou copie a pasta `data/` inteira.
- Coloque um proxy com HTTPS (Nginx, Caddy) na frente da porta 3000.

## Observações
- A pasta `data/` é o banco de dados: faça backup dela.
- Só as funções públicas do Codigo.gs (sem `_` no fim) podem ser chamadas pelo navegador;
  `instalar`, `redefinirSenhaAdmin`, `backupDiario` e `rotinaHoraria` só pela linha de comando.
- Manuais enviados como PDF ficam em `/drive/<id>`; anexos de chamados só pelo portal (com login).
