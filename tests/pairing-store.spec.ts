import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PairingStore } from '../src/server/pairing-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('PairingStore', () => {
  it('persists the bridge identity and per-device credentials', async () => {
    const filePath = await pairingFile();
    const store = await PairingStore.open(filePath, 'Codex Remote on studio');
    store.openPairingWindow();
    const request = store.createRequest('esp32-a1b2', 'Pocket Remote A1B2');

    expect(request.code).toMatch(/^\d{6}$/);
    expect(store.requestResult(request.id, 'another-device')).toEqual({
      status: 'expired',
    });

    await store.approve(request.id);
    const result = store.requestResult(request.id, 'esp32-a1b2');
    expect(result.status).toBe('approved');
    expect(result.token).toHaveLength(43);
    expect(store.isAuthorized(result.token ?? '')).toBe(true);

    const reloaded = await PairingStore.open(filePath, 'Codex Remote on studio');
    expect(reloaded.bridgeId).toBe(store.bridgeId);
    expect(reloaded.isAuthorized(result.token ?? '')).toBe(true);
    expect(reloaded.pairedDevices()).toMatchObject([{
      id: 'esp32-a1b2',
      name: 'Pocket Remote A1B2',
    }]);
  });

  it('only creates requests while the user-visible pairing window is open', async () => {
    const store = await PairingStore.open(
      await pairingFile(),
      'Codex Remote on studio',
    );

    expect(() => store.createRequest('esp32-a1b2', 'Pocket Remote')).toThrow(
      'Pairing is closed',
    );
    store.openPairingWindow();
    const first = store.createRequest('esp32-a1b2', 'Pocket Remote');
    const duplicate = store.createRequest('esp32-a1b2', 'Pocket Remote');
    expect(duplicate.id).toBe(first.id);
  });
});

async function pairingFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-remote-pairing-'));
  temporaryDirectories.push(directory);
  return join(directory, 'pairings.json');
}
