# Remote Agent Hub — 功能分析与补齐方案总结

**创建日期**：2026-10-10
**分析范围**：功能对标、缺失清单、实施优先级

---

## 执行总结

Remote Agent Hub 已完成 **P1（网关）和 P2（界面）基础阶段**，支持 Claude 和 pi 两个 agent，具备基本的线程管理和流式对话能力。

通过对标 **pi-web** 和 **Codex** 两个成熟项目，识别出 **3 大必备功能缺口** 和 **多个增强方向**，建议分 4 个阶段补齐，总工作量约 **4-6 周**。

---

## 一、当前现状

### 1.1 已完成的功能

| 功能域 | 状态 | 说明 |
|------|-----|-----|
| **网关基础** | ✅ | HTTP API、SSE 事件推送、Token 鉴权、SQLite 存储 |
| **Agent 适配** | ✅ | Claude (ACP)、pi (RPC) 两个 adapter |
| **线程管理** | ✅ | 创建、查询、删除、流式事件 |
| **UI 基础** | ✅ | 手机和桌面响应式布局、线程列表、对话页 |
| **流式对话** | ✅ | 实时消息流、时间线构建、折叠工具行 |
| **工作目录选择** | ✅ | 预配置目录列表下拉选 |

### 1.2 关键缺失功能

| 功能 | 优先级 | 影响范围 | 补齐工作量 |
|-----|------|-------|---------|
| **文件上传** | P1 | 用户工作流的基础能力 | 中 |
| **子目录导航** | P1 | 工作目录灵活性 | 中 |
| **Thread 置顶/重命名** | P1 | 线程管理体验 | 小 |
| **Session 搜索** | P2 | 大量 Thread 下的可用性 | 小 |
| **Diff 面板增强** | P2 | 代码变更可观看性 | 中 |
| **Session 导出** | P3 | 备份和知识沉淀 | 中 |
| **批注系统** | P3 | 高级对话流 | 大 |
| **Codex 适配器** | P4 | 新 Agent 支持 | 大 |

---

## 二、对标分析

### 2.1 pi-web 的核心能力（[参考](https://github.com/jmfederico/pi-web)）

**RAH 已有**
- ✅ 线程分组（按项目/cwd）
- ✅ 线程流式对话
- ✅ 工具行折叠
- ✅ 基础 Session 持久化

**RAH 缺失**
- ❌ **文件浏览与上传**：pi-web 的文件树浏览、拖拽上传是核心功能
- ❌ **Session 元数据展示**：修改时间、context 用量、token 消耗统计
- ❌ **快速操作菜单**：右键/长按的 rename、delete、export
- ❌ **Chat 区域拖拽上传**：直接向 Agent 投入文件
- ❌ **Session 分支**：从消息分出新的独立 Session

### 2.2 Codex 的设计特点

**RAH 已有**
- ✅ SSE 实时推送
- ✅ 工作目录概念
- ✅ Agent 多选（Claude、pi）

**RAH 缺失**
- ❌ **置顶与分组**：Codex 的"置顶"和"标签分组"对长期会话管理至关重要
- ❌ **实时文件树**：侧边栏显示当前 cwd 的文件结构（可选：P2）
- ❌ **行内编辑反馈**：显示某行被修改、新增还是删除
- ❌ **Session 快照导出**：Codex 支持导出会话上下文和文件状态

**RAH 新增**
- ✨ VPN + HTTP token（vs Codex 的本机 CLI）
- ✨ 多 agent 统一网关
- ✨ 批注系统（计划中）

---

## 三、补齐方案（按优先级）

### 阶段一：P1 关键路径（周 1-2）

**目标**：实现文件管理、Thread 置顶、子目录导航，使 RAH 可日常使用。

#### 1.1 文件上传与目录树

**问题**
- 无法上传文件给 Agent
- 只能选择预配置的顶级目录，不能进入子目录

**解决方案**

后端新增 3 个 API：

```ts
// 1. 列出目录内容
GET /api/directories?path=/path/to/dir
Response: {
  path: string;
  files: { name: string; type: 'file'|'dir'; size?: number; modified?: string }[];
  parent: string | null;
}

// 2. 上传文件
POST /api/threads/{id}/upload
Body: multipart/form-data (file, targetDir)
Response: { success: boolean; files: string[] }

// 3. 获取目录树（递归）
GET /api/directory-tree?root=/path&maxDepth=3
Response: { name, path, type: 'dir', children?: [] }
```

前端新增 2 个组件：

