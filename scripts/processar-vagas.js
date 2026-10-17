// Le data/vagas_cache.json (vagas brutas, com descriptionText),
// extrai as competencias exigidas de cada uma via Gemini,
// e salva data/vagas_processadas.json pronto pro endpoint /matching usar.
//
// Processa VARIAS vagas por requisicao (em lotes), porque o plano gratuito do Gemini
// limita o numero de REQUISICOES por dia (nao o tamanho de cada uma).
// Ex.: 91 vagas em lotes de 8 = ~12 requisicoes, em vez de 91.
//
// Roda UMA VEZ (ou quando quiser atualizar o cache de vagas) - nao e chamado
// a cada uso do software pelos participantes.
//
// Para rodar: node scripts/processar-vagas.js
//
// Opcional: trocar de modelo sem mexer no codigo, no .env:
//   GEMINI_MODEL=nome-do-modelo

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const TOKEN_GEMINI = process.env.GEMINI_API_KEY;
if (!TOKEN_GEMINI) {
  console.error("Erro: GEMINI_API_KEY nao configurado no .env");
  process.exit(1);
}

const MODELO = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const TAMANHO_LOTE = 8; // vagas por requisicao
const MAX_CARACTERES_DESCRICAO = 3000; // corta descricoes muito longas pra o lote caber folgado

console.log(`Modelo em uso: ${MODELO}`);

const genAI = new GoogleGenerativeAI(TOKEN_GEMINI);
const model = genAI.getGenerativeModel({
  model: MODELO,
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        resultados: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              competencias: { type: "array", items: { type: "string" } },
            },
            required: ["id", "competencias"],
          },
        },
      },
      required: ["resultados"],
    },
  },
});

const CAMINHO_ENTRADA = path.join(__dirname, "..", "data", "vagas_cache.json");
const CAMINHO_SAIDA = path.join(__dirname, "..", "data", "vagas_processadas.json");

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Erro 429 de cota DIARIA: nao adianta tentar de novo hoje, melhor parar.
function eErroDeCotaDiaria(erro) {
  const msg = erro.message || "";
  return msg.includes("429") && (msg.includes("PerDay") || msg.includes("per day"));
}

async function extrairCompetenciasDoLote(lote) {
  const vagasNoPrompt = lote
    .map(
      (vaga) =>
        `### VAGA id=${vaga.id}\nTitulo: ${vaga.title}\nDescricao:\n${(vaga.descriptionText || "").slice(
          0,
          MAX_CARACTERES_DESCRICAO
        )}`
    )
    .join("\n\n");

  const prompt = `Voce vai receber ${lote.length} vagas de emprego de TI, cada uma identificada por "id".
Para CADA vaga, extraia APENAS as competencias tecnicas exigidas ou desejadas
(linguagens de programacao, frameworks, ferramentas, bancos de dados, metodologias)
mencionadas no texto daquela vaga.

Regras:
- Nao invente competencias que nao estao no texto.
- Se uma vaga nao mencionar nenhuma, retorne lista vazia para ela.
- No maximo 10 competencias por vaga, priorizando as mais centrais ao cargo.
- Devolva exatamente um item por vaga, usando o mesmo id recebido.

${vagasNoPrompt}`;

  const MAX_TENTATIVAS = 3;
  const ESPERAS = [5000, 15000, 30000]; // backoff crescente: 5s, 15s, 30s

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    try {
      const resultado = await model.generateContent(prompt);
      const dados = JSON.parse(resultado.response.text());
      return dados.resultados || [];
    } catch (erro) {
      const eErroTemporario = erro.message?.includes("503") || erro.message?.includes("overloaded");
      const ultimaTentativa = tentativa === MAX_TENTATIVAS - 1;

      if (!eErroTemporario || ultimaTentativa) {
        throw erro;
      }

      console.log(`  Erro temporario (503), tentando de novo em ${ESPERAS[tentativa] / 1000}s...`);
      await aguardar(ESPERAS[tentativa]);
    }
  }
}

async function processarVagas() {
  if (!fs.existsSync(CAMINHO_ENTRADA)) {
    console.error(`Arquivo nao encontrado: ${CAMINHO_ENTRADA}`);
    console.error("Rode primeiro scripts/coletar-vagas.js");
    process.exit(1);
  }

  const vagas = JSON.parse(fs.readFileSync(CAMINHO_ENTRADA, "utf-8"));

  // Se ja existe um processamento parcial, continua de onde parou.
  let vagasProcessadas = [];
  if (fs.existsSync(CAMINHO_SAIDA)) {
    vagasProcessadas = JSON.parse(fs.readFileSync(CAMINHO_SAIDA, "utf-8"));
    console.log(`Encontrado processamento parcial: ${vagasProcessadas.length} vagas ja feitas.`);
  }

  const idsJaProcessados = new Set(vagasProcessadas.map((v) => String(v.id)));
  const vagasFaltando = vagas.filter((v) => !idsJaProcessados.has(String(v.id)));

  const totalLotes = Math.ceil(vagasFaltando.length / TAMANHO_LOTE);
  console.log(
    `Total de vagas: ${vagas.length}. Faltam: ${vagasFaltando.length} (${totalLotes} requisicao(oes) de ate ${TAMANHO_LOTE} vagas).`
  );

  for (let i = 0; i < vagasFaltando.length; i += TAMANHO_LOTE) {
    const lote = vagasFaltando.slice(i, i + TAMANHO_LOTE);
    const numeroLote = i / TAMANHO_LOTE + 1;
    console.log(`[Lote ${numeroLote}/${totalLotes}] Processando ${lote.length} vagas...`);

    try {
      const resultados = await extrairCompetenciasDoLote(lote);
      const competenciasPorId = new Map(resultados.map((r) => [String(r.id), r.competencias]));

      let aproveitadas = 0;
      for (const vaga of lote) {
        const competencias = competenciasPorId.get(String(vaga.id));
        if (!competencias) continue; // o modelo nao devolveu essa vaga: fica pra proxima rodada

        vagasProcessadas.push({
          id: vaga.id,
          titulo: vaga.title,
          empresa: vaga.companyName,
          local: vaga.location,
          link: vaga.link,
          competenciasRequisitadas: competencias,
        });
        aproveitadas++;
      }

      // Salva a cada lote - se o script parar no meio, nao perde o que ja foi feito
      fs.writeFileSync(CAMINHO_SAIDA, JSON.stringify(vagasProcessadas, null, 2));
      console.log(`  ${aproveitadas}/${lote.length} vagas do lote salvas.`);
    } catch (erro) {
      if (eErroDeCotaDiaria(erro)) {
        console.error("\nCota DIARIA do Gemini esgotada para esse modelo.");
        console.error(`Progresso salvo: ${vagasProcessadas.length} vagas processadas.`);
        console.error("Rode o script de novo depois que a cota zerar (meia-noite no horario do Pacifico),");
        console.error("ou troque o modelo definindo GEMINI_MODEL no .env.");
        process.exit(0);
      }
      console.error(`Falha no lote ${numeroLote}: ${erro.message}`);
      console.error("Pulando esse lote e continuando...");
    }

    // Pausa entre requisicoes para nao estourar o limite por minuto
    await aguardar(6000);
  }

  const restantes = vagas.length - vagasProcessadas.length;
  console.log(`Concluido! ${vagasProcessadas.length} vagas processadas em: ${CAMINHO_SAIDA}`);
  if (restantes > 0) {
    console.log(`Ainda faltam ${restantes} vagas. Rode o script de novo para retomar so as que faltam.`);
  }
}

processarVagas();