<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CodexRemoteDesktopState } from '../main/contracts';

const state = ref<CodexRemoteDesktopState>({
  phase: 'starting',
  error: null,
  agents: [],
  pairingOpenUntil: null,
  pairedDeviceCount: 0,
  pairedDevices: [],
  pendingPairings: [],
  server: null,
});
const selectedAgentId = ref<string | null>(null);
let unsubscribe: () => void = () => undefined;

const activeAgent = computed(() => (
  state.value.agents.find((agent) => agent.id === selectedAgentId.value)
  ?? state.value.agents[0]
  ?? null
));
const primaryNetworkUrl = computed(() => state.value.server?.networkUrls[0] ?? null);

onMounted(async () => {
  state.value = await window.codexRemote.getState();
  selectedAgentId.value = state.value.agents[0]?.id ?? null;
  unsubscribe = window.codexRemote.onStateChange((next) => {
    state.value = next;
    selectedAgentId.value ??= next.agents[0]?.id ?? null;
  });
});

onBeforeUnmount(() => unsubscribe());

async function copy(value: string | null | undefined): Promise<void> {
  if (value) await window.codexRemote.copy(value);
}

async function openSimulator(): Promise<void> {
  if (state.value.server) {
    const url = new URL(state.value.server.simulatorUrl);
    if (activeAgent.value) url.searchParams.set('agentId', activeAgent.value.id);
    await window.codexRemote.openExternal(url.toString());
  }
}

function agentStatusLabel(agent: CodexRemoteDesktopState['agents'][number]): string {
  if (agent.codexStatus === 'error') return 'Needs attention';
  if (agent.codexStatus !== 'ready') return 'Starting';
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
        v-for="agent in state.agents"
        :key="agent.id"
        class="status-card"
        :class="[agent.codexStatus, { selected: agent.id === activeAgent?.id }]"
        @click="selectedAgentId = agent.id"
      >
        <span class="status-light" />
        <div>
          <strong>{{ agent.name }} · {{ agentStatusLabel(agent) }}</strong>
          <span>{{ agent.accountLabel || 'Codex authentication pending' }}</span>
        </div>
      </div>

      <p
        v-if="state.error || activeAgent?.error"
        class="error"
      >
        {{ state.error || activeAgent?.error }}
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
      </div>

      <div class="note">
        <span>Voice path</span>
        <p>
          macOS transcribes 24 kHz PCM locally and sends a normal Codex command.
          API-key-authenticated agents can additionally use Codex realtime audio.
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
