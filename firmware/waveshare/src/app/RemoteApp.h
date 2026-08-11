#pragma once

#include "../services/AudioService.h"
#include "../services/RemoteClient.h"

class RemoteApp : public RemoteClientListener {
public:
  bool begin();
  void update();

  void onRemoteStateChanged() override;
  void onRemoteAudio(const uint8_t *data, size_t length) override;

private:
  enum class View {
    Threads,
    Conversation,
    Agents,
    Settings,
  };

  RemoteClient _client;
  AudioService _audio;
  View _view = View::Threads;
  View _settingsReturnView = View::Threads;
  int _threadOffset = 0;
  int _agentPage = 0;
  int _agentFocusIndex = 0;
  String _readerMessageId;
  int _readerPage = 0;
  bool _awaitingResponse = false;
  String _responseBaselineId;
  bool _recording = false;
  bool _bootPrevious = false;
  bool _powerPrevious = false;
  bool _touchActive = false;
  int16_t _touchStartX = 0;
  int16_t _touchStartY = 0;
  int16_t _touchLastX = 0;
  int16_t _touchLastY = 0;
  bool _playbackActive = false;
  bool _ignoreRemoteAudio = false;
  bool _autoReadReplies = false;
  uint8_t _displayBrightness = DEFAULT_BRIGHTNESS;
  int _settingsFocusIndex = 0;
  bool _dirty = true;
  unsigned long _lastDrawMs = 0;
  unsigned long _lastTelemetryRefreshMs = 0;
  String _serialCommand;

  void handleButtons();
  void handleTouch();
  void handleSerialDebug();
  void handleTap(int x, int y);
  void pageForward();
  void pageBack();
  void openThread(int index);
  void createThread();
  void backToThreads();
  void backFromAgents();
  void showAgents();
  void confirmAgent();
  void showSettings();
  void closeSettings();
  void activateSettingsFocus();
  void toggleAutoRead();
  void cycleDisplayBrightness();
  void loadSettings();
  void persistSettings();
  void startRecording();
  void stopRecording();
  void cancelRecording();
  void toggleAssistantSpeech();
  void updateReaderSelection();
  int readerMessageIndex() const;
  int messagePageCount(const RemoteMessage &message) const;
  String latestAssistantId() const;
  void draw();
  void drawAnimationFrame();
  void drawHeader();
  void drawThreads();
  void drawConversation();
  void drawAgents();
  void drawSettings();
  void drawFooter(const char *label);
  void drawMessageTextPage(const String &text, int page, int x, int y,
                           int charactersPerLine, int linesPerPage,
                           uint16_t color);
  int wrappedLineCount(const String &text, int charactersPerLine) const;
};
