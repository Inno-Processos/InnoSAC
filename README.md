# SAC Innomaker — versão self-hosted (Node.js)

O portal de chamados que nasceu no Google Apps Script, agora em Node.js, com **backend e frontend separados**.
Os dois só conversam pela API HTTP (JSON).

```
sac/
├── backend/                 API HTTP + regras de negócio (porta 3001)
│   ├── .env                 configuração (copie de .env.example)
│   └── src/
│       ├── index.js         sobe a API
│       ├── cli.js           comandos de manutenção (instalar, senha do admin, backup)
│       ├── config.js        lê o .env
│       ├── http/app.js      rotas: /api/saude, POST /api/<funcao>, /api/auth/*, /drive/<id>
│       ├── auth/authelia.js confere a sessão do Authelia e os grupos do LLDAP
│       ├── nucleo/          executor das regras, e-mail (SMTP) e gatilhos de hora em hora
│       ├── gas/servicos.js  imitação local dos serviços do Google (Planilha, Drive, Cache...)
│       └── regras/Codigo.gs regras de negócio (o mesmo código do Apps Script)
├── frontend/                interface web (porta 3000)
│   ├── server.js            entrega public/ (ou a landing page sem login) e repassa /api e /drive
│   └── public/
│       ├── index.html       estrutura da página do SAC
│       ├── landing.html     página de entrada para quem não fez login
│       ├── css/             estilo.css e interno.css
│       └── js/              api.js (cliente HTTP), app.js (telas), inicio.js (partida)
├── data/                    o banco de dados (faça backup desta pasta)
├── scripts/iniciar.js       sobe backend + frontend num só terminal
└── tests/
```

| No Google                  | Aqui                                                   |
|----------------------------|--------------------------------------------------------|
| Planilha (abas)            | `data/planilha.json`                                   |
| Pasta geral do Drive       | `data/drive/Projetos/` (cada subpasta = um projeto)    |
| Anexos / manuais           | `data/drive/Projetos/<projeto>/SC - .../`              |
| Backups (Meu Drive)        | `data/drive/SC - Backups do SAC/` (últimos 15)         |
| Gmail (MailApp)            | SMTP do `backend/.env` — ou arquivos em `data/emails/` |
| Gatilhos de hora em hora   | relógio interno do backend                             |

## Como rodar (Node 18+)

Na pasta `sac`:

```bash
cp backend/.env.example backend/.env   # ajuste PUBLIC_URL, ADMIN_EMAIL e SMTP (só na 1ª vez)
npm install                            # instala backend e frontend (só na 1ª vez)
npm run instalar                       # cria as abas e mostra login "admin" + senha (só na 1ª vez)
npm start                              # sobe tudo: abra http://localhost:3000
```

- `npm run dev`: igual ao `npm start`, mas reinicia sozinho quando você salva um arquivo.
- `npm run start:backend` / `npm run start:frontend`: sobe cada parte num terminal separado.
- `Ctrl+C` desliga.

Portas e endereços (opcional): `API_PORT` no `backend/.env`; `WEB_PORT`, `API_URL` e `PUBLIC_API_URL`
no `frontend/.env` (veja `frontend/.env.example`).

Com Docker (um container para cada parte):

```bash
cp backend/.env.example backend/.env
docker compose run --rm backend node src/cli.js instalar
docker compose up -d
```

Depois de entrar, cole o endereço público em **Configurações > Geral > URL do app**.

## API

O frontend chama o backend sempre do mesmo jeito (veja `frontend/public/js/api.js`):

```
POST /api/<funcao>     corpo: { "args": [ ... ] }
200 -> { "ok": true, "resultado": ... }
400 -> { "erro": "mensagem" }      401 sessão expirada      403 troca de senha obrigatória
404 -> função inexistente ou não pública
GET  /api/saude        -> { "ok": true }
GET  /api/auth/sessao  -> 200 com sessão do Authelia válida, 401 sem login, 403 sem grupo sac_
```

`<funcao>` é qualquer função pública de `backend/src/regras/Codigo.gs` (sem `_` no fim), exceto as de manutenção.
Por padrão o navegador fala só com o frontend, que repassa `/api` e `/drive` ao backend: uma origem só, sem CORS.
Para hospedar `frontend/public/` em outro lugar, defina `apiUrl` em `config.js` e libere a origem em `CORS_ORIGIN` no backend.