```tsx
// 1. DirectoryPicker：弹窗树形选择
<DirectoryPicker
  roots={workdirs}
  selected={draftCwd}
  onChange={setDraftCwd}
/>

// 2. FileUpload：拖拽上传
<FileUpload
  onFiles={(files) => uploadToAgent(files)}
/>
```

**安全考量**
- 路径白名单验证：只允许 `RAH_WORKDIRS` 内的目录
- 符号链接检测：避免无限递归
- 大文件限制：建议 100 MB
- 使用 `path.resolve()` 防止目录遍历攻击

**估计工作量**
- 后端 API：4-6 小时
- 前端组件：6-8 小时
- 测试与集成：4 小时
- **总计**：14-18 小时（3 人天）

#### 1.2 Thread 置顶、重命名、快速菜单

**问题**
- 线程列表无法置顶重要对话
- 无法重命名线程（标题固定）
- 无快速操作菜单

**解决方案**

数据库扩展：

```sql
ALTER TABLE threads ADD COLUMN pinned BOOLEAN DEFAULT 0;
ALTER TABLE threads ADD COLUMN tags TEXT;  -- JSON: ["tag1"]
CREATE INDEX idx_pinned_updated ON threads(pinned DESC, updatedAt DESC);
```

后端 API：

```ts
PATCH /api/threads/{id}
Body: { title?: string; pinned?: boolean; tags?: string[] }
```

前端 UI：

```tsx
// Sidebar 列表按 pinned DESC 排序
// Thread 项右键菜单：
// - 📌 置顶 / 取消置顶
// - ✏️ 重命名
// - 🗑️ 删除
// - 📤 导出
```

**估计工作量**
- 后端：2-3 小时
- 前端：4-5 小时
- 测试：2 小时
- **总计**：8-10 小时（2 人天）

#### 1.3 子目录导航与选择

**问题**
- 新建 Thread 时无法选择子目录
- 用户需要在终端手动输入完整路径，体验差

**解决方案**
- 复用 DirectoryPicker（1.1 中已实现）
- 修改 App.tsx 的工作目录选择逻辑
- 支持搜索：输入"src"快速定位 `/projects/foo/src`

**估计工作量**
- 组件集成：2-3 小时
- 测试：1 小时
- **总计**：3-4 小时（1 人天）

#### 1.4 搜索框集成

**问题**
- Sidebar 中的搜索按钮已占位，但功能未实现

**解决方案**

```tsx
// Sidebar 新增搜索逻辑
const filtered = threads.filter(t =>
  t.title.includes(query) || t.cwd.includes(query)
);
```

**估计工作量**
- 2-3 小时（1 人天）

---

### 阶段二：P2 核心功能（周 2-3）

#### 2.1 Session 元数据增强

添加展示：
- 最后修改时间
- 消息数
- Token 用量（如果 Adapter 支持）
- Agent 类型

**工作量**：4-6 小时

#### 2.2 Diff 面板增强

当前只显示"修改 3 文件，+120 -45 行"。

**增强方向**
- 展示 unified diff patch
- 行内批注 UI（配合 P3 批注系统）
- "上一轮改动"视图（对标 Codex）

**工作量**：8-10 小时

#### 2.3 Session 导出

支持导出为：
- Markdown：完整对话 + 文件改动摘要
- JSON：事件序列（用于备份/分析）
- ZIP：Markdown + 修改的文件快照

**后端 API**

```ts
GET /api/threads/{id}/export?format=markdown|json|zip
```

**工作量**：6-8 小时

---

### 阶段三：P3 交互增强（周 3-4）

#### 3.1 选中文字浮层与批注

- 在对话中选中助手回复的文字
- 弹出浮层：拷贝、添加到聊天、侧边聊天、批注
- 批注存储到 SQLite，发送时作为结构化上下文

**工作量**：10-14 小时

#### 3.2 侧边文件树（可选）

实时显示当前 cwd 下的文件结构。

**工作量**：6-8 小时

---

### 阶段四：P4 新 Agent 与发布（周 4-6）

#### 4.1 Codex AppServer 适配器

需要研究 Codex 的 `codex app-server --listen ws://...` 接口。

**计划**
1. 实现 `CodexAppServerAdapter`
2. 映射 Codex 特有功能（分区、置顶等）
3. 适配新的事件模型

**工作量**：8-12 小时（依赖研究）

#### 4.2 开源准备

- 检查脚本：`scripts/check-publish.sh`
- 英文 README
- 敏感信息扫描

**工作量**：4-6 小时

---

## 四、风险与依赖

### 4.1 技术风险

