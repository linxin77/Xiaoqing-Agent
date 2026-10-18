# 来源与第三方组件

本仓库的扩展源码、提示词、固定测试夹具与文档由 Project 小晴项目编写，沿用根目录 MIT 许可证。不打包 SillyTavern 源码、模型权重或第三方角色卡。

- **SillyTavern**：通过其公开上下文、事件和生成接口集成。项目名称与界面术语用于说明兼容性，本扩展为非官方项目。接口核对见 `docs/API_RESEARCH.md`。
- **Playwright**：可选开发工具，本地验证使用 1.62.1；Apache-2.0。运行插件不需要它，源码包不包含其代码或浏览器二进制。来源：https://github.com/microsoft/playwright 。
- **GitHub Actions**：工作流引用官方 checkout 与 setup-node Action，不打包其实现。来源：https://github.com/actions/checkout 与 https://github.com/actions/setup-node 。

用户自行导入的角色卡、世界书、图片与实际聊天记录不自动获得本仓库的 MIT 授权。贡献者引入第三方内容时应另行注明来源和适用许可。
