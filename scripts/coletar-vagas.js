// Script independente - roda UMA VEZ pra coletar vagas e salvar em disco.
// Nao faz parte do servidor principal (index.js) - e so a etapa de "atualizar o cache".
// Para rodar: node scripts/coletar-vagas.js
// Quando o processo terminar, rode node scripts/processar-vagas.js pra processar as vagas novas e atualizar o cache final.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.APIFY_API_TOKEN;

if (!TOKEN) {
  console.error("Erro: APIFY_API_TOKEN nao configurado no .env");
  process.exit(1);
}

// O LinkedIn desativou os filtros tradicionais de URL (busca por IA agora),
// entao usamos os "AI search filters" do proprio actor em vez de montar uma URL.
// Esses valores vieram da aba JSON do formulario do actor no Apify Console.
const ACTOR = "curious_coder~linkedin-jobs-scraper";
const URL_INICIAR_RUN = `https://api.apify.com/v2/actors/${ACTOR}/runs`;
const URL_STATUS_RUN = (runId) => `https://api.apify.com/v2/actor-runs/${runId}`;
const URL_DATASET = (datasetId) => `https://api.apify.com/v2/datasets/${datasetId}/items`;

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function coletarVagas() {
  console.log("Iniciando coleta de vagas no Apify (modo assincrono, sem limite de tempo)...");

  // Cada URL e uma busca separada, com geoId=106057199 (Brasil), que e o que restringe
  // o pais de verdade (o filtro de IA do actor nao restringia bem).
  //
  // Nesta coleta rodamos SO a busca de estagio. A busca "Desenvolvedor Junior"
  // ja foi coletada antes e esta salva em data/vagas_bruto.json (o script soma, nao apaga).
  // Para acrescentar outra busca no futuro, e so colocar mais uma URL nesta lista
  // (trocando o valor de keywords=).
  const URLS_DE_BUSCA = [
  "https://www.linkedin.com/jobs/search?keywords=Estagiario%20TI%20remoto&location=Brasil&geoId=106057199&trk=public_jobs_jobs-search-bar_search-submit&position=1&pageNum=0",
];
  const corpo = {
    autoConvertToAiSearch: false, 
    limitPerSource: 100, 
    scrapeCompany: true,
    splitByLocation: false,
    under10Applicants: false,
    urls: URLS_DE_BUSCA,
  };

  // 1. Inicia a execucao (nao espera terminar)
  const respostaInicio = await fetch(`${URL_INICIAR_RUN}?token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });

  if (!respostaInicio.ok) {
    const textoErro = await respostaInicio.text();
    throw new Error(`Apify retornou erro ${respostaInicio.status} ao iniciar: ${textoErro}`);
  }

  const dadosInicio = await respostaInicio.json();
  const runId = dadosInicio.data.id;
  console.log(`Run iniciada (id: ${runId}). Consultando status a cada 10s...`);

  // 2. Fica perguntando se ja terminou, a cada 10 segundos
  let status = "RUNNING";
  let datasetId = null;

  while (status === "RUNNING" || status === "READY") {
    await aguardar(10000);

    const respostaStatus = await fetch(`${URL_STATUS_RUN(runId)}?token=${TOKEN}`);
    const dadosStatus = await respostaStatus.json();

    status = dadosStatus.data.status;
    datasetId = dadosStatus.data.defaultDatasetId;
    console.log(`Status atual: ${status}`);
  }

  if (status !== "SUCCEEDED") {
    throw new Error(`A coleta terminou com status "${status}", nao foi bem sucedida.`);
  }

  // 3. Busca os resultados do dataset gerado pela run
  const respostaDataset = await fetch(`${URL_DATASET(datasetId)}?token=${TOKEN}&format=json`);
  if (!respostaDataset.ok) {
    const textoErro = await respostaDataset.text();
    throw new Error(`Apify retornou erro ${respostaDataset.status} ao buscar dataset: ${textoErro}`);
  }

  const vagas = await respostaDataset.json();
  console.log(`Coletadas ${vagas.length} vagas (antes do filtro de pais).`);

  // O filtro de IA do actor nao restringe geografia de forma confiavel,
  // entao filtramos manualmente pelo campo "location" (onde a VAGA esta,
  // nao onde a empresa tem sede - uma empresa brasileira pode ter vaga nos EUA).
  const UFS_BRASIL = [
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
    "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
  ];
  function ehVagaDoBrasil(vaga) {
    const local = vaga.location || "";
    if (/brasil|brazil/i.test(local)) return true;
    const partes = local.split(",").map((p) => p.trim());
    const ultimaParte = partes[partes.length - 1]?.toUpperCase();
    return UFS_BRASIL.includes(ultimaParte);
  }
  const vagasBrasil = vagas.filter(ehVagaDoBrasil);

  console.log(`Restaram ${vagasBrasil.length} vagas apos filtrar por Brasil.`);
  console.log("Exemplo da primeira vaga (pra conferir os campos):");
  console.log(JSON.stringify(vagasBrasil[0], null, 2));

  // O BRUTO (sem filtro) e ACUMULATIVO: junta o que ja existia com a coleta nova,
  // sem duplicar (a mesma vaga pode aparecer em duas buscas; o id e a chave).
  // Assim uma coleta nova nunca apaga as anteriores.
  const caminhoBruto = path.join(__dirname, "..", "data", "vagas_bruto.json");
  let brutoExistente = [];
  if (fs.existsSync(caminhoBruto)) {
    brutoExistente = JSON.parse(fs.readFileSync(caminhoBruto, "utf-8"));
  }
  const idsExistentes = new Set(brutoExistente.map((v) => String(v.id)));
  const novas = vagas.filter((v) => !idsExistentes.has(String(v.id)));
  const brutoAtualizado = [...brutoExistente, ...novas];

  fs.writeFileSync(caminhoBruto, JSON.stringify(brutoAtualizado, null, 2));
  console.log(
    `Bruto: ${brutoExistente.length} ja existiam + ${novas.length} novas = ${brutoAtualizado.length} no total.`
  );

  // O cache filtrado e sempre recalculado a partir do bruto TOTAL
  const caminhoSaida = path.join(__dirname, "..", "data", "vagas_cache.json");
  const vagasBrasilTotal = brutoAtualizado.filter(ehVagaDoBrasil);
  fs.writeFileSync(caminhoSaida, JSON.stringify(vagasBrasilTotal, null, 2));
  console.log(`Vagas do Brasil no cache: ${vagasBrasilTotal.length}. Salvo em: ${caminhoSaida}`);
  console.log("Proximo passo: node scripts/processar-vagas.js (so processa as vagas novas).");
}

coletarVagas().catch((erro) => {
  console.error("Falha na coleta:", erro.message);
  process.exit(1);
});