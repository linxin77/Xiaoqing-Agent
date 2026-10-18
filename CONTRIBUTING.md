# 参与开发

欢迎报告问题、讨论用例和提交修复。建议先用最小角色卡复现，再改状态机；角色性格判断继续交给模型，不加入“傲娇值”等固定心理数值。

## 检查

Node.js 20 或更新版本即可运行无外部依赖的检查：

```sh
node scripts/check.mjs
node --test tests/*.test.js
```

可选浏览器验证：安装 Playwright 1.62.1，然后运行 `node scripts/browser-smoke.mjs`。Windows 默认使用本机 Edge；其他平台需先运行 `npx playwright install chromium`。它只打开独立模拟夹具，不连接实际酒馆或模型。

```sh
npm install --no-save --ignore-scripts --package-lock=false playwright@1.62.1
npx playwright install chromium
node scripts/browser-smoke.mjs
```

## 修改原则

- 用户新消息、编辑、切换、暂停与关闭权限，必须使迟到结果失效。
- 不把模型计划当作已经发生的动作；事实来自实际聊天。
- 输出额度与请求额度分别计数，空 WAIT 不占输出额度。
- 世界时间与现实调度时间分离，不通过改写原始聊天时间来冻结世界。
- 跨标签页和刷新不能重复领取额度；异常时保守停止。
- 模型文字不插入设置 HTML、不作为命令执行、不写入未脱敏日志。

新增测试应覆盖用户可观察的行为或实际失效路径。PR 请说明问题、最终行为和验证结果。

不提交密钥、聊天数据库、个人角色卡、实际模型报告、浏览器个人资料或个人文件路径。第三方代码或素材需保留许可证和来源；不要把他人的角色卡默认为本项目 MIT 授权。
