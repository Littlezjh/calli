# 功能补齐 — 快速参考

> 简化版的关键信息，方便团队快速查看和执行。完整分析见 [ANALYSIS_SUMMARY.md](./ANALYSIS_SUMMARY.md) 和 [FEATURE_ROADMAP.md](./FEATURE_ROADMAP.md)。

---

## 🎯 当前状态与缺失

### ✅ 已有功能
- 线程管理（创建、查询、删除）
- 流式对话（SSE 推送）
- Claude + pi 两个 Agent
- 手机/桌面响应式 UI
- 工作目录预配置选择

### ❌ 关键缺失 (用户感受最强烈)

| 功能 | 级别 | 影响 |
|-----|------|------|
| **文件上传** | P1 | 无法给 Agent 投入文件 |
| **子目录导航** | P1 | 只能选预配置目录，不能进子目录 |
| **Thread 置顶/重命名** | P1 | 线程管理不便 |
| **搜索** | P2 | 大量 Thread 时找不到 |
| **Session 导出** | P3 | 无法备份对话 |
| **Codex 支持** | P4 | 暂不支持第三个 Agent |

---

## 🚀 P1 实施计划（关键路径，2 周）

### 任务 1：文件上传 & 目录树
**后端**
```ts
// 新增 3 个 API
GET /api/directories?path=...          // 列目录
POST /api/threads/{id}/upload          // 上传文件
GET /api/directory-tree?root=...       // 递归树
```

**前端**
- 新建 `DirectoryPicker.tsx`：树形目录选择弹窗
- 新建 `FileUpload.tsx`：拖拽上传组件
- 修改 `Composer.tsx`：Chat 区域拖拽上传

**时间**：14-18 小时（3 人天）

**验收**
- [ ] 可上传文件到 cwd
- [ ] 可选择子目录
- [ ] 手机/桌面均可用

---

### 任务 2：Thread 置顶 & 重命名
**后端**
```sql
ALTER TABLE threads ADD COLUMN pinned BOOLEAN DEFAULT 0;
ALTER TABLE threads ADD COLUMN tags TEXT;
```

```ts
// 新增 API
PATCH /api/threads/{id}
Body: { title?: string; pinned?: boolean; tags?: string[] }
```

**前端**
- 修改 `Sidebar.tsx`：按 pinned DESC 排序，右键菜单
- 菜单项：置顶、重命名、删除、导出

**时间**：8-10 小时（2 人天）

**验收**
- [ ] 置顶线程在顶部
- [ ] 右键菜单可用
- [ ] 重命名后刷新保留

---

### 任务 3：搜索框
**前端**
```tsx
// Sidebar 搜索逻辑
const filtered = threads.filter(t =>
  t.title.includes(query) || t.cwd.includes(query)
);
```

**时间**：2-3 小时（1 人天）

**验收**
- [ ] 按 title/cwd 模糊搜索
- [ ] 性能 OK（<200ms）

---

## 📋 P2-P4 概览

### P2（周 2-3）
- Session 元数据展示（修改时间、消息数、token 用量）
- Diff 面板增强（显示 patch 细节）
- Session 导出（Markdown/JSON/ZIP）
- **工作量**：20-25 小时

### P3（周 3-4）
- 选中文字浮层（拷贝、批注、侧边聊天）
- 批注系统（存储、显示、提交给 Agent）
- **工作量**：15-20 小时

### P4（周 4-6）
- Codex app-server 适配器
- 开源检查与发布准备
- **工作量**：12-18 小时

---

## 🔧 开发快速参考

### 数据库扩展
```sql
-- P1：置顶与标签
ALTER TABLE threads ADD COLUMN pinned BOOLEAN DEFAULT 0;
ALTER TABLE threads ADD COLUMN tags TEXT;

-- P2：元数据
ALTER TABLE threads ADD COLUMN token_usage INTEGER DEFAULT 0;

-- P3：批注
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  threadId TEXT,
  turnId TEXT,
  quote TEXT,
  comment TEXT,
  createdAt TEXT,
  FOREIGN KEY(threadId) REFERENCES threads(id)
);
```

### 文件上传安全检查清单
- [ ] 路径白名单验证（只允许 `CALLI_WORKDIRS`）
- [ ] 符号链接检测（避免无限循环）
- [ ] 文件大小限制（建议 100 MB）
- [ ] 目录深度限制（maxDepth = 5）
- [ ] 使用 `path.resolve()` 防止目录遍历

### 前端组件需求
- [ ] `DirectoryPicker`：树形选择，搜索，确认
- [ ] `FileUpload`：拖拽，进度，错误处理
- [ ] `QuickMenu`：右键菜单（置顶、重命名、删除、导出）
- [ ] `DiffPanel`：patch 展示，行内批注（P3）

### 测试需求
- [ ] 单元测试：路径验证、搜索逻辑
- [ ] 集成测试：上传流程、目录选择
- [ ] E2E 测试：手机/桌面端工作流
- [ ] 性能测试：1000+ Thread，大目录树

---

## 📌 关键决策

| 问题 | 决定 | 理由 |
|-----|------|------|
| 目录树深度限制？ | maxDepth = 5 | 避免大型单体库性能问题 |
| 文件大小限制？ | 100 MB | 平衡上传便利性和服务器压力 |
| 分块上传？ | P3 考虑 | P1 不做，先用单次上传 |
| 符号链接处理？ | 检测后跳过 | 避免无限循环 |
| 路径验证方案？ | 白名单 + resolve | 防止目录遍历攻击 |

---

## 👥 分工建议

**2 人团队，4-6 周完成**

### 前两周（P1）
- **后端开发**（1 人）：文件 API、DB 迁移、路径验证
- **前端开发**（1 人）：DirectoryPicker、FileUpload、Sidebar 增强

### 第三四周（P2）
- **后端开发**（1 人）：导出 API、元数据查询、Diff 详情
- **前端开发**（1 人）：Diff 面板、导出 UI、搜索优化

### 第五六周（P3-P4）
- 根据进度灵活调整：批注系统、Codex 适配、开源检查

---

## 📚 关键文档

| 文档 | 内容 |
|-----|-----|
| [ANALYSIS_SUMMARY.md](./ANALYSIS_SUMMARY.md) | 完整分析、风险评估、验收标准 |
| [FEATURE_ROADMAP.md](./FEATURE_ROADMAP.md) | API 设计、技术方案、详细实施步骤 |
| [PLAN.md](./PLAN.md) | 项目整体计划、阶段划分、设计原则 |

---

## 🎬 立即行动（本周）

- [ ] 确认 Claude ACP 和 pi RPC 的 fork、resume、路径参数规范
- [ ] 完成 P1 任务分解与代码框架搭建
- [ ] 编写 API 文档（OpenAPI/Swagger）
- [ ] 准备数据库迁移脚本和回滚方案

---

**最后更新**：2026-10-10
