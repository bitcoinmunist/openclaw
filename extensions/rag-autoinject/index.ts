/**
 * rag-autoinject — Reliable RAG retrieval-injection for document-grounded agents.
 *
 * Problem: with the default setup, `memory_search` is an OPTIONAL tool. The model
 * skips it on turns where it "feels confident" (the basics live in its own prompt),
 * then fabricates page numbers to satisfy a "cite document + page" mandate.
 *
 * Fix (this plugin): on every eligible user turn, run the SAME search the
 * `memory_search` tool runs (host API `getActiveMemorySearchManager().search()`),
 * and inject the RAW retrieved chunks — which already carry their `[[doc · pág N]]`
 * page markers — into the prompt context via `before_prompt_build`. The model then
 * answers from the real documents and cites real pages. No summarization (unlike
 * active-memory), so only one embedding call per turn and zero extra LLM cost.
 *
 * Graceful by design: any error / timeout / empty result -> no injection, turn
 * proceeds normally. Scoped per-agent via config.agents.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "rag-autoinject";

type PluginCfg = {
  enabled?: boolean;
  agents?: unknown;
  maxChunks?: unknown;
  minScore?: unknown;
  timeoutMs?: unknown;
  logging?: unknown;
};

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "RAG Auto-Inject",
  description:
    "Searches the agent's memory corpus before each eligible reply and injects the raw retrieved chunks (with page markers) into context.",
  register(api: OpenClawPluginApi) {
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        try {
          const cfg = api.config as OpenClawConfig;
          const pc = (resolvePluginConfigObject(cfg, PLUGIN_ID) ??
            (api.pluginConfig as Record<string, unknown> | undefined) ??
            {}) as PluginCfg;

          if (pc.enabled === false) return undefined;

          const agentId = ctx.agentId;
          if (!agentId) return undefined;

          const agents = Array.isArray(pc.agents)
            ? pc.agents.filter((a): a is string => typeof a === "string")
            : [];
          if (agents.length > 0 && !agents.includes(agentId)) return undefined;

          // Only inject for real user-driven turns (skip heartbeats/system triggers).
          if (ctx.trigger && ctx.trigger !== "user") return undefined;

          const query = (event?.prompt ?? "").trim();
          if (query.length < 3) return undefined;

          const maxChunks = Math.max(1, Math.min(30, Math.round(asNumber(pc.maxChunks, 8))));
          const minScore = asNumber(pc.minScore, 0.3);
          const timeoutMs = Math.max(500, Math.min(30000, Math.round(asNumber(pc.timeoutMs, 6000))));
          const logging = pc.logging === true;

          const { manager, error } = await getActiveMemorySearchManager({ cfg, agentId });
          if (!manager) {
            if (logging) api.logger.warn?.(`${PLUGIN_ID}: no memory manager (${error ?? "null"})`);
            return undefined;
          }

          const hits = await Promise.race([
            manager.search(query, { maxResults: maxChunks, minScore, sources: ["memory"] }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("rag-autoinject search timeout")), timeoutMs),
            ),
          ]);

          if (!Array.isArray(hits) || hits.length === 0) {
            if (logging) api.logger.info?.(`${PLUGIN_ID}: 0 chunks for agent ${agentId}`);
            return undefined;
          }

          // Nome amigável do documento a partir do caminho do arquivo — sem página.
          const docName = (p: string): string => {
            if (p.includes("01-manual")) return "Manual Básico da Entrevista";
            if (p.includes("02-cartilha")) return "Cartilha do Entrevistador";
            if (p.includes("03-tcle")) return "TCLE — Exames Laboratoriais";
            if (p.includes("04-filipeta-antrop")) return "Filipeta de Antropometria";
            if (p.includes("05-filipeta-material")) return "Filipeta de Material Biológico";
            return "documento oficial da PNS";
          };
          // Remove TODOS os marcadores [[...]] (inclusive página): esta plataforma NÃO cita página,
          // então o modelo não tem número algum para copiar nem inventar.
          const stripMarkers = (s: string): string =>
            String(s ?? "")
              .replace(/\[\[[^\]]*\]\]/g, "")
              .replace(/[ \t]+\n/g, "\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim();

          const blocks = hits
            .map((h, i) => `[${i + 1}] (Fonte: ${docName(h.path)})\n${stripMarkers(h.snippet)}`)
            .join("\n\n");

          const injected =
            "=== TRECHOS RECUPERADOS DOS DOCUMENTOS DA PNS (fonte primária para esta resposta) ===\n\n" +
            blocks +
            "\n\n=== FIM DOS TRECHOS ===\n" +
            "INSTRUÇÃO DE FIDELIDADE (obrigatória):\n" +
            "1. Responda a partir DESTES trechos.\n" +
            '2. Ao citar a fonte, use APENAS o NOME do documento (ex.: "conforme o Manual Básico da Entrevista", ' +
            '"segundo a Filipeta de Material Biológico"). NUNCA cite número de página nem "pág. N" — esta plataforma ' +
            "não usa páginas; o agente de campo localiza pelo texto.\n" +
            "3. Quando útil, reproduza entre aspas um TRECHO EXATO acima para a pessoa achar no PDF (Ctrl+F).\n" +
            "4. Se a resposta não estiver nos trechos, use a ferramenta memory_search para aprofundar " +
            "OU diga que não localizou e remeta ao material oficial. NUNCA invente dado nem fonte.\n";

          if (logging) {
            api.logger.info?.(`${PLUGIN_ID}: injected ${hits.length} chunks for agent ${agentId}`);
          }
          return { appendContext: injected };
        } catch (err) {
          try {
            api.logger.warn?.(
              `${PLUGIN_ID} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } catch {
            /* ignore logging failure */
          }
          return undefined;
        }
      },
      { timeoutMs: 12_000, priority: 40 },
    );
  },
});
