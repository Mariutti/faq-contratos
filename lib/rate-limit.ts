import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Limite inicial conservador para conter custo de embeddings e geração.
export const rateLimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "faq-contratos:perguntar",
  analytics: true,
});

export function identificarCliente(request: Request): string {
  const ipEncaminhado = request.headers.get("x-forwarded-for");
  const ip = ipEncaminhado?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip");

  return ip || "anonimo";
}
