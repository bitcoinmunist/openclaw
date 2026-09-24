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

Backup remoto da branch: fork `bitcoinmunist/openclaw` (remote `fork`) — após
commitar patches/docs, `git push fork local/v2026.9.6`. O `origin` é o upstream
(openclaw/openclaw, read-only).

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

### Quirks do node host (audit de plugins, cross-contexto)
O estado é compartilhado container↔host, mas os paths gravados são os do container.
WhatsApp (resolvido 2026-09-24): o audit do peer link checa
`/home/node/.openclaw/extensions/whatsapp/node_modules/openclaw → /app`. Symlinks no
host fazem ambos contextos resolverem os mesmos arquivos:
```bash
sudo ln -s /home/gustavo /home/node                                                      # home compartilhada
sudo ln -s ~/.nvm/versions/node/v24.21.0/lib/node_modules/openclaw /app                  # install openclaw
```
(Se o Node mudar de versão no nvm, atualizar o symlink /app.)

rag-autoinject (cosmético, SEM fix limpo): plugin exclusivo do fork, compilado só na
imagem docker. O node host (npm stock) reporta "configured plugin package is missing
or has not converged" — inofensivo: gateway roda o plugin, node host só audita.
Se um dia incomodar: publicar o fork no npm e instalar o pacote no node host também.

### Pre-keys do WhatsApp acumulando (verificado 2026-09-24)
`credentials/whatsapp/default/` tinha 167.448 `pre-key-*.json` (par {private,public},
4KB cada). FLOOD em **5–12/set** (10k–28k/dia, ~150k no pico — loop de upload do
plugin/baileys ANTIGOS; logs se perderam no recreate do container). Desde 13/set
~150/dia; **0 criados após o update de 24/set** (plugin 2026.9.4 + baileys novo, com
`lib/Utils/pre-key-manager.js` — processa deleções do protocolo mas não poda antigos).
Frequência de restart é o que dispara re-upload (938 no dia do update).
Limpeza EXECUTADA 2026-09-24: stash reversível em
`~/.openclaw-backups/prekeys-stash-20260924/` (118.161 arquivos >14 dias; sessão foi
703MB→241MB, gateway sem nenhum erro de decrypt pós-move). **Só apagar o stash após
7+ dias sem erros de decrypt** (`docker logs ... | grep -i decrypt`). Restauração:
instruções no README-restaurar.txt dentro do stash. NUNCA apagar `creds.json`,
`session-*`, `identity*`, `sender-key-*` (não casam com o padrão `pre-key-*.json`).

## Segredos (SecretRefs — migrado 2026-09-24)
`gateway.auth.token`, `channels.telegram.botToken` e o auth profile
`google-vertex:default` vivem agora como refs para o **file provider** `filemain`
→ `~/.openclaw/secrets.json` (0600; vai junto no backup). Audit limpo nos dois
contextos: `openclaw secrets audit --check` (rode no container E no host).

Armadilha descoberta: `secrets apply` grava o ref SÓ no store do agent alvo
(`agents/<id>/agent/openclaw-agent.sqlite`, tabela `auth_profile_store`); a cópia
canônica `state-db` (`state/openclaw.sqlite`, row `config_machine_state` →
`authProfiles.store`) fica com plaintext porque o scrub do apply só é alimentado
por targets de config (src/secrets/apply.ts ~linha 449), nunca pelos de
auth-profiles. Fix: replicar o payload com `keyRef` do agent DB nessa row (gateway
parado) e re-auditar. Se adicionar um perfil de API key novo, repetir esse passo.
Legacy `auth.json.migrated-*` pode ser removido depois do audit limpo (originais
ficam no tar de backup pré-update).

## Doctor: rode do CONTAINER (falso positivo no host)
Os symlinks cross-contexto do host (`/home/node → /home/gustavo`, `/app → npm
global`) enganam checks de filesystem: o doctor do HOST acusa 5× "workspace-alias…
Incoming messages cannot use this workspace" e "MCP nexus-tools ENOTFOUND
host.docker.internal" — **nenhum existe de verdade** (verificado 2026-09-24:
doctor --json dentro do container = só 2 findings, ambos esperados: loopback-only
é hardening intencional; plaintext secrets foi resolvido com SecretRefs). O MCP
nexus-tools escuta em 172.17.0.1:8790 e o container resolve via extra_hosts
host-gateway. Regra: `docker compose run --rm -T openclaw-gateway node dist/index.js
doctor --json --non-interactive`.

## Automação (2026-09-24)
- `~/bin/openclaw-backup.sh` + `openclaw-backup.timer` (domingos 09:17): tar.gz em
  `~/.openclaw-backups/` (700/600), sqlite via `.backup` (consistente com gateway
  no ar), retenção 4.
- `~/bin/openclaw-health.sh` + `openclaw-health.timer` (5 min): healthz + container
  healthy + node ativo; alerta (logger + notify-send) só na transição ok→falha.
- `~/bin/openclaw-update.sh v2026.X.Y`: codifica o cutover deste RUNBOOK (rollback
  image → branch → cherry-picks → build → stop/doctor --fix/up → node → verify).
  EDITE a lista de PATCHES a cada release. Em conflito de cherry-pick ele para.
- Build cache docker cresce a cada rebuild (169GB uma vez): podar com
  `docker buildx prune -f --max-used-space=10GB` (deixa 10GB p/ rebuild rápido).

