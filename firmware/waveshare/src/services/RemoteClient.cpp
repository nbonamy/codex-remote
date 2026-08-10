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
  if (strlen(SERVER_HOST) == 0 && _selectedBridgeId.startsWith("configured")) {
    _selectedBridgeId = "";
    forgetPairing("configured");
  }

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
  if (strlen(SERVER_HOST) > 0 && _bridgeCount == 1 &&
      _selectedBridgeId.isEmpty()) {
    selectBridge(0);
  } else if (!_selectedBridgeId.isEmpty()) {
    connect();
  } else if (strlen(DEVICE_TOKEN) > 0 && _bridgeCount > 0) {
    _selectedBridgeId = _bridges[0].id;
    _selectedBridgeName = _bridges[0].routerName;
    _selectedRouterId = _bridges[0].routerId;
    _selectedRouterName = _bridges[0].routerName;
    _selectedHostId = _bridges[0].hostId;
    _selectedHostName = _bridges[0].name;
    _currentToken = DEVICE_TOKEN;
    saveSelectedBridge();
    connect();
  } else {
    _status = "Select a host";
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
    _currentToken = tokenForBridge(_selectedRouterId);
  }
  if (_currentToken.isEmpty()) {
    _status = "Pair this host";
    changed();
    return;
  }
  _status = "Connecting";
  _error = "";
  changed();
  configureWebSocket();
  const String path =
      "/api/v1/hosts/" + _selectedHostId + "/device";
  Log::client("Remote", "connecting ws://%s:%d%s", _serverHost.c_str(),
              _serverPort, path.c_str());
  _connected = _ws.connect(_serverHost, _serverPort, path);
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
    Log::client("Remote", "refreshing configured host %s:%d",
                SERVER_HOST, SERVER_PORT);
    appendHostsForBridge("configured", "Configured computer", SERVER_HOST,
                         SERVER_PORT);
    Log::client("Remote", "configured host returned %d entries", _bridgeCount);
    changed();
    return _bridgeCount > 0;
  }
  const int count = MDNS.queryService("codex-remote", "tcp");
  Log::client("Remote", "mDNS returned %d services", count);
  String discoveredIds[kMaxBridges];
  int discoveredCount = 0;
  for (int index = 0; index < count && _bridgeCount < kMaxBridges; index++) {
    String routerId = MDNS.txt(index, "bridgeId");
    if (routerId.isEmpty()) {
      routerId = "legacy-" + MDNS.hostname(index);
    }
    bool duplicate = false;
    for (int existing = 0; existing < discoveredCount; existing++) {
      if (discoveredIds[existing] == routerId) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      continue;
    }
    if (discoveredCount < kMaxBridges) {
      discoveredIds[discoveredCount++] = routerId;
    }
    String routerName = MDNS.txt(index, "bridgeName");
    if (routerName.isEmpty()) {
      routerName = MDNS.instanceName(index);
    }
    if (routerName.isEmpty()) {
      routerName = MDNS.hostname(index);
    }
    appendHostsForBridge(routerId, routerName,
                         MDNS.address(index).toString(), MDNS.port(index));
  }
  changed();
  return _bridgeCount > 0;
}

bool RemoteClient::appendHostsForBridge(const String &routerId,
                                        const String &routerName,
                                        const String &serverHost,
                                        int serverPort) {
  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(3000);
  if (!http.begin(serverHost, serverPort, "/api/v1/hosts")) {
    return false;
  }
  const int statusCode = http.GET();
  const String responseBody = http.getString();
  http.end();
  Log::client("Remote", "GET http://%s:%d/api/v1/hosts -> %d (%s)",
              serverHost.c_str(), serverPort, statusCode,
              responseBody.substring(0, 160).c_str());
  JsonDocument response;
  if (statusCode != HTTP_CODE_OK || deserializeJson(response, responseBody)) {
    return false;
  }

  int added = 0;
  for (JsonObjectConst item : response["hosts"].as<JsonArrayConst>()) {
    if (_bridgeCount >= kMaxBridges) {
      break;
    }
    const String hostId = item["id"] | "";
    if (hostId.isEmpty()) {
      continue;
    }
    RemoteBridge &bridge = _bridges[_bridgeCount++];
    bridge.id = routerId + "|" + hostId;
    bridge.name = String(item["name"] | hostId);
    bridge.routerId = routerId;
    bridge.routerName = routerName;
    bridge.hostId = hostId;
    bridge.host = serverHost;
    bridge.port = serverPort;
    bridge.paired = strlen(DEVICE_TOKEN) > 0 ||
                    !tokenForBridge(routerId).isEmpty();
    bridge.selected =
        bridge.id == _selectedBridgeId ||
        (added == 0 && routerId == _selectedBridgeId);
    added++;
  }
  return added > 0;
}

bool RemoteClient::applySelectedBridge(const RemoteBridge &bridge) {
  const bool migratedSelection = _selectedBridgeId == bridge.routerId;
  _selectedBridgeId = bridge.id;
  _selectedBridgeName = bridge.routerName;
  _selectedRouterId = bridge.routerId;
  _selectedRouterName = bridge.routerName;
  _selectedHostId = bridge.hostId;
  _selectedHostName = bridge.name;
  _serverHost = bridge.host;
  _serverPort = bridge.port;
  if (migratedSelection) {
    saveSelectedBridge();
  }
  return !_serverHost.isEmpty() && _serverPort > 0 &&
         !_selectedHostId.isEmpty();
}

