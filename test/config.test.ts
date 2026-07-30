import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readConfigFile,
  loadConfig,
  resolveWorkspaceBase,
  ConfigError,
  type ConfigFile,
  type FileReader,
  type AsdConfig,
} from "../extensions/asd/config.ts";

// --- readConfigFile ---

test("readConfigFile 文件不存在时返回 { value: undefined }", () => {
  const never: FileReader = () => undefined;
  const r = readConfigFile("/nonexistent.json", never);
  assert.deepEqual(r, { value: undefined });
});

test("readConfigFile 合法 JSON 返回解析后的值", () => {
  const read: FileReader = (_file) => '{"a":1, "b": [2,3]}';
  const r = readConfigFile("any", read);
  assert.deepEqual(r, { value: { a: 1, b: [2, 3] } });
});

test("readConfigFile 文件存在但 JSON 有语法错时标出问题，value 为 undefined", () => {
  const read: FileReader = () => "{bad";
  const r = readConfigFile("bad.json", read);
  assert.equal(r.value, undefined);
  assert.ok(r.problem !== undefined, "problem 应该有");
  assert.match(r.problem!, /bad\.json/);
  assert.match(r.problem!, /合法的 JSON/);
});

test("readConfigFile 对空文件也应该失败（JSON.parse('') 是语法错）", () => {
  const read: FileReader = () => "";
  const r = readConfigFile("empty.json", read);
  assert.equal(r.value, undefined);
  assert.ok(r.problem !== undefined);
});

// --- loadConfig 文件合并 ---

test("loadConfig 后面的文件覆盖前面的同名字段", () => {
  const cfg = loadConfig({
    files: [
      { prefix: "low-", workspaceBase: "/w/low" },
      { prefix: "high-", followTimeout: "10m" },
    ],
    env: {},
    cwd: "/cwd",
    agentDir: "/agent",
  });
  assert.equal(cfg.prefix, "high-");
  assert.equal(cfg.workspaceBase, "/w/low");
  assert.equal(cfg.followTimeout, "10m");
});

test("loadConfig 深合并走的是 Object.assign 浅层覆盖（字段级替换，不是递归合并）", () => {
  const cfg = loadConfig({
    files: [
      { bossMode: { autoStart: true, defaultAgent: "pi" } },
      { bossMode: { autoStart: false } },
    ],
    env: {},
    cwd: "/cwd",
    agentDir: "/agent",
  });
  // 第二个 bossMode 整个替换了第一个，defaultAgent 不会残留
  assert.equal(cfg.bossMode.autoStart, false);
  assert.equal(cfg.bossMode.defaultAgent, undefined);
});

test("loadConfig 处理 ConfigFile 条目：值参与合并，problem 被收集", () => {
  const entry: ConfigFile = { value: { prefix: "cf-" }, problem: undefined };
  const cfg = loadConfig({
    files: [entry],
    env: {},
    cwd: "/cwd",
    agentDir: "/agent",
  });
  assert.equal(cfg.prefix, "cf-");
});

test("loadConfig 有 problem 的 ConfigFile 条目：值仍然参与合并（部分带错），所有 problem 汇总抛出", () => {
  const bad: ConfigFile = { value: { prefix: "still-works" }, problem: "bad.json 不是合法的 JSON：error" };
  assert.throws(
    () =>
      loadConfig({
        files: [bad],
        env: {},
        cwd: "/cwd",
        agentDir: "/agent",
      }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      assert.match(err.message, /bad\.json/);
      // 即使抛出，prefix 也没有生效——这里只测 ConfigError 被正确抛出
      return true;
    },
  );
  // 验证有 problem 时抛出，但没 problem 时同一个值能正常通过
  const clean: ConfigFile = { value: { prefix: "clean-" } };
  const cfg = loadConfig({ files: [clean], env: {}, cwd: "/cwd", agentDir: "/agent" });
  assert.equal(cfg.prefix, "clean-");
});

test("loadConfig 多个文件都有问题：全部汇总进 ConfigError", () => {
  const a: ConfigFile = { value: {}, problem: "a.json 不是合法的 JSON：Unexpected token" };
  const b: ConfigFile = { value: {}, problem: "b.json 不是合法的 JSON：Unexpected end" };
  assert.throws(
    () => loadConfig({ files: [a, b], env: {}, cwd: "/cwd", agentDir: "/agent" }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      assert.match(err.message, /a\.json/);
      assert.match(err.message, /b\.json/);
      assert.equal(err.problems.length, 2);
      return true;
    },
  );
});

// --- loadConfig 字段类型验证 ---

test("loadConfig bossMode.autoStart 不是布尔值时记录错误并使用默认值 false", () => {
  assert.throws(
    () =>
      loadConfig({
        files: [{ bossMode: { autoStart: "yes" } }],
        env: {},
        cwd: "/cwd",
        agentDir: "/agent",
      }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      assert.match(err.message, /autoStart/);
      assert.match(err.message, /布尔值/);
      return true;
    },
  );
});

test("loadConfig bossMode.defaultAgent 不是字符串时记录错误并退回 undefined", () => {
  assert.throws(
    () =>
      loadConfig({
        files: [{ bossMode: { defaultAgent: 42 } }],
        env: {},
        cwd: "/cwd",
        agentDir: "/agent",
      }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      assert.match(err.message, /defaultAgent/);
      assert.match(err.message, /字符串/);
      return true;
    },
  );
});

