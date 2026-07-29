#pragma once

#include "../Config.h"
#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>

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
  const RemoteThread &thread(int index) const { return _threads[index]; }
  const RemoteMessage &message(int index) const { return _messages[index]; }

  bool createThread();
  bool openThread(const String &threadId);
  bool listThreads();
  bool startAudio(const String &threadId);
  bool sendAudio(const uint8_t *data, size_t length);
  bool endAudio();
  bool interrupt(const String &threadId);
  void clearActiveThread();

private:
  websockets::WebsocketsClient _ws;
  RemoteClientListener *_listener = nullptr;
  RemoteThread _threads[kMaxThreads];
  RemoteMessage _messages[kMaxMessages];
  int _threadCount = 0;
  int _messageCount = 0;
  bool _connected = false;
  bool _activeThreadBusy = false;
  String _activeThreadId;
  String _activeThreadTitle;
  String _status = "Offline";
  String _error;
  String _serverHost;
  int _serverPort = SERVER_PORT;
  unsigned long _lastConnectAttemptMs = 0;

  void connect();
  bool discoverServer();
  bool sendControl(JsonDocument &document);
  void handleMessage(websockets::WebsocketsMessage message);
  void handleEvent(websockets::WebsocketsEvent event, const String &data);
  void parseThreads(JsonArrayConst threads);
  void parseThread(JsonObjectConst thread);
  void changed();
};