| 风险 | 概率 | 影响 | 缓解方案 |
|-----|------|------|-------|
| 大目录树递归性能差 | 中 | 延迟 UI，差体验 | 限制深度、添加缓存、虚拟滚动 |
| pi RPC 路径编码问题 | 低 | 某些路径无法上传 | 提前测试 pi 适配器 |
| 符号链接无限循环 | 低 | daemon 崩溃 | 检测深度限制 |

### 4.2 外部依赖

- **Claude 适配器**：需确认 `loadSession`、`fork` 等能力
- **pi 适配器**：确认上传文件的 RPC 命令
- **Codex app-server**：尚未验证接口稳定性（P4 时）

---

## 五、技术选型建议

### 5.1 前端组件库

已用 Tailwind CSS，建议保持，新增：
- **虚拟滚动**：大量 Thread 或文件树，用 react-window
- **文件树**：参考 VSCode 的 file-tree，或用 react-arborist
- **文件上传**：`react-dropzone` 或原生 drag & drop

### 5.2 后端文件处理

- **路径验证**：使用 `path.relative()` 和 `path.resolve()` 的组合
- **递归限制**：maxDepth = 5，避免大型单体库的性能问题
- **缓存**：可选，针对频繁请求的目录结构

---

## 六、验收标准

### P1 完成标准
- [ ] 可上传单/多文件到 cwd
- [ ] 可浏览目录树并选择子目录
- [ ] Thread 可置顶、重命名、快速删除
- [ ] 搜索框可用
- [ ] 手机与桌面端均可用（响应式测试通过）

### P2 完成标准
- [ ] Diff 面板展示 patch 细节
- [ ] 可导出会话为 Markdown / JSON
- [ ] 搜索性能满足（1000 个 Thread 下 <200ms）

### P3 完成标准
- [ ] 选中文字浮层可用
- [ ] 批注存储、查询、删除均正常
- [ ] 批注随消息提交给 Agent

### P4 完成标准
- [ ] Codex 适配器可完成一轮对话
- [ ] `check-publish.sh` 通过（无敏感信息泄露）
- [ ] 英文 README 完整

---

## 七、时间线预估

| 阶段 | 工作量 | 人力 | 耗时 |
|-----|------|------|-----|
| P1 | 30-35 人小时 | 2 人 | 1.5-2 周 |
| P2 | 20-25 人小时 | 2 人 | 1.5-2 周 |
| P3 | 15-20 人小时 | 1-2 人 | 1-1.5 周 |
| P4 | 12-18 人小时 | 1-2 人 | 1-2 周 |
| **总计** | **77-98 人小时** | **2 人** | **4-6 周** |

---

## 八、下一步行动

### 即刻行动（本周）

1. **确认 Agent 能力**
   - [ ] Claude ACP：确认 `fork`、`loadSession`、`resume` 等接口
   - [ ] pi RPC：确认文件上传命令、路径参数格式
   - [ ] Codex：研究 app-server 接口规范

2. **设计 API 文档**
   - [ ] 完整的请求/响应 schema（见 FEATURE_ROADMAP.md）
   - [ ] 错误处理规范

3. **数据库迁移脚本**
   - [ ] 编写 migration，添加 pinned、tags、token_usage 字段
   - [ ] 向后兼容性验证

### P1 启动（下周）

1. 后端：实现文件 API（目录树、上传）
2. 前端：DirectoryPicker、FileUpload 组件
3. 集成与测试

---

## 九、参考资料

| 资源 | 链接 | 用途 |
|-----|------|------|
| pi-web | [GitHub](https://github.com/jmfederico/pi-web) | 文件管理、Session 管理参考 |
| Codex-CLI-UI | [GitHub](https://github.com/cruzyjapan/Codex-CLI-UI) | 分组、置顶、导出参考 |
| 当前项目计划 | [docs/PLAN.md](./PLAN.md) | 整体阶段划分 |
| 功能路线图 | [docs/FEATURE_ROADMAP.md](./FEATURE_ROADMAP.md) | 详细补齐方案 |

---

## 附录：功能检查清单

### 用户使用场景覆盖

- [ ] **新用户上手**：能在 5 分钟内上传文件、创建 Thread、看到 Agent 回复
- [ ] **日常工作**：可置顶常用项目，快速切换，搜索找到历史对话
- [ ] **会话管理**：能导出会话、分支继续、查看详细改动
- [ ] **多设备**：手机和桌面端体验一致

### 功能完整性

- [ ] 文件管理（上传、浏览、删除）
- [ ] Thread 管理（创建、置顶、重命名、删除、导出、搜索）
- [ ] 对话管理（分支、续聊、取消、导出）
- [ ] 权限管理（Token、工作目录白名单）

---

**文档版本**：v1.0
**最后更新**：2026-10-10
