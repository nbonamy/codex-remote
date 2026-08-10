<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CodexRemoteDesktopState } from '../main/contracts';

const state = ref<CodexRemoteDesktopState>({
  phase: 'starting',
  error: null,
  hosts: [],
  pairingOpenUntil: null,
  pairedDeviceCount: 0,
  pairedDevices: [],
  pendingPairings: [],
  server: null,
});
const selectedHostId = ref<string | null>(null);
let unsubscribe: () => void = () => undefined;

const activeHost = computed(() => (
  state.value.hosts.find((host) => host.id === selectedHostId.value)
  ?? state.value.hosts[0]
  ?? null
));
const primaryNetworkUrl = computed(() => state.value.server?.networkUrls[0] ?? null);

onMounted(async () => {
  state.value = await window.codexRemote.getState();
  selectedHostId.value = state.value.hosts[0]?.id ?? null;
  unsubscribe = window.codexRemote.onStateChange((next) => {
    state.value = next;
    selectedHostId.value ??= next.hosts[0]?.id ?? null;
  });
});

onBeforeUnmount(() => unsubscribe());

async function copy(value: string | null | undefined): Promise<void> {
  if (value) await window.codexRemote.copy(value);
}

async function openSimulator(): Promise<void> {
  if (state.value.server) {
    const url = new URL(state.value.server.simulatorUrl);
    if (activeHost.value) url.searchParams.set('hostId', activeHost.value.id);
    await window.codexRemote.openExternal(url.toString());
  }
}

function hostStatusLabel(host: CodexRemoteDesktopState['hosts'][number]): string {
  if (host.codexStatus === 'error') return 'Needs attention';
  if (host.codexStatus !== 'ready') return 'Starting';
  return 'Ready for device';
}
</script>

<template>
  <main class="shell">
    <section class="overview">
      <header class="masthead">
        <div class="brand-mark">&gt;_</div>
        <div>
          <p class="kicker">Pocket control plane</p>
          <h1>Codex Remote</h1>
        </div>
      </header>

      <div
        v-for="host in state.hosts"
        :key="host.id"
        class="status-card"
        :class="[host.codexStatus, { selected: host.id === activeHost?.id }]"
        @click="selectedHostId = host.id"
      >
        <span class="status-light" />
        <div>
          <strong>{{ host.name }} · {{ hostStatusLabel(host) }}</strong>
          <span>{{ host.accountLabel || 'Codex authentication pending' }}</span>
        </div>
      </div>

      <p
        v-if="state.error || activeHost?.error"
        class="error"
      >
        {{ state.error || activeHost?.error }}
      </p>

      <div
        v-if="state.server"
        class="details"
      >
        <article>
          <span>LAN endpoint</span>
          <button @click="copy(primaryNetworkUrl)">
            {{ primaryNetworkUrl || 'No LAN interface found' }}
          </button>
        </article>
        <article>
          <span>Device token</span>
          <button
            class="token"
            @click="copy(state.server?.token)"
          >
            {{ state.server.token }}
          </button>
        </article>
        <article>
          <span>Default workspace</span>
          <button @click="copy(state.server?.defaultCwd)">
            {{ state.server.defaultCwd }}
          </button>
        </article>
      </div>

      <div class="note">
        <span>Voice path</span>
        <p>
          macOS transcribes 24 kHz PCM locally and sends a normal Codex command.
          API-key-authenticated hosts can additionally use Codex realtime audio.
        </p>
      </div>
    </section>

    <section class="device-stage">
      <div class="device-heading">
        <div>
          <p class="kicker">Live client</p>
          <h2>368 × 448</h2>
        </div>
        <button
          v-if="state.server"
          class="external"
          @click="openSimulator"
        >
          Open separately ↗
        </button>
      </div>
      <div class="device-frame">
        <iframe
          v-if="state.server"
          :src="state.server.simulatorUrl"
          title="ESP32 device simulator"
          allow="microphone"
        />
        <div
          v-else
          class="device-loading"
        >
          <span>&gt;_</span>
          <p>Starting app-server…</p>
        </div>
      </div>
    </section>
  </main>
</template>
