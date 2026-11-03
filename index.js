// Servidor back-end - pipeline de matching entre curriculo e vagas de TI.
//
// Rode com: npm install  ->  npm start
// Configure o .env com GEMINI_API_KEY (e, opcionalmente, GEMINI_MODEL).
//
// PAGINA: abra http://localhost:3000 no navegador (arquivo public/index.html)
//
// ROTA PRINCIPAL (a que o front-end vai usar):
//   POST /analisar-curriculo   (form-data, campo "curriculo", tipo File, um PDF)


require("dotenv").config();
const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

const upload = multer({ storage: multer.memoryStorage() });

// =====================================================================
// 1. CONFIGURACAO
// Valores "soltos" no meio do codigo sao dificeis de achar e mudar.
// Concentrar tudo aqui deixa ajustes futuros em um lugar so.
// =====================================================================
const MODELO_GEMINI = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const PERCENTUAL_MINIMO_QUASE_COMPATIVEL = 40;
const PERCENTUAL_MAXIMO_QUASE_COMPATIVEL = 80;
const NUMERO_VAGAS_RETORNADAS = 10;
const NUMERO_COMPETENCIAS_SUGERIDAS = 10;

// So cria o client do Gemini se a chave estiver configurada
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// =====================================================================
// 2. DADOS: carrega as vagas ja processadas (feitas pelos scripts/)
// =====================================================================
const CAMINHO_VAGAS = path.join(__dirname, "data", "vagas_processadas.json");
if (!fs.existsSync(CAMINHO_VAGAS)) {
  console.error(`Arquivo de vagas nao encontrado: ${CAMINHO_VAGAS}`);
  console.error("Rode scripts/coletar-vagas.js e depois scripts/processar-vagas.js");
  process.exit(1);
}
const todasAsVagas = JSON.parse(fs.readFileSync(CAMINHO_VAGAS, "utf-8"));

// Vagas sem nenhuma competencia extraida nao servem pro matching (e dariam divisao por zero)
const vagas = todasAsVagas.filter(
  (v) => Array.isArray(v.competenciasRequisitadas) && v.competenciasRequisitadas.length > 0
);
console.log(
  `Vagas carregadas: ${vagas.length} (de ${todasAsVagas.length}; descartadas sem competencias: ${
    todasAsVagas.length - vagas.length
  })`
);

// =====================================================================
// 3. TRATAMENTO DE ERROS
// Em vez de cada etapa devolver "erro generico", as etapas lancam um erro
// que diz QUAL etapa falhou e com qual status HTTP. Assim, quem usa a API
// (o front-end, voce no Postman) sabe onde olhar.
// =====================================================================
class ErroDeEtapa extends Error {
  constructor(etapa, mensagem, status = 500) {
    super(mensagem);
    this.etapa = etapa;
    this.status = status;
  }
}

// Converte os erros tecnicos do Gemini em mensagens que um usuario entende
function traduzirErroGemini(erro) {
  const msg = String(erro.message || "");
  if (msg.includes("429")) {
    return {
      status: 429,
      mensagem: "Limite de uso do Gemini atingido (cota). Tente mais tarde ou troque o modelo em GEMINI_MODEL no .env.",
    };
  }
  if (msg.includes("503")) {
    return { status: 503, mensagem: "O Gemini esta sobrecarregado no momento. Tente de novo em alguns instantes." };
  }
  if (msg.includes("404")) {
    return { status: 500, mensagem: "Modelo do Gemini nao encontrado. Confira GEMINI_MODEL no .env." };
  }
  return { status: 502, mensagem: "Falha na comunicacao com o Gemini." };
}

