// Formato de uma mensagem da conversa. "papel" usa os mesmos nomes
// que a API do Gemini espera (user / model), para não precisar
// converter nada na hora de montar o histórico multi-turno.
export type Mensagem = {
  papel: "user" | "model";
  texto: string;
};