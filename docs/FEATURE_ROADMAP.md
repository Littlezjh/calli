# Limi — 功能对标与补齐计划

> 基于 pi-web、Codex 的功能对标分析，列出当前缺失的必备功能及实施方案。

---

## 1. 对标项目分析

### 1.1 pi-web（参考：[jmfederico/pi-web](https://github.com/jmfederico/pi-web)）

**必备功能：**

| 功能 | pi-web 实现 | remote-agent-hub 现状 | 优先级 |
|---|---|---|---|
| **文件管理** | 文件浏览器、拖拽上传、项目文件树 | ❌ 无 | P1 |
| **Session 管理** | 按项目分组、resume、rename、export、delete | ✅ 部分（无UI） | P1 |
| **工作目录选择** | 列表选择 | ✅ 有（简单列表） | P2 |
| **子目录导航** | 可浏览目录树 | ❌ 无，只能选预配置目录 | P1 |
| **对话分支** | Session 内分支、Fork 到新 Session | ❌ 无 | P2 |
| **文件差异展示** | Diff 卡片 | ✅ 有（基础） | P1 增强 |
| **Chat 上传** | 拖拽文件到聊天 | ❌ 无 | P1 |
| **Session 搜索** | 按名称、日期搜索 | ⚠️ 占位符，待实现 | P2 |

### 1.2 Codex / Claude Code（参考：[Codex-CLI-UI](https://github.com/cruzyjapan/Codex-CLI-UI)）

**关键特性：**

| 功能 | Codex 实现 | remote-agent-hub 现状 | 优先级 |
|---|---|---|---|
| **Session 持久化** | 自动保存、唯一 session ID | ✅ 有（SQLite） | ✅ 完成 |
| **分组展示** | 按项目分组、置顶、标签 | ❌ 仅项目分组，无置顶/标签 | P1 |
| **Session 元数据** | 标题、上次修改、agent、context 用量、运行状态 | ✅ 部分（无 context 用量） | P2 |
| **Session 导出** | 导出会话日志、文件状态 | ❌ 无 | P3 |
| **实时搜索** | 全文搜索线程内容 | ❌ 无 | P3 |
| **侧边文件树** | 实时显示工作目录结构 | ❌ 无 | P2 |
| **行内编辑反馈** | 显示修改行数、新增文件 | ✅ 基础展示 | P2 增强 |

---

## 2. 当前缺失的必备功能（P1-P2）

### 2.1 文件与目录管理（P1 - 关键）

**问题描述**
- 不能传文件到 agent
- 不能选择目录下的子目录（只能选预配置的顶级目录）
- 工作目录结构不可见

**补齐方案**

| 功能模块 | 后端需求 | 前端需求 | 工作量 |
|---------|---------|---------|------|
| **文件上传** | API: `POST /api/upload` 处理多文件、保存到 cwd | 上传 UI、拖拽区、进度提示 | 中 |
| **目录树浏览** | API: `GET /api/directory?path=...` 返回目录结构、文件列表 | 可折叠的树形结构、当前路径面包屑 | 中 |
| **子目录选择** | 允许用户选择树中任意目录作为 cwd | 单选、确认流程 | 小 |
| **Chat 拖拽上传** | 集成上传 API、与 agent 集成 | Composer 拖拽区、上传后自动插入文件引用 | 中 |

**后端 API 设计**

```ts
// 列出目录内容
GET /api/directories?path=/path/to/dir
Response: {
  path: string;
  files: Array<{ name: string; type: 'file' | 'dir'; size: number; modified: string }>;
  parent: string | null; // 父目录路径，如果有的话
}

// 上传文件到工作目录
POST /api/threads/{id}/upload
Body: multipart/form-data（file, targetPath）
Response: { success: boolean; files: string[] }

// 获取工作目录文件树（递归）
GET /api/directory-tree?root=/path&maxDepth=3
Response: {
  name: string;
  path: string;
  type: 'dir';
  children?: Array<...>;
}
```

---

### 2.2 Session 管理 UI（P1 - 核心）

**问题描述**
- Session 列表缺少置顶、标签、搜索
- 无法重命名 Session
- 无 Session 元数据展示（修改时间、context 用量等）

**补齐方案**

| 功能 | 实现 | 优先级 |
|-----|-----|------|
| **Thread 置顶** | 后端存 `pinned` 字段；前端按 pinned desc 排序展示 | P1 |
| **Thread 重命名** | API: `PATCH /api/threads/{id}` `{ title: string }` | P1 |
| **快速操作菜单** | 右键或长按显示：置顶、重命名、导出、删除 | P1 |
| **Thread 元数据卡** | 展示：agent、cwd、创建时间、最后更新时间、消息数、token 用量 | P2 |
| **搜索框** | 按 title、cwd 的模糊搜索；实现见 Sidebar.tsx | P2 |

**数据库扩展**

```sql
-- threads 表新增字段
ALTER TABLE threads ADD COLUMN pinned BOOLEAN DEFAULT 0;
ALTER TABLE threads ADD COLUMN tags TEXT;  -- JSON: ["tag1", "tag2"]
ALTER TABLE threads ADD COLUMN token_usage INTEGER DEFAULT 0;

-- 创建索引以加速排序
CREATE INDEX idx_threads_pinned_updated ON threads(pinned DESC, updatedAt DESC);
```

---

### 2.3 子目录导航与选择（P1 - 依赖文件树）

**问题描述**
- 新建 Thread 时，只能选择 `RAH_WORKDIRS` 中配置的顶级目录
- 不能选择 `/projects/foo/src` 这样的子目录

