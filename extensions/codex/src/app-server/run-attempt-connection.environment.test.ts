import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-options.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { createParams, setupRunAttemptTestHooks, tempDir } from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex local tool environment placement", () => {
  it.each(["local", "unconfigured-local", "websocket", "unix", "proxy", "remote-root", "sandbox"])(
    "applies the prepared tool PATH only to owned local execution: %s",
    async (placement) => {
      const params = createParams(
        path.join(tempDir, `path-${placement}.jsonl`),
        path.join(tempDir, `path-${placement}`),
      );
      const localToolEnv = { PATH: ["/fixture/tools", "/fixture/system"].join(path.delimiter) };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        preparedEnvironment: () => ({
          credentialScrubEnv: {},
          localIdentityEnv: {},
          managedLocalIdentity: false,
          ...(placement === "unconfigured-local" ? {} : { localToolEnv }),
        }),
      };
      if (placement === "sandbox") {
        params.sandbox = createSandboxContext({});
      }
      const connection = await prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          pluginConfig: {
            appServer:
              placement === "websocket"
                ? { transport: "websocket", url: "ws://127.0.0.1:19400" }
                : placement === "unix"
                  ? { transport: "unix", homeScope: "user", url: "unix:///fixture/native.sock" }
                  : {
                      transport: "stdio",
                      ...(placement === "remote-root"
                        ? { remoteWorkspaceRoot: "/remote/workspace" }
                        : {}),
                      ...(placement === "proxy"
                        ? { args: ["app-server", "proxy", "--sock", "/fixture/native.sock"] }
                        : {}),
                    },
          },
        },
      });
      try {
        const expected = placement === "local" ? localToolEnv : undefined;
        expect(connection.shellEnvironment).toEqual(expected);
        expect(connection.appServer.start.env?.PATH).toBe(expected?.PATH);
        expect(connection.disableLoginShell).toBe(placement === "local");
        const refreshed = await connection.resolveRuntimeOptionsForCurrentBinding({
          modelProvider: "openai",
          model: params.modelId,
        });
        expect(refreshed.start.env?.PATH).toBe(expected?.PATH);
        if (expected) {
          expect(codexAppServerStartOptionsKey(refreshed.start)).not.toBe(
            codexAppServerStartOptionsKey({
              ...refreshed.start,
              env: { ...refreshed.start.env, PATH: "/fixture/old" },
            }),
          );
        }
      } finally {
        connection.cancellation.dispose();
        connection.releaseModelExecution();
      }
    },
  );
});
