// Independent wire examples based on onebot-11 event/message.md, not the connector encoder.
export const numericFixture = {
  time: 1780000000, self_id: 123456, post_type: 'message', message_type: 'group', sub_type: 'normal',
  message_id: -42, group_id: 987654, user_id: 654321,
  message: [{ type: 'text', data: { text: '请回复这条测试消息' } }], raw_message: '请回复这条测试消息',
  font: 0, sender: { user_id: 654321, nickname: 'fixture-user', role: 'member' },
};

export const stringFixture = {
  time: 1780000001, self_id: '123456', post_type: 'message', message_type: 'private', sub_type: 'friend',
  message_id: '73', user_id: '654321', message: '[CQ:reply,id=72]A&#91;B&#93;&amp;C',
  raw_message: '[CQ:reply,id=72]A&#91;B&#93;&amp;C', font: 0,
  sender: { user_id: '654321', nickname: 'fixture-friend', sex: 'unknown', age: 0 },
};