## Docker NAT × trustedProxies (descoberta 2026-09-24)
Com bridge docker (`-p 127.0.0.1:18789:18789`), o gateway vê conexões do node host
como vindas do gateway IP da bridge (172.23.0.1). O 2026.9.6 atribui ingress:
loopback → direct-local; SEM headers de proxy e FORA de trustedProxies → direct-remote
(ok, com token auth); trustedProxies + SEM headers → fail closed (403
`proxy_attribution_required`). O gateway AUTO-adiciona a subnet da bridge em
`gateway.trustedProxies` no boot — o que QUEBRA o node host (NAT não manda
X-Forwarded-For). Manter `gateway.trustedProxies: []` (vazio). `allowRealIpFallback`
só habilita confiança em header X-Real-IP — não resolve NAT sem headers.

## Sandbox do agente: por que fica OFF (verificado 2026-09-24)
Decisão deliberada — NÃO ligar `agents.defaults.sandbox` neste deploy:
- `mode: "non-main"` sandboxa TODAS as sessões exceto `agent:<id>:main` — e sessões
  de canal (WhatsApp/Telegram) contam como non-main. São exatamente onde o
  `exec host=node` do main roda no host real (shutdown-pc.sh etc.) → sandboxado,
  o exec cairia num container irmão e `whoami` deixaria de ser `gustavo`.
- Backend docker com Gateway EM Docker cria containers irmãos via **docker.sock do
  host montado no gateway** (docs/gateway/sandboxing/docker-backend.md). O compose
  não monta o socket de propósito (cap_drop ALL, read_only). Montar = root-equivalente
  no host dentro do gateway → perda líquida de segurança.
- fluxo/higia/syndikos não têm exec/browser — sandbox só confinaria read/write/edit.
  O confinamento real deles já vem de: chmod 400 na config, deny lists, allowlists
  de canal, hardening do compose.
- Se um dia precisar de sandbox de verdade (ex: agente de código), usar backend
  ssh/openshell para uma VM em vez de montar o socket no gateway.

## Exec approvals (2026.9.6): onde vive e o que falta p/ gatear o main
O policy document migrou do JSON antigo para o **SQLite**:
`~/.openclaw/state/openclaw.sqlite` row singleton `exec_approvals_config`
(`exec-approvals.json` NÃO existe mais; o doctor importa o legado se aparecer).
Estado atual (lido 2026-09-24):
- `defaults`: security **allowlist**, ask off, askFallback **deny**, autoAllowSkills false
- `agents.main`: security **FULL**, ask off, allowlist histórica que inclui
  `/bin/sh` e `/usr/bin/dash` → com sh na lista, allowlist é decorativa.
- Efetivo por agente (`openclaw exec-policy show --json` no host): main=full
  (config pede `mode: full`), fluxo=deny, higia/syndikos=allowlist, tool-guardian=full.

Por que o main roda sem gate: o próprio documento tem `agents.main.security: full`
E o config tem `agents.entries.main.tools.exec.mode: "full"`. Para devolver o gate:
1. Config (dance chmod 600/400): `agents.entries.main.tools.exec.mode: "ask"` (ou
   `"auto"` — allowlist direto + revisão de misses; `"full"` nunca).
2. Approvals doc: remover `agents.main` (herda defaults=allowlist) ou trocar
   security p/ allowlist. Ferramenta: `openclaw exec-policy set` / `approvals`
   CLI (docs/tools/exec-approvals.md); doc fica na row do SQLite compartilhado
   node↔gateway (mesmo state dir).
3. **Tirar `/bin/sh` e `/usr/bin/dash` da allowlist** — senão é teatro. Com
   `mode: "auto"` o node revisa comando direto "pinned" mesmo vindo de wrapper sh.
4. Allowlist útil p/ o fluxo atual: `shutdown-pc.sh`, `sudo /sbin/shutdown`,
   `ls/cat/head/git`. Misses viram **approval card no canal** (2026.9.1: approval
   chega no chat de origem, WhatsApp/Telegram, aprova por reação) — com
   askFallback deny, sem UI disponível = bloqueia (fail closed, seguro).
5. Testar: whoami via exec (deve continuar `gustavo`); comando fora da lista deve
   gerar card de aprovação; `shutdown -c` à mão se algo travar.
CUIDADO: gatear o main pode incomodar o fluxo diário de automação — avaliar antes.

**DECISÃO (2026-09-24): main permanece FULL de propósito — não gatear.** O Nexus
delega ao Claude Code (`claude -p … --dangerously-skip-permissions`, já em uso);
travar o wrapper de fora não reduz o raio real. O modelo de segurança aceito é:
a trava dura fica na camada de DEPOIS do agente, não no shell dele —
- config chmod 400 (agente não reescreve a própria config)
- sudo: só `/sbin/shutdown` NOPASSWD (resto pede senha que o agente não tem)
- backup semanal de todo o estado (`openclaw-backup.timer`) = rollback de dano
- WhatsApp/Telegram allowlist só com o número do dono (superfície de injection mínima)
- compose endurecido (read_only, cap_drop ALL) no processo do gateway
Alterações nessa decisão exigem reavaliar o bloco acima (ex: expor o gateway na LAN).

## Build / cutover
```bash
cd /home/gustavo/openclaw
docker compose build openclaw-gateway          # rebuild da working tree (COPY . .)
docker tag openclaw:local openclaw:pre-X-rollback   # rollback rápido antes de recriar
docker compose up -d openclaw-gateway          # recreate (downtime breve)
systemctl --user restart openclaw-node.service # node reconecta ao gateway
```
Hardening da config: `openclaw.json` fica **chmod 400** (agente não escreve — ver
memory/openclaw-notes). Toda manutenção que escreve config: `chmod 600` antes,
`chmod 400` depois. O `~/bin/openclaw-update.sh` faz o dance automaticamente.
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
- `modelPolicy.allow` e `agents.defaults.models` são MANUAIS (o gateway NÃO
  regenera; 2026-09-24: limpo qwen3-coder:free, allow com deepseek — fallback
  funciona mesmo fora do allow, mas seleção manual `/model` precisa do allow)

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
