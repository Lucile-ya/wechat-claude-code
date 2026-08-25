import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTextFragments,
  isMergeableFragment,
  shouldProcessImmediately,
  decideCoalesce,
} from '../inbound-coalescer.js';
import { MessageType } from '../wechat/types.js';
import type { WeixinMessage } from '../wechat/types.js';

function textMsg(text: string): WeixinMessage {
  return {
    message_type: MessageType.USER,
    from_user_id: 'user1',
    seq: 1,
    context_token: 'tok',
    item_list: [{ type: 1, text_item: { text } }],
  };
}

test('mergeTextFragments: 字母答案直接拼接', () => {
  assert.equal(mergeTextFragments(['A', 'B', 'C', 'D']), 'ABCD');
});

test('mergeTextFragments: 短中文词直接拼接', () => {
  assert.equal(mergeTextFragments(['复习', '错题']), '复习错题');
});

test('decideCoalesce: 短字母进入缓冲', () => {
  assert.equal(decideCoalesce(textMsg('A')).defer, true);
});

test('decideCoalesce: 完整指令立即处理', () => {
  assert.equal(decideCoalesce(textMsg('做题汇总')).defer, false);
});

test('shouldProcessImmediately: 长文本不等待', () => {
  assert.equal(shouldProcessImmediately('这是一条足够长的普通消息，不应进入合并缓冲', false), true);
});
