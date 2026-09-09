import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { gerarEmbeddingDaPergunta, gerarResposta } from "@/lib/gemini";
import type { Mensagem } from "@/lib/tipos";

const LIMITE_CARACTERES_PERGUNTA = 300;
const LIMITE_MENSAGENS_HISTORICO = 20; // evita o histórico crescer sem limite
const QUANTIDADE_TRECHOS_RECUPERADOS = 5;

export async function POST(request: Request) {
  const body = await request.json();
  const mensagens: Mensagem[] = body.mensagens;

  if (!Array.isArray(mensagens) || mensagens.length === 0) {
    return NextResponse.json({ erro: "Envie ao menos uma mensagem." }, { status: 400 });
  }

  const ultimaMensagem = mensagens[mensagens.length - 1];

  if (ultimaMensagem?.papel !== "user" || typeof ultimaMensagem.texto !== "string") {
    return NextResponse.json(
      { erro: "A última mensagem precisa ser do usuário." },
      { status: 400 }
    );
  }

  if (ultimaMensagem.texto.length > LIMITE_CARACTERES_PERGUNTA) {
    return NextResponse.json(
      { erro: `Pergunta muito longa (máximo de ${LIMITE_CARACTERES_PERGUNTA} caracteres).` },
      { status: 400 }
    );
  }

  // Só mandamos para a IA as últimas N mensagens, para o histórico
  // (e o custo/tamanho de cada chamada) não crescer sem limite numa
  // conversa muito longa.
  const historicoRecente = mensagens.slice(-LIMITE_MENSAGENS_HISTORICO);

  try {
    // Para a BUSCA no banco, combinamos a última pergunta do usuário
    // com a pergunta anterior dele (se houver) -- dá um pouco de
    // contexto para perguntas de continuação, sem precisar de uma
    // chamada extra só para "reescrever" a pergunta.
    const perguntasDeUsuario = historicoRecente.filter((m) => m.papel === "user");
    const textoParaBusca = perguntasDeUsuario
      .slice(-2)
      .map((m) => m.texto)
      .join("\n");

    const embeddingDaBusca = await gerarEmbeddingDaPergunta(textoParaBusca);

    const { data: trechosEncontrados, error: erroBusca } = await supabase.rpc(
      "buscar_documentos",
      { query_embedding: embeddingDaBusca, limite: QUANTIDADE_TRECHOS_RECUPERADOS }
    );

    if (erroBusca) {
      console.error("Erro na busca do Supabase:", erroBusca.message);
      return NextResponse.json(
        { erro: "Não foi possível consultar a base de conhecimento." },
        { status: 500 }
      );
    }

    if (!trechosEncontrados || trechosEncontrados.length === 0) {
      return NextResponse.json({
        resposta: "Não encontrei nada relacionado a essa pergunta na base disponível.",
        fontes: [],
      });
    }

    // Manda a CONVERSA INTEIRA (para continuidade) + os trechos
    // recuperados AGORA (para fundamentar a resposta mais recente).
    const textoResposta = await gerarResposta(
      historicoRecente,
      trechosEncontrados.map((t: { conteudo: string }) => t.conteudo)
    );

    const fontes = Array.from(
      new Set(trechosEncontrados.map((t: { fonte: string }) => t.fonte))
    );

    return NextResponse.json({ resposta: textoResposta, fontes });
  } catch (erro) {
    console.error("Erro ao processar pergunta:", erro);
    return NextResponse.json(
      { erro: "Ocorreu um erro ao gerar a resposta. Tente novamente em alguns instantes." },
      { status: 500 }
    );
  }
}