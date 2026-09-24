import type { OpenClawConfig } from "../../config/types.js";
import {
  installationTargetEnv,
  type InstallationTarget,
} from "../../infra/installation-target-context.js";
import { applyPathPrepend, findPathKey, normalizePathPrepend } from "../../infra/path-prepend.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { resolveSessionAgentIdStrict } from "../agent-scope.js";
import { prepareGitHubToolEnvironment } from "../github-tool-identity.js";
import { resolveExecToolConfig } from "../lazy-exec-tool.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Capture non-secret environment facts once; the harness owns their placement. */
export function prepareAgentHarnessEnvironment(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sandboxAgentId?: string;
  installationTarget?: InstallationTarget;
}): ReturnType<NonNullable<AgentHarnessHostCapabilities["preparedEnvironment"]>> {
  const pathPrepend = normalizePathPrepend(
    resolveExecToolConfig({
      cfg: params.config,
      agentId: params.sandboxAgentId ?? resolveSessionAgentIdStrict(params),
    }).pathPrepend,
  );
  // Capture only tool lookup, not arbitrary host environment or installation custody.
  // SAFETY: findPathKey reads only key names, so optional process.env values are unused.
  const pathKey = findPathKey(process.env as Record<string, string>);
  const localToolEnv =
    pathPrepend.length > 0 ? { [pathKey]: process.env[pathKey] ?? "" } : undefined;
  if (localToolEnv) {
    applyPathPrepend(localToolEnv, pathPrepend);
    Object.freeze(localToolEnv);
  }
  const identity = prepareGitHubToolEnvironment({
    config: params.config ?? {},
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig,
    agentId: params.agentId ?? "main",
  });
  const localProcessEnv = installationTargetEnv(params.installationTarget);
  return Object.freeze({
    credentialScrubEnv: Object.freeze({ ...identity.credentialScrubEnv }),
    localIdentityEnv: Object.freeze({ ...identity.localIdentityEnv }),
    managedLocalIdentity: identity.managedLocalIdentity,
    ...(localProcessEnv ? { localProcessEnv } : {}),
    ...(localToolEnv ? { localToolEnv } : {}),
  });
}