**补齐方案**

**变更 App.tsx 的目录选择逻辑**

```tsx
// 当前（简单列表）
<select value={draftCwd}>
  {workdirs.map(w => <option>{w}</option>)}
</select>

// 补齐后（目录树 + 搜索）
<DirectoryPicker
  roots={workdirs}
  selected={draftCwd}
  onChange={setDraftCwd}
  onBrowse={onBrowseDirectory}  // 打开目录树弹窗
/>
```

**新增 DirectoryPicker 组件**
- 点击打开弹窗
- 展示目录树（可折叠）
- 搜索框快速定位
- 确认选择

---

## 3. 增强功能（P2-P3）

### 3.1 Session 分支与 Fork

**api.ts 新增**

```ts
// Fork 线程（从某一消息点分出新线程）
forkThread(id: string, fromTurnId?: string): Promise<Thread>

// 在线程内创建分支（支持的 agent：Claude via ACP）
branchThread(id: string, fromTurnId: string): Promise<void>
```

**Adapter 能力检查**
- Claude (ACP)：支持 `forkThread` 和 `branchThread`
- pi (RPC)：确认后补充

### 3.2 文件差异增强

**当前展示**
- 简单的文件清单 + 增删行数

**增强**
- Diff 面板：展示上一轮改动的具体 patch（见 PLAN.md P3）
- 行内评论：在 diff 上批注

**后端**
```ts
// Diff 详情
GET /api/threads/{id}/events?type=diff&turnId=...
Response: Array<{
  path: string;
  patch: string;  // unified diff format
  added: number;
  deleted: number;
  mode?: 'added' | 'deleted' | 'modified';
}>
```

---

### 3.3 Session 导出与备份

**导出格式**
- Markdown：完整对话记录 + 文件改动摘要
- JSON：事件序列、元数据、批注
- ZIP：包含导出的 Markdown + 修改过的文件快照

**API**
```ts
GET /api/threads/{id}/export?format=markdown|json|zip
```

---

## 4. Codex 集成（P4）

**当前状态**
- PLAN.md 中计划为 P4
- 需确认 Codex 的原生 app-server 接口

**补齐清单**
1. `CodexAppServerAdapter` 实现（packages/daemon/src/adapters/codex.ts）
2. Codex 特有功能映射：
   - Session ID 对齐
   - Task list 展示
   - 分区（workspace、terminal）支持

---

## 5. 实施优先级与阶段划分

### P1（关键路径）- 2-3 周
- ✅ 文件上传（拖拽、Chat 上传）
- ✅ 目录树浏览与子目录选择
- ✅ Thread 置顶、重命名、快速菜单
- ✅ Session 元数据基础展示

### P2（核心功能） - 2-3 周
- ✅ Session 搜索
- ✅ Session 分支 / Fork（如果 agent 支持）
- ✅ Diff 面板增强
- ✅ 侧边文件树（实时同步）

### P3（交互增强） - 1-2 周
- ✅ Session 导出
- ✅ 批注展示与管理
- ✅ 快捷键优化

### P4（新 Agent 支持） - TBD
- ✅ Codex app-server 适配
- ✅ 分区、置顶等 Codex 特定功能

---

## 6. 开发清单

### 后端（daemon）

- [ ] 文件 API：`GET /api/directories`、`POST /api/threads/{id}/upload`
- [ ] Directory tree API：`GET /api/directory-tree`
- [ ] Thread 更新 API：`PATCH /api/threads/{id}` （支持 title、pinned）
- [ ] DB 迁移：添加 `pinned`、`tags`、`token_usage` 字段
- [ ] 搜索逻辑：模糊匹配 title、cwd
- [ ] Fork / Branch 支持（如果 adapter 支持）

### 前端（web）

- [ ] `DirectoryPicker` 组件：树形结构、搜索、确认
- [ ] `FileUpload` 组件：拖拽上传、进度、错误处理
- [ ] 增强 `Sidebar`：置顶、快速菜单、搜索框
- [ ] Thread 元数据卡片：显示 agent、cwd、时间、token 用量
- [ ] `DiffPanel` 增强：patch 展示、行内注释
- [ ] 侧边文件树（可选：P2）

### 测试

- [ ] 文件上传测试（单/多文件、大小限制）
- [ ] 目录树递归测试（深度、权限、循环链接）
- [ ] 搜索性能测试（大量 thread）
- [ ] DB 迁移测试（数据兼容性）

---

## 7. 技术债与注意事项

1. **文件权限**：上传的文件需遵守 `RAH_WORKDIRS` 白名单，不能上传到工作目录外。
2. **符号链接处理**：列出目录树时需检测符号链接，避免无限递归。
3. **大文件处理**：上传文件大小需限制（建议 100MB），分块上传待 P3。
4. **性能**：目录树递归可能较慢，考虑限制深度（如 maxDepth=5）或添加缓存。
5. **安全**：路径验证需加强，使用 `path.resolve()` 和白名单验证避免目录遍历攻击。

---

## 8. 文档与示例

**后续需补充**
- [ ] API 文档：所有新增端点的请求/响应示例
- [ ] 前端组件文档：DirectoryPicker、FileUpload 的 props 和使用示例
- [ ] 用户指南：如何上传文件、选择工作目录、管理 Session

---

## 参考

- [pi-web](https://github.com/jmfederico/pi-web) - 文件管理、Session 管理参考
- [Codex-CLI-UI](https://github.com/cruzyjapan/Codex-CLI-UI) - 分组、置顶、导出参考
- [PLAN.md](./PLAN.md) - 项目整体阶段划分
