#pragma once

#include "../Config.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <Preferences.h>

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

struct RemoteBridge {
  String id;
  String name;
  String routerId;
  String routerName;
  String hostId;
  String host;
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
  static constexpr int kMaxBridges = 8;

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
  int bridgeCount() const { return _bridgeCount; }
  const RemoteThread &thread(int index) const { return _threads[index]; }
  const RemoteMessage &message(int index) const { return _messages[index]; }
  const RemoteBridge &bridge(int index) const { return _bridges[index]; }
  bool pairingPending() const { return _pairingPending; }
  bool selectingBridge() const { return _selectingBridge; }
  const String &pairingCode() const { return _pairingCode; }
  const String &selectedBridgeName() const { return _selectedBridgeName; }
  const String &selectedHostName() const { return _selectedHostName; }

  bool createThread();
  bool openThread(const String &threadId);
  bool listThreads();
  bool startAudio(const String &threadId);
  bool sendAudio(const uint8_t *data, size_t length);
  bool endAudio();
  bool cancelAudio();
  bool interrupt(const String &threadId);
  bool speakMessage(const String &threadId, const String &messageId);
  void clearActiveThread();
  void beginBridgeSelection();
  void cancelPairing();
  void endBridgeSelection();
  bool checkPairing();
  bool refreshBridges();
  bool selectBridge(int index);

private:
  struct StoredPairing {
    String id;
    String name;
    String token;
  };

  websockets::WebsocketsClient _ws;
  RemoteClientListener *_listener = nullptr;
  RemoteThread _threads[kMaxThreads];
  RemoteMessage _messages[kMaxMessages];
  RemoteBridge _bridges[kMaxBridges];
  StoredPairing _pairings[kMaxBridges];
  int _threadCount = 0;
  int _messageCount = 0;
  int _bridgeCount = 0;
  int _pairingCount = 0;
  bool _connected = false;
  bool _selectingBridge = false;
  bool _pairingPending = false;
  bool _activeThreadBusy = false;
  String _activeThreadId;
  String _activeThreadTitle;
  String _status = "Offline";
  String _error;
  String _deviceId;
  String _deviceName;
  String _selectedBridgeId;
  String _selectedBridgeName;
  String _selectedRouterId;
  String _selectedRouterName;
  String _selectedHostId;
  String _selectedHostName;
  String _currentToken;
  String _pairingRequestId;
  String _pairingCode;
  String _serverHost;
  int _serverPort = SERVER_PORT;
  unsigned long _lastConnectAttemptMs = 0;
  unsigned long _lastPairingPollMs = 0;

  void connect();
  void configureWebSocket();
  void disconnect();
  bool resolveSelectedBridge();
  bool applySelectedBridge(const RemoteBridge &bridge);
  void clearRevokedPairing(const String &routerId);
  bool appendHostsForBridge(const String &routerId,
                            const String &routerName,
                            const String &serverHost, int serverPort);
  bool startPairing();
  void pollPairing();
  String tokenForBridge(const String &bridgeId) const;
  void loadPairings();
  void savePairing(const String &bridgeId, const String &bridgeName,
                   const String &token);
  void forgetPairing(const String &bridgeId);
  void persistPairings();
  void saveSelectedBridge();
  bool sendControl(JsonDocument &document);
  void handleMessage(websockets::WebsocketsMessage message);
  void handleEvent(websockets::WebsocketsEvent event, const String &data);
  void parseThreads(JsonArrayConst threads);
  void parseThread(JsonObjectConst thread);
  void changed();
};