## Login pelo Authelia e LLDAP

Com `AUTH_MODE=authelia` no `backend/.env`, o SAC usa a sessão que o Authelia já mantém no navegador
(cookie `authelia_session`, válido em todo `*.innomaker.com.br`). Não há senhas no SAC.

```
navegador ──(cookie authelia_session)──> frontend ──> backend ──> auth.innomaker.com.br/api/authz/auth-request
                                                                      200: usuário, nome, e-mail, grupos do LLDAP
                                                                      401: sem login  → landing page
```

- **Sem sessão no Authelia:** o endereço do SAC mostra só a landing page (`frontend/public/landing.html`), com o
  botão **Entrar com a conta Innomaker**. Depois do login, o Authelia devolve a pessoa para a página que ela abriu.
- **Com sessão:** o SAC abre direto, com o perfil definido pelos grupos do LLDAP.
- **Com sessão, mas sem grupo `sac_`:** a landing page explica que o acesso não foi liberado e oferece entrar com outra conta.
- Cada chamada à API é conferida: sair da conta Innomaker corta o SAC em até 30 segundos;
  mudanças de grupo valem em até 15 minutos. **Sair** no SAC também sai da conta Innomaker.
- Os links da pesquisa de satisfação e dos manuais continuam abrindo sem login.

**1. Regras no Authelia.** No `access_control` do `configuration.yml`, **antes** de qualquer regra mais geral
(como `*.innomaker.com.br`), porque o Authelia usa a primeira regra que combina:

```yaml
access_control:
  rules:
    # O SAC pergunta ao Authelia sobre este caminho para saber quem está logado
    - domain: 'sac.innomaker.com.br'
      resources: ['^/_sac/verificar$']
      policy: 'one_factor'      # ou 'two_factor' para exigir 2FA
    # O resto do domínio passa direto pelo Traefik: o próprio SAC mostra a landing page ou o portal
    - domain: 'sac.innomaker.com.br'
      policy: 'bypass'
```

O `bypass` é necessário quando o forward auth do Authelia está ligado para todo o entrypoint do Traefik;
sem ele, o Traefik manda direto para a tela de login do Authelia e a landing page nunca aparece.
Não é preciso cadastrar cliente OIDC nem gerar segredo.

**2. Grupos no LLDAP.** Quem não estiver em nenhum grupo `sac_` não entra.

| Grupo no LLDAP                    | Acesso no SAC                                             |
|-----------------------------------|-----------------------------------------------------------|
| `sac_admin`                       | Admin                                                     |
| `sac_n1`                          | N1                                                        |
| `sac_software`, `sac_comercial`, `sac_financeiro` | o setor (perfis novos: `sac_<nome do perfil>`) |
| `sac_projeto_<login do projeto>`  | cliente daquele projeto (vários usuários podem dividir)   |

Os nomes exatos aparecem no SAC em **Equipe** (perfis) e em **Projetos** (coluna "Grupo no LLDAP").
Quem está em mais de um grupo de equipe fica com o perfil mais alto (Admin > N1 > setores).
No primeiro acesso, a pessoa da equipe é criada em **Equipe** com o usuário, o nome e o e-mail do LLDAP;
o projeto do cliente recebe o e-mail e o nome do primeiro usuário, se estiverem vazios.
Quem sai dos grupos de equipe fica desativado no SAC.

**3. `backend/.env`:** `AUTH_MODE=authelia`, `AUTHELIA_URL=https://auth.innomaker.com.br` e
`PUBLIC_URL=https://sac.innomaker.com.br`. Se o cookie do Authelia tiver outro nome, ajuste `AUTHELIA_COOKIE`.

**4. Publique.** O `docker-compose.yml` sobe o `backend` (só na rede interna) e o `frontend` (container `sac`,
na rede `proxy` do Traefik, em `sac.innomaker.com.br`, porta 3000). Não coloque middleware do Authelia no roteador do SAC.
O SAC precisa estar num subdomínio de `innomaker.com.br`; em `localhost` o navegador não envia o cookie do Authelia
(para testar no computador, use `AUTH_MODE=senha`).

