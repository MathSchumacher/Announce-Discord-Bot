📢 Discord Mass DM Announcer Bot

Bot de anúncios via DM para servidores Discord, com suporte total a anexos, filtros de usuários, paginação de membros e sistema antitravamento.

🚀 Funcionalidades
✅ 1. Enviar anúncios via DM para todos os membros do servidor

Use o comando:

!announce Sua mensagem aqui


O bot enviará a mensagem para cada usuário individualmente (exceto bots).

📎 2. Suporte total a anexos

Você pode anexar:

imagens

vídeos

PDFs

qualquer arquivo suportado pelo Discord

Exemplo:

!announce Promoção nova! Confiram o PDF.


(Anexe o arquivo na mesma mensagem)

🚫 3. Excluir usuários do envio

Use -{ID} para não enviar para um usuário específico.

Exemplo:

!announce Olá pessoal! -{828770583709220915} -{422752998314213380}

🎯 4. Enviar apenas para usuários específicos

Use +{ID} para enviar somente para os IDs informados.

Exemplo:

!announcefor Enviando somente para vocês! +{828770583709220915} +{422752998314213380}

📦 5. Paginador interno + rate limit inteligente

O bot:

envia DM membro por membro

pausa automaticamente (500 ms)

evita rate-limit global

funciona tranquilamente em servidores com mais de 20.000 membros

🧩 Comandos
!announce

Envia mensagem + anexos para todos os membros, com exceções opcionais.

!announcefor

Envia mensagem + anexos apenas para usuários selecionados.

📌 Requisitos

Node.js 18+

Uma aplicação/bot no Discord

Token do bot

⚙️ Configuração
1. Instale dependências
npm install

2. Crie um arquivo .env na raiz
DISCORD_TOKEN=SEU_TOKEN_AQUI

3. Inicie o bot
node index.js


O bot ficará online e pronto.