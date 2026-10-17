# Matching entre Currículo e Mercado: ferramenta de recomendação de vagas para TI

Protótipo desenvolvido como Trabalho de Conclusão de Curso em Engenharia de Software (ICEV Instituto de Ensino Superior).

O usuário envia o currículo em PDF e a ferramenta mostra as vagas de estágio e júnior em TI mais compatíveis com as competências dele, além de indicar quais competências vale a pena estudar para alcançar mais vagas.

## Como funciona

1. O PDF é lido e o texto é extraído (`pdf-parse`).
2. O Gemini extrai do texto a lista de competências técnicas.
3. O código compara essas competências com os requisitos de cada vaga e calcula o percentual de compatibilidade. **Esse matching é feito pelo código, sem IA:** é uma interseção de competências, com normalização de nomes (por exemplo, `React.js`, `ReactJS` e `react` contam como a mesma competência).
4. Entre as vagas com 40% a 80% de compatibilidade, o código identifica as competências que mais faltam, e o Gemini escreve uma recomendação curta de estudo.

O projeto já inclui uma pequena coleta de vagas de estágio e júnior (coletadas em outubro de 2026) nos arquivos `data/vagas_bruto.json`, `data/vagas_cache.json` e `data/vagas_processadas.json`. O servidor usa o `vagas_processadas.json`.

## Requisitos

- [Node.js](https://nodejs.org) versão 18 ou superior (use a versão LTS mais recente).
- Uma chave de API do Gemini, gratuita, criada em [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).

## Instalação e uso

No terminal (do VS Code ou o Prompt de Comando), dentro da pasta do projeto:

```
npm install
```

Crie um arquivo chamado `.env` na raiz do projeto (o nome começa com ponto e não tem extensão) com este conteúdo, sem aspas e sem espaços ao redor do `=`:

```
GEMINI_API_KEY=sua_chave_aqui
GEMINI_MODEL=gemini-3.5-flash-lite
```

`GEMINI_MODEL` é o modelo usado, e o do exemplo foi o que utilizei nos testes. A disponibilidade e a cota diária gratuita variam por modelo e por conta, e você pode conferir os seus limites no AI Studio. Se omitir essa variável, o código usa um modelo padrão que pode já ter sido descontinuado.

Inicie o servidor:

```
npm start
```

Abra **http://localhost:3000** no navegador, escolha o PDF do currículo e clique em **Analisar currículo**.

## Estrutura do projeto

```
├── index.js              servidor Express e pipeline de análise
├── package.json
├── public/
│   └── index.html        página do front-end
├── data/
│   ├── vagas_bruto.json        coleta completa, sem filtro (acumulativa)
│   ├── vagas_cache.json        vagas do Brasil, filtradas a partir do bruto
│   └── vagas_processadas.json  vagas com as competências extraídas (usado pelo servidor)
├── scripts/
│   ├── coletar-vagas.js        coleta vagas no LinkedIn via Apify
│   ├── processar-vagas.js      extrai as competências das vagas via Gemini
│   └── filtrar-cache.js        refaz o cache do Brasil a partir do bruto, sem custo
└── .env                  criado por você; não vai para o repositório
```

A pasta `public` precisa ter o nome em minúsculas.

## Atualizar o conjunto de vagas (opcional)

Para usar a ferramenta não é preciso coletar nada: as vagas já estão incluídas. Se quiser aumentar o conjunto, os scripts abaixo coletam e processam vagas novas. Rode-os a partir da **raiz do projeto**.

1. Crie uma conta no [Apify](https://apify.com) e gere um token em **Settings → Integrations**. Adicione ao `.env`:
   ```
   APIFY_API_TOKEN=seu_token_aqui
   ```
2. No `scripts/coletar-vagas.js`, edite a lista `URLS_DE_BUSCA` com as buscas desejadas. O texto depois de `keywords=` define a busca, e o trecho `geoId=106057199` limita os resultados ao Brasil.
3. Colete as vagas:
   ```
   node scripts/coletar-vagas.js
   ```
   Cada coleta **soma** as vagas novas ao `vagas_bruto.json`, sem duplicar (a chave é o `id` da vaga), e refaz o `vagas_cache.json`.
4. Extraia as competências das vagas novas:
   ```
   node scripts/processar-vagas.js
   ```
   Ele processa só as vagas que ainda não estão no `vagas_processadas.json` e, se for interrompido, continua de onde parou. Também usa o Gemini, então a chave do `.env` precisa estar configurada.
5. Reinicie o servidor (`npm start`).

**Custos:** a coleta usa o actor [LinkedIn Jobs Scraper](https://apify.com/curious_coder/linkedin-jobs-scraper), que cobra por resultado (a partir de cerca de US$ 2 por mil resultados). O plano gratuito do Apify inclui um crédito mensal, que cobre coletas pequenas como a deste projeto.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| O PowerShell bloqueia o `npm` ("a execução de scripts foi desabilitada") | Use o Prompt de Comando, ou rode `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` no PowerShell |
| `GEMINI_API_KEY nao configurada` | Confira se o arquivo se chama `.env` (e não `.env.txt`), se está na raiz do projeto e reinicie o servidor. Ao iniciar, o terminal deve mostrar `injected env (1)` ou mais |
| `Arquivo de vagas nao encontrado` | Falta o `data/vagas_processadas.json`. Rode os scripts de coleta e processamento |
| Erro 429 do Gemini | A cota diária do modelo acabou. Espere ou troque `GEMINI_MODEL` |
| Erro 404 do Gemini | O nome em `GEMINI_MODEL` não existe. Confira no AI Studio |
| Erro 503 do Gemini | Instabilidade temporária do Google. O servidor já tenta de novo; se persistir, tente mais tarde |
| A porta 3000 está em uso | Feche o outro programa que a usa |

## Limitações

- O matching compara nomes de competências depois da normalização, mas não entende sinônimos de significado (por exemplo, "banco de dados relacional" não casa com "SQL").
- A extração das competências depende de um modelo de linguagem, que pode errar ou omitir itens.
- O conjunto de vagas é um recorte pequeno, definido pelos termos de busca usados, e não representa o mercado como um todo.
- O funcionamento depende de serviços de terceiros (Gemini e Apify), com cotas e preços que podem mudar.

## Privacidade e avisos

- O texto do currículo enviado é processado pelo Gemini (Google). Não envie currículos com dados que você não queira compartilhar, e consulte os termos do serviço para saber como os dados da camada gratuita são tratados.
- As vagas foram coletadas do LinkedIn por meio de um serviço de scraping de terceiros. A coleta automatizada pode contrariar os termos de uso da plataforma, e o projeto tem finalidade exclusivamente acadêmica.
