# Instalação do WA-AKG em um VPS

Guia para colocar o [WA-AKG](https://github.com/mrifqidaffaaditya/WA-AKG) rodando
num servidor próprio, com domínio e HTTPS, pronto para ser usado como gateway de
WhatsApp do ProspecAtlas.

O WA-AKG é um gateway e painel de WhatsApp self-hosted (Next.js 16 + Baileys +
Prisma, licença MIT). Ele conecta números de WhatsApp por QR code, envia e recebe
mensagens, agenda disparos, responde automaticamente e dispara webhooks.

**Verificado em 05/10/2026** contra o repositório na versão `1.6.4`, branch `main`.
Os comandos vieram do `README.md`, `package.json`, `.env.example`,
`ecosystem.config.js`, `prisma/schema.prisma` e `src/server/index.ts` do projeto.
Quando o repositório mudar, confira antes de seguir ao pé da letra.

---

## O que este guia cobre (e o que não cobre)

O projeto já tem documentação própria, boa e mais atualizada que qualquer cópia
que eu fizesse aqui:

| Assunto | Onde está |
|---|---|
| Instalação resumida | [README](https://github.com/mrifqidaffaaditya/WA-AKG#-quick-installation) |
| Todas as variáveis de ambiente | [docs/ENVIRONMENT_VARIABLES.md](https://github.com/mrifqidaffaaditya/WA-AKG/blob/main/docs/ENVIRONMENT_VARIABLES.md) |
| Banco de dados | [docs/DATABASE_SETUP.md](https://github.com/mrifqidaffaaditya/WA-AKG/blob/main/docs/DATABASE_SETUP.md) |
| Uso do painel | [docs/USER_GUIDE.md](https://github.com/mrifqidaffaaditya/WA-AKG/blob/main/docs/USER_GUIDE.md) |
| API REST | [docs/API_DOCUMENTATION.md](https://github.com/mrifqidaffaaditya/WA-AKG/blob/main/docs/API_DOCUMENTATION.md) |
| Atualização | [docs/UPDATE_GUIDE.md](https://github.com/mrifqidaffaaditya/WA-AKG/blob/main/docs/UPDATE_GUIDE.md) |

**Este guia cobre o que falta lá:** provisionar e proteger o servidor, instalar
MySQL, publicar com domínio e HTTPS, e as armadilhas que só aparecem quando se
roda em produção — especialmente a configuração de WebSocket no Nginx, sem a
qual o QR code simplesmente não aparece.

---

## 1. Antes de começar

### Decisões que mudam o caminho

**PM2 ou Docker?** O projeto recomenda PM2 e traz um `ecosystem.config.js`
pronto; também há `docker-compose.yml`. Este guia usa **PM2**, porque é o
caminho recomendado pelo autor e dá mais visibilidade de logs e recursos num
VPS pequeno. Se você prefere Docker, o `docker compose up -d` sobe o MySQL
junto — pule as seções 4 e 6.

**MySQL ou PostgreSQL?** O `.env.example` menciona os dois, mas o
`prisma/schema.prisma` tem `provider = "mysql"` fixo. Para usar PostgreSQL você
precisa **editar o schema** antes do `db:push`. Este guia usa MySQL, que é o
padrão do projeto.

### Servidor

O mínimo que funciona bem: **2 GB de RAM, 1–2 vCPU, 25 GB de disco**, Ubuntu
24.04 LTS. O Baileys mantém uma conexão WebSocket viva por número conectado e o
`ecosystem.config.js` reinicia o processo se ele passar de 1 GB — com 1 GB de
RAM total você vai ver reinícios.

Opções com preço parecido (valores de referência, confira no provedor):

- **Hetzner CX22** — 2 vCPU, 4 GB, ~€4/mês. Melhor custo-benefício; datacenter
  na Alemanha ou EUA (latência maior para o Brasil, irrelevante aqui).
- **DigitalOcean Basic** — 1 vCPU, 2 GB, ~US$12/mês. Interface simples, muito
  material de apoio.
- **Contabo VPS S** — 4 vCPU, 8 GB, ~€6/mês. Mais recurso pelo preço, suporte
  mais lento.
- **Magalu Cloud / Locaweb** — se você precisa de nota fiscal brasileira e
  servidor no Brasil.

Você também vai precisar de um **domínio** (ou subdomínio) apontando para o
servidor — por exemplo `wa.seudominio.com.br`.

### Sobre contas de WhatsApp

O WA-AKG usa o Baileys, que conversa com o WhatsApp Web **não oficialmente**.
Isso tem consequências reais: a conta pode ser banida se enviar mensagens em
massa para quem não é seu contato, e nada disso é coberto por suporte da Meta.
Para prospecção fria, prefira a API oficial (Cloud API). Para conversar com
quem já respondeu, o gateway resolve bem.

---

## 2. Criar o servidor

No painel do provedor, crie uma VM com:

- **Imagem:** Ubuntu 24.04 LTS
- **Autenticação:** chave SSH (não senha)
- **Região:** a mais próxima de você

Se você ainda não tem chave SSH, gere no Windows (PowerShell):

```powershell
ssh-keygen -t ed25519 -C "wa-akg"
type $env:USERPROFILE\.ssh\id_ed25519.pub
```

Cole o conteúdo da chave pública no painel do provedor ao criar a VM.

Primeiro acesso, trocando `SEU_IP` pelo IP da máquina:

```bash
ssh root@SEU_IP
```

---

## 3. Proteger o servidor

Faça isto **antes** de instalar qualquer coisa. Um Ubuntu recém-criado com SSH
aberto começa a receber tentativas de login em minutos.

```bash
# Atualiza tudo
apt update && apt upgrade -y

# Cria um usuário comum (troque "isaac" pelo nome que preferir)
adduser isaac
usermod -aG sudo isaac

# Leva sua chave SSH para o novo usuário
rsync --archive --chown=isaac:isaac ~/.ssh /home/isaac

# Firewall: só SSH, HTTP e HTTPS
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```

Note que a porta da aplicação (3000) **não** é liberada: quem fala com a
internet é o Nginx, e o WA-AKG só escuta em `localhost`.

Agora desligue o login direto como root:

```bash
sudo nano /etc/ssh/sshd_config
```

Ajuste estas três linhas:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

```bash
sudo systemctl restart ssh
```

**Antes de fechar o terminal**, abra outro e confirme que o acesso novo
funciona: `ssh isaac@SEU_IP`. Se algo deu errado, você ainda tem a sessão
antiga aberta para corrigir.

Opcional, mas recomendado — bloqueia IPs que erram a senha repetidamente:

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

---

## 4. Instalar as dependências

Conectado como o usuário comum (`ssh isaac@SEU_IP`):

```bash
# Node.js 22 (o projeto pede 20+, recomenda 22)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # deve mostrar v22.x

# Ferramentas
sudo apt install -y git build-essential
sudo npm install -g pm2

# Banco e proxy
sudo apt install -y mysql-server nginx
```

O `build-essential` não é decoração: algumas dependências do Baileys compilam
código nativo na instalação.

Proteja o MySQL:

```bash
sudo mysql_secure_installation
```

Responda: senha forte para o root, remover usuários anônimos **sim**, proibir
login remoto do root **sim**, remover o banco de teste **sim**, recarregar
privilégios **sim**.

---

## 5. Criar o banco

```bash
sudo mysql
```

Dentro do MySQL (troque a senha):

```sql
CREATE DATABASE wa_akg CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wa_akg'@'localhost' IDENTIFIED BY 'UMA_SENHA_FORTE_AQUI';
GRANT ALL PRIVILEGES ON wa_akg.* TO 'wa_akg'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

O `utf8mb4` importa: sem ele, emoji em mensagem quebra a gravação.

Guarde essa senha — ela vai para o `DATABASE_URL` no próximo passo.

---

## 6. Instalar o WA-AKG

```bash
cd ~
git clone https://github.com/mrifqidaffaaditya/WA-AKG.git
cd WA-AKG
npm install
```

O `npm install` roda `patch-package` no final (é o `postinstall` do projeto) —
isso é esperado.

### Configurar o `.env`

```bash
cp .env.example .env
# gere o segredo e já copie o resultado
openssl rand -base64 32
nano .env
```

O `.env.example` tem dezenas de variáveis. Estas são as que **precisam** mudar:

```ini
# Porta interna: o Nginx fala com ela, a internet não
PORT="3000"
HOSTNAME="127.0.0.1"

# Banco criado no passo anterior
DATABASE_URL="mysql://wa_akg:UMA_SENHA_FORTE_AQUI@localhost:3306/wa_akg"

# Cole aqui o resultado do `openssl rand -base64 32`
AUTH_SECRET="..."

# Seu domínio, com https
BASE_URL="https://wa.seudominio.com.br"
NEXTAUTH_URL="https://wa.seudominio.com.br"
NEXT_PUBLIC_APP_URL="https://wa.seudominio.com.br"
NEXT_PUBLIC_API_URL="https://wa.seudominio.com.br/api"

# Está atrás do Nginx
AUTH_TRUST_HOST="true"
NODE_ENV="production"

# O projeto é indonésio: os padrões vêm de lá e quebram horários agendados
TZ="America/Sao_Paulo"
LOCALE="pt-BR"

# A documentação Swagger fica exposta em /docs com estas credenciais
NEXT_PUBLIC_SWAGGER_USERNAME="admin"
NEXT_PUBLIC_SWAGGER_PASSWORD="TROQUE_ISTO"
```

Quatro observações que valem o tempo de ler:

1. **`AUTH_SECRET` em branco derruba o servidor em produção** — o próprio
   `.env.example` avisa: "Server will exit immediately if this is not
   configured in production".
2. **`HOSTNAME="127.0.0.1"`** faz o Node escutar só localmente. Se deixar
   `localhost` funciona igual; o que não pode é `0.0.0.0`, que exporia a porta
   3000 direto na internet, sem HTTPS.
3. **`TZ` e `LOCALE` vêm como `Asia/Jakarta` e `id-ID`.** Se você não trocar,
   mensagens agendadas saem no fuso errado — 10 ou 11 horas de diferença.
4. **A senha padrão do Swagger é `admin123`.** O `/docs` fica público; troque.

### Criar as tabelas e o primeiro acesso

```bash
npm run db:push
npm run make-admin seu@email.com SUA_SENHA_FORTE
```

O `db:push` roda `prisma db push && prisma generate` — cria as 19 tabelas e
gera o client. O `make-admin` cria a conta SUPERADMIN com o e-mail e a senha
que você passar como argumentos.

---

## 7. Subir com PM2

```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # execute o comando que ele imprimir, com sudo
```

O `ecosystem.config.js` do projeto roda `npx tsx src/server/index.ts` —
**não** `next start`. Isso porque o WA-AKG tem servidor HTTP próprio, que
carrega o Next, o socket.io e o gerenciador de sessões do Baileys no mesmo
processo. Se você tentar subir com `next start`, o painel abre mas as sessões
de WhatsApp não funcionam.

Confira que subiu:

```bash
pm2 status
pm2 logs wa-akg --lines 50
curl -I http://127.0.0.1:3000
```

O `curl` deve responder `HTTP/1.1 200 OK`.

> O projeto também traz um `start.sh` que faz conferência do `.env`, instala
> dependências, sincroniza o banco, compila e sobe o PM2 de uma vez. Depois da
> primeira instalação manual, ele é o atalho para as próximas.

---

## 8. Domínio e HTTPS

### DNS

No painel do seu domínio, crie um registro:

| Tipo | Nome | Valor |
|---|---|---|
| A | `wa` | `SEU_IP` |

Espere propagar (geralmente minutos) e confirme:

```bash
dig +short wa.seudominio.com.br
```

### Nginx — a parte que todo mundo erra

```bash
sudo nano /etc/nginx/sites-available/wa-akg
```

```nginx
server {
    listen 80;
    server_name wa.seudominio.com.br;

    # Upload de mídia: o padrão do Nginx é 1 MB, e o WA-AKG aceita até 50 MB
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Sem estas duas linhas o socket.io não conecta: o QR code não
        # aparece, o status da sessão não atualiza e a tela fica "carregando".
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # A conexão do painel fica aberta; o padrão de 60s a derrubaria
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

O WA-AKG serve o socket.io em `/api/socket/io` (confirmado em
`src/server/index.ts`). A configuração acima já cobre esse caminho porque vale
para `/`, mas é ela que faz a diferença — um proxy "padrão de Next.js", sem os
cabeçalhos de upgrade, resulta exatamente no sintoma mais comum: painel abre,
QR nunca aparece.

Ative e teste:

```bash
sudo ln -s /etc/nginx/sites-available/wa-akg /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### Certificado SSL

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d wa.seudominio.com.br
```

Escolha redirecionar HTTP para HTTPS quando perguntado. O certbot já instala a
renovação automática; para conferir:

```bash
sudo certbot renew --dry-run
```

---

## 9. Verificar se está tudo de pé

1. **Painel:** abra `https://wa.seudominio.com.br` e entre com o e-mail e a
   senha do `make-admin`.
2. **Sessão de WhatsApp:** crie uma sessão nova e leia o QR code com o celular.
   *Se o QR não aparecer, o problema é o WebSocket no Nginx — volte ao passo 8.*
3. **Mensagem de teste:** envie para o seu próprio número pelo painel.
4. **API:** gere uma API Key no painel e teste de fora do servidor:

   ```bash
   curl -X POST "https://wa.seudominio.com.br/api/..." \
     -H "Content-Type: application/json" \
     -H "x-api-key: SUA_API_KEY"
   ```

   O caminho exato e o formato do corpo estão no Swagger (`/docs`) e em
   [docs/API_DOCUMENTATION.md](https://github.com/mrifqidaffaaditya/WA-AKG/blob/main/docs/API_DOCUMENTATION.md)
   — não os reproduzo aqui porque mudam entre versões.
5. **Sobrevive a reboot:** `sudo reboot`, espere um minuto, e confira
   `pm2 status`. Se o processo não voltar, você pulou o `pm2 save` ou o
   `pm2 startup`.

---

## 10. Operação do dia a dia

```bash
pm2 status                  # o que está rodando
pm2 logs wa-akg             # logs ao vivo
pm2 restart wa-akg          # reiniciar
pm2 monit                   # CPU e memória
```

### Atualizar

```bash
cd ~/WA-AKG
pm2 stop wa-akg
git pull
npm install
npm run db:push
npm run build
pm2 restart wa-akg
```

Veja [docs/UPDATE_GUIDE.md](https://github.com/mrifqidaffaaditya/WA-AKG/blob/main/docs/UPDATE_GUIDE.md)
antes de atualizar entre versões maiores.

### Backup

Duas coisas precisam de cópia: o **banco** e as **credenciais das sessões**
(sem elas, todo número precisa ler o QR de novo).

```bash
mkdir -p ~/backups
# banco
mysqldump -u wa_akg -p wa_akg | gzip > ~/backups/wa_akg-$(date +%F).sql.gz
# sessões e mídia
tar czf ~/backups/dados-$(date +%F).tar.gz -C ~/WA-AKG data uploads
```

Automatize com cron (`crontab -e`), às 3h da manhã:

```
0 3 * * * mysqldump -u wa_akg -pSUA_SENHA wa_akg | gzip > ~/backups/wa_akg-$(date +\%F).sql.gz
5 3 * * * tar czf ~/backups/dados-$(date +\%F).tar.gz -C ~/WA-AKG data uploads
0 4 * * * find ~/backups -mtime +14 -delete
```

Baixe para a sua máquina de vez em quando — backup que só existe no mesmo
servidor não é backup:

```powershell
scp isaac@SEU_IP:~/backups/*.gz .
```

---

## 11. Quando der problema

**O QR code não aparece / a tela fica carregando.**
WebSocket bloqueado no proxy. Confirme `proxy_set_header Upgrade` e
`Connection "upgrade"` no Nginx e recarregue. É de longe a causa mais comum.

**502 Bad Gateway.**
A aplicação caiu ou não subiu. `pm2 status` e `pm2 logs wa-akg --lines 100`.
Quase sempre é `DATABASE_URL` errada ou `AUTH_SECRET` em branco — este último
encerra o processo de propósito em produção.

**O servidor sobe e cai em seguida.**
Leia as primeiras linhas de `pm2 logs`. Se for `AUTH_SECRET`, gere um com
`openssl rand -base64 32`. Se for conexão de banco, teste
`mysql -u wa_akg -p wa_akg` na mão.

**A sessão desconecta sozinha.**
O celular precisa ter internet; o Baileys mantém o vínculo com o WhatsApp Web.
Verifique também se o processo não está sendo reiniciado por memória
(`max_memory_restart: "1G"` no `ecosystem.config.js`) — `pm2 monit` mostra.

**Erro de upload acima de 1 MB.**
`client_max_body_size 50M` no Nginx (passo 8). O padrão do Nginx é 1 MB,
independente do que o WA-AKG aceita.

**Horário das mensagens agendadas sai errado.**
`TZ` ficou em `Asia/Jakarta`. Troque para `America/Sao_Paulo` no `.env` e
reinicie o PM2.

**`EMFILE: too many open files`.**
Muitas sessões simultâneas. Aumente o limite:

```bash
echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

---

## 12. Conectar ao ProspecAtlas

Hoje o ProspecAtlas **registra** a mensagem em Conversas mas não envia nada —
`sendMessage()` em `src/actions/conversations.ts` só grava em `db.messages`.
É o item 4 da [auditoria funcional](../AUDITORIA_FUNCIONAL.md).

Com o gateway no ar, o encaixe é:

1. **Envio:** um provedor de canal em `src/providers/` que chama a API do
   WA-AKG com a API Key, nos mesmos moldes do `ResendChannel` do módulo
   Carreira — envio individual, resultado explícito (aceito, recusado,
   incerto) e registro do identificador devolvido.
2. **Recebimento:** um route handler em `src/app/api/webhooks/whatsapp/` para
   o webhook do WA-AKG, com verificação de assinatura e deduplicação, como já
   é feito em `/api/webhooks/resend`.
3. **Estados:** separar "gravado", "entregue ao gateway" e "entregue ao
   destinatário", para a tela não dizer que enviou o que não saiu.

Quando o servidor estiver de pé e você tiver a API Key, me avise que eu
implemento essa parte — aí o Conversas passa a enviar de verdade.

---

## Checklist

- [ ] VPS criada com Ubuntu 24.04 e acesso por chave SSH
- [ ] Usuário comum criado, login root desativado, UFW ativo
- [ ] Node 22, PM2, MySQL e Nginx instalados
- [ ] Banco `wa_akg` e usuário criados com `utf8mb4`
- [ ] Repositório clonado e `npm install` concluído
- [ ] `.env` com `AUTH_SECRET`, `DATABASE_URL`, `BASE_URL`, `TZ` e `LOCALE`
- [ ] Senha do Swagger trocada
- [ ] `npm run db:push` e `npm run make-admin` executados
- [ ] `npm run build` e `pm2 start ecosystem.config.js`
- [ ] `pm2 save` e `pm2 startup` configurados
- [ ] DNS apontando para o servidor
- [ ] Nginx com os cabeçalhos de WebSocket e `client_max_body_size`
- [ ] HTTPS ativo e renovação testada
- [ ] QR code lido e primeira mensagem enviada
- [ ] Backup automático de banco e da pasta `data`
- [ ] Reboot testado: o PM2 volta sozinho