```bash
cp .env backend/.env          # se a configuração ainda estiver na raiz
docker compose down
docker compose up -d --build
docker compose logs -f        # deve mostrar "login: Authelia https://auth.innomaker.com.br"
```

## Projetos
Crie uma pasta por projeto em `data/drive/Projetos/` e clique em **Projetos > Buscar pastas novas**
(ou use **Criar projeto** e selecione a pasta no campo **Nome do projeto**).
O menu lista as pastas de `data/drive/Projetos/`; esta versão usa o Drive local, sem conexão com o Google Drive real.
Uma lista de pastas importada do Google Drive pode ser carregada por `data/drive-projects.json`,
com `folderId`, `importedAt` e `folders: [{ "id": "ID real", "name": "Nome da pasta" }]`.
Na inicialização, o servidor cria os diretórios locais correspondentes e preserva os IDs reais nos vínculos e links.
O catálogo é uma cópia da listagem na data da importação: não acompanha mudanças automaticamente
e não transfere arquivos ou anexos para o Google Drive. Ele fica em `data/`, junto com os dados privados da instalação.
Ao atualizar o catálogo, confira a listagem direta da pasta: resultados de busca podem omitir pastas.
Se a resposta atingir o limite do provedor, percorra as páginas antes de substituir o catálogo.
Pastas já cadastradas ficam indisponíveis para um novo vínculo. Pastas que começam com `SC - ` são ignoradas, como no original.

No portal do cliente, o código numérico inicial é omitido do nome do projeto:
`4.2.01 - Innoboat` aparece como `Innoboat`, e `4.2.16 Marinha - USV` como `Marinha - USV`.
Os nomes completos, IDs e logins são preservados no cadastro administrativo e no vínculo com as pastas.

Em **Criar projeto**, **Editar** ou **Configurações > Módulos**, cadastre os módulos em uma tabela
com nome e descrição opcional. Use **Adicionar módulo** para incluir linhas e **Remover** para excluí-las.
Os módulos cadastrados no formato antigo continuam disponíveis.

## Manutenção
- Verificação completa, incluindo modais, exclusões e a API: `npm test`.
- Verificação da API e do frontend em processos reais: `node tests/api.test.js` (dados temporários isolados).
- Verificação de projetos e nomes exibidos ao cliente: `node tests/projetos.test.js` (dados temporários isolados).
- Verificação de sessão, F5 e logout: `node tests/sessoes.test.js`.
- Nova senha do admin: `npm run senha-admin`
- Backup manual: `npm run backup` — ou copie a pasta `data/` inteira.
- Coloque um proxy com HTTPS (Nginx, Caddy) na frente da porta 3000 (frontend). O backend (3001) não precisa ficar exposto.

## Observações
- Na Equipe, novos cadastros e **Nova senha** solicitam o envio da senha temporária ao e-mail cadastrado. Editar os dados não redefine a senha. Nos Projetos, a primeira senha e as redefinições feitas pelo administrador aparecem na tela, sem envio automático ao cliente. Todos trocam a senha temporária no primeiro acesso; depois podem usar **Esqueci minha senha** com o e-mail cadastrado. O envio real requer SMTP configurado em `backend/.env`; sem ele, os e-mails são salvos em `data/emails/` e a tela informa isso.
- Criar e editar projetos, pessoas, manuais e módulos abre um formulário em janela modal, com a lista de fundo oculta. Cancelar, Fechar e Esc retornam à lista; exclusões pedem confirmação. As ações de triagem, status e encaminhamento também usam essa janela para manter o histórico separado do formulário.
- F5 mantém a sessão e recupera a tela aberta. Sessões válidas duram até 6 horas e sobrevivem ao reinício do servidor; **Sair** encerra o acesso. O arquivo privado `data/sessoes.json` guarda as sessões com chaves derivadas dos tokens.
- A pasta `data/` é o banco de dados: faça backup dela.
- Só as funções públicas do Codigo.gs (sem `_` no fim) podem ser chamadas pela API;
  `instalar`, `redefinirSenhaAdmin`, `backupDiario` e `rotinaHoraria` só pela linha de comando (`node backend/src/cli.js <funcao>`).
- Manuais enviados como PDF ficam em `/drive/<id>`; anexos de chamados só pelo portal (com login).