bool RemoteClient::resolveSelectedBridge() {
  if (_bridgeCount == 0 && !refreshBridges()) {
    return false;
  }
  for (int index = 0; index < _bridgeCount; index++) {
    if (_bridges[index].id == _selectedBridgeId ||
        _bridges[index].routerId == _selectedBridgeId) {
      return applySelectedBridge(_bridges[index]);
    }
  }
  if (!refreshBridges()) {
    return false;
  }
  for (int index = 0; index < _bridgeCount; index++) {
    if (_bridges[index].id == _selectedBridgeId ||
        _bridges[index].routerId == _selectedBridgeId) {
      return applySelectedBridge(_bridges[index]);
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
  _selectedBridgeId = "";
  _selectedBridgeName = "";
  _selectedRouterId = "";
  _selectedRouterName = "";
  _selectedHostId = "";
  _selectedHostName = "";
  _currentToken = "";
  saveSelectedBridge();
  _error = "";
  _status = "Discovering hosts";
  changed();
  refreshBridges();
  _status = _bridgeCount > 0 ? "Choose a host" : "No hosts found";
  changed();
}

bool RemoteClient::selectBridge(int index) {
  if (index < 0 || index >= _bridgeCount) {
    return false;
  }
  disconnect();
  const RemoteBridge &bridge = _bridges[index];
  _selectedBridgeId = bridge.id;
  _selectedBridgeName = bridge.routerName;
  _selectedRouterId = bridge.routerId;
  _selectedRouterName = bridge.routerName;
  _selectedHostId = bridge.hostId;
  _selectedHostName = bridge.name;
  _serverHost = bridge.host;
  _serverPort = bridge.port;
  _currentToken = tokenForBridge(bridge.routerId);
  if (_currentToken.isEmpty() && bridge.routerId == "configured" &&
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
    _error = "Could not contact host";
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
    _error = parseError ? "Invalid host response"
                        : String(response["error"] | "Try again");
    changed();
    return false;
  }
  _pairingRequestId = String(response["requestId"] | "");
  _pairingCode = String(response["code"] | "");
  if (_pairingRequestId.isEmpty() || _pairingCode.isEmpty()) {
    _status = "Pairing failed";
    _error = "Host omitted pairing code";
    changed();
    return false;
  }
  const String responseBridgeId = String(response["bridgeId"] | "");
  const String responseBridgeName = String(response["bridgeName"] | "");
  if (!responseBridgeId.isEmpty()) {
    _selectedRouterId = responseBridgeId;
    if (!responseBridgeName.isEmpty()) {
      _selectedRouterName = responseBridgeName;
      _selectedBridgeName = responseBridgeName;
    }
    _selectedBridgeId = responseBridgeId + "|" + _selectedHostId;
    for (int index = 0; index < _bridgeCount; index++) {
      if (_bridges[index].hostId != _selectedHostId) continue;
      _bridges[index].routerId = responseBridgeId;
      _bridges[index].routerName = _selectedRouterName;
      _bridges[index].id = _selectedBridgeId;
    }
    saveSelectedBridge();
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
      _error = "Host omitted credential";
      changed();
      return;
    }
    savePairing(_selectedRouterId, _selectedRouterName, token);
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
  _error = "Select the host to try again";
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
    if (_bridges[index].routerId == bridgeId) {
      _bridges[index].paired = true;
    }
  }

  persistPairings();
}

void RemoteClient::forgetPairing(const String &bridgeId) {
  int writeIndex = 0;
  for (int readIndex = 0; readIndex < _pairingCount; readIndex++) {
    if (_pairings[readIndex].id == bridgeId) continue;
    if (writeIndex != readIndex) _pairings[writeIndex] = _pairings[readIndex];
    writeIndex++;
  }
  _pairingCount = writeIndex;
  for (int index = 0; index < _bridgeCount; index++) {
    if (_bridges[index].routerId == bridgeId) _bridges[index].paired = false;
  }
  persistPairings();
}

void RemoteClient::persistPairings() {
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
    const String hostId = document["hostId"] | "";
    const String hostName = document["hostName"] | "";
    if (!hostId.isEmpty()) {
      _selectedHostId = hostId;
    }
    if (!hostName.isEmpty()) {
      _selectedHostName = hostName;
    }
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
    if (_ws.getCloseReason() == CloseReason_PolicyViolation) {
      const String revokedRouterId = _selectedRouterId;
      _selectedBridgeId = "";
      _selectedBridgeName = "";
      _selectedRouterId = "";
      _selectedRouterName = "";
      _selectedHostId = "";
      _selectedHostName = "";
      _currentToken = "";
      _selectingBridge = true;
      forgetPairing(revokedRouterId);
      _status = "Access revoked";
      _error = "Choose the Mac to pair again";
    } else {
      _status = "Reconnecting";
    }
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
