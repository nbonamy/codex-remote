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
  };

  RemoteClient _client;
  AudioService _audio;
  View _view = View::Threads;
  int _selectedThread = 0;
  bool _recording = false;
  bool _buttonAPrevious = false;
  bool _buttonBPrevious = false;
  bool _playbackActive = false;
  bool _dirty = true;
  unsigned long _lastDrawMs = 0;

  void handleButtons();
  void startRecording();
  void stopRecording();
  void draw();
  void drawHeader();
  void drawThreads();
  void drawConversation();
  void drawFooter(const char *left, const char *right);
  void drawWrappedText(const String &text, int x, int &y, int width,
                       int maxLines, uint16_t color, uint8_t size = 1);
};
