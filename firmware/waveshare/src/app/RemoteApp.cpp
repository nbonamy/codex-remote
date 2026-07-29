#include "RemoteApp.h"

#include "../Config.h"
#include "../diag/Log.h"
#include "../hal/Board.h"

namespace {
constexpr uint16_t kBlack = 0x0000;
constexpr uint16_t kPanel = 0x0861;
constexpr uint16_t kPanelSelected = 0x10E3;
constexpr uint16_t kLine = 0x2945;
constexpr uint16_t kWhite = 0xF79D;
constexpr uint16_t kMuted = 0x8C91;
constexpr uint16_t kMint = 0x87B8;
constexpr uint16_t kCyan = 0x66BF;
constexpr uint16_t kCoral = 0xFB4B;
constexpr uint16_t kYellow = 0xFE88;
} // namespace

bool RemoteApp::begin() {
  Serial.begin(115200);
  delay(150);
  if (!Board::init()) {
    return false;
  }
  Arduino_SH8601 &display = Board::display();
  if (!display.begin()) {
    Log::client("App", "display init failed");
    return false;
  }
  display.setRotation(0);
  Board::setDisplayBrightness(DEFAULT_BRIGHTNESS);
  display.fillScreen(kBlack);
  display.setTextWrap(false);

  if (!_audio.init()) {
    Log::client("App", "audio init failed");
    return false;
  }
  _client.begin(this);
  _dirty = true;
  return true;
}

void RemoteApp::update() {
  Board::update();
  _client.update();
  handleButtons();

  if (_recording && _audio.captureChunk()) {
    _client.sendAudio(reinterpret_cast<const uint8_t *>(_audio.captureData()),
                      _audio.captureBytes());
  }
  if (_playbackActive) {
    _audio.advancePlayback();
    if (_audio.playbackIdle()) {
      _playbackActive = false;
    }
  }
  if (_dirty || millis() - _lastDrawMs > 500) {
    draw();
  }
  delay(2);
}

void RemoteApp::onRemoteStateChanged() {
  if (_selectedThread > _client.threadCount()) {
    _selectedThread = _client.threadCount();
  }
  _dirty = true;
}

void RemoteApp::onRemoteAudio(const uint8_t *data, size_t length) {
  if (_recording) {
    return;
  }
  if (!_playbackActive) {
    _audio.resetPlayback();
    _audio.markPlaybackStarted();
    _playbackActive = true;
  }
  if (!_audio.queuePlayback(data, length)) {
    Log::client("App", "speaker buffer overflow");
  }
}

void RemoteApp::handleButtons() {
  const bool buttonA = Board::buttonAIsPressed();
  const bool buttonB = Board::buttonBIsPressed();

  if (_view == View::Threads) {
    if (buttonA && !_buttonAPrevious) {
      if (_selectedThread == 0) {
        _client.createThread();
      } else {
        const RemoteThread &thread = _client.thread(_selectedThread - 1);
        if (_client.openThread(thread.id)) {
          _view = View::Conversation;
        }
      }
      _dirty = true;
    }
    if (buttonB && !_buttonBPrevious) {
      _selectedThread =
          (_selectedThread + 1) % max(1, _client.threadCount() + 1);
      _dirty = true;
    }
  } else {
    if (buttonA && !_buttonAPrevious) {
      startRecording();
    }
    if (!buttonA && _buttonAPrevious && _recording) {
      stopRecording();
    }
    if (buttonB && !_buttonBPrevious && !_recording) {
      _view = View::Threads;
      _client.listThreads();
      _dirty = true;
    }
  }

  _buttonAPrevious = buttonA;
  _buttonBPrevious = buttonB;
}

void RemoteApp::startRecording() {
  if (!_client.connected() || _client.activeThreadId().isEmpty()) {
    return;
  }
  _audio.stopPlayback();
  _playbackActive = false;
  if (!_audio.startRecording()) {
    return;
  }
  if (!_client.startAudio(_client.activeThreadId())) {
    _audio.stopRecording();
    return;
  }
  _recording = true;
  _dirty = true;
}

void RemoteApp::stopRecording() {
  _recording = false;
  _audio.stopRecording();
  _client.endAudio();
  _dirty = true;
}

void RemoteApp::draw() {
  Arduino_SH8601 &display = Board::display();
  display.fillScreen(kBlack);
  drawHeader();
  if (_view == View::Threads) {
    drawThreads();
    drawFooter("BOOT  Open", "PWR  Next");
  } else {
    drawConversation();
    drawFooter(_recording ? "BOOT  Release" : "BOOT  Hold to talk",
               "PWR  Back");
  }
  _lastDrawMs = millis();
  _dirty = false;
}

