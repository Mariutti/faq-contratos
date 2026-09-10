import { GoogleGenAI } from '@google/genai';
import type { Mensagem } from './tipos';

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function obterStatusDoErro(erro: unknown): number | undefined {
	if (
		typeof erro === 'object' &&
		erro !== null &&
		'status' in erro &&
		typeof erro.status === 'number'
	) {
		return erro.status;
	}

	return undefined;
}
// Tenta de novo em caso de erro PASSAGEIRO (ex.: 503 = modelo
// temporariamente sobrecarregado do lado do Gemini). Erros de outros
// tipos (ex.: 404 de modelo inexistente, 400 de requisição inválida)
// não valem retentativa -- não vão se resolver esperando.
async function comRetentativa<T>(
	fn: () => Promise<T>,
	tentativas = 3,
): Promise<T> {
	for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
		try {
			return await fn();
		} catch (erro: unknown) {
			const status = obterStatusDoErro(erro);
			const transitorio = status === 503 || status === 429;
			if (!transitorio || tentativa === tentativas) throw erro;

			await sleep(2000 * tentativa);
		}
	}
	throw new Error('Número máximo de tentativas excedido.');
}

// Gera o embedding de um texto (usado para a busca no banco). Precisa
// ser o mesmo modelo e a mesma quantidade de dimensões (768) usados
// no script de ingestão -- senão os vetores não são comparáveis.
export async function gerarEmbeddingDaPergunta(
	texto: string,
): Promise<number[]> {
	const resposta = await comRetentativa(() =>
		ai.models.embedContent({
			model: 'gemini-embedding-001',
			contents: texto,
			config: { outputDimensionality: 768 },
		}),
	);

	return resposta.embeddings![0].values!;
}

// Gera a resposta final, considerando TODA a conversa até aqui (para
// continuidade) e os trechos de PDF recuperados para a pergunta mais
// recente (para fundamentar a resposta nos documentos).
export async function gerarResposta(
	mensagens: Mensagem[],
	trechos: string[],
): Promise<string> {
	const contexto = trechos
		.map((trecho, i) => `Trecho ${i + 1}:\n${trecho}`)
		.join('\n\n---\n\n');

	const instrucoesDoSistema = `Você é um assistente que responde dúvidas sobre contratações públicas, com base EXCLUSIVAMENTE nos trechos de documentos fornecidos a cada pergunta.

Regras:
- Responda apenas com base nas informações contidas nos trechos abaixo.
- Se os trechos não tiverem a resposta, diga claramente que não encontrou a informação na base disponível -- não invente.
- Use o histórico da conversa para entender perguntas de continuação (ex.: "e no caso de obras?" se referindo ao assunto anterior).
- Seja objetivo e direto.

Trechos disponíveis para a pergunta mais recente:
${contexto}`;

	// Converte o histórico para o formato multi-turno que o Gemini
	// espera: uma lista alternando remetente ("user"/"model") e texto.
	const contents = mensagens.map((mensagem) => ({
		role: mensagem.papel,
		parts: [{ text: mensagem.texto }],
	}));

	const resposta = await comRetentativa(() =>
		ai.models.generateContent({
			model: 'gemini-3.6-flash',
			contents,
			config: { systemInstruction: instrucoesDoSistema },
		}),
	);

	return resposta.text ?? 'Não foi possível gerar uma resposta.';
}
