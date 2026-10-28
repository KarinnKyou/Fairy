'use strict';
/*
 * handoff.js — the L1 brief (ADR-015): a self-contained task file for the harness.
 *
 * Deliberately deterministic: every line is a stored fact (need, topic, project, memories, recent
 * turns) or a fixed contract. A generated summary would be a claim the app cannot verify, and the
 * brief is about to be used as an instruction — invented context is worse than none.
 */
const fs = require('fs');
const path = require('path');

function stamp(ms) {
  return new Date(ms == null ? Date.now() : ms).toISOString().replace(/[:.]/g, '-');
}

function composeBrief(input) {
  const o = input || {};
  const need = String(o.need == null ? '' : o.need).trim();
  const lines = ['# 交给 harness 的任务', '', '## 需求', need || '（未填写）', '', '## 上下文'];
  lines.push('- 当前话题：' + (o.topic ? o.topic.title : '（无）'));
  lines.push('- 所属项目：' + (o.project ? o.project.name : '（无）'));

  lines.push('', '## 相关记忆');
  const memories = o.memories || [];
  if (!memories.length) lines.push('（无）');
  else for (const m of memories) lines.push('- ' + String(m.text || '').trim());

  lines.push('', '## 最近对话');
  const recent = o.recent || [];
  if (!recent.length) lines.push('（无）');
  else {
    for (const m of recent) {
      const who = m.role === 'user' ? '主人' : '你';
      lines.push('- ' + who + '：' + String(m.content || '').replace(/\s+/g, ' ').slice(0, 300));
    }
  }

  lines.push('', '## 约束');
  lines.push('- 先读再改；完成后说明改了什么、验证了什么、有什么风险。');
  lines.push('- 不要提交或推送，除非需求里明确要求。');
  lines.push('', '## 验收');
  lines.push('- [ ] 需求描述的行为可用');
  lines.push('- [ ] 相关测试通过');
  lines.push('- [ ] 变更范围清楚，没有顺手改无关文件');
  lines.push('', '## 回复契约');
  lines.push('完成后用不超过三行总结：改了什么 / 验证了什么 / 风险。');
  return lines.join('\n') + '\n';
}

function writeBrief(dir, brief, now) {
  const target = path.join(dir, 'handoffs');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, stamp(now) + '.md');
  fs.writeFileSync(file, brief, 'utf8');
  return { file, bytes: Buffer.byteLength(brief) };
}

module.exports = { composeBrief, writeBrief, stamp };
