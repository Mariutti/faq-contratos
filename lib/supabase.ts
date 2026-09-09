import { createClient } from "@supabase/supabase-js";

// Este cliente usa a chave "service role", que tem acesso total ao
// banco e ignora as regras de Row Level Security (RLS). Por isso,
// este arquivo só deve ser importado por código que roda no
// SERVIDOR (rotas de API) -- nunca por componentes que rodam no
// navegador do usuário.
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);