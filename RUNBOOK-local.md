# RUNBOOK — OpenClaw local (fork v2026.9.6)

Notas operacionais do deploy local (gateway Docker + node host systemd). Os patches
locais estão **commitados** na branch `local/v2026.9.6` (base `v2026.9.6`, 2026-09-24).

## Patches locais (vs upstream v2026.9.6)
- `docker-compose.yml` — hardening (read_only, tmpfs, cap_drop ALL, portas 127.0.0.1,
  limites), cache npm em tmpfs (`npm_config_cache=/tmp/.npm`), `env_file required:true`,
  `umask 077` no comando do gateway.
- `src/tts/tts-payload.ts` — strip `[[tts]]` em off-mode (não vaza marcador).
  Re-aplicado na v2026.9.6: o bug continua no upstream (early-return sem strip em
  `maybeApplyTtsToPayload`); antes vivia em `packages/speech-core/src/tts.ts`.
- `src/media/local-roots.ts` — serve `/home/node/imagens` (volume `/home/gustavo/Imagens`).
- **Obsoleto na v2026.9.6:** patch antigo de `src/infra/heartbeat-runner.ts` (TTS só no
  payload main) — o arquivo virou barrel de 16 linhas e o pipeline novo
  (`src/auto-reply/reply/dispatch-from-config.*`) aplica TTS nos pontos de dispatch.

Histórico: branch `local/v2026.6.5` preservada com os 4 commits originais
(`be81e34e30`..`ddf30d671d`) + umask (`7b7c8cd935a`).

Snapshot: `~/openclaw-local-patches.diff` (= `git diff v2026.9.6 HEAD`).

## WhatsApp é plugin externo (não-bundled)
Trust de `openKeyedStore` vem do install record em `~/.openclaw/state/openclaw.sqlite`
(tabela `installed_plugin_index`). Telegram é bundled. Credenciais WhatsApp (sessão)
ficam em `~/.openclaw/credentials/whatsapp` (separado).
NÃO usar `plugins.allow` — vira allowlist estrita e derruba os bundled.

### Update do plugin (exige config válida + gateway PARADO)
O `plugins update` valida a config ANTES de trocar o pacote e falha se o schema do
plugin instalado rejeitar a config. Janela de manutenção (gateway parado evita
disputa de lock e o loop de restart):

```bash
cd /home/gustavo/openclaw
docker compose stop openclaw-gateway
docker compose run --rm -T -e npm_config_cache=/tmp/.npm openclaw-gateway \
  node dist/index.js plugins update whatsapp
docker compose run --rm -T openclaw-gateway node dist/index.js update repair  # peer links + convergência
docker compose run --rm -T openclaw-gateway node dist/index.js doctor --fix --non-interactive
docker compose up -d openclaw-gateway
```

### ackReaction (migrado na v2026.9.4 do plugin)
`channels.whatsapp.ackReaction` (objeto `{emoji,direct,group}`) foi REMOVIDO do schema
do plugin novo → "global message acknowledgement settings": o emoji agora vive em
`messages.ackReaction` (string). Escopo por grupo já vem do `groups.*.requireMention`.
Novo no canal: `reactionLevel: "ack"|"off"|"minimal"|"extensive"` (ack reactions exigem
`"ack"`). Config atual: `messages.ackReaction: "👀"` + `reactionLevel: "ack"`.

### Quirk do node host (cosmético)
O node host audita o peer link `extensions/whatsapp/node_modules/openclaw → /app`,
que só existe no container → warning "data/settings upgrade is unfinished" no
journal do node. Inofensivo (o gateway é quem roda o plugin; conexão e skills ok).
Fix opcional no host: `sudo ln -s ~/.nvm/versions/node/v24.21.0/lib/node_modules/openclaw /app`.