// Tenta de novo quando o erro e TEMPORARIO (503). Outros erros (como 429, cota) nao
// adiantam tentar de novo na hora, entao sobem direto.
async function tentarNovamente(funcao, tentativas = 3, esperaMs = 3000) {
  for (let i = 1; ; i++) {
    try {
      return await funcao();
    } catch (erro) {
      const temporario = String(erro.message || "").includes("503");
      if (!temporario || i >= tentativas) throw erro;
      console.log(`Erro temporario (503). Tentativa ${i}/${tentativas}, aguardando ${esperaMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, esperaMs));
    }
  }
}

// Executa uma chamada ao Gemini com retry e traducao de erros, marcando a etapa
async function chamarGemini(etapa, funcao) {
  try {
    return await tentarNovamente(funcao);
  } catch (erro) {
    console.error(`[${etapa}]`, erro.message);
    const { status, mensagem } = traduzirErroGemini(erro);
    throw new ErroDeEtapa(etapa, mensagem, status);
  }
}

function obterModeloGemini(generationConfig) {
  if (!genAI) {
    throw new ErroDeEtapa("configuracao", "GEMINI_API_KEY nao configurada. Crie o arquivo .env com sua chave.");
  }
  return genAI.getGenerativeModel({
    model: MODELO_GEMINI,
    ...(generationConfig && { generationConfig }),
  });
}

// Ponto unico de resposta de erro das rotas
function responderErro(res, erro) {
  if (erro instanceof ErroDeEtapa) {
    return res.status(erro.status).json({ erro: erro.message, etapa: erro.etapa });
  }
  if (erro.name === "MulterError") {
    return res.status(400).json({
      erro: "Erro no upload. Envie um arquivo PDF no campo 'curriculo'.",
      etapa: "upload",
    });
  }
  console.error(erro);
  res.status(500).json({ erro: "Erro interno inesperado.", etapa: "desconhecida" });
}

// =====================================================================
// 4. ETAPAS DO PIPELINE (cada uma e uma funcao independente e testavel)
// =====================================================================

function validarPdfEnviado(req) {
  if (!req.file) {
    throw new ErroDeEtapa("upload", "Nenhum arquivo enviado. Use o campo 'curriculo'.", 400);
  }
  if (req.file.mimetype !== "application/pdf") {
    throw new ErroDeEtapa("upload", "O arquivo precisa ser um PDF.", 400);
  }
}

// Etapa 1: PDF -> texto
async function extrairTextoDoPdf(buffer) {
  let resultado;
  try {
    resultado = await pdfParse(buffer);
  } catch (erro) {
    console.error("[leitura_pdf]", erro.message);
    throw new ErroDeEtapa("leitura_pdf", "Nao foi possivel ler o PDF. O arquivo pode estar corrompido.", 422);
  }

  const texto = (resultado.text || "").trim();
  if (texto.length < 50) {
    throw new ErroDeEtapa(
      "leitura_pdf",
      "O PDF nao contem texto legivel (pode ser um documento escaneado como imagem).",
      422
    );
  }
  return { texto, totalPaginas: resultado.numpages };
}

// Etapa 2: texto do curriculo -> lista de competencias (via Gemini)
async function extrairCompetenciasDoTexto(texto) {
  const model = obterModeloGemini({
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: { competencias: { type: "array", items: { type: "string" } } },
      required: ["competencias"],
    },
  });

  const prompt = `Voce vai receber o texto de um curriculo. Extraia APENAS as competencias tecnicas
(linguagens de programacao, frameworks, ferramentas, bancos de dados, metodologias) mencionadas.

Nao invente competencias que nao estao no texto. Se nao encontrar nenhuma, retorne uma lista vazia.

Texto do curriculo:
"""
${texto}
"""`;

  const textoResposta = await chamarGemini("extracao_competencias", async () => {
    const resultado = await model.generateContent(prompt);
    return resultado.response.text();
  });

  try {
    return JSON.parse(textoResposta).competencias || [];
  } catch (erroParse) {
    console.error("[extracao_competencias] resposta nao era JSON valido:", textoResposta);
    throw new ErroDeEtapa(
      "extracao_competencias",
      "O Gemini respondeu em um formato inesperado. Tente novamente.",
      502
    );
  }
}

// Etapa 3: matching. Primeiro, normalizacao dos nomes de competencias.
// Apelidos comuns -> forma canonica (aplicados depois da normalizacao basica)
const APELIDOS = {
  js: "javascript",
  ts: "typescript",
  postgres: "postgresql",
  "c#": "csharp",
  "c++": "cpp",
};

// Normaliza o nome de uma competencia pra comparacao: "React.js", "ReactJS" e "react" viram "react"
function normalizarCompetencia(nome) {
  let n = String(nome).toLowerCase().trim().replace(/[\s.\-_]/g, "");
  if (n.endsWith("js") && n.length > 4) n = n.slice(0, -2); // reactjs -> react, nodejs -> node
  return APELIDOS[n] || n;
}

// Compara as competencias do usuario com as de UMA vaga: retorna % atendida,
// quais requisitos o usuario tem e quais faltam.
function calcularCompatibilidade(competenciasUsuario, competenciasVaga) {
  // Remove duplicatas da vaga (ex.: "React" e "React.js" contariam como 2 requisitos)
  const vistos = new Set();
  competenciasVaga = competenciasVaga.filter((c) => {
    const chave = normalizarCompetencia(c);
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });

  const usuarioNormalizado = new Set(competenciasUsuario.map(normalizarCompetencia));

  const requisitosAtendidos = competenciasVaga.filter((reqVaga) =>
    usuarioNormalizado.has(normalizarCompetencia(reqVaga))
  );

  const percentual = (requisitosAtendidos.length / competenciasVaga.length) * 100;

  return {
    percentual: Math.round(percentual),
    requisitosAtendidos,
    requisitosFaltantes: competenciasVaga.filter((r) => !requisitosAtendidos.includes(r)),
  };
}

// Calcula a compatibilidade do usuario com TODAS as vagas do dataset, ja ordenado
function obterVagasComCompatibilidade(competenciasUsuario) {
  return vagas
    .map((vaga) => ({
      id: vaga.id,
      titulo: vaga.titulo,
      empresa: vaga.empresa,
      local: vaga.local,
      link: vaga.link,
      ...calcularCompatibilidade(competenciasUsuario, vaga.competenciasRequisitadas),
    }))
    .sort((a, b) => b.percentual - a.percentual);
}

// Etapa 4: recomendacoes. Pega as vagas "quase compativeis", conta quais competencias
// faltantes mais se repetem entre elas e pede ao Gemini um texto de recomendacao.
function rankearCompetenciasFaltantes(vagasQuaseCompativeis) {
  const contagem = {};
  vagasQuaseCompativeis.forEach((vaga) => {
    vaga.requisitosFaltantes.forEach((req) => {
      contagem[req] = (contagem[req] || 0) + 1;
    });
  });

  return Object.entries(contagem)
    .sort((a, b) => b[1] - a[1])
    .map(([competencia, vezes]) => ({ competencia, apareceEmVagas: vezes }));
}

async function gerarTextoDeRecomendacao(competencias, totalVagasAnalisadas, ranking) {
  const model = obterModeloGemini();

  const prompt = `Um candidato a vagas de TI junior possui as seguintes competencias: ${competencias.join(", ")}.

Ele esta proximo de se qualificar para ${totalVagasAnalisadas} vaga(s), mas falta desenvolver algumas competencias.
As competencias que mais aparecem faltando nessas vagas, em ordem de frequencia, sao:
${ranking.map((c) => `- ${c.competencia} (falta em ${c.apareceEmVagas} vaga(s))`).join("\n")}

Escreva uma recomendacao curta (max 3 frases) em portugues, direta e motivadora, sugerindo
por qual competencia o candidato deveria comecar a estudar e por que, com base nessa frequencia.`;

  return chamarGemini("recomendacoes", async () => {
    const resultado = await model.generateContent(prompt);
    return resultado.response.text();
  });
}

async function gerarRecomendacoes(competencias, vagasComCompatibilidade) {
  const vagasQuase = vagasComCompatibilidade.filter(
    (v) => v.percentual >= PERCENTUAL_MINIMO_QUASE_COMPATIVEL && v.percentual <= PERCENTUAL_MAXIMO_QUASE_COMPATIVEL
  );

  // Sem vagas na faixa, nao ha o que recomendar - e nem gastamos uma chamada ao Gemini
  if (vagasQuase.length === 0) {
    return {
      vagasAnalisadas: 0,
      competenciasSugeridas: [],
      recomendacao: null,
      mensagem: `Nenhuma vaga na faixa de ${PERCENTUAL_MINIMO_QUASE_COMPATIVEL}-${PERCENTUAL_MAXIMO_QUASE_COMPATIVEL}% de compatibilidade foi encontrada para gerar recomendacoes.`,
    };
  }

  const ranking = rankearCompetenciasFaltantes(vagasQuase).slice(0, NUMERO_COMPETENCIAS_SUGERIDAS);
  const recomendacao = await gerarTextoDeRecomendacao(competencias, vagasQuase.length, ranking);

  return { vagasAnalisadas: vagasQuase.length, competenciasSugeridas: ranking, recomendacao };
}

// =====================================================================
// 5. O PIPELINE COMPLETO: encadeia as etapas na ordem do diagrama
// =====================================================================
async function analisarCurriculo(buffer) {
  const { texto, totalPaginas } = await extrairTextoDoPdf(buffer); // etapa 1
  const competencias = await extrairCompetenciasDoTexto(texto); // etapa 2

  if (competencias.length === 0) {
    throw new ErroDeEtapa(
      "extracao_competencias",
      "Nenhuma competencia tecnica foi encontrada no curriculo.",
      422
    );
  }

  const vagasComCompatibilidade = obterVagasComCompatibilidade(competencias); // etapa 3
  const recomendacoes = await gerarRecomendacoes(competencias, vagasComCompatibilidade); // etapa 4

  return {
    totalPaginas,
    competenciasDoCurriculo: competencias,
    totalVagasAnalisadas: vagas.length,
    vagasCompativeis: vagasComCompatibilidade.slice(0, NUMERO_VAGAS_RETORNADAS),
    recomendacoes,
  };
}

// =====================================================================
// 6. ROTAS: camadas finas. So recebem a requisicao, chamam as funcoes acima
// e devolvem a resposta. A regra de negocio NAO fica aqui.
// =====================================================================
app.use(express.json());

// Entrega a pagina do front-end (public/index.html) em http://localhost:3000
app.use(express.static(path.join(__dirname, "public")));

app.get("/ping", (req, res) => {
  res.json({ status: "ok", message: "Servidor rodando!" });
});

// Rota principal: o usuario manda o PDF e recebe tudo de uma vez
app.post("/analisar-curriculo", upload.single("curriculo"), async (req, res) => {
  try {
    validarPdfEnviado(req);
    const resultado = await analisarCurriculo(req.file.buffer);
    res.json({ nomeArquivo: req.file.originalname, ...resultado });
  } catch (erro) {
    responderErro(res, erro);
  }
});

// ---- Rotas de teste: uma etapa por vez ----
app.post("/upload-curriculo", upload.single("curriculo"), async (req, res) => {
  try {
    validarPdfEnviado(req);
    const { texto, totalPaginas } = await extrairTextoDoPdf(req.file.buffer);
    res.json({ nomeArquivo: req.file.originalname, totalPaginas, textoExtraido: texto });
  } catch (erro) {
    responderErro(res, erro);
  }
});

app.post("/extrair-competencias", async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || texto.trim().length === 0) {
      throw new ErroDeEtapa("validacao", "Envie o campo 'texto' no corpo da requisicao.", 400);
    }
    res.json({ competencias: await extrairCompetenciasDoTexto(texto) });
  } catch (erro) {
    responderErro(res, erro);
  }
});

function validarListaDeCompetencias(competencias) {
  if (!competencias || !Array.isArray(competencias) || competencias.length === 0) {
    throw new ErroDeEtapa("validacao", "Envie o campo 'competencias' como uma lista.", 400);
  }
}

app.post("/matching", (req, res) => {
  try {
    const { competencias } = req.body;
    validarListaDeCompetencias(competencias);
    res.json({ vagas: obterVagasComCompatibilidade(competencias) });
  } catch (erro) {
    responderErro(res, erro);
  }
});

app.post("/recomendacoes", async (req, res) => {
  try {
    const { competencias } = req.body;
    validarListaDeCompetencias(competencias);
    res.json(await gerarRecomendacoes(competencias, obterVagasComCompatibilidade(competencias)));
  } catch (erro) {
    responderErro(res, erro);
  }
});

// Captura erros que acontecem ANTES das rotas (ex.: falha do multer no upload)
app.use((erro, req, res, next) => responderErro(res, erro));

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});