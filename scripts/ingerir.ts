// scripts/ingerir.ts
//
// Este script roda LOCALMENTE, na sua máquina -- ele NÃO faz parte do
// site publicado. Ele lê os PDFs da pasta /documentos, quebra o texto
// em pedaços menores, gera um embedding para cada pedaço usando o
// Gemini (em lotes, para economizar cota), e grava tudo na tabela
// "documentos" do Supabase.
//
// O script é RETOMÁVEL: se parar no meio (ex.: por limite de cota da
// API), rode de novo -- ele pula os arquivos que já foram processados.
//
// Para reprocessar um arquivo específico do zero, apague as linhas
// dele no Supabase antes de rodar de novo:
//   delete from documentos where fonte = 'nome-do-arquivo.pdf';
//
// Como rodar (a partir da raiz do projeto):
//   npx tsx scripts/ingerir.ts

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); // lê as chaves do .env.local

import fs from 'node:fs';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const PASTA_PDFS = path.join(process.cwd(), 'documentos');
const TAMANHO_TRECHO = 2000; // caracteres por trecho
const SOBREPOSICAO = 300; // caracteres repetidos entre um trecho e o próximo
const TAMANHO_LOTE = 10; // quantos trechos vão em cada chamada à API

// Pausa fixa entre um lote e outro. Com 10 trechos de até 2000
// caracteres por lote (~5.000 tokens/chamada), 15s de intervalo
// mantém o uso bem abaixo do limite de 30K tokens por minuto (TPM)
// -- que foi a causa real dos erros anteriores, não o limite diário.
const PAUSA_ENTRE_LOTES_MS = 15_000; // 15 segundos

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const supabase = createClient(
	process.env.SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function ehRegistro(valor: unknown): valor is Record<string, unknown> {
	return typeof valor === 'object' && valor !== null;
}

function mensagemDoErro(erro: unknown): string | null {
	if (erro instanceof Error) return erro.message;

	if (ehRegistro(erro) && typeof erro.message === 'string') {
		return erro.message;
	}

	return null;
}

// A API do Gemini, quando o limite é passageiro (ex.: por minuto),
// costuma informar quantos segundos esperar antes de tentar de novo
// (campo "RetryInfo"). Essa informação vem dentro do JSON que está
// em erro.message (uma STRING), não como uma propriedade separada do
// objeto de erro -- por isso precisamos fazer o parse manualmente.
function extrairEsperaSugeridaMs(erro: unknown): number | null {
	const mensagem = mensagemDoErro(erro);
	if (!mensagem) return null;

	let corpo: unknown;
	try {
		corpo = JSON.parse(mensagem);
	} catch {
		return null;
	}

	if (!ehRegistro(corpo) || !ehRegistro(corpo.error)) return null;

	const detalhes = corpo.error.details;
	if (!Array.isArray(detalhes)) return null;

	const retryInfo = detalhes.find(
		(detalhe): detalhe is Record<string, unknown> =>
			ehRegistro(detalhe) &&
			typeof detalhe['@type'] === 'string' &&
			detalhe['@type'].includes('RetryInfo'),
	);

	if (!retryInfo || typeof retryInfo.retryDelay !== 'string') return null;

	const segundos = Number.parseFloat(retryInfo.retryDelay);
	return Number.isFinite(segundos) ? segundos * 1000 : null;
}

// Executa uma função e, se ela falhar por limite de cota (HTTP 429),
// decide o que fazer com base no que a API informou:
//   - se veio um tempo de espera sugerido -> espera esse tempo e tenta de novo
//   - se NÃO veio (provável teto diário) -> desiste na hora, sem insistir à toa
async function comRetentativa<T>(
	fn: () => Promise<T>,
	tentativas = 3,
): Promise<T> {
	for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
		try {
			return await fn();
		} catch (erro: unknown) {
			const ehLimiteDeCota =
				ehRegistro(erro) &&
				typeof erro.status === 'number' &&
				erro.status === 429;
			if (!ehLimiteDeCota) throw erro;

			const esperaSugeridaMs = extrairEsperaSugeridaMs(erro);

			if (esperaSugeridaMs === null) {
				console.log(
					`\n  A API não indicou um tempo curto de espera -- isso costuma ` +
						`significar que o limite DIÁRIO de uso foi atingido, não algo ` +
						`passageiro. Não adianta insistir agora.`,
				);
				throw erro;
			}

			if (tentativa < tentativas) {
				const esperaMs = esperaSugeridaMs + 3_000; // margem de segurança
				console.log(
					`\n  limite momentâneo atingido, aguardando ${Math.round(
						esperaMs / 1000,
					)}s (tentativa ${tentativa}/${tentativas})...`,
				);
				await sleep(esperaMs);
				continue;
			}

			throw erro;
		}
	}
	throw new Error('Número máximo de tentativas excedido.');
}

