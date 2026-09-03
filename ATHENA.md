# PMP Athena 定制

这是 [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 的 **PMP Athena 定制 fork**，在微信桥接基础上增加了 PMP 备考硬路由能力。

## 这个 fork 相对上游多了什么

核心是在 `src/athena-router.ts` 增加了一套 **Athena 硬路由**：识别 PMP 备考指令，直接调用 [pmp-athena](https://github.com/Lucile-ya/pmp-athena) 仓库的 Python 脚本返回结果，**不经 Claude 大模型**，响应更快、结果更稳定（判卷/统计/抽题等确定性逻辑不依赖 LLM）。

## 硬路由指令一览

| 分类 | 触发词 | 调用脚本 |
|------|--------|----------|
| 判卷 | 连续字母串 / 「我的答案是 X」 | `record_answer.py` + 三文件同步 |
| 复习错题 | 复习错题 / 薄弱点 / 高频错题 / 高频错题摘要卡 | `study_advisor.py` |
| 每日一练 | 每日一练 / 随机每日一练 / 做X月X日 | `daily_practice.py` |
| 模考 | 开始模考 / 随机模考 / 继续/暂停/放弃/恢复 | `mock_exam_engine.py` |
| 今日任务 | 今日任务 / 开始任务 / 下一步 | `daily_quest.py` |
| 三步走 | 今日练习 / 三步走 / 今日计划 | `study_advice.py three-step` |
| 专项练习 | 专项 <领域> | `daily_practice.py area-start` |
| 分析 | 分析趋势 / 通过率预测 | `trend_analysis.py` |
| 知识点 | X知识点 / 知识点X / X速查 | `knowledge_retriever.py` |
| 截图录入 | 发图 + 配文 / 多图关联 | OCR + 三文件同步 |
| 章节练习 | 发图 + 章节名 | `chapter_practice_recorder.py` |

> 完整规则见 [pmp-athena](https://github.com/Lucile-ya/pmp-athena) 仓库的 `CLAUDE.md`。

## 部署

### 前置条件

1. 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 并完成认证
2. Node.js >= 18
3. Python 3.10+，并安装依赖（见 pmp-athena 的 `requirements.txt`）
4. clone [pmp-athena](https://github.com/Lucile-ya/pmp-athena) 到本地（如 `D:\pmp-athena`）

### 安装

```bash
git clone https://github.com/Lucile-ya/wechat-claude-code.git
cd wechat-claude-code
npm install
npm run build   # 编译 src/ → dist/
```

### 配置 Athena 硬路由

编辑 `~/.wechat-claude-code/config.json`：

```json
{
  "workingDirectory": "D:/pmp-athena",
  "pythonBin": "D:/miniconda/python.exe"
}
```

| 字段 | 说明 |
|------|------|
| `workingDirectory` | pmp-athena 仓库的绝对路径，硬路由的 Python 脚本从这里找 |
| `pythonBin` | Python 解释器路径（需装有 pdfplumber、pytesseract 等依赖） |

### 启动

```bash
node dist/main.js start
```

Windows 下建议用 pmp-athena 仓库的 `bridge_guard.ps1` 计划任务守护（每 5 分钟检查，挂了自动拉起，规则文件更新自动热重载）。

## 版本

见 [CHANGELOG.md](CHANGELOG.md)。
