import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_PAIRING_WINDOW_MS = 2 * 60_000;
const APPROVED_REQUEST_TTL_MS = 5 * 60_000;

export type PairedDevice = {
  id: string;
  name: string;
  token: string;
  pairedAt: string;
  lastSeenAt: string | null;
};

export type PairingRequest = {
  id: string;
  deviceId: string;
  deviceName: string;
  code: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  expiresAt: number;
  token: string | null;
};

export type PublicPairingRequest = Omit<PairingRequest, 'token'>;

type PairingFile = {
  version: 1;
  bridgeId: string;
  bridgeName: string;
  devices: PairedDevice[];
};

export class PairingStore {
  readonly bridgeId: string;
  readonly bridgeName: string;

  private readonly requests = new Map<string, PairingRequest>();
  private readonly listeners = new Set<() => void>();
  private devices: PairedDevice[];
  private pairingOpenUntil = 0;
  private writeQueue = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    data: PairingFile,
  ) {
    this.bridgeId = data.bridgeId;
    this.bridgeName = data.bridgeName;
    this.devices = data.devices;
  }

  static async open(filePath: string, bridgeName: string): Promise<PairingStore> {
    let data: PairingFile | null = null;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<PairingFile>;
      if (
        parsed.version === 1
        && typeof parsed.bridgeId === 'string'
        && parsed.bridgeId.length > 0
        && Array.isArray(parsed.devices)
      ) {
        data = {
          version: 1,
          bridgeId: parsed.bridgeId,
          bridgeName,
          devices: parsed.devices.filter(isPairedDevice),
        };
      }
    } catch {
      // The first launch, or an unreadable legacy file, creates a fresh identity.
    }

    const store = new PairingStore(filePath, data ?? {
      version: 1,
      bridgeId: randomUUID(),
      bridgeName,
      devices: [],
    });
    await store.persist();
    return store;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isPairingOpen(now = Date.now()): boolean {
    return this.pairingOpenUntil > now;
  }

  pairingExpiresAt(): number | null {
    return this.isPairingOpen() ? this.pairingOpenUntil : null;
  }

  openPairingWindow(durationMs = DEFAULT_PAIRING_WINDOW_MS): number {
    this.pairingOpenUntil = Date.now() + durationMs;
    this.prune();
    this.changed();
    return this.pairingOpenUntil;
  }

  closePairingWindow(): void {
    this.pairingOpenUntil = 0;
    this.changed();
  }

  pairedDevices(): ReadonlyArray<PairedDevice> {
    return this.devices.map((device) => ({ ...device }));
  }

  pendingRequests(): PublicPairingRequest[] {
    this.prune();
    return [...this.requests.values()]
      .filter((request) => request.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicRequest);
  }

  createRequest(deviceId: string, deviceName: string): PublicPairingRequest {
    this.prune();
    if (!this.isPairingOpen()) {
      throw new PairingError(403, 'Pairing is closed. Open it from the Codex Remote menu.');
    }
    const normalizedId = requiredText(deviceId, 'deviceId', 96);
    const normalizedName = requiredText(deviceName, 'deviceName', 64);
    for (const request of this.requests.values()) {
      if (request.deviceId === normalizedId && request.status === 'pending') {
        return publicRequest(request);
      }
    }
    const now = Date.now();
    const request: PairingRequest = {
      id: randomBytes(24).toString('base64url'),
      deviceId: normalizedId,
      deviceName: normalizedName,
      code: randomIntString(),
      status: 'pending',
      createdAt: now,
      expiresAt: Math.min(this.pairingOpenUntil, now + DEFAULT_PAIRING_WINDOW_MS),
      token: null,
    };
    this.requests.set(request.id, request);
    this.changed();
    return publicRequest(request);
  }

  requestResult(
    requestId: string,
    deviceId: string,
  ): { status: 'pending' | 'approved' | 'rejected' | 'expired'; token?: string } {
    this.prune();
    const request = this.requests.get(requestId);
    if (!request || request.deviceId !== deviceId) return { status: 'expired' };
    if (request.status === 'approved' && request.token) {
      return { status: 'approved', token: request.token };
    }
    return { status: request.status };
  }

  async approve(requestId: string): Promise<void> {
    this.prune();
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') {
      throw new PairingError(404, 'Pairing request is no longer pending');
    }
    const now = new Date().toISOString();
    const token = randomBytes(32).toString('base64url');
    const existing = this.devices.findIndex((device) => device.id === request.deviceId);
    const device: PairedDevice = {
      id: request.deviceId,
      name: request.deviceName,
      token,
      pairedAt: now,
      lastSeenAt: null,
    };
    if (existing >= 0) this.devices[existing] = device;
    else this.devices.push(device);
    request.status = 'approved';
    request.token = token;
    request.expiresAt = Date.now() + APPROVED_REQUEST_TTL_MS;
    await this.persist();
    this.changed();
  }

  reject(requestId: string): void {
    this.prune();
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') return;
    request.status = 'rejected';
    this.changed();
  }

  async revoke(deviceId: string): Promise<PairedDevice | null> {
    const index = this.devices.findIndex((device) => device.id === deviceId);
    if (index < 0) return null;
    const [device] = this.devices.splice(index, 1);
    for (const [requestId, request] of this.requests) {
      if (request.deviceId === deviceId) this.requests.delete(requestId);
    }
    await this.persist();
    this.changed();
    return device ? { ...device } : null;
  }

  isAuthorized(token: string): boolean {
    if (!token) return false;
    return this.devices.some((device) => safeEquals(device.token, token));
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) {
        this.requests.delete(id);
        changed = true;
      }
    }
    if (this.pairingOpenUntil !== 0 && this.pairingOpenUntil <= now) {
      this.pairingOpenUntil = 0;
      changed = true;
    }
    if (changed) this.changed();
  }

  private persist(): Promise<void> {
    const payload: PairingFile = {
      version: 1,
      bridgeId: this.bridgeId,
      bridgeName: this.bridgeName,
      devices: this.devices,
    };
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

export class PairingError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function publicRequest(request: PairingRequest): PublicPairingRequest {
  const { token: _token, ...result } = request;
  return { ...result };
}

function requiredText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new PairingError(400, `${name} must be a non-empty string`);
  if (normalized.length > maxLength) {
    throw new PairingError(400, `${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function randomIntString(): string {
  const maximum = 1_000_000;
  const cutoff = Math.floor(0x1_0000_0000 / maximum) * maximum;
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE();
  } while (value >= cutoff);
  return String(value % maximum).padStart(6, '0');
}

function safeEquals(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isPairedDevice(value: unknown): value is PairedDevice {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<PairedDevice>;
  return (
    typeof device.id === 'string'
    && typeof device.name === 'string'
    && typeof device.token === 'string'
    && device.token.length >= 32
    && typeof device.pairedAt === 'string'
    && (device.lastSeenAt === null || typeof device.lastSeenAt === 'string')
  );
}
