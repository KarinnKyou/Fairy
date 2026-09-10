'use strict';
/*
 * capabilities.js — what this build can actually do, as data.
 *
 * These are facts about the running program, not character traits, which is why they are
 * not in personality.js. A persona edit once deleted the whole capability boundary: read as
 * character, it looked like fair game for rewriting, and five assertions turned red. Taste
 * and correctness do not belong in the same string.
 *
 * The model cannot discover any of this by introspection — it has no way to notice it lacks
 * a camera, and it cannot try and fail. Capability awareness is therefore injected state,
 * exactly like the profile and the current time; the only real choice is which layer
 * supplies it. This is that layer.
 *
 * Each entry is a claim about the code, and the claims that can be checked against the code
 * are checked in tests/conversation.test.cjs. When a phase adds a real capability, change
 * this file — the cross-checks fail until the declaration matches reality again (Phase 6
 * should generate the tool entry from the actual tool registry).
 *
 * Facts only. No behaviour rules live here: "say honestly when you cannot" is a disposition
 * and belongs in the persona, while "there is no camera" is an environment fact and belongs
 * here.
 */

/* id is for tests and for referencing an entry; text is what the model reads. Rewording
 * text is free — the tests assert ids, not wording. */
const CAN_DO = [
  { id: 'chat', text: '和主人进行文字对话' },
  { id: 'time', text: '知道当前的日期与时间（见下文）' },
];

const CANNOT_DO = [
  { id: 'camera', text: '摄像头：看不到主人的样子、表情，也看不到周围环境' },
  { id: 'hardware', text: '硬件状态：读不到 CPU、内存、电池、温度' },
  { id: 'actions', text: '代替主人操作：放音乐、发消息、查天气、改设置、定闹钟、开程序' },
  { id: 'files', text: '读写文件' },
  { id: 'network', text: '自己上网：不能搜索或打开网页、接口' },
  { id: 'tools', text: '工具调用' },
];

/* Renders the block that goes into the system prompt. Built from the data above, so a
 * declaration always reaches the prompt; the test that compares the two guards the
 * renderer against silently dropping an entry.
 *
 * Facts only, deliberately: no "do not apologise", no "say so honestly". Those are
 * dispositions and live in the persona. Keeping that line clean is what stops the two
 * layers merging back together. */
function capabilitySection() {
  const bullet = (list) => list.map((e) => '- ' + e.text).join('\n');
  return '\n\n# 你当前可以做什么（由运行环境提供，不是角色设定）\n' +
    '可以：\n' + bullet(CAN_DO) + '\n' +
    '不可以：\n' + bullet(CANNOT_DO) + '\n' +
    '以上是这台程序此刻的事实。';
}

const ids = (list) => list.map((e) => e.id);

module.exports = { CAN_DO, CANNOT_DO, capabilitySection, ids };
