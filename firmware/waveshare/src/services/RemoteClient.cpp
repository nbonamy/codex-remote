#include "RemoteClient.h"

#include "../diag/Log.h"
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WiFi.h>

using namespace websockets;

void RemoteClient::begin(RemoteClientListener *listener) {
  _listener = listener;
  const uint64_t chipId = ESP.getEfuseMac();
  char deviceId[24];
  snprintf(deviceId, sizeof(deviceId), "esp32-%04x%08x",
           static_cast<unsigned int>(chipId >> 32),
           static_cast<unsigned int>(chipId));
  _deviceId = deviceId;
  _deviceName = "Pocket Remote " + _deviceId.substring(_deviceId.length() - 4);
  loadPairings();

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
  refreshBridges();
  if (!_selectedBridgeId.isEmpty()) {
    connect();
  } else if (strlen(DEVICE_TOKEN) > 0 && _bridgeCount > 0) {
    _selectedBridgeId = _bridges[0].id;
    _selectedBridgeName = _bridges[0].name;
    _currentToken = DEVICE_TOKEN;
    saveSelectedBridge();
    connect();
  } else {
    _status = "Select a bridge";
    changed();
  }
}

void RemoteClient::update() {
  if (_connected) {
    _ws.poll();
    return;
  }
  if (_pairingPending) {
    if (millis() - _lastPairingPollMs >= 1000) {
      pollPairing();
    }
    return;
  }
  if (!_selectingBridge && !_selectedBridgeId.isEmpty() &&
      WiFi.status() == WL_CONNECTED &&
      millis() - _lastConnectAttemptMs >= RECONNECT_INTERVAL_MS) {
    connect();
  }
}

void RemoteClient::connect() {
  _lastConnectAttemptMs = millis();
  if (!resolveSelectedBridge()) {
    _status = "Looking for host";
    changed();
    return;
  }
  if (_currentToken.isEmpty()) {
    _currentToken = tokenForBridge(_selectedBridgeId);
  }
  if (_currentToken.isEmpty()) {
    _status = "Pair this bridge";
    changed();
    return;
  }
  _status = "Connecting";
  _error = "";
  changed();
  configureWebSocket();
  Log::client("Remote", "connecting ws://%s:%d%s", _serverHost.c_str(),
              _serverPort, SERVER_PATH);
  _connected = _ws.connect(_serverHost, _serverPort, SERVER_PATH);
  if (!_connected) {
    _status = "Host unavailable";
    changed();
  }
}

void RemoteClient::configureWebSocket() {
  _ws = WebsocketsClient();
  _ws.addHeader("X-Codex-Remote-Token", _currentToken);
  _ws.onMessage([this](WebsocketsMessage message) { handleMessage(message); });
  _ws.onEvent([this](WebsocketsEvent event, String data) {
    handleEvent(event, data);
  });
}

void RemoteClient::disconnect() {
  if (_connected) {
    _ws.close();
  }
  _connected = false;
}

bool RemoteClient::refreshBridges() {
  _bridgeCount = 0;
  if (strlen(SERVER_HOST) > 0) {
    RemoteBridge &bridge = _bridges[_bridgeCount++];
    bridge.id = "configured";
    bridge.name = "Configured bridge";
    bridge.host = SERVER_HOST;
    bridge.port = SERVER_PORT;
    bridge.paired = strlen(DEVICE_TOKEN) > 0 ||
                    !tokenForBridge(bridge.id).isEmpty();
    bridge.selected = bridge.id == _selectedBridgeId;
    changed();
    return true;
  }
  const int count = MDNS.queryService("codex-remote", "tcp");
  for (int index = 0; index < count && _bridgeCount < kMaxBridges; index++) {
    String bridgeId = MDNS.txt(index, "bridgeId");
    if (bridgeId.isEmpty()) {
      bridgeId = "legacy-" + MDNS.hostname(index);
    }
    bool duplicate = false;
    for (int existing = 0; existing < _bridgeCount; existing++) {
      if (_bridges[existing].id == bridgeId) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      continue;
    }
    RemoteBridge &bridge = _bridges[_bridgeCount++];
    bridge.id = bridgeId;
    bridge.name = MDNS.txt(index, "bridgeName");
    if (bridge.name.isEmpty()) {
      bridge.name = MDNS.instanceName(index);
    }
    if (bridge.name.isEmpty()) {
      bridge.name = MDNS.hostname(index);
    }
    bridge.host = MDNS.address(index).toString();
    bridge.port = MDNS.port(index);
    bridge.paired = !tokenForBridge(bridge.id).isEmpty();
    bridge.selected = bridge.id == _selectedBridgeId;
  }
  changed();
  return _bridgeCount > 0;
}