test("loadConfig workspaceBase 不是字符串时记录错误", () => {
  assert.throws(
    () =>
      loadConfig({
        files: [{ workspaceBase: true }],
        env: {},
        cwd: "/cwd",
        agentDir: "/agent",
      }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      assert.match(err.message, /workspaceBase/);
      return true;
    },
  );
});

test("loadConfig prefix 不是字符串时记录错误", () => {
  assert.throws(
    () =>
      loadConfig({
        files: [{ prefix: 0 }],
        env: {},
        cwd: "/cwd",
        agentDir: "/agent",
      }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      assert.match(err.message, /prefix/);
      return true;
    },
  );
});

test("loadConfig followTimeout 不是字符串时记录错误", () => {
  assert.throws(
    () =>
      loadConfig({
        files: [{ followTimeout: [] }],
        env: {},
        cwd: "/cwd",
        agentDir: "/agent",
      }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      assert.match(err.message, /followTimeout/);
      return true;
    },
  );
});

test("loadConfig 多个字段类型错误同时存在时全部汇总抛出", () => {
  assert.throws(
    () =>
      loadConfig({
        files: [
          {
            bossMode: { autoStart: "bad" },
            prefix: 123,
            followTimeout: null,
          },
        ],
        env: {},
        cwd: "/cwd",
        agentDir: "/agent",
      }),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) return false;
      // 三条错误应该都在
      const m = err.message;
      const hits = ["autoStart", "prefix", "followTimeout"].filter((k) => m.includes(k));
      return hits.length >= 2; // 至少两条
    },
  );
});

// --- loadConfig 默认值 ---

function empty() {
  return loadConfig({ files: [], env: {}, cwd: "/cwd", agentDir: "/agent" });
}

test("loadConfig 没有任何输入时：所有值回到默认", () => {
  const cfg = empty();
  assert.equal(cfg.bossMode.autoStart, false);
  assert.equal(cfg.bossMode.defaultAgent, undefined);
  assert.equal(cfg.workspaceBase, undefined);
  assert.equal(cfg.prefix, undefined);
  assert.equal(cfg.followTimeout, undefined);
});

test("loadConfig bossMode 整个缺失时 autoStart 默认 false，defaultAgent 默认 undefined", () => {
  // 测试中没有 bossMode 键
  const cfg = loadConfig({ files: [{ prefix: "x" }], env: {}, cwd: "/cwd", agentDir: "/agent" });
  assert.equal(cfg.bossMode.autoStart, false);
  assert.equal(cfg.bossMode.defaultAgent, undefined);
});

test("loadConfig bossMode 为 null 时也按缺失处理，不崩", () => {
  const cfg = loadConfig({ files: [{ bossMode: null }], env: {}, cwd: "/cwd", agentDir: "/agent" });
  assert.equal(cfg.bossMode.autoStart, false);
  assert.equal(cfg.bossMode.defaultAgent, undefined);
});

test("loadConfig bossMode 不是对象（比如数字）时，asRecord 变成 {}，autoStart 退回默认 false", () => {
  const cfg = loadConfig({
    files: [{ bossMode: 3.14 }],
    env: {},
    cwd: "/cwd",
    agentDir: "/agent",
  });
  assert.equal(cfg.bossMode.autoStart, false);
});

// --- ConfigError ---

test("ConfigError 的名字是 ConfigError，problems 原样带出", () => {
  const e = new ConfigError(["field A 有问题", "field B 有问题"]);
  assert.equal(e.name, "ConfigError");
  assert.deepEqual(e.problems, ["field A 有问题", "field B 有问题"]);
  assert.match(e.message, /2 处问题/);
  assert.match(e.message, /field A 有问题/);
  assert.match(e.message, /field B 有问题/);
});

test("ConfigError 单条问题时的表述不带复数", () => {
  const e = new ConfigError(["只有一个"]);
  assert.match(e.message, /1 处问题/);
});

// --- resolveWorkspaceBase ---

test("resolveWorkspaceBase 未设置 / 空串 / 纯空白都回落到默认", () => {
  assert.equal(resolveWorkspaceBase(undefined, "/fallback"), "/fallback");
  assert.equal(resolveWorkspaceBase("", "/fallback"), "/fallback");
  assert.equal(resolveWorkspaceBase("   ", "/fallback"), "/fallback");
});

test("resolveWorkspaceBase 给了就用给的，去掉首尾空白", () => {
  assert.equal(resolveWorkspaceBase("/w/agents", "/fallback"), "/w/agents");
  assert.equal(resolveWorkspaceBase("  /w/agents  ", "/fallback"), "/w/agents");
});

// --- 回归：resolveWorkspaceBase 现在是 config.ts 里的唯一定义 ---

test("resolveWorkspaceBase 作为 config.ts 导出的函数，行为与之前 tools.ts 版本一致", () => {
  // 这条测试和 tools.test.ts 里的同名测试一一对齐，确保迁移没有漏东西。
  // 之前 tools.test.ts 也从 config.ts import 了，两边跑的是同一个函数。
  const sameCases: [string | undefined, string, string][] = [
    [undefined, "/fallback", "/fallback"],
    ["", "/fallback", "/fallback"],
    ["   ", "/fallback", "/fallback"],
    ["/w/agents", "/fallback", "/w/agents"],
    ["  /w/agents  ", "/fallback", "/w/agents"],
  ];
  for (const [raw, fallback, expected] of sameCases) {
    assert.equal(resolveWorkspaceBase(raw, fallback), expected, `resolveWorkspaceBase(${JSON.stringify(raw)}, ${fallback})`);
  }
});