void RemoteApp::drawHeader() {
  Arduino_SH8601 &display = Board::display();
  display.drawFastHLine(0, 53, SCREEN_WIDTH_PX, kLine);
  display.setTextSize(2);
  display.setTextColor(kMint);
  display.setCursor(16, 18);
  display.print(">_");
  display.setTextSize(1);
  display.setTextColor(kWhite);
  display.setCursor(50, 22);
  display.print("CODEX REMOTE");

  display.fillCircle(319, 27, 4, _client.connected() ? kMint : kCoral);
  display.setTextColor(kMuted);
  display.setCursor(330, 23);
  display.print(_client.connected() ? "ON" : "OFF");
}

void RemoteApp::drawThreads() {
  Arduino_SH8601 &display = Board::display();
  display.setTextSize(1);
  display.setTextColor(kMuted);
  display.setCursor(16, 69);
  display.printf("%d RECENT THREADS", _client.threadCount());

  const int total = _client.threadCount() + 1;
  int first = max(0, _selectedThread - 2);
  first = min(first, max(0, total - 4));
  for (int visible = 0; visible < 4; visible++) {
    const int index = first + visible;
    if (index >= total) {
      break;
    }
    const int y = 89 + visible * 62;
    const bool selected = index == _selectedThread;
    display.fillRoundRect(14, y, 340, 54, 11,
                          selected ? kPanelSelected : kPanel);
    if (selected) {
      display.drawRoundRect(14, y, 340, 54, 11, kMint);
    }
    display.setTextColor(selected ? kMint : kMuted);
    display.setCursor(26, y + 21);
    display.print(index == 0 ? "+" : ">");
    display.setTextColor(kWhite);
    display.setCursor(51, y + 11);
    const String title =
        index == 0 ? "New thread" : _client.thread(index - 1).title;
    display.print(title.substring(0, 42));
    display.setTextColor(kMuted);
    display.setCursor(51, y + 31);
    const String preview = index == 0
                               ? "Start in the default workspace"
                               : _client.thread(index - 1).preview;
    display.print(preview.substring(0, 46));
  }
}

void RemoteApp::drawConversation() {
  Arduino_SH8601 &display = Board::display();
  display.setTextSize(2);
  display.setTextColor(kWhite);
  display.setCursor(16, 69);
  display.print(_client.activeThreadTitle().substring(0, 25));

  display.setTextSize(1);
  display.setTextColor(_client.activeThreadBusy() ? kYellow : kMuted);
  display.setCursor(16, 94);
  display.print(_recording ? "LISTENING" : _client.status().substring(0, 52));

  int y = 118;
  const int first = max(0, _client.messageCount() - 4);
  for (int index = first; index < _client.messageCount() && y < 370; index++) {
    const RemoteMessage &message = _client.message(index);
    const bool user = message.role == "user";
    display.fillRoundRect(user ? 76 : 14, y, user ? 278 : 326, 48, 9,
                          user ? 0x08C4 : kPanel);
    int textY = y + 9;
    drawWrappedText(message.text, user ? 88 : 26, textY, user ? 250 : 300, 3,
                    user ? kCyan : kWhite);
    y += 56;
  }
  if (_client.messageCount() == 0) {
    display.setTextColor(kMuted);
    display.setCursor(16, 147);
    display.print("Hold BOOT and tell Codex what to do.");
  }
}

void RemoteApp::drawFooter(const char *left, const char *right) {
  Arduino_SH8601 &display = Board::display();
  display.drawFastHLine(0, 399, SCREEN_WIDTH_PX, kLine);
  display.setTextSize(1);
  display.setTextColor(kWhite);
  display.setCursor(17, 420);
  display.print(left);
  const int rightWidth = strlen(right) * 6;
  display.setCursor(SCREEN_WIDTH_PX - rightWidth - 17, 420);
  display.print(right);
}

void RemoteApp::drawWrappedText(const String &text, int x, int &y, int width,
                                int maxLines, uint16_t color, uint8_t size) {
  Arduino_SH8601 &display = Board::display();
  display.setTextSize(size);
  display.setTextColor(color);
  const int charactersPerLine = max(1, width / (6 * size));
  int offset = 0;
  for (int line = 0; line < maxLines && offset < text.length(); line++) {
    int length = min(charactersPerLine, static_cast<int>(text.length()) - offset);
    int split = length;
    if (offset + length < text.length()) {
      while (split > 1 && text[offset + split] != ' ') {
        split--;
      }
      if (split <= 1) {
        split = length;
      }
    }
    display.setCursor(x, y);
    display.print(text.substring(offset, offset + split));
    offset += split;
    while (offset < text.length() && text[offset] == ' ') {
      offset++;
    }
    y += 8 * size;
  }
}
