# DeepSeek Harness 接入（v0.5 §16.5）

本目录记录**实际**接入 DSH 的方式、锁定版本和验证结果。方案文档要求不在实现里猜测
插件 API，所以这里只写已经在本机核实过的事实。

## 1. 锁定的运行环境

| 项 | 实测值 | 怎么得到的 |
|---|---|---|
| 桌面版 | `0.2.0-rc.2` | `resources/runtime/primary-runtime/runtime.json` 的 `desktopVersion` |
| Electron 版本 | `44.0.0` | 安装目录 `version` 文件 |
| 内置 Node | `24.21.0`（`runtime.json`）；`node -v` 经 Electron 报 `v24.18.1` | 两处都记录，避免混用 |
| 随附 pnpm | `11.7.0` | `runtime/versions.json` |
| DSH 包版本 | `0.1.5-rc.3` | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-tools` 的 `package.json` |
| Cordis | `4.0.2` | `dsh-base` 的 peerDependency |
| 交互 Profile | `desktop` | 本会话 `DSH_PROFILE=desktop` |
| Profile 目录 | `%DSH_HOME%\profiles\desktop` | `DSH_PROFILE_DIR`（本机值不入库） |
| 业务仓库 | 本仓库（检出路径本机相关，不入库） | 本操作包的首个真实项目 |
| 模型 provider / 模型 | `deepseek-official` / `deepseek-flash` | `profiles/desktop/cordis.patch.yml` 的 `agent-default-model` |

模型密钥走 DSH 已有的凭据渠道，**没有**写进 Contract、Skill 或本文件。

## 2. 插件契约（已核实）

从已安装的第三方插件 `dsh-codex-plus` 与 DSH 自身包中核实的契约：

```js
// lib/index.js
export const name = 'delivery-assured'
export const inject = ['tools', 'shell', 'skills']
export function apply(ctx, config) { /* ... */ }
export default { name, inject, apply }
```

- 插件包必须在 `package.json` 里声明 `dsh.bundle.patch`，指向一个 `cordis.patch.yml`。
- patch 文件用 `- insert: [{ id, name }]` 把自己插进 profile 的层栈。
- Profile 的 `package.json` 的 `dsh.profile.bundles` 决定装载顺序；插件同时要作为
  依赖安装到 profile 目录（`link:` 可以就地迭代）。
- 工具注册走 `ctx.tools.register(defineTool({...}))`。
- 命令执行走 `ctx.shell.resolve({ command, workdir, timeoutMs, env })` + `ctx.shell.run(spec)`。
- Skill 运行期注册走 `ctx.skills.register({ name, description, whenToUse, content })`。

### 两个会让插件整树加载失败的坑（都已在真实宿主里撞到并修好）

1. **输出 schema 必须落在 DSH 强制子集内。** `{ type: 'json' }` 不在
   `SCHEMA_TYPES`（object/array/string/number/integer/boolean/null）里，注册时抛
   `JsonSchemaError`，整个 profile 起不来。改用注解式 `{ type: 'object' }`。
2. **Skill 正文的字段名是 `content`。** `validateRuntimeSkill` 只校验 `name`、
   `description`、`invocation`，所以传错键名不会报错，而是注册一个加载不到内容的
   空 Skill。已加测试断言 `content` 非空。

## 3. Skill 的两条接入通路

方案文档默认项目级 `.dsh/skills/<name>/SKILL.md`。本机实测**该通路当前不可用**：

| 入口 | 本机状态 | 结论 |
|---|---|---|
| 项目级 `.dsh/skills`（`dsh-skill-filesystem`） | **disabled** | 放入仓库不会被发现 |
| 用户级 `~/.dsh/skills`（同上，rank 400） | **disabled** | 同上 |
| `ctx.skills.register()` 运行期注册（`dsh-skill`） | **active** | 采用这条 |

所以插件自带 Skill，并在 `delivery-verify` profile 里验证注册成功。同时仍保留
`integrations/deepseek-harness/delivery-assured/SKILL.md` 作为项目级模板——将来
`dsh-skill-filesystem` 被启用时，把它复制到业务仓库 `.dsh/skills/` 即可，正文不需要改。

### 运行期注册已用真实注册表核验

`ctx.skills.register()` 只校验 `name`、`description`、`invocation`。正文缺失要等到
**被加载时**才由 `validateDefinition` 以 `content must be a string` 拒绝——所以“注册成功”
不等于“能加载”。`plugins/dsh-delivery-assured/test/skill-registry.test.mjs` 用真实
`SkillRegistry` 驱动插件自身的 `apply`，再把 Skill 读回来：

```powershell
node plugins/dsh-delivery-assured/test/skill-registry.test.mjs
# 真实注册表：get() 返回 name/provider=runtime/正文长度>500，且无注册告警
# 负向对照：缺正文的定义在同一路径上被拒绝
```

该测试需要 DSH 侧包，所以按 `$DSH_HOME/profiles/node_modules` → 当前目录 → 插件目录
依次解析；全部失败时**退出码 2 而不是跳过**——跳过会让一个坏 Skill 静默出厂。

## 4. 安装与激活验证（实际做过）

```powershell
# 安装（desktop profile）；<repo> 是本仓库的检出路径
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "link:<repo>/plugins/dsh-delivery-assured"
# 并把 "dsh-delivery-assured" 加进 package.json 的 dsh.profile.bundles

