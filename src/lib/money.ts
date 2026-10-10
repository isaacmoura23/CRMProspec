/** Dinheiro em centavos → texto em reais. Sem dependência de servidor: a interface também importa. */
export function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
