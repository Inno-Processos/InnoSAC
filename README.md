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
│       ├── auth/oidc.js     login pelo Authelia (OpenID Connect)
│       ├── nucleo/          executor das regras, e-mail (SMTP) e gatilhos de hora em hora
│       ├── gas/servicos.js  imitação local dos serviços do Google (Planilha, Drive, Cache...)
│       └── regras/Codigo.gs regras de negócio (o mesmo código do Apps Script)
├── frontend/                interface web (porta 3000)
│   ├── server.js            entrega public/ e repassa /api e /drive ao backend
│   └── public/
│       ├── index.html       estrutura da página
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
```

`<funcao>` é qualquer função pública de `backend/src/regras/Codigo.gs` (sem `_` no fim), exceto as de manutenção.
Por padrão o navegador fala só com o frontend, que repassa `/api` e `/drive` ao backend: uma origem só, sem CORS.
Para hospedar `frontend/public/` em outro lugar, defina `apiUrl` em `config.js` e libere a origem em `CORS_ORIGIN` no backend.

## Login pelo Authelia e LLDAP

Com `AUTH_MODE=oidc` no `backend/.env`, todos (equipe e clientes) entram pela conta Innomaker em
`https://auth.innomaker.com.br` (OpenID Connect com PKCE). O SAC não guarda nem pede senhas:
login com senha, "Esqueci minha senha", "Trocar senha" e "Nova senha" ficam desligados.

**1. Gere o segredo do cliente** (em qualquer máquina com Docker):

```bash
docker run --rm authelia/authelia:latest authelia crypto hash generate pbkdf2 --variant sha512 --random --random.length 72 --random.charset rfc3986
```

A saída traz `Random Password` (vai em `OIDC_CLIENT_SECRET` no `backend/.env`) e `Digest` (vai no Authelia).

**2. Cadastre o SAC no `configuration.yml` do Authelia**, dentro de `identity_providers.oidc.clients`, e reinicie o Authelia:

```yaml
      - client_id: 'sac'
        client_name: 'SAC Innomaker'
        client_secret: '$pbkdf2-sha512$...'      # o Digest do passo 1
        public: false
        authorization_policy: 'one_factor'      # ou 'two_factor' para exigir 2FA
        consent_mode: 'implicit'                # sem tela de consentimento
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://sac.innomaker.com.br/api/auth/retorno'
        scopes: ['openid', 'profile', 'email', 'groups']
        response_types: ['code']
        grant_types: ['authorization_code']
        token_endpoint_auth_method: 'client_secret_basic'
```

**3. Crie os grupos no LLDAP.** Quem não estiver em nenhum grupo `sac_` não entra.

| Grupo no LLDAP                    | Acesso no SAC                                             |
|-----------------------------------|-----------------------------------------------------------|
| `sac_admin`                       | Admin                                                     |
| `sac_n1`                          | N1                                                        |
| `sac_software`, `sac_comercial`, `sac_financeiro` | o setor (perfis novos: `sac_<nome do perfil>`) |
| `sac_projeto_<login do projeto>`  | cliente daquele projeto (vários usuários podem dividir)   |

Os nomes exatos aparecem no SAC em **Equipe** (perfis) e em **Projetos** (coluna "Grupo no LLDAP").
Quem está em mais de um grupo de equipe fica com o perfil mais alto (Admin > N1 > setores).
No primeiro login, a pessoa da equipe é criada em **Equipe** com o usuário, o nome e o e-mail do LLDAP;
o projeto do cliente recebe o e-mail e o nome do primeiro usuário, se estiverem vazios.
Mudanças de grupo valem no próximo login; uma sessão aberta dura no máximo 6 horas.
Quem sai dos grupos de equipe fica desativado no SAC no próximo login.

**4. Configure o `backend/.env`:** `AUTH_MODE=oidc`, `OIDC_ISSUER=https://auth.innomaker.com.br`,
`OIDC_CLIENT_ID=sac`, `OIDC_CLIENT_SECRET=<Random Password>` e `PUBLIC_URL=https://sac.innomaker.com.br`.

**5. Publique** `sac.innomaker.com.br` no seu proxy (Nginx, Caddy, Traefik...) apontando para a porta 3000 (frontend).
Não coloque o *forward auth* do Authelia nesse domínio: o próprio SAC faz o login, e os links de pesquisa
de satisfação e dos manuais precisam abrir sem login.

**Sair** encerra a sessão do SAC e também a da conta Innomaker (`/logout` do Authelia).
Para testar no computador antes de publicar, acrescente `http://localhost:3000/api/auth/retorno` em `redirect_uris`
(se o seu Authelia aceitar `http` em localhost) e use `PUBLIC_URL=http://localhost:3000`.

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
