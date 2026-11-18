# 内置管家素材

`dafeiyu-0843238.tar.gz` 随仓库、安装目录和服务快照分发，使用普通 Git 文件保存。首次召唤从本地解压到 Calli 的 `pets/dafeiyu/` 缓存，不请求 GitHub，不需要代理或额外资源服务器。开发运行与构建后的 daemon 都按模块位置寻找本目录，不依赖启动时的工作目录。

- 来源：[QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu/tree/084323845ab82b68d5388d5c638bec09d8544a8a/assets/pet)。
- 许可证：MIT，Copyright (c) 2026 PC2005-cloud，全文见本目录的 `LICENSE.txt`，包内也保留一份。
- 内容：`idle`、`thinking`、`success`、`poke`、`head_pat`、`idle_yawn` 六段动作，每段保留原始奇数编号帧，共 726 张 WebP；包内附 `SOURCE` 来源说明。
- 压缩包约 11.24 MiB。打包只保留素材与许可证，去除机器路径、文件所有者与时间戳。

更新时从固定的上游提交收集上述动作的奇数帧，连同 `LICENSE.txt`、`SOURCE` 打包到 `dafeiyu/` 顶层目录，并同时更新 `src/pets.ts` 中的提交、压缩包路径及 SHA-256。安装时先校验完整压缩包，再解压到临时目录，最后写入版本标记并替换缓存。旧版本缓存会重新解压；同版本缓存继续复用。
