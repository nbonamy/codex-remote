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
    Bridges,
  };

  RemoteClient _client;
  AudioService _audio;
  View _view = View::Threads;
  int _threadPage = 0;
  int _bridgePage = 0;
  String _readerMessageId;
  int _readerPage = 0;
  bool _awaitingResponse = false;
  String _responseBaselineId;
  bool _recording = false;
  bool _buttonAPrevious = false;
  bool _buttonBPrevious = false;
  bool _touchActive = false;
  int16_t _touchStartX = 0;
  int16_t _touchStartY = 0;
  int16_t _touchLastX = 0;
  int16_t _touchLastY = 0;
  bool _playbackActive = false;
  bool _dirty = true;
  unsigned long _lastDrawMs = 0;

  void handleButtons();
  void handleTouch();
  void handleTap(int x, int y);
  void pageForward();
  void pageBack();
  void openThread(int index);
  void createThread();
  void backToThreads();
  void showBridges();
  void startRecording();
  void stopRecording();
  void updateReaderSelection();
  int readerMessageIndex() const;
  int messagePageCount(const RemoteMessage &message) const;
  String latestAssistantId() const;
  void draw();
  void drawHeader();
  void drawThreads();
  void drawConversation();
  void drawBridges();
  void drawFooter(const char *label);
  void drawMessageTextPage(const String &text, int page, int x, int y,
                           int charactersPerLine, int linesPerPage,
                           uint16_t color);
  int wrappedLineCount(const String &text, int charactersPerLine) const;
};
