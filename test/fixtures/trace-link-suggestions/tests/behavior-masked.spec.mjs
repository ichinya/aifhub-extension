import { test } from 'node:test';

// topic.thing is only documented in this comment.
const caption = 'topic.thing stays a literal here';

test('masked only', () => {
  caption;
});
