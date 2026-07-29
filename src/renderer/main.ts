import { createApp } from 'vue';
import App from './App.vue';
import { installRealtimeWebRtcBridge } from './realtime-webrtc';
import './style.css';

installRealtimeWebRtcBridge();
createApp(App).mount('#app');