bool RemoteClient::resolveSelectedBridge() {
  if (_bridgeCount == 0 && !refreshBridges()) {
    return false;
  }
  for (int index = 0; index < _bridgeCount; index++) {
    if (_bridges[index].id == _selectedBridgeId) {
      _serverHost = _bridges[index].host;
      _serverPort = _bridges[index].port;
      _selectedBridgeName = _bridges[index].name;
      return !_serverHost.isEmpty() && _serverPort > 0;
    }
  }
  if (!refreshBridges()) {
    return false;
  }
  for (int index = 0; index < _bridgeCount; index++) {
    if (_bridges[index].id == _selectedBridgeId) {
      _serverHost = _bridges[index].host;
      _serverPort = _bridges[index].port;
      _selectedBridgeName = _bridges[index].name;
      return !_serverHost.isEmpty() && _serverPort > 0;
    }
  }
  return false;
}

void RemoteClient::beginBridgeSelection() {
  disconnect();
  _selectingBridge = true;
  _pairingPending = false;
  _pairingRequestId = "";
  _pairingCode = "";
  _error = "";
  _status = "Discovering bridges";
  changed();
  refreshBridges();
  _status = _bridgeCount > 0 ? "Choose a bridge" : "No bridges found";
  changed();
}

void RemoteClient::cancelBridgeSelection() {
  _selectingBridge = false;
  _pairingPending = false;
  _pairingRequestId = "";
  _pairingCode = "";
  if (!_selectedBridgeId.isEmpty()) {
    connect();
  } else {
    _status = "Select a bridge";
    changed();
  }
}

bool RemoteClient::selectBridge(int index) {
  if (index < 0 || index >= _bridgeCount) {
    return false;
  }
  disconnect();
  const RemoteBridge &bridge = _bridges[index];
  _selectedBridgeId = bridge.id;
  _selectedBridgeName = bridge.name;
  _serverHost = bridge.host;
  _serverPort = bridge.port;
  _currentToken = tokenForBridge(bridge.id);
  if (_currentToken.isEmpty() && bridge.id == "configured" &&
      strlen(DEVICE_TOKEN) > 0) {
    _currentToken = DEVICE_TOKEN;
  }
  saveSelectedBridge();
  for (int item = 0; item < _bridgeCount; item++) {
    _bridges[item].selected = item == index;
  }
  if (!_currentToken.isEmpty()) {
    _selectingBridge = false;
    connect();
    return true;
  }
  return startPairing();
}

