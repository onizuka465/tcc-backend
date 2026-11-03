# Usa a imagem oficial do Node.js
FROM node:18-alpine

# Define a pasta de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de dependências primeiro (para aproveitar o cache)
COPY package*.json ./

# Instala as dependências
RUN npm install

# Copia o restante do código do projeto
COPY . .

# Expõe a porta que a aplicação usa (ex: 3000)
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["node", "index.js"]