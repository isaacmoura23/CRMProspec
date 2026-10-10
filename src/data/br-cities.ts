/**
 * Cidades para a varredura do Prospectador (Agente 2).
 *
 * "Todo o Brasil" não cabe numa execução: o Google Places cobra por chamada e entrega
 * poucas dezenas de empresas por busca. A varredura percorre estas cidades aos poucos,
 * começando pelas ainda não cobertas e pelas capitais, e registra o que já foi varrido.
 * É uma lista de grandes municípios (capitais + os mais populosos), não um ranking oficial.
 */

export interface BrCity {
  city: string;
  state: string;
  capital: boolean;
}

const c = (city: string, state: string, capital = false): BrCity => ({ city, state, capital });

export const BR_CAPITALS: BrCity[] = [
  c("São Paulo", "SP", true), c("Rio de Janeiro", "RJ", true), c("Brasília", "DF", true), c("Salvador", "BA", true),
  c("Fortaleza", "CE", true), c("Belo Horizonte", "MG", true), c("Manaus", "AM", true), c("Curitiba", "PR", true),
  c("Recife", "PE", true), c("Goiânia", "GO", true), c("Belém", "PA", true), c("Porto Alegre", "RS", true),
  c("São Luís", "MA", true), c("Maceió", "AL", true), c("Natal", "RN", true), c("Teresina", "PI", true),
  c("Campo Grande", "MS", true), c("João Pessoa", "PB", true), c("Cuiabá", "MT", true), c("Aracaju", "SE", true),
  c("Florianópolis", "SC", true), c("Porto Velho", "RO", true), c("Macapá", "AP", true), c("Rio Branco", "AC", true),
  c("Vitória", "ES", true), c("Boa Vista", "RR", true), c("Palmas", "TO", true),
];

/** Grandes municípios que não são capitais. */
export const BR_LARGE_CITIES: BrCity[] = [
  c("Guarulhos", "SP"), c("Campinas", "SP"), c("São Gonçalo", "RJ"), c("Duque de Caxias", "RJ"), c("Nova Iguaçu", "RJ"),
  c("São Bernardo do Campo", "SP"), c("Santo André", "SP"), c("Osasco", "SP"), c("Ribeirão Preto", "SP"), c("Sorocaba", "SP"),
  c("Uberlândia", "MG"), c("Contagem", "MG"), c("Joinville", "SC"), c("Feira de Santana", "BA"), c("Juiz de Fora", "MG"),
  c("Londrina", "PR"), c("Aparecida de Goiânia", "GO"), c("Niterói", "RJ"), c("Ananindeua", "PA"), c("Serra", "ES"),
  c("Caxias do Sul", "RS"), c("Campos dos Goytacazes", "RJ"), c("Belford Roxo", "RJ"), c("São José dos Campos", "SP"), c("Santos", "SP"),
  c("Mauá", "SP"), c("São José do Rio Preto", "SP"), c("Mogi das Cruzes", "SP"), c("Betim", "MG"), c("Diadema", "SP"),
  c("Piracicaba", "SP"), c("Carapicuíba", "SP"), c("Jundiaí", "SP"), c("Olinda", "PE"), c("Cariacica", "ES"),
  c("Bauru", "SP"), c("Montes Claros", "MG"), c("Maringá", "PR"), c("Anápolis", "GO"), c("Vitória da Conquista", "BA"),
  c("Itaquaquecetuba", "SP"), c("Caucaia", "CE"), c("Blumenau", "SC"), c("Canoas", "RS"), c("Franca", "SP"),
  c("Pelotas", "RS"), c("Ponta Grossa", "PR"), c("Petrolina", "PE"), c("Uberaba", "MG"), c("Paulista", "PE"),
  c("Cascavel", "PR"), c("Praia Grande", "SP"), c("São Vicente", "SP"), c("Guarujá", "SP"), c("Taubaté", "SP"),
  c("Limeira", "SP"), c("Suzano", "SP"), c("Foz do Iguaçu", "PR"), c("Governador Valadares", "MG"), c("Novo Hamburgo", "RS"),
  c("Volta Redonda", "RJ"), c("Ribeirão das Neves", "MG"), c("Santa Maria", "RS"), c("Gravataí", "RS"), c("Viamão", "RS"),
  c("São José dos Pinhais", "PR"), c("Juazeiro do Norte", "CE"), c("Marabá", "PA"), c("Barueri", "SP"), c("Imperatriz", "MA"),
  c("Dourados", "MS"), c("Sete Lagoas", "MG"), c("Divinópolis", "MG"), c("Ipatinga", "MG"), c("Rio Verde", "GO"),
  c("Itajaí", "SC"), c("Chapecó", "SC"), c("Criciúma", "SC"), c("Passo Fundo", "RS"), c("Santarém", "PA"),
  c("Mossoró", "RN"), c("Campina Grande", "PB"), c("Caruaru", "PE"), c("Arapiraca", "AL"), c("Ilhéus", "BA"),
];

export type SweepScope = "capitais" | "principais";

export const SWEEP_SCOPES: SweepScope[] = ["capitais", "principais"];

export function scopeCities(scope: SweepScope): BrCity[] {
  return scope === "capitais" ? BR_CAPITALS : [...BR_CAPITALS, ...BR_LARGE_CITIES];
}

/** Chave estável de uma cidade (sem acento, minúscula): a mesma usada para o registro de cobertura. */
export function citySlug(city: string): string {
  return city
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
