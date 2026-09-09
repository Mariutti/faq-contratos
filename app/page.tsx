"use client";

import { useEffect, useRef, useState } from "react";
import type { Mensagem } from "@/lib/tipos";

// Na tela, cada mensagem do assistente pode vir acompanhada das
// fontes usadas para gerar aquela resposta específica.
type MensagemExibida = Mensagem & { fontes?: string[] };

export default function Home() {
  const [mensagens, setMensagens] = useState<MensagemExibida[]>([]);
  const [pergunta, setPergunta] = useState("");
  const [carregando, setCarregando] = useState(false);
  const fimDaListaRef = useRef<HTMLDivElement>(null);

  // Rola a conversa para o final sempre que uma mensagem nova aparece.
  useEffect(() => {
    fimDaListaRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensagens]);

  async function enviarPergunta() {
    const texto = pergunta.trim();
    if (!texto || carregando) return;

    const novasMensagens: MensagemExibida[] = [...mensagens, { papel: "user", texto }];
    setMensagens(novasMensagens);
    setPergunta("");
    setCarregando(true);

    const res = await fetch("/api/perguntar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Manda a conversa inteira, para a IA considerar o contexto
      // das perguntas anteriores (sem os "fontes", que é só de exibição).
      body: JSON.stringify({
        mensagens: novasMensagens.map(({ papel, texto }) => ({ papel, texto })),
      }),
    });

    const dados = await res.json();

    setMensagens((atual) => [
      ...atual,
      {
        papel: "model",
        texto: dados.resposta ?? dados.erro ?? "Ocorreu um erro inesperado.",
        fontes: dados.fontes,
      },
    ]);
    setCarregando(false);
  }

  function novaConversa() {
    setMensagens([]);
    setPergunta("");
  }

  function aoPressionarTecla(evento: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envia, Shift+Enter quebra linha (padrão de chat)
    if (evento.key === "Enter" && !evento.shiftKey) {
      evento.preventDefault();
      enviarPergunta();
    }
  }

  return (
    <main
      style={{
        maxWidth: 700,
        margin: "0 auto",
        padding: "0 20px",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "20px 0",
          borderBottom: "1px solid #ddd",
        }}
      >
        <div>
          <h1 style={{ fontSize: 18, margin: 0 }}>Portal de Dúvidas em Contratações Públicas</h1>
          <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0" }}>
            Baseado na Lei nº 14.133/2021 e materiais complementares
          </p>
        </div>
        <button onClick={novaConversa} style={{ padding: "8px 14px", whiteSpace: "nowrap" }}>
          + Nova conversa
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 0" }}>
        {mensagens.length === 0 && (
          <p style={{ color: "#888" }}>
            Digite sua pergunta sobre contratações públicas para começar a conversa.
          </p>
        )}

        {mensagens.map((mensagem, indice) => (
          <div
            key={indice}
            style={{
              display: "flex",
              justifyContent: mensagem.papel === "user" ? "flex-end" : "flex-start",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "10px 14px",
                borderRadius: 12,
                background: mensagem.papel === "user" ? "#0a58ca" : "#f1f1f1",
                color: mensagem.papel === "user" ? "#fff" : "#111",
              }}
            >
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{mensagem.texto}</p>

              {mensagem.fontes && mensagem.fontes.length > 0 && (
                <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.7 }}>
                  Fontes: {mensagem.fontes.join(", ")}
                </p>
              )}
            </div>
          </div>
        ))}

        {carregando && <p style={{ color: "#888" }}>Consultando...</p>}

        <div ref={fimDaListaRef} />
      </div>

      <div style={{ display: "flex", gap: 8, padding: "12px 0 20px", borderTop: "1px solid #ddd" }}>
        <textarea
          value={pergunta}
          onChange={(evento) => setPergunta(evento.target.value)}
          onKeyDown={aoPressionarTecla}
          rows={2}
          style={{ flex: 1, padding: 10, fontSize: 16, resize: "none" }}
          placeholder="Ex.: quando é obrigatória a matriz de riscos?"
        />
        <button onClick={enviarPergunta} disabled={carregando} style={{ padding: "0 18px" }}>
          Enviar
        </button>
      </div>
    </main>
  );
}