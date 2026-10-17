// Filtra o arquivo data/vagas_bruto.json (dado SEM filtro) e gera vagas_cache.json (filtrado).
// Nao chama a API - trabalha em cima do que ja esta salvo em disco (custo zero).
// Sempre le do BRUTO, nunca do ja-filtrado, para poder rodar de novo com seguranca
// se a logica do filtro mudar.
//
// Para rodar: node scripts/filtrar-cache.js

const fs = require("fs");
const path = require("path");

const caminhoBruto = path.join(__dirname, "..", "data", "vagas_bruto.json");
const caminhoSaida = path.join(__dirname, "..", "data", "vagas_cache.json");

if (!fs.existsSync(caminhoBruto)) {
  console.error(`Arquivo nao encontrado: ${caminhoBruto}`);
  console.error("Rode primeiro o scripts/coletar-vagas.js (versao atualizada, que salva o bruto)");
  process.exit(1);
}

const vagas = JSON.parse(fs.readFileSync(caminhoBruto, "utf-8"));
console.log(`Total antes do filtro: ${vagas.length} vagas.`);

// Siglas dos 26 estados brasileiros + DF
const UFS_BRASIL = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

// Filtra pelo campo "location" (onde a VAGA esta), nao pelo endereco da empresa
// (uma empresa com sede no Brasil pode ter vagas abertas em outros paises, como vimos).
function ehVagaDoBrasil(vaga) {
  const local = vaga.location || "";
  if (/brasil|brazil/i.test(local)) return true;

  const partes = local.split(",").map((p) => p.trim());
  const ultimaParte = partes[partes.length - 1]?.toUpperCase();
  return UFS_BRASIL.includes(ultimaParte);
}

const vagasBrasil = vagas.filter(ehVagaDoBrasil);

console.log(`Total depois do filtro (so Brasil): ${vagasBrasil.length} vagas.`);

if (vagasBrasil.length === 0) {
  console.warn(
    "Nenhuma vaga sobrou! O campo 'companyAddress.addressCountry' pode ter um valor diferente do esperado."
  );
  console.warn("Confira o valor exato desse campo em uma vaga:");
  console.warn(JSON.stringify(vagas[0]?.companyAddress, null, 2));
} else {
  fs.writeFileSync(caminhoSaida, JSON.stringify(vagasBrasil, null, 2));
  console.log(`Vagas filtradas salvas em: ${caminhoSaida}`);
}