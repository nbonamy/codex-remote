<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CodexRemoteDesktopState } from '../main/contracts';

const state = ref<CodexRemoteDesktopState>({
  phase: 'starting',
  codexStatus: 'idle',
  accountLabel: null,
  error: null,
  server: null,
});
let unsubscribe: () => void = () => undefined;

const primaryNetworkUrl = computed(() => state.value.server?.networkUrls[0] ?? null);
const connectionLabel = computed(() => {
  if (state.value.phase === 'error') return 'Needs attention';
  if (state.value.phase !== 'ready') return 'Starting';
  return 'Ready for device';
});

onMounted(async () => {
  state.value = await window.codexRemote.getState();
  unsubscribe = window.codexRemote.onStateChange((next) => {
    state.value = next;
  });
});

onBeforeUnmount(() => unsubscribe());

async function copy(value: string | null | undefined): Promise<void> {
  if (value) await window.codexRemote.copy(value);
}

async function openSimulator(): Promise<void> {
  if (state.value.server) {
    await window.codexRemote.openExternal(state.value.server.simulatorUrl);
  }
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
        class="status-card"
        :class="state.phase"
      >
        <span class="status-light" />
        <div>
          <strong>{{ connectionLabel }}</strong>
          <span>{{ state.accountLabel || 'Codex authentication pending' }}</span>
        </div>
      </div>

      <p
        v-if="state.error"
        class="error"
      >
        {{ state.error }}
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
          24 kHz PCM prefers Codex WebRTC realtime. When that service is
          unavailable, macOS transcribes locally and sends a normal command.
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
