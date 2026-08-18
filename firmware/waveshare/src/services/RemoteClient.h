#pragma once

#include "../Config.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <Preferences.h>
#include <memory>

struct RemoteThread {
  String id;
  String title;
  String preview;
  String status;
};

struct RemoteMessage {
  String id;
  String role;
  String text;
  String status;
};

struct RemoteHost {
  String id;
  String name;
  String address;
  int port;
  bool paired;
};

struct RemoteAgent {
  String key;
  String name;
  String hostId;
  String hostName;
  String agentId;
  String address;
  int port;
  bool paired;
  bool selected;
};

class RemoteClientListener {
public:
  virtual ~RemoteClientListener() = default;
  virtual void onRemoteStateChanged() = 0;
  virtual void onRemoteAudio(const uint8_t *data, size_t length) = 0;
};

class RemoteClient {
public:
  static constexpr int kMaxThreads = 12;
  static constexpr int kMaxMessages = 14;
  static constexpr int kMaxHosts = 8;
  static constexpr int kMaxAgents = 8;

  void begin(RemoteClientListener *listener);
  void update();

  bool connected() const { return _connected; }
  const String &status() const { return _status; }
  const String &error() const { return _error; }
  const String &activeThreadId() const { return _activeThreadId; }
  const String &activeThreadTitle() const { return _activeThreadTitle; }
  bool activeThreadBusy() const { return _activeThreadBusy; }
  int threadCount() const { return _threadCount; }
  int messageCount() const { return _messageCount; }
  int hostCount() const { return _hostCount; }
  int agentCount() const { return _agentCount; }
  const RemoteThread &thread(int index) const { return _threads[index]; }
  const RemoteMessage &message(int index) const { return _messages[index]; }
  const RemoteHost &host(int index) const { return _hosts[index]; }
  const RemoteAgent &agent(int index) const { return _agents[index]; }
  bool pairingPending() const { return _pairingPending; }
  bool selectingAgent() const { return _selectingAgent; }
  const String &pairingCode() const { return _pairingCode; }
  const String &selectedHostName() const { return _selectedHostName; }
  const String &selectedAgentName() const { return _selectedAgentName; }

  bool createThread();
  bool openVoiceChat();
  bool openThread(const String &threadId);
  bool closeThread();
  bool listThreads();
  bool startAudio(const String &threadId, bool realtime);
  bool sendAudio(const uint8_t *data, size_t length);
  bool endAudio();
  bool cancelAudio();
  bool interrupt(const String &threadId);
  bool speakMessage(const String &threadId, const String &messageId);
  void clearActiveThread();
  void beginAgentSelection();
  void cancelPairing();
  void endAgentSelection();
  bool checkPairing();
  bool refreshDiscovery();
  bool pairHost(int index);
  bool selectAgent(int index);

private:
  struct StoredPairing {
    String id;
    String name;
    String token;
  };

  struct StoredVoiceChat {
    String agentKey;
    String threadId;
  };

  std::unique_ptr<websockets::WebsocketsClient> _ws;
  RemoteClientListener *_listener = nullptr;
  RemoteThread _threads[kMaxThreads];
  RemoteMessage _messages[kMaxMessages];
  RemoteHost _hosts[kMaxHosts];
  RemoteAgent _agents[kMaxAgents];
  StoredPairing _pairings[kMaxAgents];
  StoredVoiceChat _voiceChats[kMaxAgents];
  int _threadCount = 0;
  int _messageCount = 0;
  int _hostCount = 0;
  int _agentCount = 0;
  int _pairingCount = 0;
  int _voiceChatCount = 0;
  bool _connected = false;
  bool _selectingAgent = false;
  bool _pairingPending = false;
  bool _activeThreadBusy = false;
  bool _openingVoiceChat = false;
  String _activeThreadId;
  String _activeThreadTitle;
  String _status = "Offline";
  String _error;
  String _deviceId;
  String _deviceName;
  String _selectedAgentKey;
  String _selectedHostId;
  String _selectedHostName;
  String _selectedAgentId;
  String _selectedAgentName;
  String _currentToken;
  String _pairingRequestId;
  String _pairingCode;
  String _hostAddress;
  int _serverPort = SERVER_PORT;
  unsigned long _lastConnectAttemptMs = 0;
  unsigned long _lastPairingAttemptMs = 0;
  unsigned long _lastPairingPollMs = 0;
  unsigned long _lastDiscoveryRefreshMs = 0;

  void connect();
  void configureWebSocket();
  void disconnect();
  bool resolveSelectedAgent();
  bool applySelectedAgent(const RemoteAgent &agent);
  void clearRevokedPairing(const String &hostId);
  bool appendAgentsForHost(const String &hostId,
                           const String &hostName,
                           const String &hostAddress, int serverPort);
  bool startPairing();
  void pollPairing();
  String tokenForHost(const String &hostId) const;
  void loadPairings();
  void savePairing(const String &hostId, const String &hostName,
                   const String &token);
  void forgetPairing(const String &hostId);
  void persistPairings();
  String voiceChatThreadId() const;
  void saveVoiceChatThreadId(const String &threadId);
  void persistVoiceChats();
  void saveSelectedAgent();
  bool sendControl(JsonDocument &document);
  void handleMessage(websockets::WebsocketsMessage message);
  void handleEvent(websockets::WebsocketsEvent event, const String &data);
  void parseThreads(JsonArrayConst threads);
  void parseThread(JsonObjectConst thread);
  void changed();
};
