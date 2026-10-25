import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  deriveTokenBotIdentity,
  TokenBotConfigStore,
} from '../../../src/channels/shared/token-config-store.mjs';

const IDENTITY = Object.freeze({ botPrefix: 'telegram', tokenRefPrefix: 'DSH_TELEGRAM_BOT_TOKEN' });
const dirs = [];

async function storeWith(document) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-persona-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  if (document !== undefined) await writeFile(path, JSON.stringify(document));
  return { store: new TokenBotConfigStore(path, { channel: 'telegram', ...IDENTITY }), path };
}

function bot(platformId, extra = {}) {
  const { botId, tokenRef } = deriveTokenBotIdentity(platformId, IDENTITY);
  return { botId, tokenRef, platformId, name: `bot ${platformId}`, ...extra };
}

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('bot persona fields in the config document', () => {
  it('keeps profile and permission when they are strings', async () => {
    const { store } = await storeWith({
      version: 1,
      bots: [bot('100', { profile: 'p-137551a917', permission: 'workspace-write' })],
    });
    await store.load();
    const [record] = store.list();
    assert.equal(record.profile, 'p-137551a917');
    assert.equal(record.permission, 'workspace-write');
  });

  it('omits the fields when absent, so existing configs stay unchanged', async () => {
    const { store, path } = await storeWith({ version: 1, bots: [bot('101')] });
    await store.load();
    const [record] = store.list();
    assert.equal(Object.hasOwn(record, 'profile'), false);
    assert.equal(Object.hasOwn(record, 'permission'), false);
    await store.save(record);
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.hasOwn(written.bots[0], 'profile'), false);
    assert.equal(Object.hasOwn(written.bots[0], 'permission'), false);
  });

  it('drops a non-string persona value instead of rejecting the bot', async () => {
    const { store } = await storeWith({
      version: 1,
      bots: [bot('102', { profile: { id: 'p-1' }, permission: 7 })],
    });
    await store.load();
    const [record] = store.list();
    assert.equal(Object.hasOwn(record, 'profile'), false);
    assert.equal(Object.hasOwn(record, 'permission'), false);
  });
});
