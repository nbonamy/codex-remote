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
  if (strlen(SERVER_HOST) == 0 && _selectedAgentKey.startsWith("configured")) {
    _selectedAgentKey = "";
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
  refreshDiscovery();
  if (strlen(SERVER_HOST) > 0 && _agentCount == 1 &&
      _selectedAgentKey.isEmpty()) {
    selectAgent(0);
  } else if (!_selectedAgentKey.isEmpty()) {
    connect();
  } else {
    _status = _agentCount > 0 ? "Host found" : "Waiting for host";
    changed();
  }
}

void RemoteClient::update() {
  if (_connected) {
    if (_ws) {
      _ws->poll();
    }
    return;
  }
  if (_pairingPending) {
    if (millis() - _lastPairingPollMs >= 1000) {
      pollPairing();
    }
    return;
  }
  if (!_selectingAgent && !_selectedAgentKey.isEmpty() &&
      WiFi.status() == WL_CONNECTED &&
      millis() - _lastConnectAttemptMs >= RECONNECT_INTERVAL_MS) {
    connect();
    return;
  }
  if (_selectingAgent && _selectedAgentKey.isEmpty() && _agentCount == 0 &&
      _hostCount > 0 &&
      WiFi.status() == WL_CONNECTED &&
      millis() - _lastPairingAttemptMs >= PAIRING_RETRY_INTERVAL_MS) {
    pairHost(0);
    return;
  }
  if (_selectedAgentKey.isEmpty() && WiFi.status() == WL_CONNECTED &&
      millis() - _lastDiscoveryRefreshMs >= DISCOVERY_REFRESH_INTERVAL_MS) {
    refreshDiscovery();
    _status = _hostCount > 0
                  ? (_selectingAgent ? "Choose an agent" : "Host found")
                  : (_selectingAgent ? "No agents found" : "Waiting for host");
    changed();
  }
}

