#include "RemoteClient.h"

#include "../diag/Log.h"
#include <ESPmDNS.h>
#include <WiFi.h>

using namespace websockets;

void RemoteClient::begin(RemoteClientListener *listener) {
  _listener = listener;
  _ws.addHeader("X-Codex-Remote-Token", DEVICE_TOKEN);
  _ws.onMessage([this](WebsocketsMessage message) { handleMessage(message); });
  _ws.onEvent([this](WebsocketsEvent event, String data) {
    handleEvent(event, data);
  });

  _status = "Joining Wi-Fi";
  changed();
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const unsigned long deadline = millis() + WIFI_CONNECT_TIMEOUT_SEC * 1000UL;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(150);
  }
  if (WiFi.status() != WL_CONNECTED) {
    _status = "Wi-Fi unavailable";
    _error = "Check credentials.h";
    changed();
    return;
  }
  MDNS.begin("codex-remote-device");
  connect();
}

void RemoteClient::update() {
  if (_connected) {
    _ws.poll();
    return;
  }
  if (WiFi.status() == WL_CONNECTED &&
      millis() - _lastConnectAttemptMs >= RECONNECT_INTERVAL_MS) {
    connect();
  }
}

void RemoteClient::connect() {
  _lastConnectAttemptMs = millis();
  if (!discoverServer()) {
    _status = "Looking for host";
    changed();
    return;
  }
  _status = "Connecting";
  _error = "";
  changed();
  Log::client("Remote", "connecting ws://%s:%d%s", _serverHost.c_str(),
              _serverPort, SERVER_PATH);
  _connected = _ws.connect(_serverHost, _serverPort, SERVER_PATH);
  if (!_connected) {
    _status = "Host unavailable";
    changed();
  }
}

bool RemoteClient::discoverServer() {
  if (strlen(SERVER_HOST) > 0) {
    _serverHost = SERVER_HOST;
    _serverPort = SERVER_PORT;
    return true;
  }
  const int count = MDNS.queryService("codex-remote", "tcp");
  if (count <= 0) {
    return false;
  }
  _serverHost = MDNS.address(0).toString();
  _serverPort = MDNS.port(0);
  return !_serverHost.isEmpty() && _serverPort > 0;
}

bool RemoteClient::createThread() {
  JsonDocument document;
  document["type"] = "create_thread";
  return sendControl(document);
}

bool RemoteClient::openThread(const String &threadId) {
  JsonDocument document;
  document["type"] = "open_thread";
  document["threadId"] = threadId;
  return sendControl(document);
}

bool RemoteClient::listThreads() {
  JsonDocument document;
  document["type"] = "list_threads";
  return sendControl(document);
}

bool RemoteClient::startAudio(const String &threadId) {
  JsonDocument document;
  document["type"] = "audio_start";
  document["threadId"] = threadId;
  document["sampleRate"] = MIC_SAMPLE_RATE;
  return sendControl(document);
}

bool RemoteClient::sendAudio(const uint8_t *data, size_t length) {
  return _connected &&
         _ws.sendBinary(reinterpret_cast<const char *>(data), length);
}

bool RemoteClient::endAudio() {
  JsonDocument document;
  document["type"] = "audio_end";
  return sendControl(document);
}

bool RemoteClient::interrupt(const String &threadId) {
  JsonDocument document;
  document["type"] = "interrupt";
  document["threadId"] = threadId;
  return sendControl(document);
}

bool RemoteClient::sendControl(JsonDocument &document) {
  if (!_connected) {
    return false;
  }
  String body;
  serializeJson(document, body);
  return _ws.send(body);
}

void RemoteClient::handleMessage(WebsocketsMessage message) {
  if (message.isBinary()) {
    const auto raw = message.rawData();
    if (_listener && raw.length() > 0) {
      _listener->onRemoteAudio(
          reinterpret_cast<const uint8_t *>(raw.c_str()), raw.length());
    }
    return;
  }

  JsonDocument document;
  const DeserializationError parseError = deserializeJson(document, message.data());
  if (parseError) {
    Log::client("Remote", "invalid json: %s", parseError.c_str());
    return;
  }
  const String type = document["type"] | "";
  if (type == "hello") {
    _status = "Ready";
    _error = "";
  } else if (type == "threads") {
    parseThreads(document["threads"].as<JsonArrayConst>());
  } else if (type == "thread") {
    parseThread(document["thread"].as<JsonObjectConst>());
  } else if (type == "status") {
    _status = String(document["status"] | "ready");
  } else if (type == "transcript") {
    const String role = document["role"] | "";
    const String text = document["text"] | "";
    _status = role == "user" ? "Heard: " + text : "Codex: " + text;
  } else if (type == "error") {
    _error = String(document["message"] | "Remote error");
    _status = "Error";
  }
  changed();
}

void RemoteClient::handleEvent(WebsocketsEvent event, const String &data) {
  (void)data;
  if (event == WebsocketsEvent::ConnectionOpened) {
    _connected = true;
    _status = "Ready";
    _error = "";
    listThreads();
  } else if (event == WebsocketsEvent::ConnectionClosed) {
    _connected = false;
    _status = "Reconnecting";
  }
  changed();
}

void RemoteClient::parseThreads(JsonArrayConst threads) {
  _threadCount = 0;
  for (JsonObjectConst item : threads) {
    if (_threadCount >= kMaxThreads) {
      break;
    }
    RemoteThread &target = _threads[_threadCount++];
    target.id = String(item["id"] | "");
    target.title = String(item["title"] | "Untitled");
    target.preview = String(item["preview"] | "");
    target.status = String(item["status"] | "");
  }
}

void RemoteClient::parseThread(JsonObjectConst thread) {
  _activeThreadId = String(thread["id"] | "");
  _activeThreadTitle = String(thread["title"] | "Codex thread");
  _activeThreadBusy = thread["busy"] | false;
  _error = String(thread["error"] | "");
  _messageCount = 0;
  for (JsonObjectConst item : thread["messages"].as<JsonArrayConst>()) {
    if (_messageCount >= kMaxMessages) {
      break;
    }
    RemoteMessage &target = _messages[_messageCount++];
    target.role = String(item["role"] | "");
    target.text = String(item["text"] | "");
    target.status = String(item["status"] | "");
  }
  _status = _activeThreadBusy ? "Working" : "Ready";
}

void RemoteClient::changed() {
  if (_listener) {
    _listener->onRemoteStateChanged();
  }
}