# 验证 1：插件在 profile 内可加载
node --input-type=module -e "await import('dsh-delivery-assured')"   # 从 profile 目录执行

# 验证 2：bundle 真的参与 profile 组合
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" `
     --profile delivery-verify --dump-config
#   → 输出里出现 `- id: delivery-assured  name: dsh-delivery-assured` 及其 config
```

`desktop` profile 由 Electron 应用独占，CLI 拒绝加载（
`profile "desktop" is managed exclusively by the Electron application`）。
因此另建 `~/.dsh/profiles/delivery-verify`：只挂 `@deepseek-ai/dsh-base` +
`dsh-delivery-assured`，配置指向同一份 pack 与 project。**它挂载的是同一个插件包**，
所以在这个 profile 里组合成功，等于插件包本身可用。

## 5. 会话工作方式（写进 Skill，会话按它执行）

1. 会话开始或恢复时先加载 `delivery-assured` Skill，读 `AGENTS.md`。
2. 第一件事是 `delivery_resume`：拿到可信起点、还欠什么、最后失败、剩余预算、下一项验证。
3. 规划前 `delivery_gaps --phase contract`；验收写完后 `--phase acceptance`；
   进入验证前 `--phase slice`。
4. 用 `delivery_coverage --view mvp` 判断产品是否闭合，用 `--view slice` 判断本切片。
5. 本地验证用 `delivery_verify_local`；它永远只是诊断。
6. 卡住时用 `delivery_attempts` 判断该 Retry、Replan 还是 Block。

## 6. 直接调用脚本，保留外部判定

实现会话也可以直接跑脚本，两条路径共用 `scripts/lib` 的同一套事实计算：

```powershell
node packages/delivery-assured/scripts/check-gaps.mjs --phase contract
node packages/delivery-assured/scripts/coverage.mjs --view mvp
node packages/delivery-assured/scripts/resume.mjs
node packages/delivery-assured/scripts/attempts.mjs
node packages/delivery-assured/scripts/verify.mjs --local --slice S1
```

DSH 会话结束、插件工具返回、模型回复“完成”，**都不等于** Baseline 晋升。

## 7. 接入完成标准（据实核对）

| 标准 | 状态 |
|---|---|
| 从真实 DSH 宿主加载插件、工具与 Skill 注册成功 | 已达成（bundle 组合 + 插件激活；`--dump-config` 通过；Skill 经真实注册表读回） |
| 调用真实脚本 | 已达成（插件自测 50 项 + 注册表测试 13 项，驱动真实脚本、真实 shell） |
| 执行一条实际项目 Slice | 已达成（S1：8 条验收用例、6 个门本地全绿） |
| 取得 CI Evidence 与受保护 Baseline | **未达成**：无远端仓库与 CI 权限，列为阻塞 |
| 新会话恢复相同未完成项与预算 | 已达成（`resume` 输出未完成项与预算；换会话重算，不依赖记忆） |
| 「重启后仍可用」 | 部分达成：配置与链接已持久化到 profile 磁盘，且新宿主进程能组合并加载该插件；但**未对正在运行的 Electron 应用做一次真实重启**再复查其工具列表 |

缺一项就如实标记“接入未完成”，不用演示输出替代。第 4 行的缺口写在
`project/.agent/STATE.yaml` 的 `blockers` 里。
