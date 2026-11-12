# 网页预览批注

参考 Persona 的元素批注进入会话、Agentation 的结构化采集：页面只负责选元素，Hub 负责保存与发送。批注与当前会话、预览地址绑定，不依赖 React 或具体 playground。

## 使用

打开 HTML 文件的预览，点「加注释」，再点页面元素、写评论、保存。可以先积累多条，再点「发送批注」。每批最多 20 条；超过时分批发送。会话忙时进入现有消息队列，界面显示排队回执。保存不等于发送，刷新预览不会丢失草稿。已发送批注保留用于查看，不能删除。

本地 HTML 通过隔离的预览端口打开，Hub 在响应里注入选取脚本，不改原文件。新标签页独立打开时不启用批注，批注操作留在 Hub 预览内。

开发服务器、临时 playground 可以共用这套工具：

1. 页面引入 `<script src="https://hub.example/api/preview-bridge.js"></script>`，把地址换为自己的 Hub。
2. 从 Hub 打开 `/#/thread/<线程 ID>?preview=<encodeURIComponent(页面完整 URL)>`。远程线程同时带已有的 `machine` 参数。
3. 页面与 Hub 必须不同源。浏览器必须能访问页面，页面需允许被 iframe 嵌入；HTTPS Hub 不能嵌入 HTTP 页面。无法接入脚本的第三方网页不支持元素批注。

可在元素上提供 `data-preview-id` 稳定定位。方案容器可带 `data-variant`，`html` 可带 `data-theme` 与 `data-preview-revision`。没有提供的字段保留为空；不推测源码文件或行号。重新渲染后可点「定位」，元素消失时明确提示找不到。没有稳定 ID 的定位依赖 DOM 结构，页面大改后应以捕获的文字和元素快照为准。

## 保存结构

```json
{
  "id": "Hub 生成的 UUID",
  "page": "预览地址或相对文件路径",
  "at": "捕获时间",
  "comment": "右侧共用一个点，离线空心优先",
  "target": {
    "selector": "#thread-status",
    "text": "devbox",
    "rect": { "x": 100, "y": 80, "width": 60, "height": 24 }
  },
  "context": {
    "title": "线程列表",
    "url": "https://preview.example/",
    "theme": "light",
    "variant": "one-slot",
    "revision": "v2",
    "viewport": { "width": 390, "height": 844 }
  },
  "receipt": null
}
```

SQLite 按线程和页面保存摘要；HTML 快照单独存储，列表不读取或传输。单条详情最多包含 6000 字符的 HTML。发送后的 `receipt` 是 `{turnId}` 或 `{queued: true, id}`，表示接受回执，不代表 Agent 已处理。排队遵循现有队列生命周期；取消队列不会撤销这份历史回执。

## Agent 收到什么

```text
[注释 1]
> 网页：design.html
> 元素：#thread-status
> 文字：devbox
> 外观：one-slot · light · 390×844
> 捕获：时间 · v2
> 详情：calli preview-note <批注 ID>
评论：右侧共用一个点，离线空心优先
```

摘要沿现有用户消息通道发送，不修改 Agent 的配置或会话文件。需要 HTML 快照时执行 `calli preview-note <ID>`，工具只允许读取已经提交到本会话的批注。

接口都需要 Hub 认证：

- `GET /api/threads/:id/preview-notes?page=...`：摘要列表。
- `POST /api/threads/:id/preview-notes`：保存草稿，输入为上面的 page/comment/target/context，target 可带 html。
- `GET /api/threads/:id/preview-notes/:noteId`：按需读取详情。
- `DELETE /api/threads/:id/preview-notes/:noteId`：删除未提交草稿。
- `POST /api/threads/:id/preview-notes/send`：提交 `{page, ids}`，同一组重复提交返回已有回执，不再新建消息。

选取脚本只有 `postMessage` 能力。预览外壳检查来源窗口、来源域和是否正在点选；页面不能直接发消息给 Agent。保存与发送由外壳里的用户操作触发。`/api/preview-bridge.js` 是无凭据、无用户数据的静态脚本。

## 验证记录

- `npm run typecheck`、`npm run build` 通过。
- 新增 API / CLI 测试通过：认证、跨会话拒绝、摘要与 HTML 分离、持久保存、失败保留、重试去重、忙时排队。
- 浏览器 `preview-notes`、`preview-reload`、`sidebar-merged-hosts` 共 7 项通过，覆盖桌面/手机、亮色/深色，以及外部 playground 接入和保存失败重试。
- 前端 484 项测试通过，其余工作区测试通过。daemon 全量 1346 项通过、1 项跳过、3 项模型网关测试失败；从 HEAD 导出的未修改代码上单独运行 `claude-gateway.test.ts`，同样 3 项失败。
- 发布使用 `scripts/restart.sh`，等待所有会话空闲后重启；部署后由用户验收。
