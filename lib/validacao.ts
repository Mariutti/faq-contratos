import type { Mensagem } from "./tipos";

const MAX_MENSAGENS = 20;
const MAX_CARACTERES_POR_MENSAGEM = 1_000;
const MAX_CARACTERES_PERGUNTA_ATUAL = 300;

export type ResultadoValidacao =
  | { ok: true; mensagens: Mensagem[] }
  | { ok: false; erro: string };

/** Valida o corpo recebido antes de enviá-lo ao modelo. */
export function validarMensagens(entrada: unknown): ResultadoValidacao {
  if (!Array.isArray(entrada) || entrada.length === 0) {
    return { ok: false, erro: "Envie ao menos uma mensagem." };
  }

  if (entrada.length > MAX_MENSAGENS) {
    return { ok: false, erro: `Envie no máximo ${MAX_MENSAGENS} mensagens por conversa.` };
  }

  const mensagens: Mensagem[] = [];

  for (const mensagem of entrada) {
    if (
      typeof mensagem !== "object" ||
      mensagem === null ||
      !("papel" in mensagem) ||
      !("texto" in mensagem) ||
      (mensagem.papel !== "user" && mensagem.papel !== "model") ||
      typeof mensagem.texto !== "string"
    ) {
      return { ok: false, erro: "Formato de mensagem inválido." };
    }

    const texto = mensagem.texto.trim();
    if (!texto || texto.length > MAX_CARACTERES_POR_MENSAGEM) {
      return {
        ok: false,
        erro: `Cada mensagem deve ter entre 1 e ${MAX_CARACTERES_POR_MENSAGEM} caracteres.`,
      };
    }

    mensagens.push({ papel: mensagem.papel, texto });
  }

  const ultima = mensagens.at(-1);
  if (ultima?.papel !== "user") {
    return { ok: false, erro: "A última mensagem precisa ser do usuário." };
  }

  if (ultima.texto.length > MAX_CARACTERES_PERGUNTA_ATUAL) {
    return {
      ok: false,
      erro: `Pergunta muito longa (máximo de ${MAX_CARACTERES_PERGUNTA_ATUAL} caracteres).`,
    };
  }

  return { ok: true, mensagens };
}