## Docker NAT × trustedProxies (descoberta 2026-09-24)
Com bridge docker (`-p 127.0.0.1:18789:18789`), o gateway vê conexões do node host
como vindas do gateway IP da bridge (172.23.0.1). O 2026.9.6 atribui ingress:
loopback → direct-local; SEM headers de proxy e FORA de trustedProxies → direct-remote
(ok, com token auth); trustedProxies + SEM headers → fail closed (403
`proxy_attribution_required`). O gateway AUTO-adiciona a subnet da bridge em
`gateway.trustedProxies` no boot — o que QUEBRA o node host (NAT não manda
X-Forwarded-For). Manter `gateway.trustedProxies: []` (vazio). `allowRealIpFallback`
só habilita confiança em header X-Real-IP — não resolve NAT sem headers.

## Build / cutover
```bash
cd /home/gustavo/openclaw
docker compose build openclaw-gateway          # rebuild da working tree (COPY . .)
docker tag openclaw:local openclaw:pre-X-rollback   # rollback rápido antes de recriar
docker compose up -d openclaw-gateway          # recreate (downtime breve)
systemctl --user restart openclaw-node.service # node reconecta ao gateway
```
Reiniciar o node host DEPOIS do gateway estabilizado (conectar durante churn causa
"node pairing changed before request dispatch" no publish de skills — resolve com
novo restart do node).

## Node host (systemd --user)
- Roda de `~/.nvm/versions/node/v24.21.0/lib/node_modules/openclaw` (npm-global no nvm;
  Node >= 24.16 exigido pela 2026.9.6 — migrado de v24.13.0 em 2026-09-24).
- Token via `EnvironmentFile=~/.config/openclaw/node.env` (600) — NÃO inline no unit.
- Update: instalar Node novo via nvm se exigido, depois
  `PATH=~/.nvm/versions/node/<novo>/bin:$PATH npm i -g --prefix ~/.nvm/versions/node/<novo> openclaw@<ver>
  --allow-scripts=@google/genai,koffi,protobufjs,openclaw` (npm novo bloqueia
  install-scripts por padrão; koffi precisa do postinstall) + editar unit
  (ExecStart, SERVICE_VERSION) + `systemctl --user daemon-reload` + restart.

## Verificação rápida
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18789/healthz   # 200
docker logs openclaw-openclaw-gateway-1 2>&1 | grep -oE '[0-9]+ plugins' | tail -1  # 21
docker logs openclaw-openclaw-gateway-1 2>&1 | grep -c "Listening for WhatsApp inbound" # >=1
docker exec openclaw-openclaw-gateway-1 node dist/index.js models status  # default + fallbacks
systemctl --user is-active openclaw-node.service                          # active
```

## Modelos (2026-09-24)
- Primary: `google/gemini-3.8-flash` (API nativa, alias `gemini-flash`)
- Fallbacks: `openrouter/google/gemini-3.8-flash` → `openrouter/deepseek/deepseek-v4.1-flash`
- Transcrição de áudio: `tools.media.models[0].model = gemini-3.8-flash`
- `modelPolicy.allow` acompanha (o gateway regenera a partir de `agents.defaults.models`)

## Rollback do update 2026-09-24 (→ v2026.6.5)
imagem `openclaw:pre-update-20260924-rollback` + config `~/.openclaw/openclaw.json.bak-pre-update-20260924`
+ tar `~/openclaw-backup-pre-9.6-*.tar.gz` (estado consistente, gateway parado)
+ `git checkout local/v2026.6.5` + npm i -g openclaw@2026.6.5 no prefix v24.13.0
(= unit antigo) + build/up/restart.
ATENÇÃO: a config migrada (agents.entries, sqlite auth) NÃO abre na 2026.6.5 —
restaurar também o `.bak-pre-update` da config.

## Rollback completo (→ v2026.2.25)
imagem `openclaw:rollback-2026.2.25` + tar `~/openclaw-backup-pre-6.5-*.tar.gz`
(perms 600 — PII) + `git checkout v2026.2.25` + `npm i -g openclaw@2026.2.25`.
