import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The audit is also directly executable by Node, without a build.
import { inspectIdentity, inspectText } from '../../scripts/release-audit.mjs';

test('公開点検は資格情報・個人パス・メールの値を出力せず検出する', () => {
  assert.deepEqual(inspectText('C:' + '/Us' + 'ers/example/private'), ['personal-local-path']);
  assert.deepEqual(inspectText('person' + '@example.com'), ['non-noreply-email']);
  assert.deepEqual(inspectText('gh' + 'p_' + 'a'.repeat(36)), ['credential-pattern']);
  assert.deepEqual(inspectText('color-analysis, rei-aogaki, person@example.invalid'), []);
});

test('公開履歴の識別情報は指定ハンドルと非公開用メールを検査する', () => {
  assert.deepEqual(inspectIdentity('rei-aogaki', '123+rei-aogaki@users.noreply.github.com'), []);
  assert.deepEqual(inspectIdentity('GitHub', 'noreply@github.com'), []);
  assert.deepEqual(inspectIdentity('Example Person', 'person' + '@example.com'), ['unapproved-public-name', 'non-noreply-email']);
});
