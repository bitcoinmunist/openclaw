# RUNBOOK — OpenClaw local (fork v2026.6.5)

Notas operacionais do deploy local (gateway Docker + node host systemd). Os patches
locais estão **commitados** na branch `local/v2026.6.5` (commit `be81e34e30`).

## Patches locais (4 arquivos, vs upstream v2026.6.5)
- `docker-compose.yml` — hardening (read_only, tmpfs, cap_drop ALL, portas 127.0.0.1,
  limites), cache npm em tmpfs (`npm_config_cache=/tmp/.npm`), `env_file required:true`.
- `packages/speech-core/src/tts.ts` — strip `[[tts]]` em off-mode (não vaza marcador).
- `src/infra/heartbeat-runner.ts` — TTS só no payload main (não em reasoning).
- `src/media/local-roots.ts` — serve `/home/node/imagens` (volume `/home/gustavo/Imagens`).

Snapshot: `~/openclaw-local-patches.diff` (= `git diff v2026.6.5 HEAD`).

## WhatsApp é plugin externo (não-bundled)
Trust de `openKeyedStore` vem do install record em `~/.openclaw/state/openclaw.sqlite`
(tabela `installed_plugin_index`). Telegram é bundled. Se o WhatsApp entrar em
crash-loop `openKeyedStore is only available for trusted plugins`, reinstalar
**dentro do container** (read_only exige cache em tmpfs):

```bash
docker exec -e npm_config_cache=/tmp/.npm openclaw-openclaw-gateway-1 \
  node dist/index.js plugins install clawhub:@openclaw/whatsapp
cd /home/gustavo/openclaw && docker compose restart openclaw-gateway
```
Credenciais WhatsApp (sessão) ficam em `~/.openclaw/credentials/whatsapp` (separado).
NÃO usar `plugins.allow` — vira allowlist estrita e derruba os bundled (12→5).

## Build / cutover
```bash
cd /home/gustavo/openclaw
docker compose build openclaw-gateway          # rebuild da working tree (COPY . .)
docker tag openclaw:local openclaw:pre-X-rollback   # rollback rápido antes de recriar
docker compose up -d openclaw-gateway          # recreate (downtime breve)
systemctl --user restart openclaw-node.service # node reconecta ao gateway
```

## Node host (systemd --user)
- Roda de `~/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw` (npm-global no nvm).
- Token via `EnvironmentFile=~/.config/openclaw/node.env` (600) — NÃO inline no unit.
- Update: `npm i -g --prefix ~/.nvm/versions/node/v24.13.0 openclaw@<ver>` + restart.

## Verificação rápida
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18789/healthz   # 200
docker logs openclaw-openclaw-gateway-1 2>&1 | grep -oE '[0-9]+ plugins' | tail -1  # 12
systemctl --user is-active openclaw-node.service                          # active
```

## Rollback completo (→ v2026.2.25)
imagem `openclaw:rollback-2026.2.25` + tar `~/openclaw-backup-pre-6.5-*.tar.gz`
(perms 600 — PII) + `git checkout v2026.2.25` + `npm i -g openclaw@2026.2.25`.
