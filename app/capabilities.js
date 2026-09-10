'use strict';
/*
 * capabilities.js — what this build can actually do.
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
 * ONLY THE POSITIVES ARE RENDERED. What she can do is stated, and stated to be the complete
 * list; everything else follows from that by subtraction, so she never has to recite an
 * inventory of her own limitations. That is not just a matter of taste — a "cannot" list in
 * the prompt is self-description-shaped, and a real conversation showed the model reading
 * its bullet points straight back to the user ("做不到的有：看摄像头、读硬件状态、替你操作
 * 电脑……"), which is also exactly what an assistant should not sound like. Listing the
 * negatives additionally primes those tokens (camera, music, alarms), making it more likely
 * she talks about — or improvises around — the very things she must not promise.
 *
 * Facts only. No behaviour rules live here: "say honestly when you cannot" is a disposition
 * and belongs in the persona, while "there is no camera" is an environment fact and belongs
 * here.
 */

/* The rendered list. `id` is for tests and for referencing an entry; `text` is what the
 * model reads. Rewording text is free — the tests assert ids, not wording.
 *
 * A capability that exists in the code must appear here, and one that appears here must
 * exist in the code; the cross-checks in tests/conversation.test.cjs compare this list
 * against main.js and the page CSP, so the two cannot drift apart silently. */
const CAN_DO = [
  { id: 'chat', text: '和主人进行文字对话' },
  { id: 'time', text: '知道当前的日期与时间' },
];

/* The absences, recorded but deliberately NOT rendered — see the header. They are kept for
 * three reasons: the negative test that asserts none of them reaches the prompt uses them
 * as its fixture, the cross-checks below name them, and whoever adds a real capability
 * should see what was already considered (Phase 6 tools, Phase 5 file reading, Phase 7
 * calendar). Update this list when reality changes; do not start rendering it as a list of
 * refusals. */
const CANNOT_DO = [
  { id: 'camera', text: '看不到主人的样子、表情或周围环境' },
  { id: 'hardware', text: '读不到 CPU、内存、电池、温度等硬件状态' },
  { id: 'actions', text: '不能代替主人操作：放音乐、发消息、查天气、改设置、定闹钟、开程序' },
  { id: 'files', text: '不能读写文件' },
  { id: 'network', text: '不能上网搜索或打开网页' },
  { id: 'tools', text: '没有工具调用能力' },
];

/* Renders the block that goes into the system prompt: just the positive list, under a
 * heading. Built from the data above, so a declaration always reaches the prompt; the test
 * that compares the two guards the renderer against silently dropping an entry.
 *
 * Deliberately says nothing about the list being complete. An earlier version declared "this
 * is the whole of it" and "everything else you cannot do", so that the absences could be
 * derived by subtraction; asked what she could do, she answered with a closing "就这些".
 * Removing the claim helped but did not settle it — "就这些" still appeared in one run out of
 * three, so it is also the model's own habit of closing a short enumeration, and the persona
 * carries a manner rule against that kind of closer.
 *
 * What actually prevents fabrication is the honesty rule in the persona ("say plainly that
 * you cannot; never invent a completed action"), not a completeness claim here. That is
 * verified by behaviour probes, since it is not something an assertion can establish: five
 * questions written to invite a fabricated "已经为您做好了" (search the web, read my screen,
 * rename a file, set an alarm, read my expression) were all refused honestly with the
 * completeness claim absent. */
function capabilitySection() {
  const bullet = CAN_DO.map((e) => '- ' + e.text).join('\n');
  return '\n\n# 你能做什么\n' + bullet;
}

const ids = (list) => list.map((e) => e.id);

module.exports = { CAN_DO, CANNOT_DO, capabilitySection, ids };