void RemoteClient::connect() {
  _lastConnectAttemptMs = millis();
  if (!resolveSelectedAgent()) {
    _status = "Looking for host";
    changed();
    return;
  }
  if (_currentToken.isEmpty()) {
    _currentToken = tokenForHost(_selectedHostId);
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
      "/api/v1/agents/" + _selectedAgentId + "/device";
  Log::client("Remote", "connecting ws://%s:%d%s", _hostAddress.c_str(),
              _serverPort, path.c_str());
  _connected = _ws && _ws->connect(_hostAddress, _serverPort, path);
  if (!_connected) {
    _status = "Host unavailable";
    changed();
  }
}

void RemoteClient::configureWebSocket() {
  if (_ws) {
    _ws->close();
  }
  _ws.reset(new WebsocketsClient());
  _ws->addHeader("X-Codex-Remote-Token", _currentToken);
  _ws->onMessage([this](WebsocketsMessage message) { handleMessage(message); });
  _ws->onEvent([this](WebsocketsEvent event, String data) {
    handleEvent(event, data);
  });
}

void RemoteClient::disconnect() {
  if (_ws) {
    _ws->close();
    _ws.reset();
  }
  _connected = false;
}

bool RemoteClient::refreshDiscovery() {
  _lastDiscoveryRefreshMs = millis();
  _hostCount = 0;
  _agentCount = 0;
  if (strlen(SERVER_HOST) > 0) {
    Log::client("Remote", "refreshing configured host %s:%d",
                SERVER_HOST, SERVER_PORT);
    appendAgentsForHost("configured", "Configured host", SERVER_HOST,
                        SERVER_PORT);
    Log::client("Remote", "configured host returned %d agents", _agentCount);
    changed();
    return _hostCount > 0;
  }
  const int count = MDNS.queryService("codex-remote", "tcp");
  Log::client("Remote", "mDNS returned %d services", count);
  String discoveredIds[kMaxAgents];
  int discoveredCount = 0;
  for (int index = 0; index < count && _agentCount < kMaxAgents; index++) {
    String hostId = MDNS.txt(index, "hostId");
    if (hostId.isEmpty()) {
      continue;
    }
    bool duplicate = false;
    for (int existing = 0; existing < discoveredCount; existing++) {
      if (discoveredIds[existing] == hostId) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      continue;
    }
    if (discoveredCount < kMaxAgents) {
      discoveredIds[discoveredCount++] = hostId;
    }
    String hostName = MDNS.txt(index, "hostName");
    if (hostName.isEmpty()) {
      hostName = MDNS.instanceName(index);
    }
    if (hostName.isEmpty()) {
      hostName = MDNS.hostname(index);
    }
    appendAgentsForHost(hostId, hostName, MDNS.address(index).toString(),
                        MDNS.port(index));
  }
  changed();
  return _hostCount > 0;
}

bool RemoteClient::appendAgentsForHost(const String &hostId,
                                       const String &hostName,
                                       const String &hostAddress,
                                       int serverPort) {
  if (_hostCount >= kMaxHosts) {
    return false;
  }
  const String storedToken = tokenForHost(hostId);
  RemoteHost &host = _hosts[_hostCount++];
  host.id = hostId;
  host.name = hostName;
  host.address = hostAddress;
  host.port = serverPort;
  host.paired = !storedToken.isEmpty();
  String authorizationToken = storedToken;
  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(3000);
  if (!http.begin(hostAddress, serverPort, "/api/v1/agents")) {
    return false;
  }
  if (!authorizationToken.isEmpty()) {
    http.addHeader("X-Codex-Remote-Token", authorizationToken);
  }
  const int statusCode = http.GET();
  const String responseBody = http.getString();
  http.end();
  Log::client("Remote", "GET http://%s:%d/api/v1/agents -> %d (%s)",
              hostAddress.c_str(), serverPort, statusCode,
              responseBody.substring(0, 160).c_str());
  if (statusCode == HTTP_CODE_UNAUTHORIZED) {
    if (!storedToken.isEmpty()) {
      clearRevokedPairing(hostId);
    }
    host.paired = false;
    return true;
  }
  JsonDocument response;
  if (statusCode != HTTP_CODE_OK || deserializeJson(response, responseBody)) {
    return false;
  }
  host.paired = true;

  int added = 0;
  for (JsonObjectConst item : response["agents"].as<JsonArrayConst>()) {
    if (_agentCount >= kMaxAgents) {
      break;
    }
    const String agentId = item["id"] | "";
    if (agentId.isEmpty()) {
      continue;
    }
    RemoteAgent &agent = _agents[_agentCount++];
    agent.key = hostId + "|" + agentId;
    agent.name = String(item["name"] | agentId);
    agent.hostId = hostId;
    agent.hostName = hostName;
    agent.agentId = agentId;
    agent.address = hostAddress;
    agent.port = serverPort;
    agent.paired = true;
    agent.selected = agent.key == _selectedAgentKey;
    added++;
  }
  return true;
}

bool RemoteClient::applySelectedAgent(const RemoteAgent &agent) {
  _selectedAgentKey = agent.key;
  _selectedHostId = agent.hostId;
  _selectedHostName = agent.hostName;
  _selectedAgentId = agent.agentId;
  _selectedAgentName = agent.name;
  _hostAddress = agent.address;
  _serverPort = agent.port;
  return !_hostAddress.isEmpty() && _serverPort > 0 &&
         !_selectedAgentId.isEmpty();
}

void RemoteClient::clearRevokedPairing(const String &hostId) {
  const bool selected =
      _selectedHostId == hostId ||
      _selectedAgentKey.startsWith(hostId + "|");
  if (selected) {
    _selectedAgentKey = "";
    _selectedHostId = "";
    _selectedHostName = "";
    _selectedAgentId = "";
    _selectedAgentName = "";
    _hostAddress = "";
    _currentToken = "";
    _selectingAgent = true;
    _threadCount = 0;
    clearActiveThread();
  }
  forgetPairing(hostId);
  if (selected) {
    _status = "Access revoked";
    _error = "Choose the host to pair again";
  }
}

bool RemoteClient::resolveSelectedAgent() {
  if (_agentCount == 0 && !refreshDiscovery()) {
    return false;
  }
  for (int index = 0; index < _agentCount; index++) {
    if (_agents[index].key == _selectedAgentKey) {
      return applySelectedAgent(_agents[index]);
    }
  }
  if (!refreshDiscovery()) {
    return false;
  }
  for (int index = 0; index < _agentCount; index++) {
    if (_agents[index].key == _selectedAgentKey) {
      return applySelectedAgent(_agents[index]);
    }
  }
  return false;
}

void RemoteClient::beginAgentSelection() {
  _selectingAgent = true;
  _pairingPending = false;
  _pairingRequestId = "";
  _pairingCode = "";
  _error = "";
  if (_agentCount > 0) {
    _status = "Choose an agent";
    changed();
    return;
  }
  if (_hostCount > 0) {
    _status = "Contacting host";
    changed();
    pairHost(0);
    return;
  }
  _status = "Discovering hosts";
  changed();
  refreshDiscovery();
  if (_agentCount > 0) {
    _status = "Choose an agent";
  } else if (_hostCount > 0) {
    pairHost(0);
    return;
  } else {
    _status = "No hosts found";
  }
  changed();
}

void RemoteClient::cancelPairing() {
  if (!_pairingPending) {
    return;
  }
  _pairingPending = false;
  _pairingRequestId = "";
  _pairingCode = "";
  _selectingAgent = true;
  _error = "";
  _status = "Choose an agent";
  changed();
  refreshDiscovery();
}

void RemoteClient::endAgentSelection() {
  _pairingPending = false;
  _pairingRequestId = "";
  _pairingCode = "";
  _selectingAgent = false;
  _error = "";
  if (_connected) {
    _status = "Ready";
    changed();
    return;
  }
  if (_selectedAgentKey.isEmpty()) {
    _status = "Select an agent";
    changed();
    return;
  }
  connect();
}

bool RemoteClient::checkPairing() {
  if (!_pairingPending) {
    return false;
  }
  pollPairing();
  return true;
}

bool RemoteClient::selectAgent(int index) {
  if (index < 0 || index >= _agentCount) {
    return false;
  }
  disconnect();
  const RemoteAgent &agent = _agents[index];
  _selectedAgentKey = agent.key;
  _selectedHostId = agent.hostId;
  _selectedHostName = agent.hostName;
  _selectedAgentId = agent.agentId;
  _selectedAgentName = agent.name;
  _hostAddress = agent.address;
  _serverPort = agent.port;
  _currentToken = tokenForHost(agent.hostId);
  saveSelectedAgent();
  for (int item = 0; item < _agentCount; item++) {
    _agents[item].selected = item == index;
  }
  if (!_currentToken.isEmpty()) {
    _selectingAgent = false;
    connect();
    return true;
  }
  return startPairing();
}

bool RemoteClient::pairHost(int index) {
  if (index < 0 || index >= _hostCount) {
    return false;
  }
  disconnect();
  const RemoteHost &host = _hosts[index];
  _selectedAgentKey = "";
  _selectedHostId = host.id;
  _selectedHostName = host.name;
  _selectedAgentId = "";
  _selectedAgentName = "";
  _hostAddress = host.address;
  _serverPort = host.port;
  _currentToken = "";
  return startPairing();
}

bool RemoteClient::startPairing() {
  _lastPairingAttemptMs = millis();
  HTTPClient http;
  http.setConnectTimeout(2500);
  http.setTimeout(3000);
  if (!http.begin(_hostAddress, _serverPort, "/api/v1/pairing/requests")) {
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
                  ? "Open pairing on host"
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
  const String responseHostId = String(response["hostId"] | "");
  const String responseHostName = String(response["hostName"] | "");
  if (!responseHostId.isEmpty()) {
    _selectedHostId = responseHostId;
    if (!responseHostName.isEmpty()) {
      _selectedHostName = responseHostName;
    }
    if (!_selectedAgentId.isEmpty()) {
      _selectedAgentKey = responseHostId + "|" + _selectedAgentId;
      for (int index = 0; index < _agentCount; index++) {
        if (_agents[index].agentId != _selectedAgentId) continue;
        _agents[index].hostId = responseHostId;
        _agents[index].hostName = _selectedHostName;
        _agents[index].key = _selectedAgentKey;
      }
      saveSelectedAgent();
    }
  }
  _pairingPending = true;
  _lastPairingPollMs = millis();
  _status = "Approve on host";
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
  if (!http.begin(_hostAddress, _serverPort, path)) {
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
    savePairing(_selectedHostId, _selectedHostName, token);
    _currentToken = token;
    _pairingPending = false;
    _selectingAgent = true;
    _pairingRequestId = "";
    _pairingCode = "";
    _status = "Pairing complete";
    changed();
    refreshDiscovery();
    _status = _agentCount > 0 ? "Choose an agent" : "No agents found";
    changed();
    return;
  }
  _pairingPending = false;
  _pairingRequestId = "";
  _pairingCode = "";
  _status = state == "rejected" ? "Pairing rejected" : "Pairing expired";
  _error = "Select the host to try again";
  changed();
}

String RemoteClient::tokenForHost(const String &hostId) const {
  for (int index = 0; index < _pairingCount; index++) {
    if (_pairings[index].id == hostId) {
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
  _selectedAgentKey = preferences.getString("selected", "");
  const String serialized = preferences.getString("pairings", "[]");
  preferences.end();

  JsonDocument document;
  if (deserializeJson(document, serialized)) {
    return;
  }
  _pairingCount = 0;
  for (JsonObjectConst item : document.as<JsonArrayConst>()) {
    if (_pairingCount >= kMaxAgents) {
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

void RemoteClient::savePairing(const String &hostId,
                               const String &hostName,
                               const String &token) {
  int target = -1;
  for (int index = 0; index < _pairingCount; index++) {
    if (_pairings[index].id == hostId) {
      target = index;
      break;
    }
  }
  if (target < 0 && _pairingCount < kMaxAgents) {
    target = _pairingCount++;
  }
  if (target < 0) {
    _error = "Pairing storage is full";
    return;
  }
  _pairings[target].id = hostId;
  _pairings[target].name = hostName;
  _pairings[target].token = token;
  for (int index = 0; index < _agentCount; index++) {
    if (_agents[index].hostId == hostId) {
      _agents[index].paired = true;
    }
  }
  for (int index = 0; index < _hostCount; index++) {
    if (_hosts[index].id == hostId) {
      _hosts[index].paired = true;
    }
  }

  persistPairings();
}

void RemoteClient::forgetPairing(const String &hostId) {
  int writeIndex = 0;
  for (int readIndex = 0; readIndex < _pairingCount; readIndex++) {
    if (_pairings[readIndex].id == hostId) continue;
    if (writeIndex != readIndex) _pairings[writeIndex] = _pairings[readIndex];
    writeIndex++;
  }
  _pairingCount = writeIndex;
  for (int index = 0; index < _agentCount; index++) {
    if (_agents[index].hostId == hostId) _agents[index].paired = false;
  }
  for (int index = 0; index < _hostCount; index++) {
    if (_hosts[index].id == hostId) _hosts[index].paired = false;
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
    preferences.putString("selected", _selectedAgentKey);
    preferences.end();
  }
}

void RemoteClient::saveSelectedAgent() {
  Preferences preferences;
  if (preferences.begin("codexremote", false)) {
    preferences.putString("selected", _selectedAgentKey);
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
  return _connected && _ws &&
         _ws->sendBinary(reinterpret_cast<const char *>(data), length);
}

bool RemoteClient::endAudio() {
  JsonDocument document;
  document["type"] = "audio_end";
  return sendControl(document);
}

bool RemoteClient::cancelAudio() {
  JsonDocument document;
  document["type"] = "audio_cancel";
  return sendControl(document);
}

bool RemoteClient::interrupt(const String &threadId) {
  JsonDocument document;
  document["type"] = "interrupt";
  document["threadId"] = threadId;
  return sendControl(document);
}

bool RemoteClient::speakMessage(const String &threadId,
                                const String &messageId) {
  JsonDocument document;
  document["type"] = "speak_message";
  document["threadId"] = threadId;
  document["messageId"] = messageId;
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
  return _ws && _ws->send(body);
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
    const String agentId = document["agentId"] | "";
    const String agentName = document["agentName"] | "";
    if (!agentId.isEmpty()) {
      _selectedAgentId = agentId;
    }
    if (!agentName.isEmpty()) {
      _selectedAgentName = agentName;
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
    if (_ws && _ws->getCloseReason() == CloseReason_PolicyViolation) {
      const String revokedHostId = _selectedHostId;
      clearRevokedPairing(revokedHostId);
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