bool RemoteClient::startPairing() {
  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(3000);
  if (!http.begin(_serverHost, _serverPort, "/api/v1/pairing/requests")) {
    _status = "Pairing failed";
    _error = "Could not contact bridge";
    changed();
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  JsonDocument request;
  request["deviceId"] = _deviceId;
  request["deviceName"] = _deviceName;
  String body;
  serializeJson(request, body);
  const int statusCode = http.POST(body);
  const String responseBody = http.getString();
  http.end();

  JsonDocument response;
  const DeserializationError parseError =
      deserializeJson(response, responseBody);
  if (statusCode != HTTP_CODE_CREATED || parseError) {
    _status = statusCode == HTTP_CODE_FORBIDDEN
                  ? "Open pairing on Mac"
                  : "Pairing failed";
    _error = parseError ? "Invalid bridge response"
                        : String(response["error"] | "Try again");
    changed();
    return false;
  }
  _pairingRequestId = String(response["requestId"] | "");
  _pairingCode = String(response["code"] | "");
  if (_pairingRequestId.isEmpty() || _pairingCode.isEmpty()) {
    _status = "Pairing failed";
    _error = "Bridge omitted pairing code";
    changed();
    return false;
  }
  _pairingPending = true;
  _lastPairingPollMs = millis();
  _status = "Approve on Mac";
  _error = "";
  changed();
  return true;
}

void RemoteClient::pollPairing() {
  _lastPairingPollMs = millis();
  if (_pairingRequestId.isEmpty()) {
    _pairingPending = false;
    return;
  }
  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(3000);
  const String path = "/api/v1/pairing/requests/" + _pairingRequestId +
                      "?deviceId=" + _deviceId;
  if (!http.begin(_serverHost, _serverPort, path)) {
    return;
  }
  const int statusCode = http.GET();
  const String responseBody = http.getString();
  http.end();
  if (statusCode != HTTP_CODE_OK) {
    return;
  }
  JsonDocument response;
  if (deserializeJson(response, responseBody)) {
    return;
  }
  const String state = response["status"] | "expired";
  if (state == "pending") {
    return;
  }
  if (state == "approved") {
    const String token = response["token"] | "";
    if (token.isEmpty()) {
      _pairingPending = false;
      _status = "Pairing failed";
      _error = "Bridge omitted credential";
      changed();
      return;
    }
    savePairing(_selectedBridgeId, _selectedBridgeName, token);
    _currentToken = token;
    _pairingPending = false;
    _selectingBridge = false;
    _pairingRequestId = "";
    _pairingCode = "";
    _status = "Pairing complete";
    changed();
    connect();
    return;
  }
  _pairingPending = false;
  _pairingRequestId = "";
  _pairingCode = "";
  _status = state == "rejected" ? "Pairing rejected" : "Pairing expired";
  _error = "Select the bridge to try again";
  changed();
}

String RemoteClient::tokenForBridge(const String &bridgeId) const {
  for (int index = 0; index < _pairingCount; index++) {
    if (_pairings[index].id == bridgeId) {
      return _pairings[index].token;
    }
  }
  return "";
}

void RemoteClient::loadPairings() {
  Preferences preferences;
  if (!preferences.begin("codexremote", true)) {
    return;
  }
  _selectedBridgeId = preferences.getString("selected", "");
  const String serialized = preferences.getString("pairings", "[]");
  preferences.end();

  JsonDocument document;
  if (deserializeJson(document, serialized)) {
    return;
  }
  _pairingCount = 0;
  for (JsonObjectConst item : document.as<JsonArrayConst>()) {
    if (_pairingCount >= kMaxBridges) {
      break;
    }
    const String id = item["id"] | "";
    const String token = item["token"] | "";
    if (id.isEmpty() || token.isEmpty()) {
      continue;
    }
    StoredPairing &pairing = _pairings[_pairingCount++];
    pairing.id = id;
    pairing.name = String(item["name"] | "Codex Remote");
    pairing.token = token;
    if (id == _selectedBridgeId) {
      _selectedBridgeName = pairing.name;
      _currentToken = pairing.token;
    }
  }
}

void RemoteClient::savePairing(const String &bridgeId,
                               const String &bridgeName,
                               const String &token) {
  int target = -1;
  for (int index = 0; index < _pairingCount; index++) {
    if (_pairings[index].id == bridgeId) {
      target = index;
      break;
    }
  }
  if (target < 0 && _pairingCount < kMaxBridges) {
    target = _pairingCount++;
  }
  if (target < 0) {
    _error = "Pairing storage is full";
    return;
  }
  _pairings[target].id = bridgeId;
  _pairings[target].name = bridgeName;
  _pairings[target].token = token;
  for (int index = 0; index < _bridgeCount; index++) {
    if (_bridges[index].id == bridgeId) {
      _bridges[index].paired = true;
    }
  }

  JsonDocument document;
  JsonArray pairings = document.to<JsonArray>();
  for (int index = 0; index < _pairingCount; index++) {
    JsonObject pairing = pairings.add<JsonObject>();
    pairing["id"] = _pairings[index].id;
    pairing["name"] = _pairings[index].name;
    pairing["token"] = _pairings[index].token;
  }
  String serialized;
  serializeJson(document, serialized);
  Preferences preferences;
  if (preferences.begin("codexremote", false)) {
    preferences.putString("pairings", serialized);
    preferences.putString("selected", _selectedBridgeId);
    preferences.end();
  }
}

void RemoteClient::saveSelectedBridge() {
  Preferences preferences;
  if (preferences.begin("codexremote", false)) {
    preferences.putString("selected", _selectedBridgeId);
    preferences.end();
  }
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

void RemoteClient::clearActiveThread() {
  _activeThreadId = "";
  _activeThreadTitle = "";
  _activeThreadBusy = false;
  _messageCount = 0;
  _error = "";
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
    target.id = String(item["id"] | "");
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
