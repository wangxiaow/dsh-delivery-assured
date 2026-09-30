# 贡献指南

这个仓库用它自己的规则开发——它是 Delivery-Assured Progressive SE 的首个真实项目，
`project/.agent/CONTRACT.yaml` 就是它的需求。所以最有用的贡献方式，是先理解那套约束。

## 提交之前

改动必须能通过它自己的门。从仓库根目录运行：

```bash
# 操作包自身的测试
node packages/delivery-assured/tests/yaml.test.mjs
node plugins/dsh-delivery-assured/test/smoke.mjs
node tools/build-gate-absent-plugin.test.mjs
node tools/local-promotion-drill.mjs

# 项目侧：结构检查 + 六个门
cd project
node ../packages/delivery-assured/scripts/check-gaps.mjs --phase contract
node ../packages/delivery-assured/scripts/check-gaps.mjs --phase acceptance
node ../packages/delivery-assured/scripts/verify.mjs --local --slice S1
```

需要 DSH 侧包时（`skill-registry.test.mjs`），先设置 `DSH_HOME` 指向含有
`profiles/node_modules/@deepseek-ai/*` 的 harness 家目录。缺包时该测试**返回 2 而不是跳过**。

## 硬性约束

这几条不是风格偏好，破坏它们会让整套机制失效：

1. **不删除 Required 义务。** Replan、恢复和重构都不能让 Contract 里的 Required 项消失。
2. **不降低断言。** 不加 `skip` / `only`，不放宽期望值，不把 `expect` 挪进 driver。
3. **不缩小验证集合。** CI 的执行集合由受保护标准与父 Baseline 的 Spine 生成，不能按需筛选。
4. **不改验收标准取得通过。** `tests/acceptance/spec/` 是受保护的；只有纯追加能走自动通路，
   修改、删除或降标需要 owner 明确确认。
5. **不把本地绿灯当凭证。** 任何文档、注释、提交信息都不得把本地运行说成已晋升的 Baseline。
6. **Critical 违规立即阻塞。** 越权、错误归属、数据损坏不得延期当普通技术债处理。

## 变更的三种走法

先回答三问：是否改变任一 Journey 的可观察结果？是否触碰 Critical 规则的主体/资源/操作？
是否改变 in-scope / out-of-scope？

| 结论 | 走法 |
|---|---|
| 三问皆否（HOW） | 直接改，在 `.agent/STATE.yaml` 的 `how_decisions` 记一行原因与影响 |
| 任一为是（WHAT） | 提交 Change Proposal，暂停受影响实现，等 owner 对具体差异确认；确认后更新 Contract、由独立会话调整验收、刷新 Coverage、全量复验 |
| 纯补强既定语义下的测试 | 走标准更新通路的纯追加规则，自动纳入，无需逐项审批 |

## 代码约定

- **零运行时依赖**是硬要求，不是偏好。YAML 解析、参数解析、摘要渲染都自己实现。
- 事实计算只有一处：`packages/delivery-assured/scripts/lib/`。
  CLI、脚本、插件都从那里取，禁止复制第二份解析逻辑。
- 退出码统一 `0` 通过 / `1` 发现阻塞 / `2` 输入或工具错误。
  **`1` 是成功的查询加阻塞的答案，不是工具故障** —— 调用方必须区分这两者。
- 每个脚本同时支持人读摘要与 `--json`，两者必须给出同一组事实。
- 注释解释「为什么」，不解释「做了什么」。判断类逻辑（如覆盖状态的优先级）
  必须在注释里说明为什么是这个顺序。

## 新增测试

- 纯新增的 spec 文件与 manifest 条目可自动纳入；改动既有 spec 一律需要确认。
- 新增行为断言时，请在 PR 描述里写清它映射到哪条义务、堵住哪条失败路径。
- 负向对照比正向断言更有价值：证明「检查真的会失败」通常比「检查通过」更能防止漏检。

## 提交信息

用陈述句说明改了什么以及为什么。如果这次改动修的是一个**被测试抓出来的真实缺陷**，
把那个缺陷写进提交信息——这个仓库的价值就来自这类记录。

## 报告问题

请说明：期望行为、实际行为、复现命令、以及该问题属于哪一类
（发现遗漏 / 标准遗漏 / 执行遗漏 / 回归 / 环境漂移）。
分类会决定它该修在 Elicitation、Acceptance、还是实现里——直接跳到改代码往往修错地方。
