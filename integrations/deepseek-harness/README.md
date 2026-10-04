# DeepSeek Harness 接入（v0.5 §16.5）

本目录保留既有 DSH 接入记录和本地复核方法；下文宿主版本、profile 激活与重启信息属于历史记录，本轮未访问用户 profile，也未重新核实它们。当前开发未取得真实 CI Evidence、受保护 Baseline 晋升或真实部署证据；测试通过非完成。已有 origin/main 与 origin/standards/acceptance 本地跟踪引用，远端权限与保护是否生效未核实，不应写成“无远端仓库”。

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
- shell 接口随宿主版本变化：历史 0.1.5 线使用 `resolve()` + `run()`；0.2.x 的 `execute().result()` seam 以插件实现与 compatibility 测试为准，不沿用旧调用声明。
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

## 4. 安装与激活验证（历史记录，本轮未复核）

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

从仓库根目录先进入 project/ 再运行业务脚本；根目录不是业务输入根。项目 Kernel 位于 [project/AGENTS.md](../../project/AGENTS.md)，指向真实 .agent 声明来源，不预填已晋升 Baseline。实现会话和插件共用 scripts/lib 的同一套事实计算：

```powershell
Set-Location project
node ../packages/delivery-assured/scripts/check-gaps.mjs --phase contract
node ../packages/delivery-assured/scripts/coverage.mjs --view mvp
node ../packages/delivery-assured/scripts/resume.mjs --offline
node ../packages/delivery-assured/scripts/attempts.mjs
node ../packages/delivery-assured/scripts/verify.mjs --local --slice S1
```

`--offline` 明确不读远端；本轮仅本地诊断，远端权限仍待核实。根目录可运行 `node --test packages/delivery-assured/tests/templates.test.mjs`，这是模板 unit 测试，不是产品验收。

DSH 会话结束、插件工具返回、模型回复“完成”，**都不等于** Baseline 晋升。

## 7. 接入完成标准与当前开发状态

| 标准 | 当前证据边界 |
|---|---|
| 真实 DSH 宿主加载插件、工具与 Skill | 上文是历史接入记录；本轮未访问 profile，当前激活状态待复核 |
| 调用真实脚本 | 可按第 6 节本地复核；最新测试计数未在此宣称已验证 |
| 执行实际项目 Slice | S1 仍是候选/本地诊断；本地门与验收通过不等于 VERIFIED_DONE |
| 取得真实 CI Evidence 与受保护 Baseline | 未取得；origin/main 与 origin/standards/acceptance 本地引用存在，远端权限、保护及 CI 生效情况未核实 |
| 新会话恢复未完成项与预算 | 使用 project/ 下 resume --offline 重算；STATE 仅为线索，不能证明完成 |
| 真实部署、最终 Journey Review 与重启后可用 | 尚未取得当前版本真实部署证据；Electron 重启与实际会话调用仍待复核 |

接入未完成。本地引用、模拟晋升和测试通过均不替代真实 CI/Baseline/部署证据。[STATE 摘要](../../project/.agent/STATE.yaml) 中“无远端仓库”、历史计数与“全绿”等文字可能过期，本轮未编辑该文件；以本地引用检查、离线重算及将来的真实权威记录为准。
