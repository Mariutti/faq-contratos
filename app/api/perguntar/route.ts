import { NextResponse } from "next/server";
import { gerarEmbeddingDaPergunta, gerarResposta } from "@/lib/gemini";
import { identificarCliente, rateLimit } from "@/lib/rate-limit";
import { supabase } from "@/lib/supabase";
import { validarMensagens } from "@/lib/validacao";

const LIMITE_BYTES_CORPO = 20_000;
const LIMITE_MENSAGENS_HISTORICO = 20;
const QUANTIDADE_TRECHOS_RECUPERADOS = 5;
const LIMIAR_SIMILARIDADE = 0.55;

type TrechoEncontrado = {
  conteudo: string;
  fonte: string;
  similaridade: number;
};

export async function POST(request: Request) {
  const limite = await rateLimit.limit(identificarCliente(request));
  if (!limite.success) {
    return NextResponse.json(
      { erro: "Muitas consultas em pouco tempo. Tente novamente em instantes." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil((limite.reset - Date.now()) / 1000))) },
      }
    );
  }

  let body: unknown;
  try {
    const corpoBruto = await request.text();
    if (new TextEncoder().encode(corpoBruto).byteLength > LIMITE_BYTES_CORPO) {
      return NextResponse.json({ erro: "Requisição muito grande." }, { status: 413 });
    }
    body = JSON.parse(corpoBruto);
  } catch {
    return NextResponse.json({ erro: "JSON inválido." }, { status: 400 });
  }

  const validacao = validarMensagens(
    typeof body === "object" && body !== null && "mensagens" in body ? body.mensagens : undefined
  );
  if (!validacao.ok) {
    return NextResponse.json({ erro: validacao.erro }, { status: 400 });
  }

  const historicoRecente = validacao.mensagens.slice(-LIMITE_MENSAGENS_HISTORICO);
  const perguntasDeUsuario = historicoRecente.filter((m) => m.papel === "user");
  const textoParaBusca = perguntasDeUsuario.slice(-2).map((m) => m.texto).join("\n");

  try {
    const embeddingDaBusca = await gerarEmbeddingDaPergunta(textoParaBusca);
    const { data: trechosEncontrados, error: erroBusca } = await supabase.rpc(
      "buscar_documentos",
      {
        query_embedding: embeddingDaBusca,
        limite: QUANTIDADE_TRECHOS_RECUPERADOS,
        limiar_similaridade: LIMIAR_SIMILARIDADE,
      }
    );

    if (erroBusca) {
      console.error("Erro na busca do Supabase:", erroBusca.message);
      return NextResponse.json(
        { erro: "Não foi possível consultar a base de conhecimento." },
        { status: 500 }
      );
    }

    const trechos = (trechosEncontrados ?? []) as TrechoEncontrado[];
    if (trechos.length === 0) {
      return NextResponse.json({
        resposta: "Não encontrei evidência suficiente para responder a essa pergunta na base disponível.",
        fontes: [],
      });
    }

    const resposta = await gerarResposta(
      historicoRecente,
      trechos.map((trecho) => trecho.conteudo)
    );
    const fontes = Array.from(new Set(trechos.map((trecho) => trecho.fonte)));

    return NextResponse.json({ resposta, fontes });
  } catch (erro) {
    console.error("Erro ao processar pergunta:", erro);
    return NextResponse.json(
      { erro: "Ocorreu um erro ao gerar a resposta. Tente novamente em alguns instantes." },
      { status: 500 }
    );
  }
}
