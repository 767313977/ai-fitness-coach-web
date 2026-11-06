# AI 私人教练 · Web 版（静态镜像）

这是私有仓库 `ai-fitness-coach` 里 `web/` 目录的公开静态镜像，只包含前端代码，**不含任何真实健康数据**。

- 演示模式是**虚构人物**（70 kg / 172 cm / 28 岁 / 右肩旧伤），不是账号主人；
- 打开后是登录页，需要 Fine-grained PAT（`Contents: Read and write` + `Actions: Read and write`，只授权私有数据仓库）才能读取真实数据；
- 数据全程在浏览器和 `api.github.com` 之间直连，本仓库和托管方都看不到。

源码以私有仓库为准；更新方式：把 `web/` 的改动同步到本仓库根目录后推送。
