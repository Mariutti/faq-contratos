-- Requer a extensão pgvector e a tabela public.documentos já existente.
-- O limiar impede que o RAG use os "cinco menos ruins" quando não há
-- evidência semanticamente suficiente para a pergunta.
begin;

drop function if exists public.buscar_documentos(vector, integer);

drop function if exists public.buscar_documentos(vector, integer, double precision);

create function public.buscar_documentos(
  query_embedding vector(768),
  limite integer,
  limiar_similaridade double precision
)
returns table (
  conteudo text,
  fonte text,
  similaridade double precision
)
language sql
stable
as $$
  select
    d.conteudo,
    d.fonte,
    1 - (d.embedding <=> query_embedding) as similaridade
  from public.documentos as d
  where 1 - (d.embedding <=> query_embedding) >= limiar_similaridade
  order by d.embedding <=> query_embedding
  limit least(greatest(limite, 1), 10);
$$;

commit;

notify pgrst, 'reload schema';