// Quebra um texto longo em pedaços menores, com uma pequena
// sobreposição entre eles -- isso evita que uma frase importante
// fique cortada bem na fronteira entre dois trechos.
function dividirEmTrechos(texto: string): string[] {
	const trechos: string[] = [];
	let inicio = 0;

	while (inicio < texto.length) {
		const fim = inicio + TAMANHO_TRECHO;
		trechos.push(texto.slice(inicio, fim));
		inicio = fim - SOBREPOSICAO;
	}

	return trechos.map((t) => t.trim()).filter((t) => t.length > 0);
}

// Gera os embeddings de vários trechos em UMA ÚNICA chamada à API
// (isso é o que economiza cota: 50 trechos = 1 requisição, não 50).
async function gerarEmbeddingsEmLote(textos: string[]): Promise<number[][]> {
	const resposta = await comRetentativa(() =>
		ai.models.embedContent({
			model: 'gemini-embedding-001',
			contents: textos,
			config: { outputDimensionality: 768 },
		}),
	);

	return resposta.embeddings!.map((e) => e.values!);
}

// Compara o que já está gravado no banco para este arquivo com o que
// deveria estar lá (o total de trechos gerados AGORA a partir do PDF).
// Isso é o que evita o bug de marcar um arquivo como "concluído" quando,
// na verdade, só alguns lotes dele foram gravados antes de uma queda.
async function verificarProgresso(
	nomeArquivo: string,
	totalEsperado: number,
): Promise<'completo' | 'incompleto' | 'novo'> {
	const { count } = await supabase
		.from('documentos')
		.select('id', { count: 'exact', head: true })
		.eq('fonte', nomeArquivo);

	const existentes = count ?? 0;

	if (existentes === 0) return 'novo';
	if (existentes === totalEsperado) return 'completo';
	return 'incompleto';
}

async function processarPdf(nomeArquivo: string) {
	const caminho = path.join(PASTA_PDFS, nomeArquivo);
	const bytes = fs.readFileSync(caminho);
	const parser = new PDFParse({ data: bytes });
	const { text } = await parser.getText();
	await parser.destroy();

	const trechos = dividirEmTrechos(text);
	const status = await verificarProgresso(nomeArquivo, trechos.length);

	if (status === 'completo') {
		console.log(
			`  ${nomeArquivo}: já processado (${trechos.length} trecho(s)) -- pulando`,
		);
		return;
	}

	if (status === 'incompleto') {
		console.log(
			`  ${nomeArquivo}: dados incompletos de uma execução anterior -- apagando e reprocessando`,
		);
		await supabase.from('documentos').delete().eq('fonte', nomeArquivo);
	}

	console.log(`  ${nomeArquivo}: ${trechos.length} trecho(s) encontrado(s)`);

	for (let inicio = 0; inicio < trechos.length; inicio += TAMANHO_LOTE) {
		const lote = trechos.slice(inicio, inicio + TAMANHO_LOTE);
		const embeddings = await gerarEmbeddingsEmLote(lote);

		const linhas = lote.map((trecho, i) => ({
			fonte: nomeArquivo,
			conteudo: trecho,
			embedding: embeddings[i],
		}));

		const { error } = await supabase.from('documentos').insert(linhas);

		if (error) {
			console.error(`\n    erro ao gravar lote:`, error.message);
		} else {
			process.stdout.write('.');
		}

		await sleep(PAUSA_ENTRE_LOTES_MS);
	}

	console.log(''); // pula linha após os pontinhos de progresso
}

async function main() {
	if (!fs.existsSync(PASTA_PDFS)) {
		console.log(`Pasta não encontrada: ${PASTA_PDFS}`);
		console.log(
			`Crie a pasta "documentos" na raiz do projeto e coloque os PDFs lá.`,
		);
		return;
	}

	const arquivos = fs
		.readdirSync(PASTA_PDFS)
		.filter((nome) => nome.toLowerCase().endsWith('.pdf'));

	if (arquivos.length === 0) {
		console.log(`Nenhum PDF encontrado em ${PASTA_PDFS}`);
		return;
	}

	console.log(`Processando ${arquivos.length} arquivo(s):`);

	for (const arquivo of arquivos) {
		try {
			await processarPdf(arquivo);
		} catch {
			console.log(
				`\nParando por aqui. O que já foi gravado continua salvo -- ` +
					`rode o script de novo mais tarde para continuar a partir de "${arquivo}".`,
			);
			process.exit(1);
		}
	}

	console.log('Concluído -- todos os arquivos foram processados.');
}

main();
