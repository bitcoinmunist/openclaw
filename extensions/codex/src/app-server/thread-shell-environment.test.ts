import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { buildThreadStartParams, buildThreadResumeParams } from "./thread-lifecycle.js";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";

describe("Codex managed shell environment", () => {
  it.each([
    { action: "start" as const, inherit: "none" },
    { action: "resume" as const, inherit: "core" },
  ])(
    "applies the host environment last for thread/$action with inherit=$inherit",
    ({ action, inherit }) => {
      const options = {
        appServer: createAppServerOptions() as never,
        config: {
          allow_login_shell: true,
          shell_environment_policy: {
            inherit,
            experimental_use_profile: true,
            exclude: ["GIT_*"],
            set: { GH_CONFIG_DIR: "/user-selected", KEEP_ME: "yes", PATH: "/user-selected/bin" },
            include_only: ["PATH"],
          },
        },
        shellEnvironment: {
          PATH: "/host-tools:/usr/bin",
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
          OPENCLAW_STATE_DIR: "/fixture/diagnosed",
          OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
          OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
        },
        disableLoginShell: true,
      };
      const request =
        action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });

      const shellEnvironmentPolicy = request.config?.shell_environment_policy;
      if (!isJsonObject(shellEnvironmentPolicy)) {
        throw new Error("expected shell environment policy");
      }
      expect(shellEnvironmentPolicy).toMatchObject({
        inherit,
        experimental_use_profile: false,
        exclude: ["GIT_*"],
        set: {
          PATH: "/host-tools:/usr/bin",
          GH_CONFIG_DIR: "/host-selected",
          KEEP_ME: "yes",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
          OPENCLAW_STATE_DIR: "/fixture/diagnosed",
          OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
          OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
        },
      });
      expect(request.config?.allow_login_shell).toBe(false);
      const includeOnly = shellEnvironmentPolicy.include_only;
      expect(includeOnly).toHaveLength(8);
      expect(includeOnly).toEqual(
        expect.arrayContaining([
          "PATH",
          "GH_CONFIG_DIR",
          "GITHUB_TOKEN",
          "GH_TOKEN",
          "PREVIEW_SERVICE_TOKEN",
          "OPENCLAW_STATE_DIR",
          "OPENCLAW_CONFIG_PATH",
          "OPENCLAW_WORKSPACE_DIR",
        ]),
      );
      expect(shellEnvironmentPolicy.experimental_use_profile).toBe(false);
      expect(shellEnvironmentPolicy).not.toHaveProperty("use_profile");
    },
  );

  it.each(["start", "resume"] as const)(
    "disables login profiles only for protected thread/%s environments",
    (action) => {
      const build = (
        config: JsonObject,
        shellEnvironment?: Readonly<Record<string, string>>,
        disableLoginShell?: boolean,
      ) => {
        const options = {
          appServer: createAppServerOptions() as never,
          config,
          shellEnvironment,
          disableLoginShell,
        };
        return action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });
      };

      expect(build({ allow_login_shell: true }).config?.allow_login_shell).toBe(true);
      expect(build({}).config).not.toHaveProperty("allow_login_shell");
      expect(build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" }).config).not.toHaveProperty(
        "allow_login_shell",
      );
      expect(build({}, { GH_TOKEN: "", GITHUB_TOKEN: "" }, true).config?.allow_login_shell).toBe(
        false,
      );
    },
  );

  it.each(["start", "resume"] as const)(
    "admits host values through restrictive filters for thread/%s",
    (action) => {
      const options = {
        appServer: createAppServerOptions() as never,
        config: {
          allow_login_shell: false,
          shell_environment_policy: {
            experimental_use_profile: true,
            filters: { PATH: "include", "GIT_*": "exclude" },
            set: { KEEP_ME: "yes" },
          },
        },
        shellEnvironment: {
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
        },
        disableLoginShell: true,
      };
      const request =
        action === "start"
          ? buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              cwd: "/repo",
              dynamicTools: [],
            })
          : buildThreadResumeParams(createAttemptParams({ provider: "openai" }), {
              ...options,
              threadId: "thread-1",
            });

      expect(request.config?.shell_environment_policy).toMatchObject({
        experimental_use_profile: false,
        set: {
          KEEP_ME: "yes",
          GH_CONFIG_DIR: "/host-selected",
          GH_TOKEN: "",
          PREVIEW_SERVICE_TOKEN: "",
        },
        filters: {
          PATH: "include",
          "GIT_*": "exclude",
          GH_CONFIG_DIR: "include",
          GH_TOKEN: "include",
          PREVIEW_SERVICE_TOKEN: "include",
        },
      });
      expect(request.config?.shell_environment_policy).not.toHaveProperty("include_only");
    },
  );
});
